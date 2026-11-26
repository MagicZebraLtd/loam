/**
 * Emergency Reset from the host menu: ask the launcher (main.js `loam-emergency-reset`) to run the server's
 * in-process wipe, and wait for its answer. Mirrors `requestDbStartFresh`'s round trip. Never throws: a
 * timeout, a host that isn't running yet, or a thrown `post()` all resolve to `{ ok: false, error }`.
 */
import { awaitWithin } from './await-within';
import { addOwnListener } from './bridge-listener';
import type { BridgeChannel } from './db-encryption';
import { hostErrorText, hostNoResponseText } from './host-errors';

export type EmergencyResetResult =
  /**
   * The wipe ran; `complete` is false when deletion couldn't be fully verified (the node stays locked).
   * `keyClear` is true when the launcher handed this app the device-key clear (`loam-wipe-restart`).
   * `journaled` is false when the server couldn't record the wipe on disk before starting it: an incomplete
   * wipe is then NOT finished by the next boot, and the reset has to be run again (main.js `resetReply`).
   */
  | { ok: true; complete: boolean; keyClear: boolean; journaled: boolean }
  | { ok: false; error: string };

/**
 * What the reset screen does with a result:
 *   - 'close'      everything is erased: close LOAM, so the next launch is a clean start on setup;
 *   - 'key-clear'  erased, but the device key is still being cleared (index.tsx `attemptWipeKeyClear`,
 *                  which closes LOAM once the clear is verified, or shows why it couldn't): never close
 *                  before that, or the clear could be cut off;
 *   - 'incomplete' some data couldn't be erased and verified gone: the node stays locked and the screen
 *                  says so (reopening LOAM finishes the erase from the wipe journal), never closing as if it
 *                  had worked;
 *   - 'unrecorded' the same, but the wipe journal couldn't be written first, so reopening does NOT finish
 *                  the erase: the screen says the reset didn't finish and asks for it to be run again;
 *   - 'failed'     the reset didn't run.
 */
export type ResetOutcome = 'close' | 'key-clear' | 'incomplete' | 'unrecorded' | 'failed';

export function resetOutcome(result: EmergencyResetResult): ResetOutcome {
  if (!result.ok) {
    return 'failed';
  }
  if (!result.complete) {
    return result.journaled ? 'incomplete' : 'unrecorded';
  }
  return result.keyClear ? 'key-clear' : 'close';
}

/** What closing after a reset clears first (reset-close.ts wires the real ones). */
export type ResetCloseSteps = {
  /** The last shared file's cached copy (lib/save-file.ts `clearSharedFiles`). */
  clearSharedFiles: () => Promise<void>;
  /** The setup record (`loam.setup`), so setup never names or pre-fills the erased network. */
  clearSetupRecord: () => Promise<void>;
  /** The host WebView's own storage, which the page only purges if it heard the `wipe` frame. */
  deleteHostWebData: () => Promise<void>;
  closeApp: () => void;
};

/**
 * Close LOAM after a reset, once what it would otherwise leave on this phone until the next launch (or for
 * good) is gone: the share-sheet cache, the setup record and the host WebView's storage. Best effort: a step
 * that fails never keeps the app open, and the WebView delete is waited for at most `webDataTimeoutMs`, so a
 * native call that never answers can't block the close. Dependencies are injected so the ordering is
 * testable without them.
 */
export async function closeAfterReset(steps: ResetCloseSteps, webDataTimeoutMs: number): Promise<void> {
  for (const step of [steps.clearSharedFiles, steps.clearSetupRecord]) {
    try {
      await step();
    } catch {
      // best effort: the app closes either way
    }
  }
  try {
    await awaitWithin(steps.deleteHostWebData(), webDataTimeoutMs);
  } catch {
    // best effort: the app closes either way
  }
  steps.closeApp();
}

/**
 * Which device-key clear main.js asked for with `loam-wipe-restart`:
 *   - 'live'   a running server was just reset (no payload). Its runtime can't restart in this process, so
 *              LOAM closes once the key is cleared;
 *   - 'resume' main.js found, at its own boot, a reset an earlier launch never finished (`{ resume: true }`).
 *              The runtime is fresh and boots on in this process once the key is cleared, and the setup
 *              screens have already run in this launch, so the setup record names the new network.
 */
export type WipeKeyClearKind = 'live' | 'resume';

/** The kind of a `loam-wipe-restart` payload: a resume only on an explicit `resume: true`. */
export function wipeRestartKind(payload: unknown): WipeKeyClearKind {
  return typeof payload === 'object' && payload !== null && (payload as { resume?: unknown }).resume === true
    ? 'resume'
    : 'live';
}

/** What {@link finishWipeKeyClear} runs (reset-close.ts wires the real ones). */
export type WipeKeyClearSteps = {
  /** The setup record (`loam.setup`). */
  clearSetupRecord: () => Promise<void>;
  /** The last shared file's cached copy. */
  clearSharedFiles: () => Promise<void>;
  /** All of the host WebView's storage. */
  deleteHostWebData: () => Promise<void>;
  /** Clear the device key and, only on a verified clear, acknowledge `loam-wipe-complete`. */
  clearKeyAndAck: () => Promise<{ ok: boolean; error?: string }>;
  /** Clear what a reset leaves behind and close LOAM (`closeLoamAfterReset`). */
  closeLoam: () => Promise<void>;
};

/**
 * Finish a reset whose device key this app must clear, in the order its kind needs. Never rejects.
 *   - live: forget the setup record first, so it is gone even if a later step dies, then clear the key; on a
 *     verified clear, close LOAM.
 *   - resume: delete the shared file and the WebView's storage first (waited for at most `webDataTimeoutMs`;
 *     the WebView has loaded nothing yet in this launch, so this can't race the new network's page), then
 *     clear the key. The setup record and the app stay: the boot carries on.
 * A failed clear is returned for the Retry screen, with no acknowledgement and no close.
 */
export async function finishWipeKeyClear(
  kind: WipeKeyClearKind,
  steps: WipeKeyClearSteps,
  webDataTimeoutMs: number,
): Promise<{ ok: boolean; error?: string }> {
  if (kind === 'live') {
    try {
      await steps.clearSetupRecord();
    } catch {
      // best effort: closing clears it again
    }
  } else {
    try {
      await steps.clearSharedFiles();
    } catch {
      // best effort: the key clear matters more
    }
    try {
      await awaitWithin(steps.deleteHostWebData(), webDataTimeoutMs);
    } catch {
      // best effort: the key clear matters more
    }
  }
  let result: { ok: boolean; error?: string };
  try {
    result = await steps.clearKeyAndAck();
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : undefined };
  }
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  if (kind === 'live') {
    await steps.closeLoam();
  }
  return { ok: true };
}

/**
 * Where the screen's device-key clear stands: `clearing` from the request until a resumed clear finishes (a
 * live one closes LOAM, so it stays `clearing`), `failed` while the Retry screen shows.
 */
export type WipeKeyClearState = 'idle' | 'clearing' | 'failed';

/** The state after a clear of `kind` answered `result`. */
export function wipeKeyClearStateAfter(kind: WipeKeyClearKind, result: { ok: boolean }): WipeKeyClearState {
  if (!result.ok) {
    return 'failed';
  }
  return kind === 'resume' ? 'idle' : 'clearing';
}

/**
 * Whether the re-bootstrap the web client's `loam-wipe` message schedules may run. It is for an in-process
 * reset; while a device-key clear is under way or has failed, the screen is closing LOAM or showing Retry,
 * and a re-bootstrap would only remount the WebView against a server that is gone.
 */
export function mayRebootstrapAfterWipe(state: WipeKeyClearState): boolean {
  return state === 'idle';
}

/** Long enough for an encrypted wipe on a slow phone; the server answers as soon as it's done. */
const DEFAULT_TIMEOUT_MS = 30_000;

export function requestEmergencyReset(channel: BridgeChannel, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<EmergencyResetResult> {
  return new Promise((resolve) => {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let settled = false;

    const finish = (result: EmergencyResetResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      removeListener();
      resolve(result);
    };

    const onResult = (payload: unknown): void => {
      const result = payload as
        | {
            requestId?: unknown;
            ok?: unknown;
            complete?: unknown;
            keyClear?: unknown;
            journaled?: unknown;
            error?: unknown;
            errorCode?: unknown;
          }
        | undefined;
      if (!result || result.requestId !== requestId) {
        return;
      }
      finish(
        result.ok === true
          ? {
              ok: true,
              complete: result.complete === true,
              keyClear: result.keyClear === true,
              // Only an explicit false: an answer without it keeps the reopen-to-finish screen, as before.
              journaled: result.journaled !== false,
            }
          : { ok: false, error: hostErrorText(result) },
      );
    };

    const timer = setTimeout(() => {
      finish({ ok: false, error: hostNoResponseText() });
    }, timeoutMs);

    const removeListener = addOwnListener(channel, 'loam-emergency-reset-result', onResult);
    try {
      channel.post('loam-emergency-reset', { requestId });
    } catch (err) {
      finish({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}

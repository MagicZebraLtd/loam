// React Native wiring for closing LOAM after an Emergency Reset (see emergency-reset.ts `closeAfterReset`)
// and for finishing a reset whose device key this app clears (`finishWipeKeyClear`). The host-menu reset
// screen (components/emergency-reset.tsx) closes through `closeLoamAfterReset`; the device-key clear
// (`attemptWipeKeyClear` in src/app/index.tsx) goes through `clearWipeKeyAfterReset`.
import { closeApp, deleteAllWebData } from '../../modules/loam-hotspot';
import { closeAfterReset, finishWipeKeyClear, type WipeKeyClearKind } from './emergency-reset';
import { clearSetupRecord } from './new-network';
import { clearSharedFiles } from './save-file';

/** How long a reset waits for the WebView storage delete before going on anyway. */
export const HOST_WEB_DATA_TIMEOUT_MS = 1500;

/**
 * Clear what a reset must not leave behind on this phone, then close LOAM. Never rejects. The WebView only
 * ever shows LOAM, so all of its storage and cookies go.
 */
export function closeLoamAfterReset(): Promise<void> {
  return closeAfterReset(
    {
      clearSharedFiles,
      clearSetupRecord,
      deleteHostWebData: deleteAllWebData,
      closeApp,
    },
    HOST_WEB_DATA_TIMEOUT_MS,
  );
}

/**
 * Clear the device key after a reset of `kind` (see `finishWipeKeyClear`): a live reset closes LOAM once the
 * key is cleared, a resumed one keeps the setup just made and lets the boot carry on. Never rejects.
 */
export function clearWipeKeyAfterReset(
  kind: WipeKeyClearKind,
  clearKeyAndAck: () => Promise<{ ok: boolean; error?: string }>,
): Promise<{ ok: boolean; error?: string }> {
  return finishWipeKeyClear(
    kind,
    {
      clearSetupRecord,
      clearSharedFiles,
      deleteHostWebData: deleteAllWebData,
      clearKeyAndAck,
      closeLoam: closeLoamAfterReset,
    },
    HOST_WEB_DATA_TIMEOUT_MS,
  );
}

/**
 * The node's lifecycle: one state machine that owns the embedded server, the network's key and the phase the
 * host window shows (DesktopPhase in src/shared/ipc.ts). Every change goes through `setPhase`, which pushes the
 * whole DesktopState to the host window; while the node runs, its status is polled every 2 s and pushed only
 * when it moved.
 *
 * Everything with a side effect outside this file is a dependency (the server, the keychain, the settings
 * file, the port probe, the clock), so the tests drive every transition with a fake server and never boot
 * Electron or the real node. Operations are serialized: a double-clicked Start can't boot two servers.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  cleanNodeName,
  presetConfig,
  type DbEncryptionMode,
  type HostCode,
  type HostResult,
  type HostUser,
  type LoamConfig,
  type LoamConfigUpdate,
} from "@loam/schema";

import type {
  DesktopCapabilities,
  DesktopError,
  DesktopErrorCode,
  DesktopPhase,
  DesktopSettingsView,
  DesktopState,
  NodeInfo,
  SettingsUpdate,
  SetupRequest,
  UnlockRequest,
} from "../shared/ipc.js";
import { errorCode, errorDetail, mapBootError, WIPE_RESUME_CODE } from "./boot-errors.js";
import { emptyDataDir, ensureDataDir, writeInitialConfig } from "./data-dir.js";
import { buildJoinUrl, localOrigin } from "./join-url.js";
import { KeyError, resolveDbKey, type DeviceSecretStore } from "./keys.js";
import type { LogFeed } from "./log-feed.js";
import type { EmbeddedNode, StartServer } from "./server-module.js";
import { HOST_ACK_VERSION, settingsView, type DesktopSettings, type SettingsStore } from "./settings.js";
import { clearWipePhase, readWipePhase } from "./wipe-phase.js";

/** The node's database file in its data folder (the server's `loam.db`). */
const DATABASE_FILE = "loam.db";
/** The address the node listens on: every interface, so phones on the LAN can join. */
export const LISTEN_HOST = "0.0.0.0";
/** The port preferred when the host hasn't picked one. */
export const DEFAULT_PORT = 3000;
/** How often the Running screen's status is refreshed. */
export const STATUS_POLL_MS = 2_000;
/** How long stopping the node may take before the launcher gives up waiting (Quit must not hang). */
export const CLOSE_TIMEOUT_MS = 10_000;
/** How long a reset the launcher didn't start may take before its aftermath (the client copy) is dealt with anyway. */
const OUTSIDE_RESET_WAIT_MS = 30_000;
/** A boot that keeps handing the key clear back (it never should) stops after this many rounds. */
const MAX_KEY_CLEAR_ROUNDS = 2;

/** The env the launcher owns. Cleared before every boot so a value from the host's shell can't leak in. */
const LAUNCHER_ENV = [
  "LOAM_DATA_DIR",
  "LOAM_CLIENT_DIST",
  "LOAM_CONFIG_FILE",
  "LOAM_JOIN_HOST",
  "LOAM_DB_KEY",
  "LOAM_DB_KEY_MIGRATE_FROM",
  "LOAM_DB_KEY_REQUEST_ID",
  "LOAM_DB_ENCRYPTION_MODE",
  "LOAM_DB_DRIVER",
  "LOAM_HOST_TOKEN",
  "LOAM_DEV_MODE",
  "CLIENT_PORT",
  "PORT",
  "HOST",
] as const;

const NOT_RUNNING = "The network isn't running.";
const STOP_TIMEOUT = "The network didn't stop in time, so nothing else can start until it has.";
const KEYCHAIN_MISSING =
  "This computer has no keychain to keep the network's key in. Choose a passphrase, or keep the data only while LOAM runs.";
const DRIVER_MISSING =
  "Encryption isn't available on this computer: LOAM's encrypted database driver didn't load. Choose Off, or reinstall LOAM.";
const WRONG_PASSPHRASE = "That passphrase didn't open this network.";

export type ControllerDeps = {
  capabilities: DesktopCapabilities;
  version: string;
  /** LOAM_DATA_DIR: `userData/node`. */
  dataDir: string;
  /** The packaged web client (LOAM_CLIENT_DIST). */
  clientDist: string;
  settings: SettingsStore;
  secrets: DeviceSecretStore;
  /** The server bundle's `startEmbeddedServer`, loaded on first use. */
  loadServer(): Promise<StartServer>;
  /** Whether the SQLCipher driver loads (checked before every encrypted boot). */
  driverLoads(): boolean;
  log: LogFeed;
  /** @loam/tui `clean`: for every piece of text that came from someone else. */
  clean(text: string): string;
  findFreePort(preferred: number, host: string): Promise<number | undefined>;
  lanAddresses(): string[];
  /** Where the server reads its configuration: `process.env` in the app, a plain object in tests. */
  env: NodeJS.ProcessEnv;
  /**
   * Install the server's fixed-key reset hook (`globalThis.__loamRequestWipeRestart`, read by
   * apps/server/src/store-lifecycle.ts `wipeRestartHook`). Installed once; the server calls it when a
   * persistent/passphrase network's data is deleted and the key must now be destroyed.
   */
  installWipeRestartHook(hook: () => void): void;
  /**
   * Install the server's reset-started hook (`globalThis.__loamHostReset`, apps/server/src/kill-switch.ts), called
   * at the start of EVERY Emergency Reset, whoever ran it: the web client's admin screen and `/api/panic` included.
   */
  installHostResetHook(hook: () => void): void;
  /** Push the state to the host window. */
  onState(state: DesktopState): void;
  /** The node (re)started on `origin`, or an Emergency Reset finished: an open client window must reload. */
  onNodeChanged(origin: string | undefined): void;
  /** The network was discarded (or a new one is being set up): erase what the host's client window stored. */
  onNetworkDiscarded(): Promise<void>;
  /**
   * An Emergency Reset erased the network: erase the host client window's copy of it (its IndexedDB lives outside
   * the database's encryption), leaving the window open to reload.
   */
  clearClientData(): Promise<void>;
  now?: () => number;
  pollMs?: number;
  closeTimeoutMs?: number;
  outsideResetWaitMs?: number;
};

/** A booted node and what the launcher handed it. */
type RunningNode = { node: EmbeddedNode; hostToken: string; port: number; startedAt: number };

/** What one boot attempt came to. */
type BootOutcome = "done" | "key_clear";

/** A persistent or passphrase network: its key is fixed, so a reset must end with the launcher destroying it. */
function isFixedKey(mode: DbEncryptionMode): boolean {
  return mode === "persistent" || mode === "passphrase";
}

/** Resolve after `ms`, without keeping the process alive for it. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}

export class NodeController {
  private phase: DesktopPhase = { phase: "setup" };
  private running: RunningNode | undefined;
  /** What the host typed this start (passphrase networks only). Never stored; dropped on stop. */
  private passphrase: string | undefined;
  /** Set by the server's fixed-key reset hook during a reset or a boot. */
  private wipeRestartRequested = false;
  /**
   * The device secret may be minted at the next boot: the network was just set up, or a reset destroyed its old
   * key. Otherwise a missing secret is a lock, never a reason to mint (keys.ts). Cleared once a boot succeeds.
   */
  private freshKey = false;
  /** The launcher itself is running a reset (resetNow, newNetwork): the server's hooks are its business then. */
  private launcherReset = false;
  /** Quit has begun: nothing may boot any more. */
  private shuttingDown = false;
  /**
   * A close still in progress: the node was given up on after the close timeout, but its listener and its store
   * may well be alive. Nothing boots until this settles (two nodes on one data folder, or one port, is never
   * acceptable); every operation that needs the node gone waits for it again, bounded, and fails `stop_timeout`.
   */
  private closing: Promise<void> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private lastPushed = "";
  private readonly now: () => number;

  constructor(private readonly deps: ControllerDeps) {
    this.now = deps.now ?? Date.now;
    deps.installWipeRestartHook(() => {
      this.wipeRestartRequested = true;
      this.onServerWipeRestart();
    });
    deps.installHostResetHook(() => {
      // Every reset, whoever started it: the host's client window now holds a copy of an erased network.
      this.markClientCopyStale();
      this.onServerReset();
    });
  }

  // ---- State ------------------------------------------------------------------------------------------------

  /** The whole state, as the host window sees it. */
  getState(): DesktopState {
    const settings = this.deps.settings.read();
    return {
      ...this.phase,
      capabilities: this.deps.capabilities,
      ...(settings.network ? { network: settings.network } : {}),
      settings: this.view(settings),
    };
  }

  /** The current phase's name (for the windows and the smoke run). */
  phaseName(): DesktopPhase["phase"] {
    return this.phase.phase;
  }

  /** The loopback origin of the running node, or undefined. */
  localOrigin(): string | undefined {
    return this.running ? localOrigin(this.running.port) : undefined;
  }

  /** The port the running node listens on, or undefined. */
  localPort(): number | undefined {
    return this.running?.port;
  }

  /**
   * Whether the host's client window keeps its browser storage in memory only: for a network kept only while
   * LOAM runs, a copy of its messages on disk would outlive the key that protects the network (windows.ts).
   */
  clientStorageInMemory(): boolean {
    return this.deps.settings.read().network?.encryption === "ephemeral";
  }

  /**
   * What the client window's preload injects, while the node runs: the host token, the transport key, and
   * whether the web client must keep no copy of the network in its storage (`noLocalCache`: every encrypted
   * network, since the client's IndexedDB would sit on the disk outside the database's key; see trust.ts).
   */
  hostInjection(): { hostToken: string; transportKey?: string; noLocalCache: boolean } | undefined {
    if (!this.running) {
      return undefined;
    }
    const transportKey = this.running.node.host.transportPublicKey();
    const encryption = this.deps.settings.read().network?.encryption ?? "off";
    return { hostToken: this.running.hostToken, ...(transportKey ? { transportKey } : {}), noLocalCache: encryption !== "off" };
  }

  private view(settings: DesktopSettings): DesktopSettingsView {
    return settingsView(settings, this.deps.dataDir, this.deps.version);
  }

  private setPhase(phase: DesktopPhase): void {
    this.phase = phase;
    const state = this.getState();
    this.lastPushed = JSON.stringify(state);
    this.deps.onState(state);
  }

  /** The Unlock screen; `fresh` when the passphrase typed now starts the network over (its old key was destroyed). */
  private lockedPhase(wrongPassphrase: boolean): DesktopPhase {
    return { phase: "locked", wrongPassphrase, fresh: this.freshKey };
  }

  private fail(code: DesktopErrorCode, detail?: string): void {
    const error: DesktopError = detail ? { code, detail } : { code };
    this.deps.log.note("error", `LOAM couldn't start the network (${code})${detail ? `: ${detail}` : ""}`);
    this.setPhase({ phase: "failed", error });
  }

  /** Run `operation` after every earlier one has settled, so two boots can never overlap. */
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation);
    this.queue = run.catch(() => undefined);
    return run;
  }

  // ---- Running-node status ----------------------------------------------------------------------------------

  /** The Running screen's view of the node: its status, the join URL and this computer's addresses. */
  private nodeInfo(running: RunningNode): NodeInfo {
    const { host } = running.node;
    const status = host.status();
    const transportKey = host.transportPublicKey();
    const invite = host.invite();
    return {
      ...status,
      nodeName: this.deps.clean(status.nodeName),
      joinUrl: buildJoinUrl({
        joinHost: status.joinHost,
        port: status.port,
        ...(transportKey ? { transportKey } : {}),
        ...(invite ? { inviteCode: invite.code } : {}),
      }),
      // Always present: a boot without one is refused (bootOnce).
      transportPublicKey: transportKey ?? "",
      addresses: this.deps.lanAddresses(),
      startedAt: running.startedAt,
    };
  }

  /** Re-read the node's status and push it when anything moved. */
  refresh(): void {
    if (!this.running || this.phase.phase !== "running") {
      return;
    }
    let node: NodeInfo;
    try {
      node = this.nodeInfo(this.running);
    } catch (error) {
      // Mid-reset the node can refuse; the next tick (or the reset's own transition) catches up.
      this.deps.log.note("warn", `Couldn't read the network's status: ${errorDetail(error)}`);
      return;
    }
    this.phase = { phase: "running", node };
    const state = this.getState();
    const json = JSON.stringify(state);
    if (json !== this.lastPushed) {
      this.lastPushed = json;
      this.deps.onState(state);
    }
  }

  private startPolling(): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => this.refresh(), this.deps.pollMs ?? STATUS_POLL_MS);
    this.pollTimer.unref?.();
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  // ---- Boot ---------------------------------------------------------------------------------------------------

  /** At launch: set up a network, ask for its passphrase, or start it. */
  initialize(): Promise<void> {
    return this.serialize(async () => {
      // A reset or discard that erased the network but not (yet) the host client window's copy of it: erase
      // that first, before any window could show it.
      if (this.deps.settings.read().clientCopyStale) {
        this.deps.log.note("warn", "Erasing the LOAM window's copy of a network that was erased earlier.");
        await this.clearClientCopy();
      }
      const { network } = this.deps.settings.read();
      if (!network) {
        this.setPhase({ phase: "setup" });
      } else if (network.encryption === "passphrase" && this.passphrase === undefined) {
        // A reset that proved the data gone but crashed before destroying the key: destroy it now, before asking
        // for anything, so the screen can say the passphrase typed next starts the network over.
        if (readWipePhase(this.deps.dataDir) === "key-clear-ready") {
          this.deps.log.note("warn", "Finishing an interrupted Emergency Reset before asking for the passphrase.");
          if (!this.finishKeyClear()) {
            this.fail("reset_incomplete", "The reset's journal couldn't be removed from the data folder.");
            return;
          }
          await this.clearClientCopy();
        }
        this.setPhase(this.lockedPhase(false));
      } else {
        await this.boot();
      }
    });
  }

  /**
   * Boot the network, finishing a fixed-key Emergency Reset on the way when the server asks for it: its boot-time
   * resume deleted the data and stopped to hand over the key clear (`db_encryption_wipe_resume` after the hook).
   */
  private async boot(): Promise<void> {
    for (let round = 0; round <= MAX_KEY_CLEAR_ROUNDS; round += 1) {
      if ((await this.bootOnce()) === "done") {
        return;
      }
      this.deps.log.note("warn", "Finishing an interrupted Emergency Reset: destroying the old key and starting fresh.");
      if (!this.finishKeyClear()) {
        this.fail("reset_incomplete", "The reset's journal couldn't be removed from the data folder.");
        return;
      }
      await this.clearClientCopy();
    }
    this.fail("reset_incomplete", "The reset kept asking for a new key.");
  }

  /**
   * The last step of a fixed-key reset: destroy the device secret (the cryptographic wipe: nothing written under
   * it can be read again, even with the passphrase), then remove the wipe journal, proven gone. In that order,
   * as the Android launcher does: a crash between the two leaves `key-clear-ready`, and the next boot just
   * destroys the (still unused) new secret again.
   */
  private finishKeyClear(): boolean {
    try {
      this.deps.secrets.destroy();
    } catch (error) {
      this.deps.log.note("error", `Couldn't delete the device secret: ${errorDetail(error)}`);
      return false;
    }
    // The old key is gone: whatever boots next is a new network and gets a new secret.
    this.freshKey = true;
    return clearWipePhase(this.deps.dataDir);
  }

  /** After a fixed-key reset's data is proven gone and the node is closed: destroy the key, erase the client copy, boot. */
  private async completeKeyClearAndBoot(): Promise<void> {
    if (!this.finishKeyClear()) {
      this.fail("reset_incomplete", "The reset's journal couldn't be removed from the data folder.");
      return;
    }
    await this.clearClientCopy();
    await this.boot();
  }

  /**
   * Forget the erased network's log (who connected, what they asked for), as the terminal UI does once a reset
   * has finished; `line` is all the Activity screen keeps from before.
   */
  private forgetLog(line: string): void {
    this.deps.log.clear();
    this.deps.log.note("warn", line);
  }

  /**
   * Erase the host client window's copy after a reset, and the log with it; a failure to erase is logged,
   * never a reason to stop, and leaves the stale mark in place so the next launch tries again.
   */
  private async clearClientCopy(): Promise<void> {
    this.forgetLog("Emergency Reset: every message, person and file on this network was erased, and this log with it.");
    try {
      await this.deps.clearClientData();
      this.markClientCopyFresh();
    } catch (error) {
      this.deps.log.note("warn", `Couldn't erase the LOAM window's stored copy: ${errorDetail(error)}`);
    }
  }

  /**
   * Record, durably, that the host client window's copy belongs to a network being erased. Written before the
   * first destructive step and cleared only once the copy is erased, so a crash in between is finished at the
   * next launch. A settings file that can't be written is logged: the erase itself still runs.
   */
  private markClientCopyStale(): void {
    const settings = this.deps.settings.read();
    if (settings.clientCopyStale) {
      return;
    }
    try {
      this.deps.settings.write({ ...settings, clientCopyStale: true });
    } catch (error) {
      this.deps.log.note("warn", `Couldn't record that the LOAM window's copy must be erased: ${errorDetail(error)}`);
    }
  }

  /** The copy is erased: drop the mark (a write that fails only means one needless erase at the next launch). */
  private markClientCopyFresh(): void {
    const { clientCopyStale, ...rest } = this.deps.settings.read();
    if (!clientCopyStale) {
      return;
    }
    try {
      this.deps.settings.write(rest);
    } catch (error) {
      this.deps.log.note("warn", `Couldn't record that the LOAM window's copy was erased: ${errorDetail(error)}`);
    }
  }

  // ---- Resets the launcher didn't start --------------------------------------------------------------------------

  /**
   * The server's fixed-key hook fired. During a boot (its resume) or the launcher's own reset, they handle it. Any
   * other time the reset came from the web client's admin screen or `/api/panic`: the data is deleted and proven
   * gone, the node is locked (503), and the key must now be destroyed and the node booted again, exactly as the
   * Android launcher's `loam-wipe-restart` listener does. Queued, so it never overlaps another operation.
   */
  private onServerWipeRestart(): void {
    const running = this.running;
    if (!running || this.launcherReset) {
      return;
    }
    this.stopPolling();
    this.setPhase({ phase: "resetting" });
    void this.serialize(() => this.finishOutsideReset(running.node));
  }

  private async finishOutsideReset(node: EmbeddedNode): Promise<void> {
    if (this.running?.node !== node || this.shuttingDown) {
      return;
    }
    this.deps.log.note("warn", "An Emergency Reset erased this network: destroying its old key and starting it again, empty.");
    await this.closeNode();
    await this.completeKeyClearAndBoot();
  }

  /**
   * A reset began, whoever started it. One the launcher didn't start and that finishes in-process (a plaintext or
   * ephemeral network, reset from the web client) still leaves the host's client window holding a copy: once the
   * node says the reset is over, erase that copy and reload the window. A fixed-key reset is finished by
   * {@link onServerWipeRestart} instead, which closes this node and so ends the wait below. One still going when
   * the wait runs out didn't finish (the node answers 503 then), and ends as the launcher's own would (resetNow):
   * journaled, a restart finishes it; not journaled, the node stays locked and Retry runs the reset again.
   */
  private onServerReset(): void {
    const running = this.running;
    if (!running || this.launcherReset) {
      return;
    }
    void (async () => {
      let finished = false;
      const wait = this.deps.outsideResetWaitMs ?? OUTSIDE_RESET_WAIT_MS;
      for (let waited = 0; waited < wait && !finished; waited += 100) {
        await delay(100);
        if (this.running !== running) {
          return;
        }
        try {
          finished = !running.node.host.status().resetting;
        } catch {
          // Mid-wipe the node can refuse; ask again.
        }
      }
      await this.serialize(async () => {
        if (this.running !== running || this.shuttingDown) {
          return;
        }
        if (finished) {
          await this.clearClientCopy();
          this.deps.onNodeChanged(localOrigin(running.port));
          this.refresh();
          return;
        }
        this.stopPolling();
        if (readWipePhase(this.deps.dataDir) !== undefined) {
          this.deps.log.note("warn", "An Emergency Reset started elsewhere didn't finish; restarting the network to finish it.");
          this.setPhase({ phase: "resetting" });
          await this.closeNode();
          await this.clearClientCopy();
          await this.boot();
          return;
        }
        this.fail("reset_incomplete", "An Emergency Reset started elsewhere didn't finish, and couldn't be recorded on disk.");
      });
    })();
  }

  private async bootOnce(): Promise<BootOutcome> {
    const { deps } = this;
    const settings = deps.settings.read();
    const network = settings.network;
    if (!network) {
      this.setPhase({ phase: "setup" });
      return "done";
    }
    if (this.shuttingDown) {
      return "done";
    }
    this.setPhase({ phase: "starting" });
    // Never over a node that hasn't finished closing: its store may still be open on this folder.
    if (!(await this.awaitClose())) {
      this.fail("stop_timeout", STOP_TIMEOUT);
      return "done";
    }
    const mode = network.encryption;

    if (!existsSync(join(deps.clientDist, "index.html"))) {
      this.fail("client_missing", `No web client in ${deps.clientDist}`);
      return "done";
    }
    ensureDataDir(deps.dataDir);

    // A reset whose data is already proven gone, interrupted before the key was destroyed: finish it before any
    // key is resolved, so the fresh database is never written under the key the reset was destroying.
    if (isFixedKey(mode) && readWipePhase(deps.dataDir) === "key-clear-ready") {
      deps.log.note("warn", "Finishing an interrupted Emergency Reset before starting.");
      if (!this.finishKeyClear()) {
        this.fail("reset_incomplete", "The reset's journal couldn't be removed from the data folder.");
        return "done";
      }
      await this.clearClientCopy();
    }

    let dbKey: string | undefined;
    try {
      dbKey = resolveDbKey(mode, deps.secrets, {
        keychain: deps.capabilities.keychain,
        // A new secret only for a new network: just set up, its old key destroyed by a reset, or no database yet
        // (nothing a new key could lock out). Any other missing secret is reported, not papered over.
        mayMint: this.freshKey || !existsSync(join(deps.dataDir, DATABASE_FILE)),
        ...(this.passphrase !== undefined ? { passphrase: this.passphrase } : {}),
      });
    } catch (error) {
      if (error instanceof KeyError) {
        if (mode === "passphrase" && this.passphrase === undefined) {
          this.setPhase(this.lockedPhase(false));
        } else {
          this.fail(error.code, error.message);
        }
        return "done";
      }
      this.fail("unknown", errorDetail(error));
      return "done";
    }

    if (mode !== "off" && !deps.driverLoads()) {
      this.fail("db_encryption_driver_missing", "better-sqlite3-multiple-ciphers didn't load.");
      return "done";
    }

    const port = await this.pickPort(settings);
    if (port === undefined) {
      return "done";
    }

    let startServer: StartServer;
    try {
      startServer = await deps.loadServer();
    } catch (error) {
      this.fail("unknown", `The server bundle didn't load: ${errorDetail(error)}`);
      return "done";
    }

    this.prepareEnv(settings, mode, port, dbKey);
    const hostToken = randomBytes(32).toString("base64url");
    this.wipeRestartRequested = false;
    let node: EmbeddedNode;
    try {
      node = await startServer({ hostToken, logStream: deps.log, handleSignals: false });
    } catch (error) {
      if (errorCode(error) === WIPE_RESUME_CODE && this.wipeRestartRequested && isFixedKey(mode)) {
        return "key_clear";
      }
      const failure = mapBootError(error, mode);
      if (failure.kind === "wrong_passphrase") {
        this.passphrase = undefined;
        deps.log.note("warn", "The passphrase didn't open this network's database.");
        this.setPhase(this.lockedPhase(true));
      } else {
        this.fail(failure.error.code, failure.error.detail);
      }
      return "done";
    } finally {
      // The server read the key at boot; nothing a later child process inherits (a browser opened for a
      // link, the file manager) should carry it.
      delete deps.env.LOAM_DB_KEY;
    }

    // The join QR's `#k=` and the client window's pin both need the node's transport key. Only Developer Mode
    // has none, and this launcher always runs the node with NODE_ENV=production, which refuses it: a node
    // without one is not something to hand out.
    if (!node.host.transportPublicKey()) {
      await node.close().catch(() => undefined);
      this.fail("unknown", "The network started without its transport key (Developer Mode?), so it was stopped.");
      return "done";
    }
    if (this.shuttingDown) {
      await node.close().catch(() => undefined);
      return "done";
    }
    this.running = { node, hostToken, port, startedAt: this.now() };
    this.freshKey = false;
    try {
      node.host.setLogLevel(settings.logLevel);
    } catch {
      // A log level is a nicety; a node that refuses it is still running.
    }
    this.setPhase({ phase: "running", node: this.nodeInfo(this.running) });
    this.startPolling();
    deps.onNodeChanged(localOrigin(port));
    return "done";
  }

  /**
   * The port for this start: the host's preference (or 3000), stepping past one another program holds, as
   * `loamnet` does. A saved port this computer won't allow at all (below 1024 without administrator rights)
   * falls back to 3000 rather than stopping every start.
   */
  private async pickPort(settings: DesktopSettings): Promise<number | undefined> {
    const { deps } = this;
    let preferred = settings.port ?? DEFAULT_PORT;
    let port: number | undefined;
    try {
      port = await deps.findFreePort(preferred, LISTEN_HOST);
    } catch (error) {
      if (settings.port === undefined) {
        this.fail("port_unavailable", errorDetail(error));
        return undefined;
      }
      deps.log.note("warn", `Port ${preferred} can't be used here (${errorCode(error) ?? errorDetail(error)}), so LOAM is using ${DEFAULT_PORT} or the next free one.`);
      preferred = DEFAULT_PORT;
      try {
        port = await deps.findFreePort(preferred, LISTEN_HOST);
      } catch (fallbackError) {
        this.fail("port_unavailable", errorDetail(fallbackError));
        return undefined;
      }
    }
    if (port === undefined) {
      this.fail("port_unavailable", `Ports from ${preferred} on are all in use.`);
      return undefined;
    }
    if (port !== preferred) {
      deps.log.note("info", `Port ${preferred} is in use by another program, so LOAM is using ${port} instead.`);
    }
    return port;
  }

  /** Set exactly the env the server reads (apps/server/src/embedded.ts), and nothing left over from the shell. */
  private prepareEnv(settings: DesktopSettings, mode: DbEncryptionMode, port: number, dbKey: string | undefined): void {
    const { env } = this.deps;
    for (const name of LAUNCHER_ENV) {
      delete env[name];
    }
    env.NODE_ENV = "production";
    env.LOAM_DATA_DIR = this.deps.dataDir;
    env.LOAM_CLIENT_DIST = this.deps.clientDist;
    env.PORT = String(port);
    env.HOST = LISTEN_HOST;
    env.LOAM_VERSION = this.deps.version;
    env.LOAM_DB_ENCRYPTION_MODE = mode;
    if (dbKey !== undefined) {
      env.LOAM_DB_KEY = dbKey;
    }
    // A pinned join address is used only while this computer still has it (a laptop moves between networks);
    // otherwise the server picks the best address on every request.
    if (settings.joinHost && this.deps.lanAddresses().includes(settings.joinHost)) {
      env.LOAM_JOIN_HOST = settings.joinHost;
    } else if (settings.joinHost) {
      this.deps.log.note("warn", `The saved join address ${settings.joinHost} isn't on this computer now, so LOAM picks one.`);
    }
  }

  /**
   * Stop the running node. Bounded: one that won't close in time is reported (false), and its close is kept in
   * `closing`, so nothing boots over it; the next operation that needs it gone waits for it again. Quit is
   * bounded on its own (index.ts exits once the wait is over, whatever the node did).
   */
  private async closeNode(): Promise<boolean> {
    this.stopPolling();
    const running = this.running;
    this.running = undefined;
    if (running) {
      const closed = (this.closing ?? Promise.resolve())
        .then(() => running.node.close())
        .catch((error: unknown) => {
          this.deps.log.note("error", `Error while stopping the network: ${errorDetail(error)}`);
        })
        .then(() => {
          if (this.closing === closed) {
            this.closing = undefined;
          }
          // Given up on earlier, and nothing took its place since: it is stopped after all.
          if (this.phase.phase === "failed" && this.phase.error.code === "stop_timeout" && !this.running) {
            this.deps.log.note("info", "The network has stopped.");
            this.setPhase(this.deps.settings.read().network ? { phase: "stopped" } : { phase: "setup" });
          }
        });
      this.closing = closed;
    }
    const closedInTime = await this.awaitClose();
    if (running) {
      this.deps.onNodeChanged(undefined);
    }
    return closedInTime;
  }

  /** Wait, bounded, for a close still in progress. True when there is none, or it finished in time. */
  private async awaitClose(): Promise<boolean> {
    const closing = this.closing;
    if (!closing) {
      return true;
    }
    const timeout = this.deps.closeTimeoutMs ?? CLOSE_TIMEOUT_MS;
    if (await Promise.race([closing.then(() => true), delay(timeout).then(() => false)])) {
      return true;
    }
    this.deps.log.note("error", `The network didn't stop within ${timeout / 1000} s. Nothing can start until it has.`);
    return false;
  }

  // ---- What the host asks for ---------------------------------------------------------------------------------

  /** First run: write the network's starting config and record, then start it. */
  setup(request: SetupRequest): Promise<HostResult<void>> {
    return this.serialize(async () => {
      if (this.phase.phase !== "setup" || this.deps.settings.read().network) {
        return { ok: false, error: "A network is already set up on this computer." };
      }
      if (request.encryption === "persistent" && !this.deps.capabilities.keychain) {
        return { ok: false, error: KEYCHAIN_MISSING };
      }
      if (request.encryption !== "off" && !this.deps.driverLoads()) {
        return { ok: false, error: DRIVER_MISSING };
      }
      // A new network starts from an empty folder and a new secret: nothing of an earlier one carries over.
      const left = emptyDataDir(this.deps.dataDir);
      if (left.length > 0) {
        return { ok: false, error: `Some files in the data folder couldn't be removed: ${left.join(", ")}` };
      }
      this.deps.secrets.destroy();
      this.freshKey = true;
      this.markClientCopyStale();
      await this.discardClientData();
      const nodeName = cleanNodeName(request.nodeName);
      writeInitialConfig(this.deps.dataDir, presetConfig(request.preset, nodeName, "en"));
      // The record is written last: until it is on disk the next launch offers setup again, which empties the
      // folder again, so a crash part-way through leaves nothing half made.
      const settings = this.deps.settings.read();
      this.deps.settings.write({
        ...settings,
        network: { preset: request.preset, nodeName, encryption: request.encryption, createdAt: this.now() },
      });
      this.passphrase = request.encryption === "passphrase" ? request.passphrase : undefined;
      await this.boot();
      return { ok: true, value: undefined };
    });
  }

  /** Open a passphrase network. A wrong passphrase leaves the Unlock screen up, saying so. */
  unlock(request: UnlockRequest): Promise<HostResult<void>> {
    return this.serialize(async () => {
      if (this.phase.phase !== "locked") {
        return { ok: false, error: "The network isn't waiting for its passphrase." };
      }
      this.passphrase = request.passphrase;
      await this.boot();
      return this.phase.phase === "locked" ? { ok: false, error: WRONG_PASSPHRASE } : { ok: true, value: undefined };
    });
  }

  /** Start (or retry) the network. After a reset that couldn't finish, retrying runs the reset again. */
  start(): Promise<HostResult<void>> {
    return this.serialize(async () => {
      if (this.phase.phase === "running" || this.phase.phase === "starting") {
        return { ok: true, value: undefined };
      }
      if (this.running && this.phase.phase === "failed" && this.phase.error.code === "reset_incomplete") {
        this.launcherReset = true;
        const reset = await this.resetNow().finally(() => {
          this.launcherReset = false;
        });
        return reset.ok ? { ok: true, value: undefined } : reset;
      }
      const { network } = this.deps.settings.read();
      if (!network) {
        this.setPhase({ phase: "setup" });
      } else if (network.encryption === "passphrase" && this.passphrase === undefined) {
        this.setPhase(this.lockedPhase(false));
      } else {
        if (!(await this.closeNode())) {
          this.fail("stop_timeout", STOP_TIMEOUT);
          return { ok: false, error: STOP_TIMEOUT };
        }
        await this.boot();
      }
      return { ok: true, value: undefined };
    });
  }

  /** Stop the network. A passphrase network asks for its passphrase again on the next start. */
  stop(): Promise<HostResult<void>> {
    return this.serialize(async () => {
      const closed = await this.closeNode();
      this.passphrase = undefined;
      if (!closed) {
        this.fail("stop_timeout", STOP_TIMEOUT);
        return { ok: false, error: STOP_TIMEOUT };
      }
      this.setPhase(this.deps.settings.read().network ? { phase: "stopped" } : { phase: "setup" });
      return { ok: true, value: undefined };
    });
  }

  /**
   * Discard this network and go back to setup. A running node is reset first, so every joined device is told
   * to purge its copy; then the node stops, its key is destroyed and its folder emptied.
   */
  newNetwork(): Promise<HostResult<void>> {
    return this.serialize(async () => {
      if (this.running) {
        this.launcherReset = true;
        try {
          await this.running.node.host.emergencyReset();
        } catch (error) {
          this.deps.log.note("warn", `The reset before discarding the network failed: ${errorDetail(error)}`);
        } finally {
          this.launcherReset = false;
        }
      }
      const closed = await this.closeNode();
      this.passphrase = undefined;
      if (!closed) {
        // The old node may still hold the folder and the key's database open: nothing is destroyed under it.
        this.fail("stop_timeout", STOP_TIMEOUT);
        return { ok: false, error: STOP_TIMEOUT };
      }
      this.deps.secrets.destroy();
      this.freshKey = true;
      this.markClientCopyStale();
      this.forgetLog("Starting a new network: the old one was erased, and its log with it.");
      await this.discardClientData();
      const left = emptyDataDir(this.deps.dataDir);
      if (left.length > 0) {
        const detail = `Some files in the data folder couldn't be removed: ${left.join(", ")}`;
        this.fail("unknown", detail);
        return { ok: false, error: detail };
      }
      const { network: _discarded, ...rest } = this.deps.settings.read();
      this.deps.settings.write(rest);
      this.setPhase({ phase: "setup" });
      return { ok: true, value: undefined };
    });
  }

  /** Emergency Reset from the host's own screen (no admin session needed, whatever `killSwitch.enabled` says). */
  emergencyReset(): Promise<HostResult<{ complete: boolean; journaled: boolean }>> {
    return this.serialize(async () => {
      this.launcherReset = true;
      try {
        return await this.resetNow();
      } finally {
        this.launcherReset = false;
      }
    });
  }

  /**
   * The reset itself. Three ways it ends, by what the server did:
   * - a fixed-key network: the server deleted every file, proved them gone and called the hook. The launcher
   *   stops the node, destroys the device secret and boots again under a fresh one (docs/02);
   * - in-process (plaintext, ephemeral): done, the node keeps running on an empty database;
   * - incomplete: journaled → a restart finishes it, so restart now; not journaled → the node stays locked
   *   (it answers 503) and the Failed screen's Retry runs the reset again.
   */
  private async resetNow(): Promise<HostResult<{ complete: boolean; journaled: boolean }>> {
    const running = this.running;
    const network = this.deps.settings.read().network;
    if (!running || !network) {
      return { ok: false, error: NOT_RUNNING };
    }
    this.stopPolling();
    this.setPhase({ phase: "resetting" });
    this.wipeRestartRequested = false;
    this.markClientCopyStale();
    let result: { complete: boolean; journaled: boolean };
    try {
      result = await running.node.host.emergencyReset();
    } catch (error) {
      this.deps.log.note("error", `The Emergency Reset failed: ${errorDetail(error)}`);
      result = { complete: false, journaled: false };
    }

    if (this.wipeRestartRequested && isFixedKey(network.encryption)) {
      await this.closeNode();
      await this.completeKeyClearAndBoot();
      return { ok: true, value: { complete: this.phase.phase === "running", journaled: true } };
    }
    if (result.complete) {
      await this.clearClientCopy();
      this.setPhase({ phase: "running", node: this.nodeInfo(running) });
      this.startPolling();
      this.deps.onNodeChanged(localOrigin(running.port));
      return { ok: true, value: result };
    }
    if (result.journaled) {
      this.deps.log.note("warn", "The Emergency Reset didn't finish; restarting the network to finish it.");
      await this.closeNode();
      await this.clearClientCopy();
      await this.boot();
      return { ok: true, value: { complete: this.phase.phase === "running", journaled: true } };
    }
    this.fail("reset_incomplete", "The reset couldn't be recorded on disk, so it must be run again.");
    return { ok: true, value: result };
  }

  /** Change the launcher's settings; the join address and log level apply at once, the port at the next start. */
  updateSettings(update: SettingsUpdate): HostResult<DesktopSettingsView> {
    const settings = this.deps.settings.read();
    if (update.port !== undefined) {
      if (update.port === null) {
        delete settings.port;
      } else {
        settings.port = update.port;
      }
    }
    if (update.joinHost !== undefined) {
      if (update.joinHost === null) {
        delete settings.joinHost;
      } else {
        settings.joinHost = update.joinHost;
      }
    }
    if (update.logLevel !== undefined) {
      settings.logLevel = update.logLevel;
    }
    try {
      this.deps.settings.write(settings);
    } catch (error) {
      return { ok: false, error: `The settings couldn't be saved: ${errorDetail(error)}` };
    }
    if (this.running) {
      try {
        if (update.joinHost !== undefined) {
          this.running.node.host.setJoinHost(update.joinHost ?? undefined);
        }
        if (update.logLevel !== undefined) {
          this.running.node.host.setLogLevel(update.logLevel);
        }
      } catch (error) {
        this.deps.log.note("warn", `A setting couldn't be applied to the running network: ${errorDetail(error)}`);
      }
    }
    this.setPhase(this.phase.phase === "running" && this.running ? { phase: "running", node: this.nodeInfo(this.running) } : this.phase);
    return { ok: true, value: this.view(this.deps.settings.read()) };
  }

  /** The host read "You run this network". */
  acknowledgeHost(): void {
    const settings = this.deps.settings.read();
    if ((settings.hostAck ?? 0) < HOST_ACK_VERSION) {
      this.deps.settings.write({ ...settings, hostAck: HOST_ACK_VERSION });
      this.setPhase(this.phase);
    }
  }

  /** Erase the host client window's storage; a failure is logged, never a reason to keep the old network. */
  private async discardClientData(): Promise<void> {
    try {
      await this.deps.onNetworkDiscarded();
      this.markClientCopyFresh();
    } catch (error) {
      this.deps.log.note("warn", `Couldn't erase the LOAM window's stored copy: ${errorDetail(error)}`);
    }
  }

  /**
   * Stop the node for Quit. Waits its turn behind whatever is running (a boot in progress finishes, then is
   * closed), and nothing boots after it. Never throws; the caller bounds how long it waits.
   */
  shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.stopPolling();
    return this.serialize(async () => {
      await this.closeNode();
    }).catch(() => undefined);
  }

  // ---- The host API, for the People and Settings screens ------------------------------------------------------

  /** Run `call` against the running node's host API; a refusal or a throw comes back as an error, never a crash. */
  private withHost<T>(call: (node: EmbeddedNode) => HostResult<T>): HostResult<T> {
    if (!this.running) {
      return { ok: false, error: NOT_RUNNING };
    }
    try {
      return call(this.running.node);
    } catch (error) {
      this.deps.log.note("error", `The network refused a request from this screen: ${errorDetail(error)}`);
      return { ok: false, error: "That didn't work. The details are in the Activity log." };
    }
  }

  private cleanUser(user: HostUser): HostUser {
    return { ...user, displayName: this.deps.clean(user.displayName) };
  }

  hostConfig(): HostResult<LoamConfig> {
    return this.withHost((node) => ({ ok: true, value: node.host.config() }));
  }

  hostUpdateConfig(update: LoamConfigUpdate): HostResult<LoamConfig> {
    const result = this.withHost((node) => node.host.updateConfig(update));
    this.refresh();
    return result;
  }

  hostUsers(): HostResult<HostUser[]> {
    return this.withHost((node) => ({ ok: true, value: node.host.users().map((user) => this.cleanUser(user)) }));
  }

  hostMakeAdmin(userId: string): HostResult<HostUser> {
    const result = this.withHost((node) => node.host.makeAdmin(userId));
    this.refresh();
    return result.ok ? { ok: true, value: this.cleanUser(result.value) } : result;
  }

  hostAdminClaimCode(): HostResult<HostCode | null> {
    return this.withHost((node) => ({ ok: true, value: node.host.adminClaimCode() }));
  }

  hostRevokeAdminClaimCode(code: string): void {
    this.withHost((node) => {
      node.host.revokeAdminClaimCode(code);
      return { ok: true, value: undefined };
    });
  }

  hostLinkCode(): HostResult<HostCode> {
    return this.withHost((node) => ({ ok: true, value: node.host.linkCode() }));
  }

  hostInvite(): HostResult<HostCode | null> {
    return this.withHost((node) => ({ ok: true, value: node.host.invite() }));
  }
}

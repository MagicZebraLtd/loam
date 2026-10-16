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

/** The address the node listens on: every interface, so phones on the LAN can join. */
export const LISTEN_HOST = "0.0.0.0";
/** The port preferred when the host hasn't picked one. */
export const DEFAULT_PORT = 3000;
/** How often the Running screen's status is refreshed. */
export const STATUS_POLL_MS = 2_000;
/** How long stopping the node may take before the launcher gives up waiting (Quit must not hang). */
export const CLOSE_TIMEOUT_MS = 10_000;
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
  /** Push the state to the host window. */
  onState(state: DesktopState): void;
  /** The node (re)started on `origin`, or an Emergency Reset finished: an open client window must reload. */
  onNodeChanged(origin: string | undefined): void;
  /** The network was discarded (or a new one is being set up): erase what the host's client window stored. */
  onNetworkDiscarded(): Promise<void>;
  now?: () => number;
  pollMs?: number;
  closeTimeoutMs?: number;
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
  private queue: Promise<unknown> = Promise.resolve();
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private lastPushed = "";
  private readonly now: () => number;

  constructor(private readonly deps: ControllerDeps) {
    this.now = deps.now ?? Date.now;
    deps.installWipeRestartHook(() => {
      this.wipeRestartRequested = true;
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

  /**
   * Whether the host's client window keeps its browser storage in memory only: for a network kept only while
   * LOAM runs, a copy of its messages on disk would outlive the key that protects the network (windows.ts).
   */
  clientStorageInMemory(): boolean {
    return this.deps.settings.read().network?.encryption === "ephemeral";
  }

  /** The host token and transport key the client window's preload injects, while the node runs. */
  hostInjection(): { hostToken: string; transportKey?: string } | undefined {
    if (!this.running) {
      return undefined;
    }
    const transportKey = this.running.node.host.transportPublicKey();
    return { hostToken: this.running.hostToken, ...(transportKey ? { transportKey } : {}) };
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
      const { network } = this.deps.settings.read();
      if (!network) {
        this.setPhase({ phase: "setup" });
      } else if (network.encryption === "passphrase" && this.passphrase === undefined) {
        this.setPhase({ phase: "locked", wrongPassphrase: false });
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
    return clearWipePhase(this.deps.dataDir);
  }

  private async bootOnce(): Promise<BootOutcome> {
    const { deps } = this;
    const settings = deps.settings.read();
    const network = settings.network;
    if (!network) {
      this.setPhase({ phase: "setup" });
      return "done";
    }
    this.setPhase({ phase: "starting" });
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
    }

    let dbKey: string | undefined;
    try {
      dbKey = resolveDbKey(mode, deps.secrets, {
        keychain: deps.capabilities.keychain,
        ...(this.passphrase !== undefined ? { passphrase: this.passphrase } : {}),
      });
    } catch (error) {
      if (error instanceof KeyError) {
        if (mode === "passphrase" && this.passphrase === undefined) {
          this.setPhase({ phase: "locked", wrongPassphrase: false });
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
        this.setPhase({ phase: "locked", wrongPassphrase: true });
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
    this.running = { node, hostToken, port, startedAt: this.now() };
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

  /** Stop the running node (bounded: a node that won't close in time is abandoned, not waited on forever). */
  private async closeNode(): Promise<void> {
    this.stopPolling();
    const running = this.running;
    this.running = undefined;
    if (!running) {
      return;
    }
    const timeout = this.deps.closeTimeoutMs ?? CLOSE_TIMEOUT_MS;
    const closed = running.node.close().then(
      () => true,
      (error: unknown) => {
        this.deps.log.note("error", `Error while stopping the network: ${errorDetail(error)}`);
        return true;
      },
    );
    if (!(await Promise.race([closed, delay(timeout).then(() => false)]))) {
      this.deps.log.note("error", `The network didn't stop within ${timeout / 1000} s.`);
    }
    this.deps.onNodeChanged(undefined);
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
        const reset = await this.resetNow();
        return reset.ok ? { ok: true, value: undefined } : reset;
      }
      const { network } = this.deps.settings.read();
      if (!network) {
        this.setPhase({ phase: "setup" });
      } else if (network.encryption === "passphrase" && this.passphrase === undefined) {
        this.setPhase({ phase: "locked", wrongPassphrase: false });
      } else {
        await this.closeNode();
        await this.boot();
      }
      return { ok: true, value: undefined };
    });
  }

  /** Stop the network. A passphrase network asks for its passphrase again on the next start. */
  stop(): Promise<HostResult<void>> {
    return this.serialize(async () => {
      await this.closeNode();
      this.passphrase = undefined;
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
        try {
          await this.running.node.host.emergencyReset();
        } catch (error) {
          this.deps.log.note("warn", `The reset before discarding the network failed: ${errorDetail(error)}`);
        }
      }
      await this.closeNode();
      this.passphrase = undefined;
      this.deps.secrets.destroy();
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
    return this.serialize(() => this.resetNow());
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
    let result: { complete: boolean; journaled: boolean };
    try {
      result = await running.node.host.emergencyReset();
    } catch (error) {
      this.deps.log.note("error", `The Emergency Reset failed: ${errorDetail(error)}`);
      result = { complete: false, journaled: false };
    }

    if (this.wipeRestartRequested && isFixedKey(network.encryption)) {
      await this.closeNode();
      if (!this.finishKeyClear()) {
        this.fail("reset_incomplete", "The reset's journal couldn't be removed from the data folder.");
        return { ok: true, value: { complete: false, journaled: true } };
      }
      await this.boot();
      return { ok: true, value: { complete: this.phase.phase === "running", journaled: true } };
    }
    if (result.complete) {
      this.deps.log.note("warn", "Emergency Reset: every message, person and file on this network was erased.");
      this.setPhase({ phase: "running", node: this.nodeInfo(running) });
      this.startPolling();
      this.deps.onNodeChanged(localOrigin(running.port));
      return { ok: true, value: result };
    }
    if (result.journaled) {
      this.deps.log.note("warn", "The Emergency Reset didn't finish; restarting the network to finish it.");
      await this.closeNode();
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
    } catch (error) {
      this.deps.log.note("warn", `Couldn't erase the LOAM window's stored copy: ${errorDetail(error)}`);
    }
  }

  /** Stop the node for Quit. Bounded by the close timeout, and never throws. */
  async shutdown(): Promise<void> {
    this.stopPolling();
    await this.closeNode().catch(() => undefined);
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

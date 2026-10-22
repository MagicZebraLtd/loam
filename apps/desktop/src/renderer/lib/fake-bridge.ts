/**
 * An in-memory stand-in for `window.loamDesktop`, for working on the screens with plain `vite` in a browser
 * (where there is no main process) and for the renderer's tests. It walks through the same phases the real
 * main process does (setup → starting → running → stopped, a locked passphrase network, a reset) with fake
 * data, and records what it was asked to do. Nothing here talks to a network or a disk.
 */
import type { HostCode, HostResult, HostUser } from "@loam/schema";
import type { LogEntry } from "@loam/tui";

import type {
  DesktopBridge,
  DesktopCapabilities,
  DesktopPhase,
  DesktopSettingsView,
  DesktopState,
  NetworkRecord,
  NodeInfo,
  SettingsUpdate,
  UpdateCheckResult,
} from "../../shared/ipc";
import { RELEASES_PAGE } from "./limits";

/** A transport key shaped like the real one (32 bytes, base64url). */
export const FAKE_TRANSPORT_KEY = "Q2hhbmdlTWVJbkEtUmVhbC1Ob2RlLUtleS0xMjM0NTY";

/** The passphrase the fake refuses, so the "wrong passphrase" path can be seen. */
export const FAKE_WRONG_PASSPHRASE = "wrong";

/** A running node's info, with anything overridden. */
export function sampleNode(overrides: Partial<NodeInfo> = {}): NodeInfo {
  return {
    nodeName: "Riverside",
    version: "0.6.4",
    joinHost: "192.168.1.20",
    port: 3000,
    transportPublicKey: FAKE_TRANSPORT_KEY,
    transportEncryption: "optional",
    dbEncryption: "persistent",
    securityProfile: "standard",
    joinPolicy: "open",
    devMode: false,
    clients: ["192.168.1.31", "192.168.1.44"],
    people: { total: 3, online: 2, pending: 0, admins: 1 },
    quarantined: 0,
    logLevel: "info",
    resets: 0,
    resetting: false,
    joinUrl: `http://192.168.1.20:3000/#k=${FAKE_TRANSPORT_KEY}`,
    addresses: ["192.168.1.20", "10.0.0.5"],
    startedAt: Date.now() - 60_000,
    ...overrides,
  };
}

/** Some people, one of each kind the People screen draws. */
export function sampleUsers(): HostUser[] {
  const now = Date.now();
  return [
    { id: "user.0a1b2c3d4e5f6a7b", displayName: "amber.clay.heron", isAdmin: true, online: true, pending: false, banned: false, createdAt: now - 3_600_000 },
    { id: "user.1b2c3d4e5f6a7b8c", displayName: "Sam", isAdmin: false, online: true, pending: false, banned: false, createdAt: now - 1_800_000 },
    { id: "user.2c3d4e5f6a7b8c9d", displayName: "sam", isAdmin: false, online: false, pending: true, banned: false, createdAt: now - 600_000 },
    { id: "user.3d4e5f6a7b8c9d0e", displayName: "slate.moss.wren", isAdmin: false, online: false, pending: false, banned: true, createdAt: now - 300_000 },
  ];
}

/** A few log lines, one of each kind the Activity screen draws. */
export function sampleLog(): LogEntry[] {
  const now = Date.now();
  return [
    { kind: "message", time: now - 50_000, level: "info", text: "Server listening at http://0.0.0.0:3000" },
    { kind: "request", time: now - 40_000, method: "GET", url: "/api/bootstrap", status: 200, ms: 3.2, remote: "192.168.1.31" },
    { kind: "request", time: now - 30_000, method: "POST", url: "/api/transport/tunnel", status: 200, ms: 14, remote: "192.168.1.31" },
    { kind: "request", time: now - 20_000, method: "GET", url: "/api/missing", status: 404, ms: 1.1, remote: "192.168.1.44" },
    { kind: "message", time: now - 10_000, level: "warn", text: "A sync peer didn't answer" },
  ];
}

export function sampleSettings(overrides: Partial<DesktopSettingsView> = {}): DesktopSettingsView {
  return { logLevel: "info", hostAck: 1, dataDir: "/Users/someone/Library/Application Support/LOAM/node", version: "0.6.4", ...overrides };
}

export function sampleNetwork(overrides: Partial<NetworkRecord> = {}): NetworkRecord {
  return { preset: "community", nodeName: "Riverside", encryption: "persistent", createdAt: Date.now() - 86_400_000, ...overrides };
}

/** A whole state: the phase, plus a network (except in setup) and the settings. */
export function sampleState(phase: DesktopPhase, overrides: Partial<Omit<DesktopState, keyof DesktopPhase>> = {}): DesktopState {
  return {
    ...phase,
    capabilities: { platform: "darwin", keychain: true },
    ...(phase.phase === "setup" ? {} : { network: sampleNetwork() }),
    settings: sampleSettings(),
    ...overrides,
  } as DesktopState;
}

export type FakeBridgeOptions = {
  /** The state to begin in (default: first run, setup). */
  state?: DesktopState;
  capabilities?: Partial<DesktopCapabilities>;
  /** How long "starting" and "resetting" last before the next phase (default 0). */
  delayMs?: number;
  users?: HostUser[];
  log?: LogEntry[];
  update?: UpdateCheckResult;
};

/** The fake, with what it recorded and a way to push a state from outside (as main would). */
export type FakeBridge = DesktopBridge & {
  /** The bridge methods called, in order (`"setup"`, `"host.makeAdmin"`…). */
  readonly calls: string[];
  /** The text of the last `copy`. */
  readonly copied: string | undefined;
  /** The URLs `openExternal` was asked for. */
  readonly opened: string[];
  current(): DesktopState;
  push(state: DesktopState): void;
  emitLog(entry: LogEntry): void;
  /** The main process forgot the log (a reset finished). */
  clearLog(): void;
};

const ok: HostResult<void> = { ok: true, value: undefined };

export function createFakeBridge(options: FakeBridgeOptions = {}): FakeBridge {
  const delay = options.delayMs ?? 0;
  let state: DesktopState = options.state ?? sampleState({ phase: "setup" }, { settings: sampleSettings({ hostAck: undefined }) });
  if (options.capabilities) {
    state = { ...state, capabilities: { ...state.capabilities, ...options.capabilities } };
  }
  let users = options.users ?? sampleUsers();
  let log = options.log ?? [];
  const stateListeners = new Set<(state: DesktopState) => void>();
  const logListeners = new Set<(entry: LogEntry) => void>();
  const logClearedListeners = new Set<() => void>();
  const calls: string[] = [];
  const opened: string[] = [];
  let copied: string | undefined;

  function push(next: DesktopState): void {
    state = next;
    for (const listener of [...stateListeners]) {
      listener(next);
    }
  }

  /** Swap the phase, keeping the capabilities, network and settings. */
  function phase(next: DesktopPhase): void {
    const { capabilities, network, settings } = state;
    push({ ...next, capabilities, settings, ...(network ? { network } : {}) } as DesktopState);
  }

  function nodeFor(): NodeInfo {
    const name = state.network?.nodeName || "LOAM";
    return sampleNode({
      nodeName: name,
      dbEncryption: state.network?.encryption ?? "persistent",
      ...(state.settings.joinHost ? { joinHost: state.settings.joinHost, joinUrl: `http://${state.settings.joinHost}:3000/#k=${FAKE_TRANSPORT_KEY}` } : {}),
      people: {
        total: users.length,
        online: users.filter((user) => user.online).length,
        pending: users.filter((user) => user.pending).length,
        admins: users.filter((user) => user.isAdmin).length,
      },
    });
  }

  /** Go through "starting" to "running" after the delay. */
  function boot(): void {
    phase({ phase: "starting" });
    setTimeout(() => phase({ phase: "running", node: nodeFor() }), delay);
  }

  function record(name: string): void {
    calls.push(name);
  }

  const bridge: FakeBridge = {
    calls,
    opened,
    get copied() {
      return copied;
    },
    current: () => state,
    push,
    emitLog(entry) {
      log = [...log, entry];
      for (const listener of [...logListeners]) {
        listener(entry);
      }
    },
    clearLog() {
      log = [];
      for (const listener of [...logClearedListeners]) {
        listener();
      }
    },
    async getState() {
      record("getState");
      return state;
    },
    async setup(request) {
      record("setup");
      state = {
        ...state,
        network: { preset: request.preset, nodeName: request.nodeName || "LOAM", encryption: request.encryption, createdAt: Date.now() },
      };
      boot();
      return ok;
    },
    async unlock(request) {
      record("unlock");
      // A fresh network takes whatever passphrase it is given: there is nothing old to check it against.
      const fresh = state.phase === "locked" && state.fresh;
      if (!fresh && request.passphrase === FAKE_WRONG_PASSPHRASE) {
        phase({ phase: "locked", wrongPassphrase: true, fresh: false });
        return ok;
      }
      boot();
      return ok;
    },
    async start() {
      record("start");
      if (state.network?.encryption === "passphrase") {
        phase({ phase: "locked", wrongPassphrase: false, fresh: false });
        return ok;
      }
      boot();
      return ok;
    },
    async stop() {
      record("stop");
      phase({ phase: "stopped" });
      return ok;
    },
    async newNetwork() {
      record("newNetwork");
      const { capabilities, settings } = state;
      push({ phase: "setup", capabilities, settings });
      return ok;
    },
    async openClient(request) {
      record(request?.page ? `openClient:${request.page}` : "openClient");
    },
    async copy(text) {
      record("copy");
      copied = text;
    },
    async openExternal(url) {
      record("openExternal");
      opened.push(url);
    },
    async openDataFolder() {
      record("openDataFolder");
    },
    async updateSettings(update: SettingsUpdate) {
      record("updateSettings");
      const settings: DesktopSettingsView = { ...state.settings };
      if (update.port !== undefined) {
        if (update.port === null) delete settings.port;
        else settings.port = update.port;
      }
      if (update.joinHost !== undefined) {
        if (update.joinHost === null) delete settings.joinHost;
        else settings.joinHost = update.joinHost;
      }
      if (update.logLevel) settings.logLevel = update.logLevel;
      push({ ...state, settings });
      return { ok: true, value: settings };
    },
    async acknowledgeHost() {
      record("acknowledgeHost");
      push({ ...state, settings: { ...state.settings, hostAck: 1 } });
    },
    async checkForUpdates() {
      record("checkForUpdates");
      return options.update ?? { ok: true, current: state.settings.version, latest: "0.7.0", newer: true, url: RELEASES_PAGE };
    },
    async log() {
      record("log");
      return log;
    },
    host: {
      async config() {
        record("host.config");
        return { ok: false, error: "Not available in the preview" };
      },
      async updateConfig() {
        record("host.updateConfig");
        return { ok: false, error: "Not available in the preview" };
      },
      async users() {
        record("host.users");
        return state.phase === "running" ? { ok: true, value: users } : { ok: false, error: "The network isn't running" };
      },
      async makeAdmin(userId) {
        record("host.makeAdmin");
        const user = users.find((candidate) => candidate.id === userId);
        if (!user) return { ok: false, error: "No such person" };
        if (user.banned) return { ok: false, error: "A banned person can't be made admin" };
        const promoted = { ...user, isAdmin: true, pending: false };
        users = users.map((candidate) => (candidate.id === userId ? promoted : candidate));
        if (state.phase === "running") phase({ phase: "running", node: nodeFor() });
        return { ok: true, value: promoted };
      },
      async adminClaimCode() {
        record("host.adminClaimCode");
        return { ok: true, value: null };
      },
      async revokeAdminClaimCode() {
        record("host.revokeAdminClaimCode");
      },
      async linkCode() {
        record("host.linkCode");
        const code: HostCode = { code: Math.random().toString(36).slice(2, 10).padEnd(16, "x"), expiresAt: Date.now() + 600_000 };
        return { ok: true, value: code };
      },
      async invite() {
        record("host.invite");
        return { ok: true, value: null };
      },
      async emergencyReset() {
        record("host.emergencyReset");
        phase({ phase: "resetting" });
        users = [];
        setTimeout(() => phase({ phase: "running", node: nodeFor() }), delay);
        return { ok: true, value: { complete: true, journaled: true } };
      },
    },
    onState(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    onLog(listener) {
      logListeners.add(listener);
      return () => logListeners.delete(listener);
    },
    onLogCleared(listener) {
      logClearedListeners.add(listener);
      return () => logClearedListeners.delete(listener);
    },
  };
  return bridge;
}

/**
 * Put the fake on `window.loamDesktop` for a browser preview (no preload there), with a little activity so
 * the screens have something to show. Starts on the setup screen; `?phase=running` (or locked, locked-fresh, failed…)
 * in the address starts elsewhere.
 */
export function installFakeBridge(): FakeBridge {
  const wanted = new URLSearchParams(window.location.search).get("phase");
  const start: Record<string, DesktopState> = {
    running: sampleState({ phase: "running", node: sampleNode() }),
    locked: sampleState({ phase: "locked", wrongPassphrase: false, fresh: false }, { network: sampleNetwork({ encryption: "passphrase" }) }),
    "locked-fresh": sampleState({ phase: "locked", wrongPassphrase: false, fresh: true }, { network: sampleNetwork({ encryption: "passphrase" }) }),
    stopped: sampleState({ phase: "stopped" }),
    failed: sampleState({ phase: "failed", error: { code: "port_in_use", detail: "EADDRINUSE 0.0.0.0:3000" } }),
  };
  const fake = createFakeBridge({ delayMs: 900, log: sampleLog(), ...(wanted && start[wanted] ? { state: start[wanted] } : {}) });
  window.loamDesktop = fake;
  let count = 0;
  window.setInterval(() => {
    if (fake.current().phase === "running") {
      count += 1;
      fake.emitLog({ kind: "request", time: Date.now(), method: "POST", url: "/api/transport/tunnel", status: count % 7 ? 200 : 500, ms: 4 + (count % 5), remote: "192.168.1.31" });
    }
  }, 4_000);
  return fake;
}

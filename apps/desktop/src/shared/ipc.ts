/**
 * The contract between the desktop app's main process and its windows: every channel, what each carries,
 * and the bridge the host-shell preload exposes as `window.loamDesktop`. The main process validates
 * every request it receives against the schemas here before acting (a renderer is a web page, so its
 * input is untrusted), and the renderer never sees anything but these shapes.
 *
 * Shared by `src/main` (handles), `src/preload` (bridge) and `src/renderer` (consumer). Types only at
 * runtime for the renderer: the schemas are used by the main process.
 */
import {
  DbEncryptionModeSchema,
  IdSchema,
  LoamConfigUpdateSchema,
  SETUP_PRESETS,
  type DbEncryptionMode,
  type HostCode,
  type HostLogLevel,
  type HostResult,
  type HostStatus,
  type HostUser,
  type LoamConfig,
  type LoamConfigUpdate,
  type SetupPreset,
} from "@loam/schema";
import type { LogEntry } from "@loam/tui";
import { z } from "zod";

/** IPC channel names. `invoke` channels are request/response; the two `*Event` channels are main → renderer pushes. */
export const IPC = {
  getState: "desktop:getState",
  setup: "desktop:setup",
  unlock: "desktop:unlock",
  start: "desktop:start",
  stop: "desktop:stop",
  newNetwork: "desktop:newNetwork",
  openClient: "desktop:openClient",
  copy: "desktop:copy",
  openExternal: "desktop:openExternal",
  openDataFolder: "desktop:openDataFolder",
  updateSettings: "desktop:updateSettings",
  acknowledgeHost: "desktop:acknowledgeHost",
  checkForUpdates: "desktop:checkForUpdates",
  log: "desktop:log",
  hostConfig: "host:config",
  hostUpdateConfig: "host:updateConfig",
  hostUsers: "host:users",
  hostMakeAdmin: "host:makeAdmin",
  hostAdminClaimCode: "host:adminClaimCode",
  hostRevokeAdminClaimCode: "host:revokeAdminClaimCode",
  hostLinkCode: "host:linkCode",
  hostInvite: "host:invite",
  hostEmergencyReset: "host:emergencyReset",
  /** Pushed whenever the state below changes (and every couple of seconds while running, if the node's status moved). */
  stateEvent: "desktop:state",
  /** Pushed for every new log entry. */
  logEvent: "desktop:logEntry",
  /** Synchronous, answered only to the client window's own preload: the host token + transport key to inject. */
  hostInjection: "desktop:hostInjection",
} as const;

/** Why the node couldn't start or run. Mirrors the Android launcher's catalog where the failure is the same. */
export const DESKTOP_ERROR_CODES = [
  /** The chosen port (a pinned one) is held by another program. */
  "port_in_use",
  /** No free port could be found near the preferred one. */
  "port_unavailable",
  /** Encryption was asked for but the SQLCipher driver didn't load on this computer. */
  "db_encryption_driver_missing",
  /** The database exists but didn't open under the key offered (a wrong passphrase, or a lost device secret). */
  "db_encryption_locked",
  /** The database is unreadable and no recovery applied. */
  "db_unreadable",
  /** The OS keychain isn't available, so a persistent key can't be kept safely. */
  "keychain_unavailable",
  /** The packaged web client is missing (a broken install). */
  "client_missing",
  /** An Emergency Reset didn't finish and couldn't be journaled; the node stays locked until it's run again. */
  "reset_incomplete",
  "unknown",
] as const;
export type DesktopErrorCode = (typeof DESKTOP_ERROR_CODES)[number];

export type DesktopError = {
  code: DesktopErrorCode;
  /** A short English detail for the Activity screen and bug reports, never the only thing shown. */
  detail?: string;
};

export type DesktopPlatform = "darwin" | "win32" | "linux";

/** What this computer can do, decided once at launch. */
export type DesktopCapabilities = {
  platform: DesktopPlatform;
  /** The OS keychain (macOS Keychain, Windows DPAPI, a Linux secret service) can protect a stored key. False on a
   *  Linux desktop with no secret service, where Electron would fall back to writing the key in the clear. */
  keychain: boolean;
};

/** The network this computer set up, kept in desktop.json. */
export type NetworkRecord = {
  preset: SetupPreset;
  nodeName: string;
  encryption: DbEncryptionMode;
  createdAt: number;
};

/** The launcher's own settings (desktop.json), as the Settings screen shows them. */
export type DesktopSettingsView = {
  /** A preferred port; the node steps past it when taken. Absent means 3000. */
  port?: number;
  /** A pinned join address; absent means "pick the best one automatically". */
  joinHost?: string;
  logLevel: HostLogLevel;
  /** The version of the host's "You run this network" note acknowledged, if any (`HOST_ACK_VERSION` in @loam/tui). */
  hostAck?: number;
  /** Where the node keeps its database, media and config. */
  dataDir: string;
  /** The app's version, as the server reports it to clients. */
  version: string;
};

/** The running node, for the Running screen. */
export type NodeInfo = HostStatus & {
  /** The URL joiners open: `http://<joinHost>:<port>/#k=<transport key>` plus `&i=<invite>` on an approval-only node. */
  joinUrl: string;
  /** The node's transport public key (the `#k=` of every QR: join, link-a-node, admin link). */
  transportPublicKey: string;
  /** Every address this computer could be reached on right now (for pinning one). */
  addresses: string[];
  startedAt: number;
};

export type DesktopPhase =
  /** First run: no network has been set up on this computer. */
  | { phase: "setup" }
  /** A passphrase-encrypted network exists and needs its passphrase. */
  | { phase: "locked"; wrongPassphrase: boolean }
  | { phase: "starting" }
  | { phase: "running"; node: NodeInfo }
  /** The host stopped the node; it can be started again. */
  | { phase: "stopped" }
  | { phase: "failed"; error: DesktopError }
  /** An Emergency Reset is running. */
  | { phase: "resetting" };

export type DesktopState = DesktopPhase & {
  capabilities: DesktopCapabilities;
  network?: NetworkRecord;
  settings: DesktopSettingsView;
};

export const MAX_NODE_NAME = 80;
export const MAX_PASSPHRASE = 1024;

export const SetupRequestSchema = z
  .object({
    nodeName: z.string().max(MAX_NODE_NAME),
    preset: z.enum(SETUP_PRESETS as unknown as [SetupPreset, ...SetupPreset[]]),
    encryption: DbEncryptionModeSchema,
    passphrase: z.string().min(1).max(MAX_PASSPHRASE).optional(),
  })
  .refine((request) => (request.encryption === "passphrase") === (request.passphrase !== undefined), {
    message: "A passphrase is required exactly when encryption is 'passphrase'.",
  });
export type SetupRequest = z.infer<typeof SetupRequestSchema>;

export const UnlockRequestSchema = z.object({ passphrase: z.string().min(1).max(MAX_PASSPHRASE) });
export type UnlockRequest = z.infer<typeof UnlockRequestSchema>;

/** An IPv4 literal or a DNS name (what the server's host allowlist and the join QR accept). */
export const JoinHostSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(/^(?:\d{1,3}(?:\.\d{1,3}){3}|[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)$/);

/** `null` clears a setting (back to the default); a left-out field is unchanged. */
export const SettingsUpdateSchema = z.object({
  port: z.number().int().min(1).max(65535).nullable().optional(),
  joinHost: JoinHostSchema.nullable().optional(),
  logLevel: z.enum(["info", "debug"]).optional(),
});
export type SettingsUpdate = z.infer<typeof SettingsUpdateSchema>;

export const CopyRequestSchema = z.object({ text: z.string().max(4096) });
export const OpenExternalRequestSchema = z.object({ url: z.string().url().max(2048) });
export const MakeAdminRequestSchema = z.object({ userId: IdSchema });
export const RevokeCodeRequestSchema = z.object({ code: z.string().max(128) });
export const UpdateConfigRequestSchema = LoamConfigUpdateSchema;

/** The tap-only "Check for updates" answer (GitHub's latest release; nothing is downloaded). */
export type UpdateCheckResult =
  | { ok: true; current: string; latest: string; newer: boolean; url: string }
  | { ok: false; error: "offline" | "timeout" | "bad_response" };

/** What the host-shell preload exposes as `window.loamDesktop`. */
export type DesktopBridge = {
  getState(): Promise<DesktopState>;
  setup(request: SetupRequest): Promise<HostResult<void>>;
  unlock(request: UnlockRequest): Promise<HostResult<void>>;
  start(): Promise<HostResult<void>>;
  stop(): Promise<HostResult<void>>;
  /** Discard this network (an Emergency Reset if it's running, its data otherwise) and go back to setup. */
  newNetwork(): Promise<HostResult<void>>;
  /** Open (or focus) the web client in its own window, as the host: admin from the first page. */
  openClient(): Promise<void>;
  copy(text: string): Promise<void>;
  /** Open a web page in the computer's browser. The main process allows only http(s) pages it knows. */
  openExternal(url: string): Promise<void>;
  openDataFolder(): Promise<void>;
  updateSettings(update: SettingsUpdate): Promise<HostResult<DesktopSettingsView>>;
  acknowledgeHost(): Promise<void>;
  checkForUpdates(): Promise<UpdateCheckResult>;
  /** The log so far (newest last); later entries arrive through `onLog`. */
  log(): Promise<LogEntry[]>;
  host: {
    config(): Promise<HostResult<LoamConfig>>;
    updateConfig(update: LoamConfigUpdate): Promise<HostResult<LoamConfig>>;
    users(): Promise<HostResult<HostUser[]>>;
    makeAdmin(userId: string): Promise<HostResult<HostUser>>;
    adminClaimCode(): Promise<HostResult<HostCode | null>>;
    revokeAdminClaimCode(code: string): Promise<void>;
    linkCode(): Promise<HostResult<HostCode>>;
    invite(): Promise<HostResult<HostCode | null>>;
    emergencyReset(): Promise<HostResult<{ complete: boolean; journaled: boolean }>>;
  };
  /** Subscribe to state pushes; returns the unsubscribe. */
  onState(listener: (state: DesktopState) => void): () => void;
  onLog(listener: (entry: LogEntry) => void): () => void;
};

declare global {
  interface Window {
    loamDesktop: DesktopBridge;
  }
}

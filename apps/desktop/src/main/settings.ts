/**
 * The launcher's own settings: `desktop.json` in Electron's userData folder, beside (never inside) the node's
 * data folder. It records the network this computer set up and the host's choices that apply before the
 * server exists (the port, the join address, the log level, the host note acknowledged). Never a key: the
 * device secret lives in its own keychain-protected file (keys.ts) and a passphrase is never stored.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { DbEncryptionModeSchema, SETUP_PRESETS, type HostLogLevel, type SetupPreset } from "@loam/schema";
import { z } from "zod";

import { JoinHostSchema, MAX_NODE_NAME, type DesktopSettingsView, type NetworkRecord } from "../shared/ipc.js";

export type DesktopSettings = {
  network?: NetworkRecord;
  port?: number;
  joinHost?: string;
  logLevel: HostLogLevel;
  hostAck?: number;
};

export const SETTINGS_FILE = "desktop.json";

/**
 * The version of the host's "You run this network" note. The same note, and the same number, as the terminal
 * UI's `HOST_ACK_VERSION` (packages/tui/src/app.ts), which @loam/tui doesn't export: bump both together.
 */
export const HOST_ACK_VERSION = 1;

const NetworkRecordSchema = z.object({
  preset: z.enum(SETUP_PRESETS as unknown as [SetupPreset, ...SetupPreset[]]),
  nodeName: z.string().min(1).max(MAX_NODE_NAME),
  encryption: DbEncryptionModeSchema,
  createdAt: z.number().int().nonnegative(),
});

/**
 * Keep only well-formed fields: the file can be edited by hand, and a bad port must not lose the network record
 * with it. A malformed network record is dropped, which sends the host back to setup rather than booting a
 * network under a guessed encryption mode.
 */
export function parseSettings(raw: unknown): DesktopSettings {
  const settings: DesktopSettings = { logLevel: "info" };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return settings;
  }
  const value = raw as Record<string, unknown>;
  const network = NetworkRecordSchema.safeParse(value.network);
  if (network.success) {
    settings.network = network.data;
  }
  if (typeof value.port === "number" && Number.isInteger(value.port) && value.port >= 1 && value.port <= 65535) {
    settings.port = value.port;
  }
  const joinHost = JoinHostSchema.safeParse(value.joinHost);
  if (joinHost.success) {
    settings.joinHost = joinHost.data;
  }
  if (value.logLevel === "debug") {
    settings.logLevel = "debug";
  }
  if (typeof value.hostAck === "number" && Number.isInteger(value.hostAck) && value.hostAck >= 1) {
    settings.hostAck = value.hostAck;
  }
  return settings;
}

/** What the Settings screen shows. */
export function settingsView(settings: DesktopSettings, dataDir: string, version: string): DesktopSettingsView {
  return {
    ...(settings.port !== undefined ? { port: settings.port } : {}),
    ...(settings.joinHost !== undefined ? { joinHost: settings.joinHost } : {}),
    logLevel: settings.logLevel,
    ...(settings.hostAck !== undefined ? { hostAck: settings.hostAck } : {}),
    dataDir,
    version,
  };
}

/** Reads and writes desktop.json. A file the tests can point at a temporary folder. */
export type SettingsStore = {
  read(): DesktopSettings;
  write(settings: DesktopSettings): void;
};

/** desktop.json in `userData`: read tolerantly, written beside the file and renamed over it. */
export function fileSettingsStore(userData: string): SettingsStore {
  const path = join(userData, SETTINGS_FILE);
  return {
    read() {
      try {
        return parseSettings(JSON.parse(readFileSync(path, "utf8")));
      } catch {
        return parseSettings(undefined);
      }
    },
    write(settings) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.tmp`;
      // A leftover temporary file would keep its old permissions (`mode` only applies to a new file).
      rmSync(temporary, { force: true });
      writeFileSync(temporary, `${JSON.stringify(parseSettings(settings), null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, path);
    },
  };
}

/** An in-memory store, for tests and the smoke run. */
export function memorySettingsStore(initial: DesktopSettings = { logLevel: "info" }): SettingsStore {
  let current = parseSettings(initial);
  return {
    read: () => structuredClone(current),
    write(settings) {
      current = parseSettings(settings);
    },
  };
}

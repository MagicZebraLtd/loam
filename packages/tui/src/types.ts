import type { HostApi, HostStatus } from "@loam/schema";

import type { Line } from "./ansi.js";
import type { Key } from "./keys.js";
import type { LogBook, LogEntry } from "./log.js";
import type { Modal } from "./modal.js";
import type { CliSettings } from "./settings.js";
import type { System } from "./system.js";
import type { Terminal } from "./terminal.js";

/** Facts about the launch that the server doesn't know, for the Debug screen. */
export type LaunchInfo = {
  dataDir: string;
  nodeVersion: string;
  platform: string;
  /** "node:sqlite", or "SQLCipher" for an encrypted database. */
  databaseDriver: string;
  /**
   * The address and port the server listens on (`HOST`, `PORT`). Links that open LOAM on this computer use
   * them: the port in the status is the one advertised to joiners, which `CLIENT_PORT` can set apart.
   */
  listenHost: string;
  listenPort: number;
};

export type TuiOptions = {
  host: HostApi;
  log: LogBook;
  terminal: Terminal;
  system: System;
  launch: LaunchInfo;
  /** The saved startup settings (cli.json), and how to save new ones. */
  settings: CliSettings;
  saveSettings(next: CliSettings): void;
  /** Write a file (the diagnostics report); a parameter so tests write nowhere. */
  writeFile(path: string, contents: string): void;
  /** Start locked in kiosk mode (`--kiosk`, or "start locked" saved in cli.json). */
  startLocked?: boolean;
  /** Stop the node and exit. */
  quit(): void | Promise<void>;
  now?: () => number;
};

export type ScreenId = "join" | "activity" | "people" | "settings" | "debug";

/** Per-screen UI state that survives switching screens. */
export type ScreenState = {
  qrHidden: boolean;
  /** `frozen` holds what was on screen when the list was paused. `scroll` counts rows up from the newest. */
  activity: { errorsOnly: boolean; frozen?: readonly LogEntry[]; scroll: number };
  people: { selected: number };
  settings: { selected: number };
};

/** What a screen sees and can do. */
export type View = {
  options: TuiOptions;
  status: HostStatus;
  /** The screen showing now, and the dialog over it, if any (an async step checks both before it opens one). */
  readonly screen: ScreenId;
  readonly modal: Modal | undefined;
  state: ScreenState;
  settings: CliSettings;
  now(): number;
  open(modal: Modal): void;
  toast(message: string, tone?: "ok" | "error"): void;
  redraw(): void;
  /** `http://<join address>:<port>`. */
  joinUrl(): string;
  /** What the join QR encodes: the join URL with the node key, and the invite on an approval-only node. */
  joinLink(): string;
  /** `http://127.0.0.1:<listen port>`, or the one address the server listens on (local-link.ts). */
  localUrl(): string;
  /** Save the startup settings; false (and an error shown) when they couldn't be written. */
  saveSettings(next: CliSettings): boolean;
  lockKiosk(): void;
};

export type Screen = {
  id: ScreenId;
  title: string;
  /** The key hints shown on the bottom row. */
  hints(view: View): string;
  render(view: View, width: number, height: number): Line[];
  /** Handle a key; return false to let the global keys (screens, help, quit) have it. */
  key(view: View, key: Key): boolean;
};

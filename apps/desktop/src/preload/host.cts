/**
 * The host shell's preload: `window.loamDesktop`, the DesktopBridge from src/shared/ipc.ts, over ipcRenderer.
 * Sandboxed (CommonJS, `electron` is the only module it may load), so it carries no code from the contract but
 * the channel names, re-declared here and checked against the contract's `IPC` by the compiler: a renamed or
 * missing channel fails the typecheck. The page gets these functions and nothing else of Electron.
 */
import type { IpcRendererEvent } from "electron";
import electron = require("electron");

import type { DesktopBridge, DesktopState, IPC as IpcChannels } from "../shared/ipc.js";
import type { LogEntry } from "@loam/tui";

const IPC: typeof IpcChannels = {
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
  stateEvent: "desktop:state",
  logEvent: "desktop:logEntry",
  logClearedEvent: "desktop:logCleared",
  hostInjection: "desktop:hostInjection",
};

const { contextBridge, ipcRenderer } = electron;

/** Ask the main process on `channel`; the answer's type is the bridge method's. */
function invoke<T>(channel: string, payload?: unknown): Promise<T> {
  return ipcRenderer.invoke(channel, payload) as Promise<T>;
}

/** Subscribe `listener` to a push channel, handing it only the payload (never the Electron event). */
function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, value: T): void => listener(value);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

const bridge: DesktopBridge = {
  getState: () => invoke(IPC.getState),
  setup: (request) => invoke(IPC.setup, request),
  unlock: (request) => invoke(IPC.unlock, request),
  start: () => invoke(IPC.start),
  stop: () => invoke(IPC.stop),
  newNetwork: () => invoke(IPC.newNetwork),
  openClient: (request) => invoke(IPC.openClient, request ?? {}),
  copy: (text) => invoke(IPC.copy, { text }),
  openExternal: (url) => invoke(IPC.openExternal, { url }),
  openDataFolder: () => invoke(IPC.openDataFolder),
  updateSettings: (update) => invoke(IPC.updateSettings, update),
  acknowledgeHost: () => invoke(IPC.acknowledgeHost),
  checkForUpdates: () => invoke(IPC.checkForUpdates),
  log: () => invoke(IPC.log),
  host: {
    config: () => invoke(IPC.hostConfig),
    updateConfig: (update) => invoke(IPC.hostUpdateConfig, update),
    users: () => invoke(IPC.hostUsers),
    makeAdmin: (userId) => invoke(IPC.hostMakeAdmin, { userId }),
    adminClaimCode: () => invoke(IPC.hostAdminClaimCode),
    revokeAdminClaimCode: (code) => invoke(IPC.hostRevokeAdminClaimCode, { code }),
    linkCode: () => invoke(IPC.hostLinkCode),
    invite: () => invoke(IPC.hostInvite),
    emergencyReset: () => invoke(IPC.hostEmergencyReset),
  },
  onState: (listener) => subscribe<DesktopState>(IPC.stateEvent, listener),
  onLog: (listener) => subscribe<LogEntry>(IPC.logEvent, listener),
  onLogCleared: (listener) => subscribe<undefined>(IPC.logClearedEvent, () => listener()),
};

contextBridge.exposeInMainWorld("loamDesktop", bridge);

/**
 * The client window's preload: before the web client's own scripts run, ask the main process (synchronously)
 * for this boot's host token and the node's transport key, and put them where the client looks for them
 * (`window.__loamHostDeviceToken`, `window.__loamHostTransportKey`: apps/client/src/app.tsx and
 * lib/transport.ts, the same injection the Android host's WebView gets). The main process answers only this
 * window's top frame while it shows the node's loopback origin; anywhere else the answer is null and nothing
 * is exposed. Never put in a URL: anyone could craft one.
 */
import electron = require("electron");

import type { IPC as IpcChannels } from "../shared/ipc.js";

/** The one channel this preload uses, checked against the contract by the compiler. */
const HOST_INJECTION: (typeof IpcChannels)["hostInjection"] = "desktop:hostInjection";

const { contextBridge, ipcRenderer } = electron;

/** What the main process hands over, if it hands over anything. */
type Injection = { hostToken: string; transportKey?: string };

/** The answer, accepted only in the expected shape. */
function readInjection(value: unknown): Injection | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const { hostToken, transportKey } = value as { hostToken?: unknown; transportKey?: unknown };
  if (typeof hostToken !== "string" || hostToken.length === 0) {
    return undefined;
  }
  return typeof transportKey === "string" && transportKey.length > 0 ? { hostToken, transportKey } : { hostToken };
}

const injection = readInjection(ipcRenderer.sendSync(HOST_INJECTION));
if (injection) {
  contextBridge.exposeInMainWorld("__loamHostDeviceToken", injection.hostToken);
  if (injection.transportKey) {
    contextBridge.exposeInMainWorld("__loamHostTransportKey", injection.transportKey);
  }
}

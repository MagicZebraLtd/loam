/**
 * The two windows. The host window is the launcher's own screen (dist/renderer, from file://, talking to this
 * process only through the host preload's bridge); the client window is the web client served by the node on
 * loopback, opened as the host: its preload injects the per-boot host token and the node's transport key, so the
 * host is admin from the first page without any link that could be copied.
 *
 * Both are sandboxed with context isolation and no Node. Neither may navigate anywhere else or open windows:
 * links to the web go to the computer's browser, everything else is refused.
 */
import { existsSync } from "node:fs";

import type { LogEntry } from "@loam/tui";
import { app, BrowserWindow, nativeImage, session, shell, type Session, type WebContents } from "electron";

import { IPC, type DesktopState } from "../shared/ipc.js";
import { isWebUrl } from "./external-links.js";
import { appPaths } from "./paths.js";
import { strings } from "./strings.js";
import { CLIENT_PARTITIONS, clientPartition as partitionFor, navigationDecision } from "./trust.js";

/** The only permission a page gets: writing to the clipboard (the client's "Copy" buttons). */
const ALLOWED_PERMISSION = "clipboard-sanitized-write";

/** Open `url` in the computer's browser if it is a web page; anything else is dropped. */
function openInBrowser(url: string): void {
  if (isWebUrl(url)) {
    void shell.openExternal(url);
  }
}

/** A page shown in place of a host shell this install doesn't have (a broken install, or dev before a renderer build). */
function missingRendererPage(): string {
  const html = `<!doctype html><meta charset="utf-8"><title>${strings.rendererMissingTitle}</title>
<body style="font: 15px system-ui; padding: 32px; color: CanvasText; background: Canvas">${strings.rendererMissing}</body>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

export type WindowManager = {
  showHost(): void;
  /** True when `contents` is the host window's page. */
  isHost(contents: WebContents): boolean;
  /** True when `contents` is the client window's page. */
  isClient(contents: WebContents): boolean;
  sendState(state: DesktopState): void;
  sendLog(entry: LogEntry): void;
  /** The log was forgotten (a reset finished): the Activity screen drops what it shows. */
  sendLogCleared(): void;
  /** Open (or focus) the client window on `origin`; `inMemory` keeps its storage off the disk. */
  openClient(origin: string, inMemory: boolean): void;
  /** The network was discarded: close the client window and erase what it stored. */
  discardClient(): Promise<void>;
  /** An Emergency Reset erased the network: erase the client window's copy too (the window stays; it reloads). */
  clearClientData(): Promise<void>;
  /** The node moved (a new boot, a reset) or stopped: reload or close the client window to match. */
  nodeChanged(origin: string | undefined): void;
  /** From now on, closing the host window really closes it (Quit). */
  setQuitting(): void;
};

/** Create the window manager. Call once, after `app` is ready and before any window exists. */
export function createWindowManager(options: { icon: string | undefined }): WindowManager {
  let host: BrowserWindow | undefined;
  let client: BrowserWindow | undefined;
  let clientOrigin: string | undefined;
  let quitting = false;
  const icon = options.icon && existsSync(options.icon) ? nativeImage.createFromPath(options.icon) : undefined;

  let clientPartition: string | undefined;

  /** One permission (clipboard writes), nothing else, in every session a page of this app uses. */
  function harden(target: Session): Session {
    target.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === ALLOWED_PERMISSION));
    target.setPermissionCheckHandler((_contents, permission) => permission === ALLOWED_PERMISSION);
    return target;
  }
  harden(session.defaultSession);
  // The client window's sessions are created here, first, with no HTTP cache: the node is on loopback, so a
  // cache buys nothing, and in `optional` transport mode it would keep pictures and files served in the clear
  // on the disk, outside the database's key (trust.ts). A later lookup by partition name finds these sessions.
  harden(session.fromPartition(CLIENT_PARTITIONS.kept, { cache: false }));
  harden(session.fromPartition(CLIENT_PARTITIONS.memory, { cache: false }));

  // Every page this app creates, whichever window it's in: no new windows, no navigation away.
  app.on("web-contents-created", (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      openInBrowser(url);
      return { action: "deny" };
    });
    contents.on("will-attach-webview", (event) => event.preventDefault());
    // The client window stays on the node it was opened for; the host shell is one page and never navigates.
    const guard = (event: { preventDefault(): void }, url: string): void => {
      const isClientWindow = client !== undefined && !client.isDestroyed() && contents === client.webContents;
      const decision = navigationDecision(url, { isClientWindow, clientOrigin });
      if (decision === "allow") {
        return;
      }
      event.preventDefault();
      if (decision === "open-in-browser") {
        openInBrowser(url);
      }
    };
    contents.on("will-navigate", guard);
    contents.on("will-redirect", guard);
  });

  const webPreferences = (preload: string, partition?: string) => ({
    preload,
    ...(partition ? { partition } : {}),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webviewTag: false,
    spellcheck: false,
  });

  /** Erase what the client window stored, in both partitions (the network may have changed kind). */
  async function clearClientStorage(): Promise<void> {
    for (const name of Object.values(CLIENT_PARTITIONS)) {
      await session.fromPartition(name).clearStorageData();
      await session.fromPartition(name).clearCache();
    }
  }

  function createHost(): BrowserWindow {
    const window = new BrowserWindow({
      width: 960,
      height: 760,
      minWidth: 360,
      minHeight: 480,
      show: false,
      title: strings.appName,
      ...(icon && process.platform === "linux" ? { icon } : {}),
      webPreferences: webPreferences(appPaths.hostPreload),
    });
    window.once("ready-to-show", () => window.show());
    // Closing the window keeps the network running (the tray, and the dock on macOS, bring it back); only
    // Quit stops it.
    window.on("close", (event) => {
      if (!quitting) {
        event.preventDefault();
        window.hide();
      }
    });
    window.on("closed", () => {
      host = undefined;
    });
    if (existsSync(appPaths.rendererIndex)) {
      void window.loadFile(appPaths.rendererIndex);
    } else {
      void window.loadURL(missingRendererPage());
    }
    return window;
  }

  function createClient(origin: string, partition: string): BrowserWindow {
    const window = new BrowserWindow({
      width: 1100,
      height: 820,
      minWidth: 360,
      minHeight: 480,
      title: strings.appName,
      ...(icon && process.platform === "linux" ? { icon } : {}),
      webPreferences: webPreferences(appPaths.clientPreload, partition),
    });
    window.on("closed", () => {
      client = undefined;
    });
    void window.loadURL(`${origin}/`);
    return window;
  }

  return {
    showHost() {
      host ??= createHost();
      if (host.isMinimized()) {
        host.restore();
      }
      host.show();
      host.focus();
    },
    isHost: (contents) => host !== undefined && !host.isDestroyed() && contents === host.webContents,
    isClient: (contents) => client !== undefined && !client.isDestroyed() && contents === client.webContents,
    sendState(state) {
      if (host && !host.isDestroyed()) {
        host.webContents.send(IPC.stateEvent, state);
      }
    },
    sendLog(entry) {
      if (host && !host.isDestroyed()) {
        host.webContents.send(IPC.logEvent, entry);
      }
    },
    sendLogCleared() {
      if (host && !host.isDestroyed()) {
        host.webContents.send(IPC.logClearedEvent);
      }
    },
    openClient(origin, inMemory) {
      const partition = partitionFor(inMemory);
      // A window on the other kind of storage (the network changed) is replaced, never reused.
      if (client && !client.isDestroyed() && clientPartition !== partition) {
        client.destroy();
        client = undefined;
      }
      clientPartition = partition;
      if (client && !client.isDestroyed()) {
        if (clientOrigin !== origin) {
          clientOrigin = origin;
          void client.loadURL(`${origin}/`);
        }
        if (client.isMinimized()) {
          client.restore();
        }
        client.show();
        client.focus();
        return;
      }
      clientOrigin = origin;
      client = createClient(origin, partition);
    },
    async discardClient() {
      if (client && !client.isDestroyed()) {
        client.destroy();
      }
      client = undefined;
      clientOrigin = undefined;
      await clearClientStorage();
    },
    clearClientData: () => clearClientStorage(),
    nodeChanged(origin) {
      clientOrigin = origin ?? clientOrigin;
      if (!client || client.isDestroyed()) {
        return;
      }
      if (origin === undefined) {
        // The node stopped; the page stays (it shows the client's own "can't reach" state) until it is back.
        return;
      }
      // A new boot means a new host token (and maybe a new port or key): load the page again so the preload
      // injects what this boot's node accepts.
      void client.loadURL(`${origin}/`);
    },
    setQuitting() {
      quitting = true;
    },
  };
}

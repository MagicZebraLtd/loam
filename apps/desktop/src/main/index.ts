/**
 * The desktop app's main process: the launcher for a LOAM network on this computer. It runs the embedded
 * server in this process (the server bundle, dist/main/loam-server.js), keeps the network's key in the OS
 * keychain, and shows two windows: the host shell (setup, the join QR, People, Settings, Activity) and, on
 * request, the web client opened as the host. Joiners use their own browsers; nothing here phones home.
 *
 * `--smoke` runs the headless boot check instead (smoke.ts).
 */
import { join } from "node:path";

import { clean, createLogBook } from "@loam/tui";
import { app, safeStorage } from "electron";

import type { DesktopPlatform } from "../shared/ipc.js";
import { encryptedDriverLoads } from "./driver.js";
import { registerIpc } from "./ipc.js";
import { lanAddresses } from "./join-url.js";
import { fileDeviceSecretStore, keychainProtects } from "./keys.js";
import { createLogFeed } from "./log-feed.js";
import { CLOSE_TIMEOUT_MS, NodeController } from "./node-controller.js";
import { appPaths, nodeDataDir } from "./paths.js";
import { findFreePort } from "./port.js";
import { loadServerModule } from "./server-module.js";
import { fileSettingsStore } from "./settings.js";
import { runSmoke } from "./smoke.js";
import { createTray, installAppMenu, type TrayHandle } from "./tray.js";
import { createWindowManager } from "./windows.js";

// Before the server bundle is ever imported (it is imported lazily, at the first boot): the shipped app must
// refuse Developer Mode, exactly as the Android host does (apps/server/src/embedded-main.ts).
process.env.NODE_ENV = "production";

// The app's name, and so its folder and its keychain item ("LOAM Safe Storage"), is LOAM, not the workspace
// package's name. A development run (`electron .`) keeps its own folder, so it never touches a real network.
app.setName("LOAM");
app.setPath("userData", join(app.getPath("appData"), app.isPackaged ? "LOAM" : "LOAM (development)"));

/** The server's fixed-key Emergency Reset hook (apps/server/src/store-lifecycle.ts `wipeRestartHook`). */
type WipeRestartGlobal = { __loamRequestWipeRestart?: () => void };

/** Resolve after `ms`. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The normal run: one instance, a tray icon, the host window, the network started if one is set up. */
async function runApp(): Promise<void> {
  // One launcher per computer user: a second launch (a double click on the icon again) shows this one's window.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  if (process.platform === "win32") {
    app.setAppUserModelId("com.loamnet.desktop");
  }

  await app.whenReady();

  const platform = process.platform as DesktopPlatform;
  const userData = app.getPath("userData");
  const dataDir = nodeDataDir(userData);
  const version = app.getVersion();
  const log = createLogFeed(createLogBook(), clean);
  const windows = createWindowManager({ icon: appPaths.icon });
  let tray: TrayHandle | undefined;

  const controller = new NodeController({
    capabilities: { platform, keychain: keychainProtects(safeStorage, platform) },
    version,
    dataDir,
    clientDist: appPaths.clientDist,
    settings: fileSettingsStore(userData),
    secrets: fileDeviceSecretStore(userData, safeStorage),
    loadServer: async () => (await loadServerModule()).startEmbeddedServer,
    driverLoads: () => encryptedDriverLoads(appPaths.serverBundle),
    log,
    clean,
    findFreePort,
    lanAddresses,
    env: process.env,
    installWipeRestartHook: (hook) => {
      (globalThis as WipeRestartGlobal).__loamRequestWipeRestart = hook;
    },
    onState: (state) => {
      windows.sendState(state);
      tray?.update(state);
    },
    onNodeChanged: (origin) => windows.nodeChanged(origin),
    onNetworkDiscarded: () => windows.discardClient(),
  });
  log.setListener((entry) => windows.sendLog(entry));

  registerIpc({ controller, windows, log, version, dataDir, lanAddresses });
  installAppMenu();
  tray = createTray(appPaths.icon, {
    showHost: () => windows.showHost(),
    openClient: () => {
      const origin = controller.localOrigin();
      if (origin) {
        windows.openClient(origin, controller.clientStorageInMemory());
      }
    },
  });
  tray.update(controller.getState());

  app.on("second-instance", () => windows.showHost());
  // macOS: clicking the dock icon brings the window back.
  app.on("activate", () => windows.showHost());
  // Closing every window leaves the network running (the tray brings the window back): only Quit stops it.
  app.on("window-all-closed", () => undefined);

  let stopped = false;
  let stopping = false;
  app.on("before-quit", (event) => {
    windows.setQuitting();
    if (stopped) {
      return;
    }
    event.preventDefault();
    if (stopping) {
      return;
    }
    stopping = true;
    void Promise.race([controller.shutdown(), delay(CLOSE_TIMEOUT_MS)]).finally(() => {
      stopped = true;
      app.quit();
    });
  });

  windows.showHost();
  await controller.initialize();
}

if (process.argv.includes("--smoke")) {
  void runSmoke();
} else {
  runApp().catch((error: unknown) => {
    console.error("LOAM couldn't start:", error);
    app.exit(1);
  });
}

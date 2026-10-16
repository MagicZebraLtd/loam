/**
 * The tray icon (the menu bar on macOS): how the host gets the window back after closing it, since closing the
 * window leaves the network running. Its menu shows the window, opens LOAM as the host while the network runs,
 * and quits (which stops the network).
 */
import { existsSync } from "node:fs";

import { app, Menu, nativeImage, Tray, type NativeImage } from "electron";

import type { DesktopState } from "../shared/ipc.js";
import { strings } from "./strings.js";

export type TrayActions = {
  showHost(): void;
  openClient(): void;
};

export type TrayHandle = {
  /** Match the menu and tooltip to the state (Open LOAM only while running). */
  update(state: DesktopState): void;
};

/** The tray icon at the size each platform's tray draws. */
function trayImage(iconPath: string): NativeImage {
  if (!existsSync(iconPath)) {
    return nativeImage.createEmpty();
  }
  const size = process.platform === "darwin" ? 18 : process.platform === "win32" ? 16 : 24;
  return nativeImage.createFromPath(iconPath).resize({ width: size, height: size, quality: "best" });
}

export function createTray(iconPath: string, actions: TrayActions): TrayHandle {
  const tray = new Tray(trayImage(iconPath));
  tray.setToolTip(strings.trayTooltip);
  // On Windows and Linux a click on the icon is the usual way back to the window.
  if (process.platform !== "darwin") {
    tray.on("click", () => actions.showHost());
  }

  let lastKey = "";
  function update(state: DesktopState): void {
    const running = state.phase === "running";
    const tooltip = running ? strings.trayTooltipRunning(state.node.nodeName, state.node.clients.length) : strings.trayTooltip;
    const key = `${running}|${tooltip}`;
    if (key === lastKey) {
      return;
    }
    lastKey = key;
    tray.setToolTip(tooltip);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: strings.trayShow, click: () => actions.showHost() },
        { label: strings.trayOpenClient, enabled: running, click: () => actions.openClient() },
        { type: "separator" },
        { label: strings.trayQuit, click: () => app.quit() },
      ]),
    );
  }

  return { update };
}

/**
 * The application menu. macOS needs one for the Edit shortcuts (copy and paste in a text field) to work at
 * all; Windows and Linux get none, so there is no menu bar and no developer-tools shortcut in the shipped app.
 */
export function installAppMenu(): void {
  if (process.platform === "darwin") {
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }]));
  } else {
    Menu.setApplicationMenu(null);
  }
}

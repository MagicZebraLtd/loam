/**
 * The few words the main process shows itself (the tray menu, the app menu, a page for a broken install).
 * English only for now, like the renderer's strings.ts, and kept in one table so translation is a one-file job.
 * No em-dashes (the house rule for user-facing copy).
 */
export const strings = {
  appName: "LOAM",
  trayTooltip: "LOAM",
  trayTooltipRunning: (nodeName: string, devices: number) =>
    `LOAM: ${nodeName}, ${devices === 1 ? "1 device connected" : `${devices} devices connected`}`,
  trayShow: "Show LOAM",
  trayOpenClient: "Open LOAM",
  trayQuit: "Quit LOAM",
  rendererMissingTitle: "LOAM",
  rendererMissing: "This copy of LOAM is incomplete: its window couldn't be found. Reinstall LOAM.",
} as const;

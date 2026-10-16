/**
 * The main process's IPC handlers: one per channel in src/shared/ipc.ts. A renderer is a web page, so every
 * request is checked twice before anything acts on it: it must come from the host window's own top frame (the
 * client window, a web page served to the LAN, can't drive the launcher), and its payload must parse against
 * the contract's schema.
 *
 * The one synchronous channel, `hostInjection`, answers only the client window's top frame while it shows the
 * node's loopback origin: that is how the host token reaches the host's own client, and nothing else.
 */
import { clipboard, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from "electron";
import type { z } from "zod";

import {
  CopyRequestSchema,
  IPC,
  MakeAdminRequestSchema,
  OpenExternalRequestSchema,
  RevokeCodeRequestSchema,
  SettingsUpdateSchema,
  SetupRequestSchema,
  UnlockRequestSchema,
  UpdateConfigRequestSchema,
} from "../shared/ipc.js";
import { isKnownExternalUrl } from "./external-links.js";
import type { LogFeed } from "./log-feed.js";
import type { NodeController } from "./node-controller.js";
import { appPaths } from "./paths.js";
import { hostShellUrl, isHostShellSender, mayInjectHostToken, type SenderFacts } from "./trust.js";
import { checkForUpdates } from "./updates.js";
import type { WindowManager } from "./windows.js";

const INVALID = { ok: false as const, error: "That request wasn't understood." };

export type IpcContext = {
  controller: NodeController;
  windows: WindowManager;
  log: LogFeed;
  version: string;
  dataDir: string;
  lanAddresses(): string[];
};

/** The facts about who sent `event`, for the decisions in trust.ts. */
function senderFacts(isWindow: (contents: WebContents) => boolean, event: IpcMainInvokeEvent | IpcMainEvent): SenderFacts {
  const frame = event.senderFrame;
  return {
    isWindow: isWindow(event.sender),
    isMainFrame: frame !== null && frame === event.sender.mainFrame,
    frameUrl: frame?.url ?? "",
  };
}

/** The payload parsed against `schema`, or undefined. */
function parse<T>(schema: z.ZodType<T>, payload: unknown): T | undefined {
  const result = schema.safeParse(payload);
  return result.success ? result.data : undefined;
}

/** The running node's port and this computer's addresses, for the external-link check. */
function nodeHosts(context: IpcContext): { port: number; hosts: string[] } | undefined {
  const origin = context.controller.localOrigin();
  return origin ? { port: Number(new URL(origin).port), hosts: context.lanAddresses() } : undefined;
}

export function registerIpc(context: IpcContext): void {
  const { controller, windows } = context;
  const shellUrl = hostShellUrl(appPaths.rendererIndex);

  /** Handle `channel` from the host shell only. A request from anywhere else is refused before it is read. */
  function handle(channel: string, handler: (payload: unknown, sender: WebContents) => unknown): void {
    ipcMain.handle(channel, (event, payload: unknown) => {
      if (!isHostShellSender(senderFacts(windows.isHost, event), shellUrl)) {
        throw new Error("Refused: not the host window.");
      }
      return handler(payload, event.sender);
    });
  }

  handle(IPC.getState, () => controller.getState());
  handle(IPC.setup, (payload) => {
    const request = parse(SetupRequestSchema, payload);
    return request ? controller.setup(request) : INVALID;
  });
  handle(IPC.unlock, (payload) => {
    const request = parse(UnlockRequestSchema, payload);
    return request ? controller.unlock(request) : INVALID;
  });
  handle(IPC.start, () => controller.start());
  handle(IPC.stop, () => controller.stop());
  handle(IPC.newNetwork, () => controller.newNetwork());
  handle(IPC.openClient, () => {
    const origin = controller.localOrigin();
    if (origin) {
      windows.openClient(origin, controller.clientStorageInMemory());
    }
  });
  handle(IPC.copy, (payload) => {
    const request = parse(CopyRequestSchema, payload);
    if (request) {
      clipboard.writeText(request.text);
    }
  });
  handle(IPC.openExternal, async (payload) => {
    const request = parse(OpenExternalRequestSchema, payload);
    if (request && isKnownExternalUrl(request.url, nodeHosts(context))) {
      await shell.openExternal(request.url);
    }
  });
  handle(IPC.openDataFolder, async () => {
    await shell.openPath(context.dataDir);
  });
  handle(IPC.updateSettings, (payload) => {
    const update = parse(SettingsUpdateSchema, payload);
    return update ? controller.updateSettings(update) : INVALID;
  });
  handle(IPC.acknowledgeHost, () => controller.acknowledgeHost());
  handle(IPC.checkForUpdates, () => checkForUpdates(context.version));
  handle(IPC.log, () => context.log.entries());

  handle(IPC.hostConfig, () => controller.hostConfig());
  handle(IPC.hostUpdateConfig, (payload) => {
    const update = parse(UpdateConfigRequestSchema, payload);
    return update ? controller.hostUpdateConfig(update) : INVALID;
  });
  handle(IPC.hostUsers, () => controller.hostUsers());
  handle(IPC.hostMakeAdmin, (payload) => {
    const request = parse(MakeAdminRequestSchema, payload);
    return request ? controller.hostMakeAdmin(request.userId) : INVALID;
  });
  handle(IPC.hostAdminClaimCode, () => controller.hostAdminClaimCode());
  handle(IPC.hostRevokeAdminClaimCode, (payload) => {
    const request = parse(RevokeCodeRequestSchema, payload);
    if (request) {
      controller.hostRevokeAdminClaimCode(request.code);
    }
  });
  handle(IPC.hostLinkCode, () => controller.hostLinkCode());
  handle(IPC.hostInvite, () => controller.hostInvite());
  handle(IPC.hostEmergencyReset, () => controller.emergencyReset());

  // Synchronous: the client preload must have the token before the page's own scripts run. Assigned exactly
  // once: setting `returnValue` sends the reply, and a second assignment is never seen.
  ipcMain.on(IPC.hostInjection, (event) => {
    const trusted = mayInjectHostToken(senderFacts(windows.isClient, event), controller.localOrigin());
    event.returnValue = trusted ? (controller.hostInjection() ?? null) : null;
  });
}

/**
 * Who the main process trusts, as pure decisions (so they are unit-tested; windows.ts and ipc.ts only gather the
 * facts and act). Two pages run in this app: the host shell (our own page, from file://, allowed to drive the
 * launcher) and the web client (a page the node serves to the whole LAN, trusted with nothing but the host token
 * of the node it was opened on).
 */
import { pathToFileURL } from "node:url";

import { isKnownExternalUrl, isSameOrigin, isWebUrl } from "./external-links.js";

/** The facts about an IPC sender the decisions below need. */
export type SenderFacts = {
  /** The sender is the host window's webContents (or the client window's, for {@link mayInjectHostToken}). */
  isWindow: boolean;
  /** The message came from that window's top frame (not an iframe). */
  isMainFrame: boolean;
  /** The URL of the frame that sent it ("" when unknown). */
  frameUrl: string;
};

/** The file: URL of the host shell's page, without query or fragment. */
export function hostShellUrl(rendererIndex: string): string {
  return pathToFileURL(rendererIndex).href;
}

/**
 * `url` without its query and fragment, or undefined when it isn't a URL. A Windows drive letter is compared
 * upper-case: Chromium canonicalises `file:///c:/...` to `file:///C:/...` in a frame's URL, while Node's
 * `pathToFileURL` keeps the case the process was launched with (a `cd c:\...` shell gives a lower-case one).
 */
function documentUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.replace(/^\/[a-z]:/, (drive) => drive.toUpperCase());
    return `${parsed.protocol}//${parsed.host}${pathname}`;
  } catch {
    return undefined;
  }
}

/**
 * Whether an `invoke` may drive the launcher: only from the host window's top frame while it shows the packaged
 * host shell page itself. The client window, any iframe, and any other page are refused.
 */
export function isHostShellSender(facts: SenderFacts, shellUrl: string): boolean {
  return facts.isWindow && facts.isMainFrame && documentUrl(facts.frameUrl) === documentUrl(shellUrl);
}

/**
 * Whether the client window's preload may be handed the host token: only its top frame, only while it shows the
 * running node's exact loopback origin. Anything else (another origin it was sent to, an iframe, no node) gets null.
 */
export function mayInjectHostToken(facts: SenderFacts, nodeOrigin: string | undefined): boolean {
  return facts.isWindow && facts.isMainFrame && isSameOrigin(facts.frameUrl, nodeOrigin);
}

/** What happens to a navigation a page started. */
export type NavigationDecision = "allow" | "open-in-browser" | "block";

/** The running node's port and this computer's addresses (undefined while nothing runs), for the host window's rule. */
export type KnownNode = { port: number; hosts: readonly string[] } | undefined;

/**
 * Whether a window open (or a refused navigation) goes to the computer's browser. From the client window any web
 * page may, since members' links must open; from the host window only the pages LOAM knows may, the same rule the
 * `openExternal` request follows, so a page that got into the host shell can't send the browser anywhere.
 * Anything else (file:, custom schemes) goes nowhere.
 */
export function windowOpenDecision(url: string, page: { isClientWindow: boolean; node: KnownNode }): "open-in-browser" | "block" {
  const allowed = page.isClientWindow ? isWebUrl(url) : isKnownExternalUrl(url, page.node);
  return allowed ? "open-in-browser" : "block";
}

/**
 * The client window may move around its own node's origin; the host shell is one page and never navigates.
 * Anything refused goes to the browser as {@link windowOpenDecision} says.
 */
export function navigationDecision(
  url: string,
  page: { isClientWindow: boolean; clientOrigin: string | undefined; node: KnownNode },
): NavigationDecision {
  if (page.isClientWindow && isSameOrigin(url, page.clientOrigin)) {
    return "allow";
  }
  return windowOpenDecision(url, page);
}

/** What the client window does when the node moves or stops, and the origin it may stay on afterwards. */
export type ClientWindowChange = { clientOrigin: string | undefined; action: "reload" | "close" | "none" };

/**
 * The client window when the node (re)started on `origin`, or stopped (`undefined`). A new boot reloads an open
 * window, so its preload injects what this boot's node accepts. A stop closes it and forgets the origin: nothing of
 * LOAM's holds that port now, another program on this computer can take it, and a reload of the dead page (the
 * client's own error screen offers one) would load that program's page where the host's identity is stored.
 */
export function clientWindowOnNodeChange(origin: string | undefined, windowOpen: boolean): ClientWindowChange {
  if (origin === undefined) {
    return { clientOrigin: undefined, action: windowOpen ? "close" : "none" };
  }
  return { clientOrigin: origin, action: windowOpen ? "reload" : "none" };
}

/**
 * The client window's own browser storage, apart from the host shell's. The web client keeps its identity and
 * preferences (localStorage) and, as any browser, a copy of what it shows (IndexedDB); on disk that copy would
 * sit outside the network's encryption. So for a network kept only while LOAM runs (ephemeral) everything lives
 * in memory and is gone on Quit; any other network keeps the partition on disk (so the host stays the same
 * person across restarts), and on every encrypted one the preload tells the web client to keep no IndexedDB at
 * all (`noLocalCache` in the host injection). Neither partition has an HTTP cache (windows.ts). Both are erased
 * on every Emergency Reset and when the network is discarded.
 */
export const CLIENT_PARTITIONS = { kept: "persist:loam-client", memory: "loam-client-memory" } as const;

/** The partition the client window uses. */
export function clientPartition(inMemory: boolean): string {
  return inMemory ? CLIENT_PARTITIONS.memory : CLIENT_PARTITIONS.kept;
}

/**
 * Who the main process trusts, as pure decisions (so they are unit-tested; windows.ts and ipc.ts only gather the
 * facts and act). Two pages run in this app: the host shell (our own page, from file://, allowed to drive the
 * launcher) and the web client (a page the node serves to the whole LAN, trusted with nothing but the host token
 * of the node it was opened on).
 */
import { pathToFileURL } from "node:url";

import { isSameOrigin, isWebUrl } from "./external-links.js";

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

/** `url` without its query and fragment, or undefined when it isn't a URL. */
function documentUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
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

/**
 * The client window may move around its own node's origin; the host shell is one page and never navigates.
 * Anything refused that is a web page opens in the computer's browser instead; anything else (file:, custom
 * schemes) goes nowhere.
 */
export function navigationDecision(url: string, page: { isClientWindow: boolean; clientOrigin: string | undefined }): NavigationDecision {
  if (page.isClientWindow && isSameOrigin(url, page.clientOrigin)) {
    return "allow";
  }
  return isWebUrl(url) ? "open-in-browser" : "block";
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

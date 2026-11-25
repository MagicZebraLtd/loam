/**
 * Pruning the per-conversation read markers (`conversationKey` → time of the newest message seen). They are
 * kept on the device, so on a network with retention a marker that outlives its conversation would keep a
 * list of who the member talked to, and when, after the node and the message cache had deleted the messages.
 */
import type { DmInbox, Message } from "@loam/schema";

/** What is still here: the channels the node listed and the DM partners still held. Absent = not judged. */
export interface LiveConversations {
  channelIds?: ReadonlySet<string>;
  dmPeerIds?: ReadonlySet<string>;
}

/**
 * Whether the conversation `key` (`channel:<id>` or `dm:<peer id>`) is gone, judged only on the side `live`
 * names. A key of any other shape is never judged gone.
 */
export function isConversationGone(key: string, live: LiveConversations): boolean {
  if (live.channelIds && key.startsWith("channel:")) {
    return !live.channelIds.has(key.slice("channel:".length));
  }
  if (live.dmPeerIds && key.startsWith("dm:")) {
    return !live.dmPeerIds.has(key.slice("dm:".length));
  }
  return false;
}

/**
 * `reads` without the markers `isGone` picks. Returns the same object when nothing goes, so a caller can
 * skip the write.
 */
export function readMarkersWithout(
  reads: Record<string, number>,
  isGone: (key: string) => boolean,
): Record<string, number> {
  const kept = Object.entries(reads).filter(([key]) => !isGone(key));
  return kept.length === Object.keys(reads).length ? reads : Object.fromEntries(kept);
}

/**
 * The DM partners still held once the inbox has landed: everyone the inbox lists, plus the partner of any DM
 * that arrived after the inbox request began (those are never dropped as stale, see
 * `dropStaleConversationMessages`). A DM held before the request with anyone else has just been dropped.
 *
 * @param inbox - The node's DM inbox.
 * @param messages - The messages held now.
 * @param preFetchMessageIds - What was held when the inbox request began.
 * @param currentUserId - Who this is.
 */
export function heldDmPeers(
  inbox: DmInbox["conversations"],
  messages: readonly Message[],
  preFetchMessageIds: ReadonlySet<string>,
  currentUserId: string,
): Set<string> {
  const peers = new Set(inbox.map((entry) => entry.userId));
  for (const message of messages) {
    if (message.type === "dm" && !preFetchMessageIds.has(message.id)) {
      peers.add(message.authorId === currentUserId ? message.recipientUserId : message.authorId);
    }
  }
  return peers;
}

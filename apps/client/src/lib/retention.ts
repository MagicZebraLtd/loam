import type { Channel, Message } from "@loam/schema";

import { putRecord } from "./local-store";

/**
 * The client side of message retention (docs/07). The node's reaper deletes expired messages and tells the
 * sockets that are connected at that moment; a device that was away keeps its copies. So the client applies
 * the same rule to what it holds: the node TTL it was told (`NetworkConfig.messageTtlMs`, remembered in the
 * local store so an offline start can prune too) and each channel's own shorter `messageTtlMs`.
 */

/** The `sync` store record that remembers the node's retention for an offline start. */
export const RETENTION_RECORD_ID = "retention";

/** What {@link RETENTION_RECORD_ID} holds: the node TTL last reported, or none (messages are kept). */
export type RetentionRecord = { id: typeof RETENTION_RECORD_ID; messageTtlMs?: number };

/** A positive, finite TTL, or undefined (zero, negative, NaN and null all mean "no retention"). */
function usableTtl(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** The node TTL remembered in the local store's `sync` records, if any. */
export function cachedRetentionTtl(records: readonly { id: string }[]): number | undefined {
  const record = records.find((entry) => entry.id === RETENTION_RECORD_ID) as Partial<RetentionRecord> | undefined;
  return usableTtl(record?.messageTtlMs);
}

/** Remember the node TTL for the next (possibly offline) start; best effort, like the other `sync` records. */
export async function persistRetentionTtl(messageTtlMs: number | undefined): Promise<void> {
  const ttl = usableTtl(messageTtlMs);
  const record: RetentionRecord = { id: RETENTION_RECORD_ID, ...(ttl !== undefined ? { messageTtlMs: ttl } : {}) };
  await putRecord("sync", record).catch(() => undefined);
}

/**
 * The TTL that applies to a message, the server's rule (`reapExpiredMessages`): a channel's own TTL may only
 * shorten the node's, with the node TTL off it stands alone; DMs and reactions follow the node TTL.
 */
export function retentionTtlFor(
  message: Message,
  channelsById: ReadonlyMap<string, Channel>,
  nodeTtlMs: number | undefined,
): number | undefined {
  const nodeTtl = usableTtl(nodeTtlMs);
  const channelTtl =
    message.type === "channelPost" || message.type === "channelReply"
      ? usableTtl(channelsById.get(message.channelId)?.messageTtlMs)
      : undefined;
  return channelTtl !== undefined && nodeTtl !== undefined ? Math.min(channelTtl, nodeTtl) : (channelTtl ?? nodeTtl);
}

/**
 * The ids of held messages past their retention, with what the node deletes alongside them: the replies under
 * an expired post and the reactions on any expired message. A reply still streaming is spared, as on the node.
 *
 * `now` is the later of this device's clock and the newest `createdAt` it holds (a server stamp): a phone whose
 * clock runs slow would otherwise keep messages the node already dropped. A clock that runs fast prunes early,
 * which only removes the copy sooner.
 */
export function expiredMessageIds(
  messages: readonly Message[],
  channels: readonly Channel[],
  nodeTtlMs: number | undefined,
  clockNow: number,
): Set<string> {
  const expired = new Set<string>();
  const channelsById = new Map(channels.map((channel) => [channel.id, channel]));
  let now = clockNow;
  for (const message of messages) {
    now = Math.max(now, message.createdAt);
  }

  for (const message of messages) {
    if (message.meta?.streaming) {
      continue;
    }
    const ttl = retentionTtlFor(message, channelsById, nodeTtlMs);
    if (ttl !== undefined && message.createdAt < now - ttl) {
      expired.add(message.id);
    }
  }
  if (!expired.size) {
    return expired;
  }

  // Cascade like the node's delete: replies under an expired post (to any depth an older build wrote), then
  // reactions on anything expired.
  let grew = true;
  while (grew) {
    grew = false;
    for (const message of messages) {
      if (
        message.type === "channelReply" &&
        !message.meta?.streaming &&
        expired.has(message.parentMessageId) &&
        !expired.has(message.id)
      ) {
        expired.add(message.id);
        grew = true;
      }
    }
  }
  for (const message of messages) {
    if (message.type === "reaction" && expired.has(message.targetMessageId)) {
      expired.add(message.id);
    }
  }
  return expired;
}

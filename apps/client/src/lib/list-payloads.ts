/**
 * Checks for the lists a node sends (channels, users, a conversation's history, the DM inbox) before they
 * reach state or IndexedDB. Each entry is parsed on its own with the shared schema and one that fails is
 * dropped, so a single malformed row from a version-skewed node can't be cached and break a conversation on
 * every open, while the good rows still arrive.
 */
import { DmInboxSchema, type DmInbox } from "@loam/schema";

import { t } from "../i18n";

/** The part of a Zod schema these checks use. */
interface EntrySchema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

/**
 * The entries of `payload` that pass `schema`, in order. When some fail, one `console.warn` says how many
 * were dropped from which list (the count only, never the content, which may be someone's message).
 *
 * @param payload - The parsed JSON the node returned.
 * @param schema - The shared schema each entry must pass.
 * @param listName - What the list is, for the warning ("channel", "message"…).
 * @throws Error when `payload` is not a list at all: the request is treated as failed, so a caller's
 *   reconcile never takes a broken answer for an empty list and deletes what it holds.
 */
export function parseListEntries<T>(payload: unknown, schema: EntrySchema<T>, listName: string): T[] {
  if (!Array.isArray(payload)) {
    console.warn(`LOAM: the node's ${listName} list was not a list.`);
    throw new Error(t("app.serverUnreachable"));
  }
  const entries: T[] = [];
  for (const item of payload) {
    const parsed = schema.safeParse(item);
    if (parsed.success) {
      entries.push(parsed.data);
    }
  }
  const dropped = payload.length - entries.length;
  if (dropped > 0) {
    console.warn(`LOAM: dropped ${dropped} of ${payload.length} ${listName} entries that failed validation.`);
  }
  return entries;
}

/** The schema of one `GET /api/dms` entry. */
const DmInboxEntrySchema = DmInboxSchema.shape.conversations.element;

/**
 * The conversations of a `GET /api/dms` answer, each checked on its own (see {@link parseListEntries}).
 *
 * @throws Error when the answer has no `conversations` list.
 */
export function parseDmInboxEntries(payload: unknown): DmInbox["conversations"] {
  const conversations =
    payload !== null && typeof payload === "object" ? (payload as { conversations?: unknown }).conversations : undefined;
  return parseListEntries(conversations, DmInboxEntrySchema, "DM inbox");
}

import type { Channel, Message } from "@loam/schema";

import { expiredMessageIds } from "./retention";

/**
 * Keeping the Search screen's results in step with the app. The screen holds its own copy of the messages a
 * search returned, so whatever takes a message or channel out of the app's state (a delete, a moderator's
 * removal, an edit, losing a private channel) is published here as well, and the screen folds it into what it
 * shows. A search is a snapshot: a change can take a row away or rewrite it, never add one.
 */

/** A live change an open search must reflect. */
export type SearchChange =
  | { kind: "deleted"; messageId: string }
  | { kind: "updated"; message: Message }
  | { kind: "channelRemoved"; channelId: string };

/** Whether `message` matches `term` the way `GET /api/search` matches: a case-insensitive substring of its body. */
export function matchesSearchTerm(message: Message, term: string): boolean {
  return "body" in message && message.body.toLowerCase().includes(term.trim().toLowerCase());
}

/**
 * Fold one change into the results of a search for `term`: a deleted message's row goes, every row in a removed
 * channel goes, and an updated message replaces its row in place while its text still matches (it goes once it
 * no longer does: an edit, or a moderator's removal, which blanks the body). An update for a message that isn't
 * in the results is ignored. Returns `results` itself when nothing changed.
 */
export function applySearchChange(results: Message[], change: SearchChange, term: string): Message[] {
  if (change.kind === "deleted") {
    return results.some((message) => message.id === change.messageId)
      ? results.filter((message) => message.id !== change.messageId)
      : results;
  }

  if (change.kind === "channelRemoved") {
    const inChannel = (message: Message): boolean =>
      (message.type === "channelPost" || message.type === "channelReply") && message.channelId === change.channelId;
    return results.some(inChannel) ? results.filter((message) => !inChannel(message)) : results;
  }

  const index = results.findIndex((message) => message.id === change.message.id);

  if (index === -1) {
    return results;
  }

  if (!matchesSearchTerm(change.message, term)) {
    return results.filter((_, position) => position !== index);
  }

  const next = results.slice();
  next[index] = change.message;
  return next;
}

/**
 * Drop the results past their retention, by the rule conversations use (`expiredMessageIds`). `held` is what the
 * app holds: it is judged alongside the results, so `now` is the later of `clockNow` and the newest `createdAt`
 * of either, as for conversations, and a reply whose expired post the app holds goes with it. Returns `results`
 * itself when nothing expired.
 */
export function pruneExpiredResults(
  results: Message[],
  channels: readonly Channel[],
  nodeTtlMs: number | undefined,
  clockNow: number,
  held: readonly Message[] = [],
): Message[] {
  if (!results.length) {
    return results;
  }

  const expired = expiredMessageIds([...results, ...held], channels, nodeTtlMs, clockNow);
  return results.some((message) => expired.has(message.id))
    ? results.filter((message) => !expired.has(message.id))
    : results;
}

/** Who is listening for changes: the Search screen while it is mounted. */
const listeners = new Set<(change: SearchChange) => void>();

/**
 * Tell every listener about a change. A listener that throws is skipped and the rest still hear it; its error is
 * not logged, since it could carry message text or the search term.
 */
export function publishSearchChange(change: SearchChange): void {
  for (const listener of [...listeners]) {
    try {
      listener(change);
    } catch {
      // Dropped on purpose (see above): the publisher is the app's state path and must carry on.
    }
  }
}

/** Listen for changes until the returned function is called. */
export function subscribeSearchChanges(listener: (change: SearchChange) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

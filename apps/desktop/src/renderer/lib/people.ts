/**
 * People-screen helpers, the same rules as the TUI's (packages/tui/src/screens/people.ts): anyone can choose
 * any display name, so each row shows the end of the id and a shared name is flagged, so copying someone's
 * name isn't enough to be promoted in their place.
 */
import type { HostUser } from "@loam/schema";

/** The last characters of an id: enough to tell two people with the same name apart. */
export function shortId(id: string): string {
  return id.slice(-6);
}

/**
 * The form of a display name compared to tell whether two people share one: NFKC-normalised, stripped of
 * invisible characters (a zero-width joiner slipped into a copied name), spaces collapsed, lower-cased.
 * The TUI cleans control characters first; here the main process already has.
 */
export function nameKey(displayName: string): string {
  return displayName
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Display names (as {@link nameKey}s) used by more than one person. */
export function sharedNames(users: readonly HostUser[]): Set<string> {
  const seen = new Set<string>();
  const shared = new Set<string>();
  for (const user of users) {
    const name = nameKey(user.displayName);
    (seen.has(name) ? shared : seen).add(name);
  }
  return shared;
}

/** Whether the host can make this person an admin from here (not one already, never a banned person). */
export function canMakeAdmin(user: HostUser): boolean {
  return !user.banned && !(user.isAdmin && !user.pending);
}

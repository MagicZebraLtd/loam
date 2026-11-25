/**
 * How often a crashed host window is reloaded. A renderer that crashes once (out of memory, a GPU reset) comes
 * back on a reload; one that crashes on every load would spin, so after a few reloads in a short time the window
 * is left closed and the tray opens a fresh one. Pure, so it is unit-tested.
 */

/** Reloads allowed within {@link CRASH_RELOAD_WINDOW_MS}. */
export const CRASH_RELOAD_LIMIT = 3;
/** The span the limit counts over. */
export const CRASH_RELOAD_WINDOW_MS = 60_000;

/**
 * A budget of reloads: each call records a crash and answers whether to reload for it (true) or give up (false).
 * Crashes older than `windowMs` no longer count.
 */
export function createCrashReloadBudget(
  options: { limit?: number; windowMs?: number; now?: () => number } = {},
): () => boolean {
  const limit = options.limit ?? CRASH_RELOAD_LIMIT;
  const windowMs = options.windowMs ?? CRASH_RELOAD_WINDOW_MS;
  const now = options.now ?? Date.now;
  let reloads: number[] = [];
  return () => {
    const at = now();
    reloads = reloads.filter((time) => at - time < windowMs);
    if (reloads.length >= limit) {
      return false;
    }
    reloads.push(at);
    return true;
  };
}

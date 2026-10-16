/**
 * The launcher's side of the fixed-key Emergency Reset protocol, ported from the Android launcher
 * (apps/app/nodejs-project-template/main.js, "Wipe-restart handoff"). SHARED CONTRACT with the server's wipe
 * journal (apps/server/src/store-lifecycle.ts, kill-switch.ts): a durable `.loam-wipe-phase` file whose phase
 * is one of two values:
 *   - `delete-pending`: a wipe started but its artifacts are NOT yet proven gone. The launcher must NOT clear
 *     the device key: it boots the server under the OLD key, and the server's boot-time resume re-runs the
 *     deletion (then asks for the key clear itself).
 *   - `key-clear-ready`: every artifact is proven gone; the only step left is clearing the device key. Only
 *     here does the launcher clear it and delete the phase file, then boot under a fresh key.
 * Route on the phase, never on mere presence.
 */
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { fsyncDirectory, isMissing, removeProven } from "./durable-files.js";

export type WipePhase = "delete-pending" | "key-clear-ready";

/** The journal the server writes. */
export const WIPE_PHASE_FILE = ".loam-wipe-phase";
/** The single marker an older server build wrote; still recognised as an unfinished wipe. */
export const LEGACY_WIPE_PENDING_FILE = ".loam-wipe-pending";

/**
 * The durable wipe phase in `dataDir`. No file → undefined (no wipe pending). Any unreadable, malformed or
 * unrecognised content → `delete-pending`: a phase file that is present but ambiguous means a wipe WAS in
 * progress, so err toward the server's deletion retry rather than clearing the key early.
 */
export function readWipePhase(dataDir: string): WipePhase | undefined {
  let raw: string;
  try {
    raw = readFileSync(join(dataDir, WIPE_PHASE_FILE), "utf8");
  } catch (error) {
    if (!isMissing(error)) {
      return "delete-pending";
    }
    try {
      lstatSync(join(dataDir, LEGACY_WIPE_PENDING_FILE));
      return "delete-pending";
    } catch (legacyError) {
      return isMissing(legacyError) ? undefined : "delete-pending";
    }
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return (parsed as { phase?: unknown }).phase === "key-clear-ready" ? "key-clear-ready" : "delete-pending";
    }
  } catch {
    // Not JSON: an older build's plain-string phase.
  }
  return raw.trim() === "key-clear-ready" ? "key-clear-ready" : "delete-pending";
}

/**
 * Delete the phase file (and the legacy marker) and PROVE both gone, durably. Only after this may a fresh device
 * secret be minted: a phase file that lingered would make the next boot clear THAT secret and strand the new
 * database. False on any failure (the caller stays locked; reopening retries).
 */
export function clearWipePhase(dataDir: string): boolean {
  return removeProven([WIPE_PHASE_FILE, LEGACY_WIPE_PENDING_FILE].map((name) => join(dataDir, name))) && fsyncDirectory(dataDir);
}

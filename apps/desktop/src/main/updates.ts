/**
 * "Check for updates", tap-only: ask GitHub for LOAM's latest release and compare it with this build. Ported
 * from the Android host's pure helpers (apps/app/src/lib/app-updates.ts). Nothing checks on launch and nothing
 * is downloaded: the answer says a version exists, and the Settings screen opens the releases page in the
 * browser. The request carries no LOAM data: GitHub sees this computer's address and that it asked.
 */
import type { UpdateCheckResult } from "../shared/ipc.js";

/** GitHub's "latest release" endpoint for LOAM. Drafts and pre-releases are never "latest". */
export const GITHUB_LATEST_RELEASE_API = "https://api.github.com/repos/MagicZebraLtd/loam/releases/latest";
/** Where people download a newer build. */
export const GITHUB_RELEASES_PAGE = "https://github.com/MagicZebraLtd/loam/releases/latest";
/** Give up after this long, so a dead connection doesn't leave the button spinning. */
export const UPDATE_CHECK_TIMEOUT_MS = 10_000;

export type Version = readonly [number, number, number];

/** A pre-release suffix: `-beta.N` sorts before `-rc.N`, and both before the final release. */
export type PreRelease = { readonly channel: "beta" | "rc"; readonly number: number };

/** The installed build's version: X.Y.Z, plus the pre-release a release candidate carries. */
export type InstalledVersion = { readonly version: Version; readonly preRelease: PreRelease | null };

/** `0.5.0` or `v0.5.0` → `[0, 5, 0]`. Anything else (a suffix, extra parts, junk) → null. Pure. */
export function parseVersion(text: string): Version | null {
  const match = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(text.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/**
 * `0.6.0`, `v0.6.0`, `0.6.0-rc.1` or `v0.6.0-beta.2` → its parts. The suffixes are exactly the ones a release
 * tag may carry (scripts/check-versions.mjs); anything else → null. Pure.
 */
export function parseInstalledVersion(text: string): InstalledVersion | null {
  const match = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-(rc|beta)\.(\d{1,6}))?$/.exec(text.trim());
  if (!match) {
    return null;
  }
  const version: Version = [Number(match[1]), Number(match[2]), Number(match[3])];
  const channel = match[4] as PreRelease["channel"] | undefined;
  return { version, preRelease: channel ? { channel, number: Number(match[5]) } : null };
}

/** Negative when `a` is older, positive when newer, 0 when equal: X.Y.Z, then beta < rc < final. Pure. */
export function compareInstalledVersions(a: InstalledVersion, b: InstalledVersion): number {
  for (let i = 0; i < 3; i++) {
    if (a.version[i] !== b.version[i]) {
      return a.version[i]! - b.version[i]!;
    }
  }
  const rank = (pre: PreRelease | null): number => (pre === null ? 2 : pre.channel === "rc" ? 1 : 0);
  if (rank(a.preRelease) !== rank(b.preRelease)) {
    return rank(a.preRelease) - rank(b.preRelease);
  }
  return (a.preRelease?.number ?? 0) - (b.preRelease?.number ?? 0);
}

/** True when the error is the abort our own timer fired. */
function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

/**
 * Ask GitHub for the latest release and compare it with `currentVersion`. Only the release's tag is read, and
 * only as a strict `vX.Y.Z`; nothing else from the reply is used. No cookies, no LOAM data. Never throws:
 * a network failure is `offline`, our timer is `timeout`, and an odd reply (a dev build's version included,
 * which there is nothing to compare with) is `bad_response`.
 */
export async function checkForUpdates(
  currentVersion: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = UPDATE_CHECK_TIMEOUT_MS,
): Promise<UpdateCheckResult> {
  const current = parseInstalledVersion(currentVersion);
  if (!current) {
    return { ok: false, error: "bad_response" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(GITHUB_LATEST_RELEASE_API, {
      method: "GET",
      headers: { Accept: "application/vnd.github+json" },
      credentials: "omit",
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, error: "bad_response" };
    }
    const body: unknown = await response.json();
    const tag = body && typeof body === "object" ? (body as { tag_name?: unknown }).tag_name : undefined;
    const latest = typeof tag === "string" ? parseVersion(tag) : null;
    if (!latest) {
      return { ok: false, error: "bad_response" };
    }
    return {
      ok: true,
      current: currentVersion,
      latest: latest.join("."),
      newer: compareInstalledVersions({ version: latest, preRelease: null }, current) > 0,
      url: GITHUB_RELEASES_PAGE,
    };
  } catch (error) {
    if (controller.signal.aborted || isAbort(error)) {
      return { ok: false, error: "timeout" };
    }
    // A reply that wasn't JSON is GitHub's fault, not the network's.
    return { ok: false, error: error instanceof SyntaxError ? "bad_response" : "offline" };
  } finally {
    clearTimeout(timer);
  }
}

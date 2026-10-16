// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  checkForUpdates,
  compareInstalledVersions,
  GITHUB_LATEST_RELEASE_API,
  GITHUB_RELEASES_PAGE,
  parseInstalledVersion,
  parseVersion,
} from "./updates.js";

/** A fetch that answers with `body` (JSON) and `status`, recording what it was asked. */
function answering(body: unknown, status = 200): { fetch: typeof fetch; calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fetch: impl, calls };
}

describe("version parsing", () => {
  it("reads strict release tags only", () => {
    expect(parseVersion("v0.6.4")).toEqual([0, 6, 4]);
    expect(parseVersion("0.7.0")).toEqual([0, 7, 0]);
    expect(parseVersion("v0.7.0-rc.1")).toBeNull();
    expect(parseVersion("latest")).toBeNull();
  });

  it("orders pre-releases before the final release", () => {
    const final = parseInstalledVersion("0.7.0")!;
    const rc = parseInstalledVersion("0.7.0-rc.2")!;
    const beta = parseInstalledVersion("0.7.0-beta.5")!;
    expect(compareInstalledVersions(beta, rc)).toBeLessThan(0);
    expect(compareInstalledVersions(rc, final)).toBeLessThan(0);
    expect(compareInstalledVersions(parseInstalledVersion("0.6.9")!, beta)).toBeLessThan(0);
    expect(compareInstalledVersions(final, final)).toBe(0);
  });
});

describe("checkForUpdates", () => {
  it("reports a newer release and where to get it", async () => {
    const { fetch, calls } = answering({ tag_name: "v0.7.0" });
    expect(await checkForUpdates("0.6.4", fetch)).toEqual({
      ok: true,
      current: "0.6.4",
      latest: "0.7.0",
      newer: true,
      url: GITHUB_RELEASES_PAGE,
    });
    expect(calls[0]?.url).toBe(GITHUB_LATEST_RELEASE_API);
    expect(calls[0]?.init?.credentials).toBe("omit");
  });

  it("says when this build is current", async () => {
    const { fetch } = answering({ tag_name: "v0.6.4" });
    expect(await checkForUpdates("0.6.4", fetch)).toMatchObject({ ok: true, newer: false });
  });

  it("treats the final release as newer than its release candidate", async () => {
    const { fetch } = answering({ tag_name: "v0.7.0" });
    expect(await checkForUpdates("0.7.0-rc.1", fetch)).toMatchObject({ ok: true, newer: true });
  });

  it("refuses an odd reply", async () => {
    expect(await checkForUpdates("0.6.4", answering({ tag_name: 7 }).fetch)).toEqual({ ok: false, error: "bad_response" });
    expect(await checkForUpdates("0.6.4", answering({}, 500).fetch)).toEqual({ ok: false, error: "bad_response" });
    expect(await checkForUpdates("0.6.4", answering("<html>").fetch)).toEqual({ ok: false, error: "bad_response" });
  });

  it("has nothing to compare a dev build with", async () => {
    expect(await checkForUpdates("dev", answering({ tag_name: "v0.7.0" }).fetch)).toEqual({ ok: false, error: "bad_response" });
  });

  it("reports a network failure as offline", async () => {
    const failing = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    expect(await checkForUpdates("0.6.4", failing)).toEqual({ ok: false, error: "offline" });
  });

  it("gives up after the timeout", async () => {
    const hanging = ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as typeof fetch;
    expect(await checkForUpdates("0.6.4", hanging, 10)).toEqual({ ok: false, error: "timeout" });
  });
});

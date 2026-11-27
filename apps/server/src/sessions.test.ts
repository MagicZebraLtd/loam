import { afterEach, describe, expect, it } from "vitest";

import type { LoamApp } from "./app.js";
import { subnetIdentityFactor } from "./defaults.js";
import { makeSessionToken, makeSessionUserId } from "./identity.js";
import { DEFAULT_MAX_ENTRIES } from "./rate-limit.js";
import { makeApp, newSession, sessionCookie, teardownApps } from "./test-support/app-harness.js";

afterEach(teardownApps);

describe("anonymous identity minting limit", () => {
  it("429s new identities from one IP past the cap but lets cookie'd requests through", async () => {
    const app = await makeApp(undefined, { maxNewIdentitiesPerWindow: 3 });

    const first = await app.server.inject({ method: "GET", url: "/api/config" });
    expect(first.statusCode).toBe(200);
    const cookie = sessionCookie(first);

    // Two more fresh mints (count 2, 3) are allowed; the 4th cookieless request exceeds the cap.
    expect((await app.server.inject({ method: "GET", url: "/api/config" })).statusCode).toBe(200);
    expect((await app.server.inject({ method: "GET", url: "/api/config" })).statusCode).toBe(200);
    const refused = await app.server.inject({ method: "GET", url: "/api/config" });
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ code: "rate_limited" });

    // A request that carries an existing session cookie mints nothing, so it's unaffected.
    const returning = await app.server.inject({ method: "GET", url: "/api/config", headers: { cookie } });
    expect(returning.statusCode).toBe(200);
  });
});

describe("new-identity budget by address and IPv6 /64", () => {
  const max = 3;

  /** The `n`th address (from 1) in the /64 `prefix`, e.g. `fd00:1:2:3::5`. */
  function inSubnet(prefix: string, n: number): string {
    return `${prefix}::${n.toString(16)}`;
  }

  /** A cookie-less `GET /api/config` from `remoteAddress`: mints an identity unless the budget refuses. */
  async function mintFrom(app: LoamApp, remoteAddress: string): Promise<number> {
    return (await app.server.inject({ method: "GET", url: "/api/config", remoteAddress })).statusCode;
  }

  it("stops a /64 at the subnet bound however many of its addresses mint, with the usual 429", async () => {
    const app = await makeApp(undefined, { maxNewIdentitiesPerWindow: max });
    const usersBefore = app.store.loadUsers().length;
    const statuses: number[] = [];
    for (let n = 1; n <= max * subnetIdentityFactor + 10; n += 1) {
      // One mint per address: every address stays under its own bound.
      statuses.push(await mintFrom(app, inSubnet("fd00:1:2:3", n)));
    }

    expect(statuses.filter((status) => status === 200)).toHaveLength(max * subnetIdentityFactor);
    expect(statuses.slice(max * subnetIdentityFactor).every((status) => status === 429)).toBe(true);
    expect(app.store.loadUsers().length - usersBefore).toBe(max * subnetIdentityFactor);

    const refused = await app.server.inject({ method: "GET", url: "/api/config", remoteAddress: inSubnet("fd00:1:2:3", 0xffff) });
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ code: "rate_limited" });
  });

  it("gives each /64 its own bound", async () => {
    const app = await makeApp(undefined, { maxNewIdentitiesPerWindow: max });
    for (let n = 1; n <= max * subnetIdentityFactor; n += 1) {
      expect(await mintFrom(app, inSubnet("fd00:1:2:3", n))).toBe(200);
    }
    expect(await mintFrom(app, inSubnet("fd00:1:2:3", 0xfff0))).toBe(429);

    expect(await mintFrom(app, inSubnet("fd00:1:2:4", 1))).toBe(200);
  });

  it("counts an IPv4-mapped IPv6 address as its IPv4 form", async () => {
    const app = await makeApp(undefined, { maxNewIdentitiesPerWindow: max });
    expect(await mintFrom(app, "::ffff:10.0.0.5")).toBe(200);
    expect(await mintFrom(app, "10.0.0.5")).toBe(200);
    expect(await mintFrom(app, "::ffff:10.0.0.5")).toBe(200);
    expect(await mintFrom(app, "10.0.0.5")).toBe(429);
    expect(await mintFrom(app, "::ffff:10.0.0.5")).toBe(429);

    expect(await mintFrom(app, "10.0.0.6")).toBe(200);
  });

  it("keeps the IPv4 bound per address, with no wider bucket", async () => {
    const app = await makeApp(undefined, { maxNewIdentitiesPerWindow: max });
    for (let n = 0; n < max; n += 1) {
      expect(await mintFrom(app, "192.168.4.20")).toBe(200);
    }
    expect(await mintFrom(app, "192.168.4.20")).toBe(429);

    // More addresses in one IPv4 /24 than an IPv6 /64 may mint for: each still has its own budget.
    for (let n = 1; n <= max * subnetIdentityFactor + 5; n += 1) {
      expect(await mintFrom(app, `192.168.5.${n}`)).toBe(200);
    }
  });

  it("bounds the user rows cookie-less admin claims create from one /64", async () => {
    const app = await makeApp({ admin: { bootstrap: "setupCode" } }, { maxNewIdentitiesPerWindow: max });
    const usersBefore = app.store.loadUsers().length;
    for (let n = 1; n <= max * subnetIdentityFactor + 10; n += 1) {
      await app.server.inject({
        method: "POST",
        url: "/api/admin/claim",
        payload: { secret: "wrong" },
        remoteAddress: inSubnet("fd00:1:2:3", n),
      });
    }

    expect(app.store.loadUsers().length - usersBefore).toBe(max * subnetIdentityFactor);
  });

  it("a /64 that has spent its bound adds no entries, so its flood can't reset another address's budget", async () => {
    const app = await makeApp({ admin: { bootstrap: "setupCode" } }, { maxNewIdentitiesPerWindow: 1 });
    // An IPv4 address spends its whole budget.
    expect(await mintFrom(app, "10.0.0.9")).toBe(200);
    expect(await mintFrom(app, "10.0.0.9")).toBe(429);
    const usersBefore = app.store.loadUsers().length;

    // The claim route counts per address, so the flood reaches the identity budget from every address.
    for (let n = 1; n <= DEFAULT_MAX_ENTRIES + 50; n += 1) {
      await app.server.inject({
        method: "POST",
        url: "/api/admin/claim",
        payload: { secret: "wrong" },
        remoteAddress: inSubnet("fd00:1:2:3", n),
      });
    }

    // The /64 minted up to its bound and no further: one entry per address that minted, the /64's own, and
    // the IPv4 address's. The refused requests after that added nothing.
    expect(app.store.loadUsers().length - usersBefore).toBe(subnetIdentityFactor);
    expect(app.rateLimiterEntryCounts().identity).toBe(subnetIdentityFactor + 2);
    // So the IPv4 address's window was never evicted: it is still out of budget.
    expect(await mintFrom(app, "10.0.0.9")).toBe(429);
  }, 60_000);

  it("keeps the budget's tables within their cap under a flood of fresh subnets", async () => {
    const app = await makeApp({ admin: { bootstrap: "setupCode" } }, { maxNewIdentitiesPerWindow: 1 });
    // One address in each of more /64s than a table holds: every one is allowed, and each adds an address
    // entry and a subnet entry.
    for (let n = 1; n <= DEFAULT_MAX_ENTRIES + 50; n += 1) {
      await app.server.inject({
        method: "POST",
        url: "/api/admin/claim",
        payload: { secret: "wrong" },
        remoteAddress: `fd00:1:2:${n.toString(16)}::1`,
      });
    }

    expect(app.rateLimiterEntryCounts().identity).toBe(DEFAULT_MAX_ENTRIES * 2);
  }, 60_000);
});

describe("session identity minting", () => {
  it("mints 64-bit user ids that never alias an existing one, and 256-bit session tokens", async () => {
    const app = await makeApp();
    const session = await newSession(app);
    expect(session.userId).toMatch(/^user\.[0-9a-f]{16}$/);
    expect(decodeURIComponent(session.cookie.slice("loam_session=".length))).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(makeSessionToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // The minter retries until the id is free.
    const seen: string[] = [];
    const id = makeSessionUserId((candidate) => {
      seen.push(candidate);
      return seen.length < 4;
    });
    expect(seen).toHaveLength(4);
    expect(id).toBe(seen[3]);
  });
});

describe("ending a session", () => {
  it("ends the caller's session so the next request mints a fresh identity", async () => {
    const app = await makeApp();
    const user = await newSession(app);

    const end = await app.server.inject({
      method: "POST",
      url: "/api/session/end",
      headers: { cookie: user.cookie },
    });
    expect(end.statusCode).toBe(200);
    // The Set-Cookie clears the session cookie (Max-Age=0).
    expect(String(end.headers["set-cookie"])).toContain("Max-Age=0");

    // Reusing the now-invalidated cookie mints a brand-new identity rather than the wiped one.
    const after = await app.server.inject({ method: "GET", url: "/api/config", headers: { cookie: user.cookie } });
    const newId = (after.json() as { currentUser: { id: string } }).currentUser.id;
    expect(newId).not.toBe(user.userId);
  });

  it("session/end is a safe no-op on an absent/unknown cookie and never mints a session", async () => {
    const app = await makeApp();
    const usersBefore = app.store.loadUsers().length;

    // No cookie at all.
    const none = await app.server.inject({ method: "POST", url: "/api/session/end" });
    expect(none.statusCode).toBe(200);
    // An unknown token.
    const unknown = await app.server.inject({
      method: "POST",
      url: "/api/session/end",
      headers: { cookie: "loam_session=deadbeef" },
    });
    expect(unknown.statusCode).toBe(200);

    // Crucially, ending a session must not itself create an identity.
    expect(app.store.loadUsers().length).toBe(usersBefore);
  });
});

describe("the node's clock in its answers", () => {
  // Messages carry this node's clock as `createdAt`. A client judges retention by it (`serverTime`), since its
  // own clock may be hours from the host's off-grid.
  it("stamps /api/bootstrap and /api/config with the time it answered", async () => {
    const app = await makeApp();
    const session = await newSession(app);

    const before = Date.now();
    const bootstrap = (await app.server.inject({ method: "GET", url: "/api/bootstrap" })).json() as { serverTime?: number };
    const config = (
      await app.server.inject({ method: "GET", url: "/api/config", headers: { cookie: session.cookie } })
    ).json() as { serverTime?: number };
    const after = Date.now();

    for (const stamp of [bootstrap.serverTime, config.serverTime]) {
      expect(Number.isSafeInteger(stamp)).toBe(true);
      expect(stamp).toBeGreaterThanOrEqual(before);
      expect(stamp).toBeLessThanOrEqual(after);
    }
  });
});

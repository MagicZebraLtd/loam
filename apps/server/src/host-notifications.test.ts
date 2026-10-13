import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LoamApp } from "./app.js";
import { HOST_NOTICE_BODY_MAX_LENGTH } from "./realtime.js";
import { claim, makeApp, newSession, teardownApps } from "./test-support/app-harness.js";
import type { HostMessageNotice } from "./types.js";

const HOST_TOKEN = "host-token-notifications-0123456789abcdefghij";

type Hooked = typeof globalThis & { __loamNotifyHost?: (notice: HostMessageNotice) => void };

let notices: HostMessageNotice[] = [];
let cleanupHook: (() => void) | undefined;

beforeEach(() => {
  notices = [];
  (globalThis as Hooked).__loamNotifyHost = (notice) => notices.push(notice);
});

afterEach(async () => {
  delete (globalThis as Hooked).__loamNotifyHost;
  cleanupHook?.();
  cleanupHook = undefined;
  await teardownApps();
});

function post(app: LoamApp, cookie: string, payload: Record<string, unknown>) {
  return app.server.inject({ method: "POST", url: "/api/messages", headers: { cookie }, payload });
}

/** A host-token node whose host phone (the WebView's person) has claimed, plus one other member. */
async function hostedNode() {
  const app = await makeApp(undefined, { hostToken: HOST_TOKEN });
  const host = await newSession(app);
  expect((await claim(app, host.cookie, HOST_TOKEN)).statusCode).toBe(200);
  const member = await newSession(app);
  return { app, host, member };
}

describe("Android notifications for the host phone's person", () => {
  it("hands over a direct message and a channel post to the host, with who and where", async () => {
    const { app, host, member } = await hostedNode();

    expect((await post(app, member.cookie, { type: "dm", recipientUserId: host.userId, body: "  are you there?  " })).statusCode).toBe(201);
    expect((await post(app, member.cookie, { type: "channelPost", channelId: "general", body: "hello all" })).statusCode).toBe(201);

    const author = (await app.server.inject({ method: "GET", url: "/api/users", headers: { cookie: host.cookie } }))
      .json<{ id: string; displayName: string }[]>()
      .find((user) => user.id === member.userId)?.displayName;
    expect(notices).toEqual([
      { conversation: `dm:${member.userId}`, direct: true, author, body: "are you there?", attachment: false, location: false },
      {
        conversation: "channel:general",
        direct: false,
        author,
        channel: "General",
        body: "hello all",
        attachment: false,
        location: false,
      },
    ]);
  });

  it("never for the host's own messages, or a DM between two other people", async () => {
    const { app, host, member } = await hostedNode();
    const third = await newSession(app);

    await post(app, host.cookie, { type: "channelPost", channelId: "general", body: "from the host" });
    await post(app, member.cookie, { type: "dm", recipientUserId: third.userId, body: "just us" });

    expect(notices).toEqual([]);
  });

  it("never from someone the host blocked, or a shadow-banned author", async () => {
    const { app, host, member } = await hostedNode();
    const other = await newSession(app);

    expect(
      (await app.server.inject({ method: "PUT", url: `/api/users/me/blocks/${member.userId}`, headers: { cookie: host.cookie } })).statusCode,
    ).toBe(200);
    expect(
      (
        await app.server.inject({
          method: "PATCH",
          url: `/api/moderation/users/${other.userId}`,
          headers: { cookie: host.cookie },
          payload: { shadowBanned: true },
        })
      ).statusCode,
    ).toBe(200);

    await post(app, member.cookie, { type: "channelPost", channelId: "general", body: "blocked" });
    await post(app, other.cookie, { type: "channelPost", channelId: "general", body: "shadow" });

    expect(notices).toEqual([]);
  });

  it("never from a private channel the host isn't in", async () => {
    const { app, member } = await hostedNode();
    const created = await app.server.inject({
      method: "POST",
      url: "/api/channels",
      headers: { cookie: member.cookie },
      payload: { name: "Members only", visibility: "private" },
    });
    expect(created.statusCode).toBe(201);

    await post(app, member.cookie, { type: "channelPost", channelId: created.json<{ id: string }>().id, body: "secret" });

    expect(notices).toEqual([]);
  });

  it("cuts long text for the notification", async () => {
    const { app, host, member } = await hostedNode();

    await post(app, member.cookie, { type: "dm", recipientUserId: host.userId, body: "x".repeat(1000) });

    expect(notices[0].body).toHaveLength(HOST_NOTICE_BODY_MAX_LENGTH);
    expect(notices[0].body.endsWith("…")).toBe(true);
  });

  it("follows the host's WebView: an admin presenting the token again is remembered, a LAN session is not", async () => {
    const app = await makeApp(undefined, { hostToken: HOST_TOKEN });
    const host = await newSession(app);
    const member = await newSession(app);

    // Nobody has presented the token yet: no person to notify.
    await post(app, member.cookie, { type: "channelPost", channelId: "general", body: "early" });
    expect(notices).toEqual([]);

    // A wrong secret names nobody.
    expect((await claim(app, member.cookie, "not-the-token")).statusCode).toBe(403);
    await post(app, host.cookie, { type: "channelPost", channelId: "general", body: "still nobody" });
    expect(notices).toEqual([]);

    expect((await claim(app, host.cookie, HOST_TOKEN)).statusCode).toBe(200);
    // The host's next page load presents it again as an admin: still 200, still the host.
    expect((await claim(app, host.cookie, HOST_TOKEN)).statusCode).toBe(200);
    await post(app, member.cookie, { type: "channelPost", channelId: "general", body: "now" });
    expect(notices.map((notice) => notice.body)).toEqual(["now"]);
  });

  it("forgets the host's person in an Emergency Reset, and tells the launcher to clear the notifications", async () => {
    const resets = vi.fn();
    (globalThis as { __loamHostReset?: () => void }).__loamHostReset = resets;
    cleanupHook = () => delete (globalThis as { __loamHostReset?: () => void }).__loamHostReset;
    const app = await makeApp({ killSwitch: { enabled: true, requireConfirmation: false } }, { hostToken: HOST_TOKEN });
    const host = await newSession(app);
    expect((await claim(app, host.cookie, HOST_TOKEN)).statusCode).toBe(200);

    // Run by another admin, from a browser: the host's WebView takes no part.
    const other = await newSession(app);
    expect(
      (
        await app.server.inject({
          method: "POST",
          url: `/api/admin/users/${other.userId}/promote`,
          headers: { cookie: host.cookie },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await app.server.inject({ method: "POST", url: "/api/admin/kill-switch", headers: { cookie: other.cookie }, payload: {} })).statusCode,
    ).toBe(200);
    expect(resets).toHaveBeenCalledTimes(1);

    const member = await newSession(app);
    await post(app, member.cookie, { type: "channelPost", channelId: "general", body: "after the reset" });
    expect(notices).toEqual([]);
  });

  it("does nothing on a node without the launcher's hook", async () => {
    delete (globalThis as Hooked).__loamNotifyHost;
    const { app, host, member } = await hostedNode();

    expect((await post(app, member.cookie, { type: "dm", recipientUserId: host.userId, body: "hi" })).statusCode).toBe(201);
  });
});

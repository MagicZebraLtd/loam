import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LoamApp } from "./app.js";
import { HOST_NOTICE_BODY_MAX_LENGTH, HOST_NOTICE_RECORD_MAX } from "./realtime.js";
import { assistantRevision, claim, cleanups, makeApp, newSession, startMockOllama, teardownApps } from "./test-support/app-harness.js";
import type { HostMessageNotice, HostNoticeWithdrawal } from "./types.js";

const HOST_TOKEN = "host-token-notifications-0123456789abcdefghij";

type Hooked = typeof globalThis & {
  __loamNotifyHost?: (notice: HostMessageNotice) => void;
  __loamWithdrawHostNotice?: (withdrawal: HostNoticeWithdrawal) => void;
};

let notices: HostMessageNotice[] = [];
let withdrawals: HostNoticeWithdrawal[] = [];
let cleanupHook: (() => void) | undefined;

beforeEach(() => {
  notices = [];
  withdrawals = [];
  (globalThis as Hooked).__loamNotifyHost = (notice) => notices.push(notice);
  (globalThis as Hooked).__loamWithdrawHostNotice = (withdrawal) => withdrawals.push(withdrawal);
});

afterEach(async () => {
  delete (globalThis as Hooked).__loamNotifyHost;
  delete (globalThis as Hooked).__loamWithdrawHostNotice;
  cleanupHook?.();
  cleanupHook = undefined;
  await teardownApps();
});

function post(app: LoamApp, cookie: string, payload: Record<string, unknown>) {
  return app.server.inject({ method: "POST", url: "/api/messages", headers: { cookie }, payload });
}

/** The id of the message a `POST /api/messages` created. */
function messageId(response: Awaited<ReturnType<typeof post>>): string {
  return response.json<{ message: { id: string } }>().message.id;
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

    const dm = await post(app, member.cookie, { type: "dm", recipientUserId: host.userId, body: "  are you there?  " });
    const channelPost = await post(app, member.cookie, { type: "channelPost", channelId: "general", body: "hello all" });
    expect(dm.statusCode).toBe(201);
    expect(channelPost.statusCode).toBe(201);

    const author = (await app.server.inject({ method: "GET", url: "/api/users", headers: { cookie: host.cookie } }))
      .json<{ id: string; displayName: string }[]>()
      .find((user) => user.id === member.userId)?.displayName;
    expect(notices).toEqual([
      {
        messageId: messageId(dm),
        conversation: `dm:${member.userId}`,
        direct: true,
        author,
        body: "are you there?",
        attachment: false,
        location: false,
      },
      {
        messageId: messageId(channelPost),
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

  it("stops notifying for the host's identity once the host phone ends that session", async () => {
    const { app, host, member } = await hostedNode();

    expect((await app.server.inject({ method: "POST", url: "/api/session/end", headers: { cookie: host.cookie } })).statusCode).toBe(200);
    await post(app, member.cookie, { type: "dm", recipientUserId: host.userId, body: "to the forgotten identity" });

    expect(notices).toEqual([]);
  });

  it("keeps the host's identity when someone else ends their session", async () => {
    const { app, host, member } = await hostedNode();
    const other = await newSession(app);

    expect((await app.server.inject({ method: "POST", url: "/api/session/end", headers: { cookie: other.cookie } })).statusCode).toBe(200);
    await post(app, member.cookie, { type: "dm", recipientUserId: host.userId, body: "still here" });

    expect(notices.map((notice) => notice.body)).toEqual(["still here"]);
  });

  it("does nothing on a node without the launcher's hook", async () => {
    delete (globalThis as Hooked).__loamNotifyHost;
    const { app, host, member } = await hostedNode();

    expect((await post(app, member.cookie, { type: "dm", recipientUserId: host.userId, body: "hi" })).statusCode).toBe(201);
  });
});

describe("taking the host phone's notifications back", () => {
  /** Delete a message as `cookie`'s person. */
  function remove(app: LoamApp, id: string, cookie: string) {
    return app.server.inject({ method: "DELETE", url: `/api/messages/${id}`, headers: { cookie } });
  }

  /** Create a private channel owned by `cookie`'s person and invite `userIds`; returns its id. */
  async function privateChannel(app: LoamApp, cookie: string, userIds: string[]): Promise<string> {
    const created = await app.server.inject({
      method: "POST",
      url: "/api/channels",
      headers: { cookie },
      payload: { name: "Planning", visibility: "private" },
    });
    expect(created.statusCode).toBe(201);
    const channelId = created.json<{ id: string }>().id;
    for (const userId of userIds) {
      const invited = await app.server.inject({
        method: "POST",
        url: `/api/channels/${channelId}/members`,
        headers: { cookie },
        payload: { userId },
      });
      expect(invited.statusCode).toBe(200);
    }
    return channelId;
  }

  it("withdraws a notified message once when its author deletes it", async () => {
    const { app, host, member } = await hostedNode();
    const id = messageId(await post(app, member.cookie, { type: "dm", recipientUserId: host.userId, body: "regret this" }));

    expect((await remove(app, id, member.cookie)).statusCode).toBe(200);

    expect(withdrawals).toEqual([{ messageId: id }]);
  });

  it("withdraws a notified message once when a moderator removes it, and not again when it is then deleted", async () => {
    const { app, host, member } = await hostedNode();
    const id = messageId(await post(app, member.cookie, { type: "channelPost", channelId: "general", body: "abuse" }));
    expect(notices.map((notice) => notice.messageId)).toEqual([id]);

    const removal = await app.server.inject({
      method: "POST",
      url: `/api/moderation/messages/${id}/remove`,
      headers: { cookie: host.cookie },
      payload: {},
    });
    expect(removal.statusCode).toBe(200);
    expect(withdrawals).toEqual([{ messageId: id }]);

    expect((await remove(app, id, host.cookie)).statusCode).toBe(200);
    expect(withdrawals).toEqual([{ messageId: id }]);
  });

  it("withdraws a notified message once when its author edits it", async () => {
    const { app, host, member } = await hostedNode();
    const id = messageId(await post(app, member.cookie, { type: "dm", recipientUserId: host.userId, body: "first words" }));

    const edit = (body: string) =>
      app.server.inject({ method: "PATCH", url: `/api/messages/${id}`, headers: { cookie: member.cookie }, payload: { body } });
    expect((await edit("second words")).statusCode).toBe(200);
    expect((await edit("third words")).statusCode).toBe(200);

    expect(withdrawals).toEqual([{ messageId: id }]);
  });

  it("withdraws a notified message once when it expires under retention", async () => {
    const app = await makeApp({ retention: { messageTtlMs: 500 } }, { hostToken: HOST_TOKEN });
    const host = await newSession(app);
    expect((await claim(app, host.cookie, HOST_TOKEN)).statusCode).toBe(200);
    const member = await newSession(app);
    // Only `Date` is faked: `server.inject` needs real timers (see messages.test.ts).
    vi.useFakeTimers({ toFake: ["Date"] });
    const id = messageId(await post(app, member.cookie, { type: "dm", recipientUserId: host.userId, body: "short-lived" }));

    vi.setSystemTime(Date.now() + 1_000);
    app.reapExpiredMessages();
    app.reapExpiredMessages();

    expect(withdrawals).toEqual([{ messageId: id }]);
  });

  it("withdraws a reply deleted with its thread", async () => {
    const { app, host, member } = await hostedNode();
    const parent = messageId(await post(app, host.cookie, { type: "channelPost", channelId: "general", body: "the host's thread" }));
    const reply = messageId(
      await post(app, member.cookie, { type: "channelReply", channelId: "general", parentMessageId: parent, body: "a reply" }),
    );

    expect((await remove(app, parent, host.cookie)).statusCode).toBe(200);

    expect(withdrawals).toEqual([{ messageId: reply }]);
  });

  it("withdraws a shadow-banned author's notified messages, once", async () => {
    const { app, host, member } = await hostedNode();
    const other = await newSession(app);
    const first = messageId(await post(app, member.cookie, { type: "dm", recipientUserId: host.userId, body: "one" }));
    const second = messageId(await post(app, member.cookie, { type: "channelPost", channelId: "general", body: "two" }));
    await post(app, other.cookie, { type: "channelPost", channelId: "general", body: "someone else" });

    const moderate = (payload: Record<string, unknown>) =>
      app.server.inject({ method: "PATCH", url: `/api/moderation/users/${member.userId}`, headers: { cookie: host.cookie }, payload });
    expect((await moderate({ shadowBanned: true })).statusCode).toBe(200);
    // A later change to the same person finds nothing left to take back.
    expect((await moderate({ timeoutMs: 60_000 })).statusCode).toBe(200);

    expect(withdrawals).toEqual([{ messageId: first }, { messageId: second }]);
  });

  it("calls nothing for messages it never notified", async () => {
    const ollama = startMockOllama(["a reply from the bot"]);
    cleanups.push(ollama.close);
    const app = await makeApp({ llm: { ollama: { enabled: true, baseUrl: await ollama.url } } }, { hostToken: HOST_TOKEN });
    const host = await newSession(app);
    expect((await claim(app, host.cookie, HOST_TOKEN)).statusCode).toBe(200);
    const member = await newSession(app);
    const blocked = await newSession(app);

    // The host's own message.
    const own = messageId(await post(app, host.cookie, { type: "channelPost", channelId: "general", body: "mine" }));
    expect((await remove(app, own, host.cookie)).statusCode).toBe(200);

    // A bot's reply: updated as it streams in, then deleted.
    const botId = (await app.server.inject({ method: "GET", url: "/api/users", headers: { cookie: host.cookie } }))
      .json<{ id: string; type: string }[]>()
      .find((user) => user.type === "bot")?.id;
    expect(botId).toBeDefined();
    const hello = { type: "dm", recipientUserId: botId, body: "hello bot", assistantDestinationRevision: await assistantRevision(app) };
    expect((await post(app, host.cookie, hello)).statusCode).toBe(201);
    let botReply: string | undefined;
    await vi.waitFor(async () => {
      botReply = (await app.server.inject({ method: "GET", url: `/api/dms/${botId}`, headers: { cookie: host.cookie } }))
        .json<{ id: string; authorId: string; meta?: { streaming?: boolean } }[]>()
        .find((message) => message.authorId === botId && !message.meta?.streaming)?.id;
      expect(botReply).toBeDefined();
    });
    expect((await remove(app, botReply ?? "", host.cookie)).statusCode).toBe(200);

    // One from someone the host blocked.
    expect(
      (await app.server.inject({ method: "PUT", url: `/api/users/me/blocks/${blocked.userId}`, headers: { cookie: host.cookie } })).statusCode,
    ).toBe(200);
    const fromBlocked = messageId(await post(app, blocked.cookie, { type: "channelPost", channelId: "general", body: "blocked" }));
    expect((await remove(app, fromBlocked, blocked.cookie)).statusCode).toBe(200);

    // One in a private channel the host isn't in.
    const channelId = await privateChannel(app, member.cookie, []);
    const secret = messageId(await post(app, member.cookie, { type: "channelPost", channelId, body: "secret" }));
    expect((await remove(app, secret, member.cookie)).statusCode).toBe(200);

    expect(notices).toEqual([]);
    expect(withdrawals).toEqual([]);
  });

  it(`remembers only the last ${HOST_NOTICE_RECORD_MAX} notified messages`, async () => {
    const { app, host, member } = await hostedNode();
    const ids: string[] = [];
    for (let index = 0; index < 300; index += 1) {
      const response = await app.server.inject({
        method: "POST",
        url: "/api/messages",
        headers: { cookie: member.cookie },
        payload: { type: "dm", recipientUserId: host.userId, body: `message ${index}` },
        // Spread over addresses, so the per-address request limiter never trips.
        remoteAddress: `10.0.0.${(index % 50) + 1}`,
      });
      expect(response.statusCode).toBe(201);
      ids.push(messageId(response));
    }
    expect(notices).toHaveLength(300);

    expect((await remove(app, ids[0], member.cookie)).statusCode).toBe(200);
    expect(withdrawals).toEqual([]);

    expect((await remove(app, ids[299], member.cookie)).statusCode).toBe(200);
    expect(withdrawals).toEqual([{ messageId: ids[299] }]);
  });

  /** Run a request from one of 50 spread addresses, so the per-address request limiter never trips. */
  function spread(index: number) {
    return `10.0.${Math.floor(index / 50) % 250}.${(index % 50) + 1}`;
  }

  /** Delete `ids` one by one as `cookie`'s person, each from a spread address. */
  async function removeAll(app: LoamApp, ids: string[], cookie: string): Promise<void> {
    for (const [index, id] of ids.entries()) {
      const response = await app.server.inject({ method: "DELETE", url: `/api/messages/${id}`, headers: { cookie }, remoteAddress: spread(index) });
      expect(response.statusCode).toBe(200);
    }
  }

  it("keeps the record behind a conversation's notification while another conversation fills the rest", async () => {
    const { app, host, member } = await hostedNode();
    const dm = messageId(await post(app, member.cookie, { type: "dm", recipientUserId: host.userId, body: "still on screen" }));
    const channelIds: string[] = [];
    for (let index = 0; index < HOST_NOTICE_RECORD_MAX + 44; index += 1) {
      const response = await app.server.inject({
        method: "POST",
        url: "/api/messages",
        headers: { cookie: member.cookie },
        payload: { type: "channelPost", channelId: "general", body: `post ${index}` },
        remoteAddress: spread(index),
      });
      expect(response.statusCode).toBe(201);
      channelIds.push(messageId(response));
    }
    expect(withdrawals).toEqual([]);

    expect((await remove(app, dm, member.cookie)).statusCode).toBe(200);
    expect(withdrawals).toEqual([{ messageId: dm }]);

    // What is left remembered is the channel's newest posts, one fewer than the cap with the DM's record.
    withdrawals = [];
    await removeAll(app, channelIds, member.cookie);
    expect(withdrawals).toEqual(channelIds.slice(-(HOST_NOTICE_RECORD_MAX - 1)).map((id) => ({ messageId: id })));
  });

  it("takes back the oldest conversation's notification when more conversations than the cap have one", async () => {
    const { app, host } = await hostedNode();
    const extra = 4;
    const senders: { cookie: string; userId: string }[] = [];
    const ids: string[] = [];
    for (let index = 0; index < HOST_NOTICE_RECORD_MAX + extra; index += 1) {
      const config = await app.server.inject({ method: "GET", url: "/api/config", remoteAddress: spread(index) });
      const cookie = String(config.headers["set-cookie"]).split(";")[0];
      const userId = config.json<{ currentUser: { id: string } }>().currentUser.id;
      senders.push({ cookie, userId });
      const response = await app.server.inject({
        method: "POST",
        url: "/api/messages",
        headers: { cookie },
        payload: { type: "dm", recipientUserId: host.userId, body: `hello ${index}` },
        remoteAddress: spread(index),
      });
      expect(response.statusCode).toBe(201);
      ids.push(messageId(response));
    }
    expect(notices).toHaveLength(HOST_NOTICE_RECORD_MAX + extra);
    expect(withdrawals).toEqual(senders.slice(0, extra).map((sender) => ({ conversation: `dm:${sender.userId}` })));

    // Exactly the cap's worth is remembered: the newest conversations, each withdrawn once on delete.
    withdrawals = [];
    for (const [index, id] of ids.entries()) {
      const response = await app.server.inject({
        method: "DELETE",
        url: `/api/messages/${id}`,
        headers: { cookie: senders[index].cookie },
        remoteAddress: spread(index),
      });
      expect(response.statusCode).toBe(200);
    }
    expect(withdrawals).toEqual(ids.slice(extra).map((id) => ({ messageId: id })));
  });

  it("withdraws a private channel's notification when the host's person is removed from it or leaves", async () => {
    const { app, host, member } = await hostedNode();
    const channelId = await privateChannel(app, member.cookie, [host.userId]);
    const removeHost = (cookie: string) =>
      app.server.inject({ method: "DELETE", url: `/api/channels/${channelId}/members/${host.userId}`, headers: { cookie } });
    const id = messageId(await post(app, member.cookie, { type: "channelPost", channelId, body: "for members" }));
    expect(notices.map((notice) => notice.messageId)).toEqual([id]);

    // Removed by the owner.
    expect((await removeHost(member.cookie)).statusCode).toBe(200);
    expect(withdrawals).toEqual([{ conversation: `channel:${channelId}` }]);
    // The channel's messages were forgotten with it: deleting the old post takes nothing more back.
    expect((await remove(app, id, member.cookie)).statusCode).toBe(200);
    expect(withdrawals).toEqual([{ conversation: `channel:${channelId}` }]);

    // Invited again, then leaving.
    const invited = await app.server.inject({
      method: "POST",
      url: `/api/channels/${channelId}/members`,
      headers: { cookie: member.cookie },
      payload: { userId: host.userId },
    });
    expect(invited.statusCode).toBe(200);
    expect((await removeHost(host.cookie)).statusCode).toBe(200);
    expect(withdrawals).toEqual([{ conversation: `channel:${channelId}` }, { conversation: `channel:${channelId}` }]);
  });

  it("withdraws a deleted channel's messages and the channel, and nothing when someone else leaves it", async () => {
    const { app, host, member } = await hostedNode();
    const other = await newSession(app);
    const channelId = await privateChannel(app, member.cookie, [host.userId, other.userId]);
    const id = messageId(await post(app, member.cookie, { type: "channelPost", channelId, body: "for members" }));

    const left = await app.server.inject({
      method: "DELETE",
      url: `/api/channels/${channelId}/members/${other.userId}`,
      headers: { cookie: other.cookie },
    });
    expect(left.statusCode).toBe(200);
    expect(withdrawals).toEqual([]);

    const deleted = await app.server.inject({ method: "DELETE", url: `/api/channels/${channelId}`, headers: { cookie: member.cookie } });
    expect(deleted.statusCode).toBe(200);
    expect(withdrawals).toEqual([{ messageId: id }, { conversation: `channel:${channelId}` }]);
  });

  it("breaks nothing without the hook, or with a hook that throws", async () => {
    delete (globalThis as Hooked).__loamWithdrawHostNotice;
    const { app, host, member } = await hostedNode();
    const first = messageId(await post(app, member.cookie, { type: "dm", recipientUserId: host.userId, body: "one" }));
    expect((await remove(app, first, member.cookie)).statusCode).toBe(200);

    (globalThis as Hooked).__loamWithdrawHostNotice = () => {
      throw new Error("bridge gone");
    };
    const second = messageId(await post(app, member.cookie, { type: "dm", recipientUserId: host.userId, body: "two" }));
    expect((await remove(app, second, member.cookie)).statusCode).toBe(200);

    const left = await app.server.inject({ method: "GET", url: `/api/dms/${member.userId}`, headers: { cookie: host.cookie } });
    expect(left.json<unknown[]>()).toEqual([]);
  });

  it("forgets what it notified in an Emergency Reset", async () => {
    // A linked peer hands this node one author's posts before and after the reset: the only way a message
    // from before the reset can come up after it.
    const author = { id: "user.peerauthor0001", displayName: "Peer", type: "human", isAdmin: false, createdAt: 1, ephemeral: true };
    const peerPost = (id: string) => ({ id, type: "channelPost", authorId: author.id, channelId: "general", body: id, createdAt: Date.now() - 1_000 });
    let offered = [peerPost("msg.before-reset")];
    const peer = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/sync/digest") {
        response.end(JSON.stringify({ channels: [], messages: offered.map((message) => ({ id: message.id })) }));
        return;
      }
      if (request.url === "/api/sync/messages") {
        response.end(JSON.stringify({ messages: offered, users: [author] }));
        return;
      }
      response.statusCode = 404;
      response.end("{}");
    });
    await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", () => resolve()));
    cleanups.push(() => new Promise<void>((resolve) => peer.close(() => resolve())));
    const peerUrl = `http://127.0.0.1:${(peer.address() as AddressInfo).port}`;
    const app = await makeApp(
      { killSwitch: { enabled: true, requireConfirmation: false }, sync: { enabled: true, peers: [{ url: peerUrl }], intervalMs: 3_600_000 } },
      { hostToken: HOST_TOKEN },
    );
    const runSync = (cookie: string) => app.server.inject({ method: "POST", url: "/api/admin/sync/run", headers: { cookie } });

    const before = await newSession(app);
    expect((await claim(app, before.cookie, HOST_TOKEN)).statusCode).toBe(200);
    expect((await runSync(before.cookie)).statusCode).toBe(200);
    expect(notices.map((notice) => notice.messageId)).toEqual(["msg.before-reset"]);

    const reset = await app.server.inject({ method: "POST", url: "/api/admin/kill-switch", headers: { cookie: before.cookie }, payload: {} });
    expect(reset.statusCode).toBe(200);

    // The host phone's WebView signs in again as the new person, and turns sync (paused by the reset) back on.
    const after = await newSession(app);
    expect((await claim(app, after.cookie, HOST_TOKEN)).statusCode).toBe(200);
    const resumed = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie: after.cookie },
      payload: { sync: { enabled: true } },
    });
    expect(resumed.statusCode).toBe(200);
    offered = [peerPost("msg.after-reset")];
    expect((await runSync(after.cookie)).statusCode).toBe(200);
    expect(notices.map((notice) => notice.messageId)).toEqual(["msg.before-reset", "msg.after-reset"]);

    // Shadow-banning the author takes back what the phone shows now, and nothing from before the reset.
    const banned = await app.server.inject({
      method: "PATCH",
      url: `/api/moderation/users/${author.id}`,
      headers: { cookie: after.cookie },
      payload: { shadowBanned: true },
    });
    expect(banned.statusCode).toBe(200);
    expect(withdrawals).toEqual([{ messageId: "msg.after-reset" }]);
  });
});

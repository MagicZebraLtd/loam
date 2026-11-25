// Who a message, a socket and a private roster belong to: a session with no user record gets nothing, only
// someone already in a private channel can add a person to it, a channel message whose channel is gone has
// no audience, a message the caller can't see answers like one that doesn't exist, and reactions only ever
// target a message, never another reaction.
import { afterEach, describe, expect, it } from "vitest";

import { type Message, MessageSchema } from "@loam/schema";

import type { AppContext } from "./app-context.js";
import type { LoamApp } from "./app.js";
import { createRealtime } from "./realtime.js";
import type { ClientEvent } from "./types.js";
import {
  assistantRevision,
  makeApp,
  newSession,
  reopenApp,
  startMockOllama,
  teardownApps,
  cleanups,
  type InjectResponse,
} from "./test-support/app-harness.js";

afterEach(teardownApps);

const BOT_ID = "llm.ollama.gemma4";

type WireEvent = { type?: string; messageId?: string; error?: string; code?: string };

const openSockets: WebSocket[] = [];

afterEach(() => {
  for (const socket of openSockets) {
    socket.close();
  }
  openSockets.length = 0;
});

/** Open a plaintext socket presenting `cookie`, collecting every frame it receives. */
function connect(baseUrl: string, cookie: string): Promise<{ events: WireEvent[]; closed: Promise<void> }> {
  return new Promise((resolve, reject) => {
    const socket = new (WebSocket as unknown as new (url: string, opts: unknown) => WebSocket)(
      `${baseUrl.replace("http", "ws")}/ws`,
      { headers: { cookie } },
    );
    const events: WireEvent[] = [];
    const closed = new Promise<void>((resolveClose) => socket.addEventListener("close", () => resolveClose()));
    socket.addEventListener("message", (event) => events.push(JSON.parse(String((event as MessageEvent).data)) as WireEvent));
    socket.addEventListener("open", () => {
      openSockets.push(socket);
      resolve({ events, closed });
    });
    socket.addEventListener("error", () => reject(new Error("websocket failed to connect")));
  });
}

/** Poll `check` until it holds (or a few seconds pass). */
async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 4_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return check();
}

/** The status and raw JSON body of a reply, for comparing two answers byte for byte. */
function answer(response: InjectResponse): { status: number; body: string } {
  return { status: response.statusCode, body: response.body };
}

/** POST a message as `cookie` and return the reply. */
function post(app: LoamApp, cookie: string, payload: Record<string, unknown>): Promise<InjectResponse> {
  return app.server.inject({ method: "POST", url: "/api/messages", headers: { cookie }, payload });
}

/** POST a message as `cookie`, assert it was created, and return its id. */
async function postOk(app: LoamApp, cookie: string, payload: Record<string, unknown>): Promise<string> {
  const response = await post(app, cookie, payload);
  expect(response.statusCode).toBe(201);
  return (response.json() as { message: { id: string } }).message.id;
}

describe("a session with no user record", () => {
  it("POST /api/messages creates the caller's record and answers its approval gate before the assistant checks", async () => {
    const app = await makeApp({
      access: { joinPolicy: "approval" },
      llm: { ollama: { enabled: true, baseUrl: "http://127.0.0.1:11434", model: "m" } },
    });
    await newSession(app); // the firstUser admin, so the next identity is an ordinary newcomer

    // No cookie and no destination revision: the 409 the assistant check would give must not come first.
    const response = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      payload: { type: "dm", recipientUserId: BOT_ID, body: "hello" },
    });

    expect(response.statusCode).toBe(403);
    expect((response.json() as { error: string }).error).toBe("Your join is awaiting approval");

    const token = decodeURIComponent(String(response.headers["set-cookie"]).split(";")[0]!.split("=")[1]!);
    const minted = app.store.loadSessions().find((session) => session.token === token)?.userId;
    expect(minted).toBeDefined();
    const row = app.store.loadUsers().find((user) => user.id === minted);
    expect(row?.pending).toBe(true);
  });

  it("is refused at /ws like an unauthenticated socket", async () => {
    const { app, dataDir } = await makeApp();
    const token = "no-user-row-session-token-0123456789abcdef";
    app.store.putSession(token, "user.00112233aabbccdd");
    const next = await reopenApp(app, dataDir);
    const baseUrl = await next.server.listen({ port: 0, host: "127.0.0.1" });

    const socket = await connect(baseUrl, `loam_session=${encodeURIComponent(token)}`);
    const closed = await Promise.race([
      socket.closed.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_000)),
    ]);

    expect(closed).toBe(true);
    expect(socket.events.some((event) => event.type === "error" && event.error === "Unauthenticated websocket")).toBe(true);
    expect(next.sockets.size).toBe(0);
  });

  it("is sent nothing but a wipe by the broadcast filter", () => {
    const channel = { id: "general", name: "General", visibility: "public", createdAt: 0 };
    const message = MessageSchema.parse({ id: "m1", type: "channelPost", authorId: "user.aaaaaaaaaaaaaaaa", channelId: "general", body: "hi", createdAt: 1 });
    // A node with no user records at all: every recipient is unknown. Everything else answers "public".
    const ctx = {
      data: { users: [], channels: [channel], messages: [message] },
      options: {},
      ensureChannel: () => channel,
      canAccessChannel: () => true,
      canModerate: () => false,
      canGreet: () => false,
      messageAudienceUserIds: () => undefined,
    } as unknown as AppContext;
    const realtime = createRealtime(ctx);
    const events = [
      { type: "messageCreated", message },
      { type: "messageDeleted", messageId: message.id, message },
      { type: "typing", userId: "user.bbbbbbbbbbbbbbbb", channelId: "general" },
      { type: "userUpserted", user: { id: "user.bbbbbbbbbbbbbbbb", displayName: "b", type: "human", isAdmin: false, createdAt: 0, ephemeral: true } },
      { type: "channelUpserted", channel },
      { type: "presence", onlineUserIds: [] },
      { type: "configUpdated", networkConfig: {} },
      { type: "wipe" },
    ] as unknown as ClientEvent[];

    const delivered = events.filter((event) => realtime.socketCanReceiveEvent("user.cccccccccccccccc", event)).map((event) => event.type);
    expect(delivered).toEqual(["wipe"]);
  });
});

describe("growing a private channel's roster", () => {
  /** An admin (first session), an owner with a private channel, and a third person. */
  async function setup() {
    const app = await makeApp();
    const admin = await newSession(app);
    const owner = await newSession(app);
    const third = await newSession(app);
    expect(admin.isAdmin).toBe(true);
    const created = await app.server.inject({
      method: "POST",
      url: "/api/channels",
      headers: { cookie: owner.cookie },
      payload: { name: "Inner circle", visibility: "private" },
    });
    expect(created.statusCode).toBe(201);
    const channelId = (created.json() as { id: string }).id;
    await postOk(app, owner.cookie, { type: "channelPost", channelId, body: "the history" });
    return { app, admin, owner, third, channelId };
  }

  const invite = (app: LoamApp, cookie: string, channelId: string, userId: string) =>
    app.server.inject({ method: "POST", url: `/api/channels/${channelId}/members`, headers: { cookie }, payload: { userId } });
  const transfer = (app: LoamApp, cookie: string, channelId: string, userId: string) =>
    app.server.inject({ method: "POST", url: `/api/channels/${channelId}/transfer`, headers: { cookie }, payload: { userId } });

  it("refuses a non-member admin's self-invite, and the history stays hidden", async () => {
    const { app, admin, channelId } = await setup();
    const refused = await invite(app, admin.cookie, channelId, admin.userId);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({ error: "Only people in this channel can add someone to it", code: "channel_members_only" });

    const history = await app.server.inject({ method: "GET", url: `/api/messages/${channelId}`, headers: { cookie: admin.cookie } });
    expect(history.statusCode).toBe(404);
  });

  it("refuses a non-member admin inviting a third person", async () => {
    const { app, admin, third, channelId } = await setup();
    const refused = await invite(app, admin.cookie, channelId, third.userId);
    expect(refused.statusCode).toBe(403);
    expect((refused.json() as { code: string }).code).toBe("channel_members_only");
    const history = await app.server.inject({ method: "GET", url: `/api/messages/${channelId}`, headers: { cookie: third.cookie } });
    expect(history.statusCode).toBe(404);
  });

  it("refuses a non-member admin approving a join request, and the request stays", async () => {
    const { app, admin, owner, third, channelId } = await setup();
    const opened = await app.server.inject({
      method: "PATCH",
      url: `/api/channels/${channelId}`,
      headers: { cookie: owner.cookie },
      payload: { allowJoinRequests: true },
    });
    expect(opened.statusCode).toBe(200);
    const asked = await app.server.inject({ method: "POST", url: `/api/channels/${channelId}/join-requests`, headers: { cookie: third.cookie } });
    expect(asked.statusCode).toBe(201);

    const refused = await app.server.inject({
      method: "POST",
      url: `/api/channels/${channelId}/join-requests/${third.userId}/approve`,
      headers: { cookie: admin.cookie },
    });
    expect(refused.statusCode).toBe(403);
    expect((refused.json() as { code: string }).code).toBe("channel_members_only");

    const queue = await app.server.inject({ method: "GET", url: `/api/channels/${channelId}/join-requests`, headers: { cookie: owner.cookie } });
    expect((queue.json() as { id: string }[]).map((user) => user.id)).toEqual([third.userId]);
  });

  it("refuses a non-member admin transferring the channel to themselves", async () => {
    const { app, admin, channelId } = await setup();
    const refused = await transfer(app, admin.cookie, channelId, admin.userId);
    expect(refused.statusCode).toBe(403);
    expect((refused.json() as { code: string }).code).toBe("channel_members_only");
  });

  it("lets a non-member admin transfer the channel to an existing member", async () => {
    const { app, admin, owner, third, channelId } = await setup();
    expect((await invite(app, owner.cookie, channelId, third.userId)).statusCode).toBe(200);
    const moved = await transfer(app, admin.cookie, channelId, third.userId);
    expect(moved.statusCode).toBe(200);
    expect((moved.json() as { ownerUserId: string; memberUserIds: string[] }).ownerUserId).toBe(third.userId);
    expect((moved.json() as { memberUserIds: string[] }).memberUserIds).not.toContain(admin.userId);
  });

  it("lets an admin who is a member invite, and the owner invite", async () => {
    const { app, admin, owner, third, channelId } = await setup();
    expect((await invite(app, owner.cookie, channelId, admin.userId)).statusCode).toBe(200);
    const added = await invite(app, admin.cookie, channelId, third.userId);
    expect(added.statusCode).toBe(200);
    expect((added.json() as { memberUserIds: string[] }).memberUserIds).toContain(third.userId);
  });
});

describe("a channel message whose channel record is missing", () => {
  it("is deleted by the reaper without any socket hearing about it", async () => {
    const ttlMs = 2_000;
    const { app, dataDir } = await makeApp({ retention: { messageTtlMs: ttlMs } });
    const viewer = await newSession(app);
    // Fresh enough to survive the reopened node's boot sweep, so the reaper below runs with the socket open.
    const createdAt = Date.now();
    app.store.insertMessage(
      MessageSchema.parse({ id: "msg.orphan", type: "channelPost", authorId: viewer.userId, channelId: "ghost", body: "orphan text", createdAt }),
    );
    // A public post beside it, whose delete event proves the broadcast went out.
    app.store.insertMessage(
      MessageSchema.parse({ id: "msg.public", type: "channelPost", authorId: viewer.userId, channelId: "general", body: "public", createdAt }),
    );
    const next = await reopenApp(app, dataDir);
    const baseUrl = await next.server.listen({ port: 0, host: "127.0.0.1" });
    const socket = await connect(baseUrl, viewer.cookie);

    await waitFor(() => Date.now() > createdAt + ttlMs + 50, ttlMs + 1_000);
    next.reapExpiredMessages();

    expect(await waitFor(() => socket.events.some((event) => event.type === "messageDeleted" && event.messageId === "msg.public"))).toBe(true);
    expect(socket.events.some((event) => event.messageId === "msg.orphan")).toBe(false);
    expect(next.store.loadMessages().some((message) => message.id === "msg.orphan")).toBe(false);
  }, 15_000);
});

describe("a message the caller cannot see", () => {
  /** Alice and Bob share a DM; Carol is outside it. Admin is the firstUser admin. */
  async function dmSetup() {
    const app = await makeApp();
    const admin = await newSession(app);
    const alice = await newSession(app);
    const bob = await newSession(app);
    const carol = await newSession(app);
    const dmId = await postOk(app, alice.cookie, { type: "dm", recipientUserId: bob.userId, body: "between us" });
    return { app, admin, alice, bob, carol, dmId };
  }

  it("PATCH by a non-participant answers like an unknown id", async () => {
    const { app, carol, dmId } = await dmSetup();
    const edit = (id: string) =>
      app.server.inject({ method: "PATCH", url: `/api/messages/${id}`, headers: { cookie: carol.cookie }, payload: { body: "rewritten" } });
    expect(answer(await edit(dmId))).toEqual(answer(await edit("msg.does-not-exist")));
    expect((await edit(dmId)).statusCode).toBe(404);
  });

  it("DELETE by a non-participant answers like an unknown id, and an admin's delete still works", async () => {
    const { app, admin, carol, dmId } = await dmSetup();
    const remove = (cookie: string, id: string) => app.server.inject({ method: "DELETE", url: `/api/messages/${id}`, headers: { cookie } });
    expect(answer(await remove(carol.cookie, dmId))).toEqual(answer(await remove(carol.cookie, "msg.does-not-exist")));
    expect((await remove(admin.cookie, dmId)).statusCode).toBe(200);
  });

  it("a reaction on a target the caller can't see answers like an unknown target", async () => {
    const { app, carol, dmId } = await dmSetup();
    const react = (id: string) => post(app, carol.cookie, { type: "reaction", targetMessageId: id, reaction: "👍" });
    expect(answer(await react(dmId))).toEqual(answer(await react("msg.does-not-exist")));
  });

  it("DELETE of a DM still being written answers a non-participant like an unknown id", async () => {
    const ollama = startMockOllama(["one ", "two ", "three ", "four ", "five"], { delayMs: 300 });
    cleanups.push(ollama.close);
    const app = await makeApp({ llm: { ollama: { enabled: true, baseUrl: await ollama.url, model: "m" } } });
    await newSession(app); // the admin
    const alice = await newSession(app);
    const carol = await newSession(app);
    await postOk(app, alice.cookie, {
      type: "dm",
      recipientUserId: BOT_ID,
      body: "hello",
      assistantDestinationRevision: await assistantRevision(app),
    });

    let streamingId: string | undefined;
    expect(
      await waitFor(async () => {
        const thread = await app.server.inject({ method: "GET", url: `/api/dms/${BOT_ID}`, headers: { cookie: alice.cookie } });
        streamingId = (thread.json() as Message[]).find((message) => message.authorId === BOT_ID && message.meta?.streaming)?.id;
        return streamingId !== undefined;
      }),
    ).toBe(true);

    const remove = (id: string) => app.server.inject({ method: "DELETE", url: `/api/messages/${id}`, headers: { cookie: carol.cookie } });
    expect(answer(await remove(streamingId!))).toEqual(answer(await remove("msg.does-not-exist")));
  });
});

describe("reactions on reactions", () => {
  it("are refused like an unknown target", async () => {
    const app = await makeApp();
    const alice = await newSession(app);
    const postId = await postOk(app, alice.cookie, { type: "channelPost", channelId: "general", body: "hello" });
    const reactionId = await postOk(app, alice.cookie, { type: "reaction", targetMessageId: postId, reaction: "👍" });
    const react = (id: string) => post(app, alice.cookie, { type: "reaction", targetMessageId: id, reaction: "🎉" });
    expect(answer(await react(reactionId))).toEqual(answer(await react("msg.does-not-exist")));
  });

  /** A post with a reaction, and two more reactions stacked under that one, written straight to the store. */
  async function storedChain(config?: unknown) {
    const { app, dataDir } = await makeApp(config);
    const alice = await newSession(app);
    const postId = await postOk(app, alice.cookie, { type: "channelPost", channelId: "general", body: "hello" });
    const first = await postOk(app, alice.cookie, { type: "reaction", targetMessageId: postId, reaction: "👍" });
    const now = Date.now();
    app.store.insertMessage(MessageSchema.parse({ id: "msg.r2", type: "reaction", authorId: alice.userId, targetMessageId: first, reaction: "🎉", createdAt: now }));
    app.store.insertMessage(MessageSchema.parse({ id: "msg.r3", type: "reaction", authorId: alice.userId, targetMessageId: "msg.r2", reaction: "🔥", createdAt: now }));
    const next = await reopenApp(app, dataDir);
    return { app: next, alice, ids: [postId, first, "msg.r2", "msg.r3"] };
  }

  it("go with their root when it is deleted", async () => {
    const { app, alice, ids } = await storedChain();
    const deleted = await app.server.inject({ method: "DELETE", url: `/api/messages/${ids[0]}`, headers: { cookie: alice.cookie } });
    expect(deleted.statusCode).toBe(200);
    expect(new Set((deleted.json() as { deletedIds: string[] }).deletedIds)).toEqual(new Set(ids));
    expect(app.store.loadMessages().filter((message) => ids.includes(message.id))).toEqual([]);
  });

  it("go with their root when the retention reaper takes it", async () => {
    const { app: first, dataDir } = await makeApp({ retention: { messageTtlMs: 60_000 } });
    const alice = await newSession(first);
    const old = Date.now() - 120_000;
    const now = Date.now();
    first.store.insertMessage(MessageSchema.parse({ id: "msg.root", type: "channelPost", authorId: alice.userId, channelId: "general", body: "old", createdAt: old }));
    first.store.insertMessage(MessageSchema.parse({ id: "msg.r1", type: "reaction", authorId: alice.userId, targetMessageId: "msg.root", reaction: "👍", createdAt: now }));
    first.store.insertMessage(MessageSchema.parse({ id: "msg.r2", type: "reaction", authorId: alice.userId, targetMessageId: "msg.r1", reaction: "🎉", createdAt: now }));
    const app = await reopenApp(first, dataDir);
    app.reapExpiredMessages();
    const left = app.store.loadMessages().map((message) => message.id);
    expect(left.filter((id) => ["msg.root", "msg.r1", "msg.r2"].includes(id))).toEqual([]);
  });
});

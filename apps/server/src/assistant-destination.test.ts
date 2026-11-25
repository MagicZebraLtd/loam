// A DM to the assistant names the destination its sender was shown (`assistantDestinationRevision`,
// docs/06 "What members are told"). The node advertises an opaque revision of the destination record with
// `NetworkConfig`, refuses (409 `assistant_destination_changed`) a DM to the assistant that names any other,
// before anything is stored, broadcast or sent to a backend, and checks again right before a reply starts.
// The local backend is the shared mock Ollama; the "online" one is `https://chat.example.com/v1`, reached
// through a `fetch` stub that records every request to it, so a test can prove nothing was sent there.
import { afterEach, describe, expect, it, vi } from "vitest";

import { type LoamConfig, type Message, MessageSchema, type StreamEvent, type User } from "@loam/schema";

import type { LoamApp } from "./app.js";
import { defaultLoamConfig } from "./config.js";
import { ASSISTANT_DESTINATION_CONFIG_KEY } from "./db.js";
import { ASSISTANT_FAILURE_BODY, createLlmLayer } from "./llm.js";
import type { Runtime } from "./runtime.js";
import {
  assistantRevision,
  cleanups,
  makeApp,
  newSession,
  reopenApp,
  startMockOllama,
  teardownApps,
} from "./test-support/app-harness.js";

const BOT_ID = "llm.ollama.gemma4";
const ONLINE_BASE_URL = "https://chat.example.com/v1";

afterEach(async () => {
  vi.restoreAllMocks();
  await teardownApps();
});

/**
 * Stub `fetch` for the online service: every request to chat.example.com is recorded (URL and body) and
 * answered with a one-delta SSE stream; anything else goes to the real `fetch` (the mock Ollama on loopback).
 */
function stubOnlineService(): { requests: { url: string; body: string }[] } {
  const requests: { url: string; body: string }[] = [];
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url).hostname !== "chat.example.com") {
      return realFetch(input, init);
    }
    requests.push({ url, body: typeof init?.body === "string" ? init.body : "" });
    const chunk = JSON.stringify({ id: "x", choices: [{ index: 0, delta: { content: "online answer" } }] });
    return new Response(`data: ${chunk}\n\ndata: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
  });
  return { requests };
}

type NetworkConfigView = { assistantDestination?: { kind: string; host?: string }; assistantDestinationRevision?: string };

/** `networkConfig` as `/api/bootstrap` (no cookie) or `/api/config` (with one) answers it. */
async function networkConfig(app: LoamApp, cookie?: string): Promise<NetworkConfigView> {
  const response = await app.server.inject({ method: "GET", url: cookie ? "/api/config" : "/api/bootstrap", headers: cookie ? { cookie } : {} });
  expect(response.statusCode).toBe(200);
  return (response.json() as { networkConfig: NetworkConfigView }).networkConfig;
}

/** Save `llm` as the admin and assert it was accepted. */
async function saveLlm(app: LoamApp, cookie: string, llm: Record<string, unknown>): Promise<void> {
  const saved = await app.server.inject({ method: "PATCH", url: "/api/admin/config", headers: { cookie }, payload: { llm } });
  expect(saved.statusCode).toBe(200);
}

/** POST a DM as `cookie`, with `revision` as its `assistantDestinationRevision` when given. */
async function postDm(app: LoamApp, cookie: string, recipientUserId: string, body: string, revision?: string) {
  return app.server.inject({
    method: "POST",
    url: "/api/messages",
    headers: { cookie },
    payload: { type: "dm", recipientUserId, body, ...(revision === undefined ? {} : { assistantDestinationRevision: revision }) },
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

type WireEvent = { type?: string; message?: Record<string, unknown> & { authorId?: string; body?: string } };

/** Open a cookie-authenticated socket on a listening app and collect what it receives. */
async function connect(app: LoamApp, cookie: string): Promise<WireEvent[]> {
  const baseUrl = await app.server.listen({ port: 0, host: "127.0.0.1" });
  return new Promise((resolve, reject) => {
    const socket = new (WebSocket as unknown as new (url: string, opts: unknown) => WebSocket)(`${baseUrl.replace("http", "ws")}/ws`, {
      headers: { cookie },
    });
    const events: WireEvent[] = [];
    socket.addEventListener("message", (event) => events.push(JSON.parse(String((event as MessageEvent).data)) as WireEvent));
    socket.addEventListener("open", () => {
      cleanups.push(() => socket.close());
      resolve(events);
    });
    socket.addEventListener("error", () => reject(new Error("websocket failed to connect")));
  });
}

/** The finished assistant replies in `cookie`'s DM with the bot. */
async function finishedReplies(app: LoamApp, cookie: string): Promise<{ body: string }[]> {
  const thread = (await app.server.inject({ method: "GET", url: `/api/dms/${BOT_ID}`, headers: { cookie } })).json() as {
    authorId: string;
    body: string;
    meta?: { streaming?: boolean };
  }[];
  return thread.filter((message) => message.authorId === BOT_ID && message.meta?.streaming === false);
}

describe("the assistant destination revision", () => {
  it("is advertised beside the destination, and absent while the assistant is off", async () => {
    const off = await makeApp();
    const offUser = await newSession(off);
    expect(await networkConfig(off)).not.toHaveProperty("assistantDestinationRevision");
    expect(await networkConfig(off, offUser.cookie)).not.toHaveProperty("assistantDestinationRevision");

    const on = await makeApp({ llm: { ollama: { enabled: true, baseUrl: "http://127.0.0.1:11434", model: "m" } } });
    const onUser = await newSession(on);
    const advertised = await networkConfig(on);
    expect(advertised.assistantDestination).toEqual({ kind: "host" });
    expect(advertised.assistantDestinationRevision).toMatch(/^[0-9a-f]{32}$/);
    expect((await networkConfig(on, onUser.cookie)).assistantDestinationRevision).toBe(advertised.assistantDestinationRevision);
  });

  it("stays the same across an unrelated save and a restart, and changes with provider, host, port, path and a switch back", async () => {
    const { app, dataDir } = await makeApp({ llm: { ollama: { enabled: true, baseUrl: "http://127.0.0.1:11434", model: "m" } } });
    const admin = await newSession(app);
    const first = await assistantRevision(app);
    expect(first).toBeDefined();

    const renamed = await app.server.inject({ method: "PATCH", url: "/api/admin/config", headers: { cookie: admin.cookie }, payload: { node: { name: "Renamed" } } });
    expect(renamed.statusCode).toBe(200);
    expect(await assistantRevision(app)).toBe(first);
    // A save that keeps the destination (a new model) doesn't change it either.
    await saveLlm(app, admin.cookie, { ollama: { model: "other-model" } });
    expect(await assistantRevision(app)).toBe(first);

    const reopened = await reopenApp(app, dataDir);
    expect(await assistantRevision(reopened)).toBe(first);

    const seen = [first];
    const changes: Record<string, unknown>[] = [
      { ollama: { baseUrl: "http://127.0.0.1:11435" } }, // port
      { ollama: { baseUrl: "http://127.0.0.1:11435/tenant" } }, // path
      { ollama: { baseUrl: "http://127.0.0.2:11435/tenant" } }, // host
      { openai: { enabled: true, baseUrl: "http://127.0.0.2:11435/tenant", model: "m" } }, // provider
      { openai: { enabled: false }, ollama: { baseUrl: "http://127.0.0.1:11434" } }, // back to the first
    ];
    for (const llm of changes) {
      await saveLlm(reopened, admin.cookie, llm);
      const next = await assistantRevision(reopened);
      expect(next).toMatch(/^[0-9a-f]{32}$/);
      expect(seen).not.toContain(next);
      seen.push(next);
    }
  });

  it("is random, not derived from the destination: two nodes with the same assistant advertise different ones", async () => {
    const llm = { ollama: { enabled: true, baseUrl: "http://127.0.0.1:11434", model: "m" } };
    const one = await makeApp({ llm });
    const two = await makeApp({ llm });

    const first = await assistantRevision(one);
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(await assistantRevision(two)).not.toBe(first);
  });

  it("gives a record an earlier version wrote a revision, keeping its history cut-off", async () => {
    const { app, dataDir } = await makeApp({ llm: { ollama: { enabled: true, baseUrl: "http://127.0.0.1:11434", model: "m" } } });
    const stored = JSON.parse(app.store.getConfigValue(ASSISTANT_DESTINATION_CONFIG_KEY) ?? "{}") as { key: string; rev?: string };
    expect(stored.rev).toBe(await assistantRevision(app));
    // As an earlier version left it: the destination and its cut-off, no revision.
    app.store.setConfigValue(ASSISTANT_DESTINATION_CONFIG_KEY, JSON.stringify({ key: stored.key, since: 1234 }));

    const reopened = await reopenApp(app, dataDir);
    const upgraded = await assistantRevision(reopened);
    expect(upgraded).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.parse(reopened.store.getConfigValue(ASSISTANT_DESTINATION_CONFIG_KEY) ?? "{}")).toEqual({
      key: stored.key,
      since: 1234,
      rev: upgraded,
    });
    expect(await assistantRevision(reopened)).toBe(upgraded);
  });
});

describe("a DM to the assistant names the destination its sender was shown", () => {
  it("is accepted and answered when it names the current one", async () => {
    const ollama = startMockOllama(["local answer"]);
    cleanups.push(ollama.close);
    const app = await makeApp({ llm: { ollama: { enabled: true, baseUrl: await ollama.url, model: "m" } } });
    const user = await newSession(app);

    const posted = await postDm(app, user.cookie, BOT_ID, "hello", await assistantRevision(app));
    expect(posted.statusCode).toBe(201);
    expect(await waitFor(async () => (await finishedReplies(app, user.cookie)).length === 1)).toBe(true);
    expect((await finishedReplies(app, user.cookie))[0]?.body).toBe("local answer");
    expect(ollama.requests).toHaveLength(1);
    // Request-only: neither the reply to the POST nor the stored row carries it.
    expect((posted.json() as { message: Record<string, unknown> }).message).not.toHaveProperty("assistantDestinationRevision");
    expect(app.store.loadMessages().find((message) => message.authorId === user.userId)).not.toHaveProperty("assistantDestinationRevision");
  });

  it("is refused when the host switched to an online service after the sender's screen last heard: nothing stored, broadcast or sent", async () => {
    const online = stubOnlineService();
    const ollama = startMockOllama(["local answer"]);
    cleanups.push(ollama.close);
    const app = await makeApp({ llm: { ollama: { enabled: true, baseUrl: await ollama.url, model: "m" } } });
    const admin = await newSession(app);
    const member = await newSession(app);
    const events = await connect(app, member.cookie);
    const local = await assistantRevision(app);

    await saveLlm(app, admin.cookie, { openai: { enabled: true, baseUrl: ONLINE_BASE_URL, model: "svc" } });
    expect((await networkConfig(app)).assistantDestination).toEqual({ kind: "online", host: "chat.example.com" });

    const refused = await postDm(app, member.cookie, BOT_ID, "written for the local model", local);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: "assistant_destination_changed" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ollama.requests).toHaveLength(0);
    expect(online.requests).toHaveLength(0);

    // A message sent with the new revision is delivered: its broadcast proves the socket is live, so the
    // absence of the refused one below is a real verdict.
    const current = await assistantRevision(app);
    expect(current).not.toBe(local);
    expect((await postDm(app, member.cookie, BOT_ID, "written for the online service", current)).statusCode).toBe(201);
    expect(await waitFor(() => events.some((event) => event.type === "messageCreated" && event.message?.body === "written for the online service"))).toBe(true);
    expect(await waitFor(() => online.requests.length === 1)).toBe(true);

    expect(events.some((event) => JSON.stringify(event).includes("written for the local model"))).toBe(false);
    const thread = (await app.server.inject({ method: "GET", url: `/api/dms/${BOT_ID}`, headers: { cookie: member.cookie } })).json() as { body: string }[];
    expect(thread.some((message) => message.body === "written for the local model")).toBe(false);
    expect(app.store.loadMessages().some((message) => "body" in message && message.body === "written for the local model")).toBe(false);
    // Neither backend ever saw the refused question: the local one got nothing, the online one only the resend.
    expect(ollama.requests).toHaveLength(0);
    expect(online.requests[0]?.body).toContain("written for the online service");
    expect(online.requests[0]?.body).not.toContain("written for the local model");
  });

  it("is refused the same way when it names no revision at all", async () => {
    const online = stubOnlineService();
    const ollama = startMockOllama(["local answer"]);
    cleanups.push(ollama.close);
    const app = await makeApp({ llm: { ollama: { enabled: true, baseUrl: await ollama.url, model: "m" } } });
    const admin = await newSession(app);
    const member = await newSession(app);

    const missing = await postDm(app, member.cookie, BOT_ID, "no revision, local");
    expect(missing.statusCode).toBe(409);
    expect(missing.json()).toMatchObject({ code: "assistant_destination_changed" });

    await saveLlm(app, admin.cookie, { openai: { enabled: true, baseUrl: ONLINE_BASE_URL, model: "svc" } });
    const missingOnline = await postDm(app, member.cookie, BOT_ID, "no revision, online");
    expect(missingOnline.statusCode).toBe(409);
    expect(missingOnline.json()).toMatchObject({ code: "assistant_destination_changed" });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(app.store.loadMessages().filter((message) => message.authorId === member.userId)).toHaveLength(0);
    expect(ollama.requests).toHaveLength(0);
    expect(online.requests).toHaveLength(0);
  });

  it("does not hold the assistant's busy slot when refused", async () => {
    const ollama = startMockOllama(["one", " two", " three"], { delayMs: 100 });
    cleanups.push(ollama.close);
    const app = await makeApp({ llm: { ollama: { enabled: true, baseUrl: await ollama.url, model: "m" } } });
    const member = await newSession(app);

    expect((await postDm(app, member.cookie, BOT_ID, "stale", "0".repeat(32))).statusCode).toBe(409);
    expect((await postDm(app, member.cookie, BOT_ID, "stale again")).statusCode).toBe(409);
    // One reply in flight per member: had a refusal taken the slot, this would be a 429.
    const accepted = await postDm(app, member.cookie, BOT_ID, "current", await assistantRevision(app));
    expect(accepted.statusCode).toBe(201);
    expect(await waitFor(async () => (await finishedReplies(app, member.cookie)).length === 1)).toBe(true);
  });
});

describe("a DM to a person", () => {
  it("ignores the revision, and neither stores nor broadcasts it", async () => {
    const app = await makeApp({ llm: { ollama: { enabled: true, baseUrl: "http://127.0.0.1:11434", model: "m" } } });
    const sender = await newSession(app);
    const recipient = await newSession(app);
    const events = await connect(app, recipient.cookie);

    const posted = await postDm(app, sender.cookie, recipient.userId, "hello person", "junk-revision");
    expect(posted.statusCode).toBe(201);
    expect((posted.json() as { message: Record<string, unknown> }).message).not.toHaveProperty("assistantDestinationRevision");

    expect(await waitFor(() => events.some((event) => event.type === "messageCreated" && event.message?.body === "hello person"))).toBe(true);
    const created = events.find((event) => event.type === "messageCreated" && event.message?.body === "hello person");
    expect(created?.message).not.toHaveProperty("assistantDestinationRevision");
    const stored = app.store.loadMessages().find((message) => "body" in message && message.body === "hello person");
    expect(stored).toBeDefined();
    expect(stored).not.toHaveProperty("assistantDestinationRevision");
  });
});

describe("the reply checks the destination again before it starts", () => {
  /**
   * A minimal live `Runtime` over a mutable config, enough for the LLM layer's reply path. `closeStore`
   * makes the config table unreadable, as a store an incomplete Emergency Reset left closed.
   */
  function fakeRuntime(appConfig: LoamConfig) {
    const configValues = new Map<string, string>();
    let closed = false;
    const users: User[] = [];
    const messages: Message[] = [];
    const streamEvents: StreamEvent[] = [];
    const runtime = {
      get appConfig() {
        return appConfig;
      },
      data: { users, channels: [], messages },
      store: {
        getConfigValue: (key: string) => {
          if (closed) {
            throw new Error("The database connection is not open");
          }
          return configValues.get(key);
        },
        setConfigValue: (key: string, value: string) => void configValues.set(key, value),
        insertMessage: () => undefined,
        upsertUser: () => undefined,
      },
      wipeGeneration: 0,
      log: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
      options: {},
      broadcast: () => undefined,
      broadcastStreamEvent: (_audience: Set<string>, event: StreamEvent) => void streamEvents.push(event),
      updateMessage: (message: Message, nextBody: string, streaming: boolean) =>
        Object.assign(message, MessageSchema.parse({ ...message, body: nextBody, meta: { ...message.meta, streaming } })),
      dmMessages: (peerId: string, userId: string) =>
        messages.filter(
          (message) =>
            message.type === "dm" &&
            ((message.authorId === peerId && message.recipientUserId === userId) ||
              (message.authorId === userId && message.recipientUserId === peerId)),
        ),
    };
    return { runtime: runtime as unknown as Runtime, messages, streamEvents, closeStore: () => void (closed = true) };
  }

  /** A member's DM to the bot, already "stored" as the route would have done. */
  function memberDm(messages: Message[]): Message {
    const dm = MessageSchema.parse({
      id: "msg_0123456789abcdef",
      type: "dm",
      authorId: "user.0123456789abcdef",
      recipientUserId: BOT_ID,
      body: "question",
      createdAt: Date.now(),
    });
    messages.push(dm);
    return dm;
  }

  it("contacts no backend and ends the reply as a failure when the destination changed after the DM was accepted", async () => {
    const first = startMockOllama(["first answer"]);
    const second = startMockOllama(["second answer"]);
    cleanups.push(first.close, second.close);
    const config = defaultLoamConfig();
    config.llm.ollama = { ...config.llm.ollama, enabled: true, baseUrl: await first.url };
    const { runtime, messages, streamEvents } = fakeRuntime(config);
    const llm = createLlmLayer(runtime);
    expect(llm.ensureBotUser()?.id).toBe(BOT_ID);
    const accepted = llm.destinationRevision();
    const dm = memberDm(messages);

    config.llm.ollama = { ...config.llm.ollama, baseUrl: await second.url };
    await llm.createAssistantResponse(dm, accepted);

    expect(first.requests).toHaveLength(0);
    expect(second.requests).toHaveLength(0);
    const reply = messages.find((message) => message.authorId === BOT_ID);
    expect(reply).toMatchObject({ body: ASSISTANT_FAILURE_BODY, meta: { streaming: false } });
    expect(streamEvents.at(-1)).toMatchObject({ type: "error", error: ASSISTANT_FAILURE_BODY });
  });

  it("answers as usual while the destination is the one the DM was accepted under", async () => {
    const backend = startMockOllama(["the answer"]);
    cleanups.push(backend.close);
    const config = defaultLoamConfig();
    config.llm.ollama = { ...config.llm.ollama, enabled: true, baseUrl: await backend.url };
    const { runtime, messages } = fakeRuntime(config);
    const llm = createLlmLayer(runtime);
    llm.ensureBotUser();
    const dm = memberDm(messages);

    await llm.createAssistantResponse(dm, llm.destinationRevision());

    expect(backend.requests).toHaveLength(1);
    expect(messages.find((message) => message.authorId === BOT_ID)).toMatchObject({ body: "the answer", meta: { streaming: false } });
  });

  it("treats an unreadable destination record as a change: no revision advertised, every DM stale, no backend contacted", async () => {
    const backend = startMockOllama(["the answer"]);
    cleanups.push(backend.close);
    const config = defaultLoamConfig();
    config.llm.ollama = { ...config.llm.ollama, enabled: true, baseUrl: await backend.url };
    const { runtime, messages, closeStore } = fakeRuntime(config);
    const llm = createLlmLayer(runtime);
    llm.ensureBotUser();
    const accepted = llm.destinationRevision();
    const dm = memberDm(messages);

    closeStore();
    expect(llm.destinationRevision()).toBeUndefined();
    expect(llm.assistantDestinationStale(BOT_ID, "user.0123456789abcdef", accepted)).toBe(true);
    expect(llm.assistantDestinationStale(BOT_ID, "user.0123456789abcdef", undefined)).toBe(true);
    // A DM to a person is still not the assistant's business.
    expect(llm.assistantDestinationStale("user.fedcba9876543210", "user.0123456789abcdef", undefined)).toBe(false);
    await llm.createAssistantResponse(dm, undefined);

    expect(backend.requests).toHaveLength(0);
    expect(messages.find((message) => message.authorId === BOT_ID)).toMatchObject({ body: ASSISTANT_FAILURE_BODY });
  });
});

describe("the history cut when the destination changes", () => {
  /** The stored destination record, parsed. */
  function storedRecord(app: LoamApp): { key: string; since: number; rev?: string } {
    return JSON.parse(app.store.getConfigValue(ASSISTANT_DESTINATION_CONFIG_KEY) ?? "{}") as { key: string; since: number; rev?: string };
  }

  it("sends a new destination none of the old turns after the host clock went back", async () => {
    const online = stubOnlineService();
    const ollama = startMockOllama(["local answer"]);
    cleanups.push(ollama.close);
    const app = await makeApp({ llm: { ollama: { enabled: true, baseUrl: await ollama.url, model: "m" } } });
    const admin = await newSession(app);
    expect((await postDm(app, admin.cookie, BOT_ID, "said to the local model", await assistantRevision(app))).statusCode).toBe(201);
    expect(await waitFor(async () => (await finishedReplies(app, admin.cookie)).length === 1)).toBe(true);

    // The host's clock goes back an hour (no network time, or a manual change), then the host goes online.
    const realNow = Date.now;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() - 3_600_000);
    await saveLlm(app, admin.cookie, { openai: { enabled: true, baseUrl: ONLINE_BASE_URL, model: "svc" } });

    expect((await postDm(app, admin.cookie, BOT_ID, "said to the online service", await assistantRevision(app))).statusCode).toBe(201);
    expect(await waitFor(() => online.requests.length === 1)).toBe(true);
    expect((JSON.parse(online.requests[0]?.body ?? "{}") as { messages: unknown }).messages).toEqual([
      { role: "user", content: "said to the online service" },
    ]);
  });

  it("treats a change of scheme as a change of destination", async () => {
    const online = stubOnlineService();
    const app = await makeApp({ llm: { openai: { enabled: true, baseUrl: ONLINE_BASE_URL, model: "svc" } } });
    const admin = await newSession(app);
    expect((await postDm(app, admin.cookie, BOT_ID, "said over https", await assistantRevision(app))).statusCode).toBe(201);
    expect(await waitFor(async () => (await finishedReplies(app, admin.cookie)).length === 1)).toBe(true);
    const before = await assistantRevision(app);

    await saveLlm(app, admin.cookie, { openai: { baseUrl: "http://chat.example.com/v1" } });
    const after = await assistantRevision(app);
    expect(after).toMatch(/^[0-9a-f]{32}$/);
    expect(after).not.toBe(before);
    expect((await postDm(app, admin.cookie, BOT_ID, "written for https", before)).statusCode).toBe(409);

    expect((await postDm(app, admin.cookie, BOT_ID, "said over http", after)).statusCode).toBe(201);
    expect(await waitFor(() => online.requests.length === 2)).toBe(true);
    expect(online.requests[1]?.url).toBe("http://chat.example.com/v1/chat/completions");
    expect((JSON.parse(online.requests[1]?.body ?? "{}") as { messages: unknown }).messages).toEqual([{ role: "user", content: "said over http" }]);
  });

  it("rewrites a record in the old scheme-less form for the same destination, keeping its cut-off and revision", async () => {
    const { app, dataDir } = await makeApp({ llm: { openai: { enabled: true, baseUrl: ONLINE_BASE_URL, model: "svc" } } });
    const rev = "ab".repeat(16);
    app.store.setConfigValue(ASSISTANT_DESTINATION_CONFIG_KEY, JSON.stringify({ key: "openai:chat.example.com/v1", since: 1234, rev }));

    const reopened = await reopenApp(app, dataDir);
    expect(await assistantRevision(reopened)).toBe(rev);
    expect(storedRecord(reopened)).toEqual({ key: "openai:https://chat.example.com/v1", since: 1234, rev });
  });

  it("still counts a record in the old form for another host as a change", async () => {
    const { app, dataDir } = await makeApp({ llm: { openai: { enabled: true, baseUrl: ONLINE_BASE_URL, model: "svc" } } });
    const rev = "cd".repeat(16);
    app.store.setConfigValue(ASSISTANT_DESTINATION_CONFIG_KEY, JSON.stringify({ key: "openai:other.example.com/v1", since: 1234, rev }));

    const reopened = await reopenApp(app, dataDir);
    const current = await assistantRevision(reopened);
    expect(current).toMatch(/^[0-9a-f]{32}$/);
    expect(current).not.toBe(rev);
    const record = storedRecord(reopened);
    expect(record.key).toBe("openai:https://chat.example.com/v1");
    expect(record.since).toBeGreaterThan(1234);
  });
});

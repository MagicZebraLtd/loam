import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApp, type LoamApp } from "./app.js";
import { defaultLoamConfig, sanitizeLegacyFullConfigJson } from "./config.js";

// The OpenAI-compatible backend ("chat service": OpenRouter, OpenAI, LM Studio...), the write-only API
// key, the model-list endpoint and the hardened-network rule. The service is mocked with a tiny local
// `node:http` server that speaks the SSE shape `streamOpenAiChat` parses and the `/models` list
// `listModels` reads, and checks the Authorization header it is sent. Ollama is mocked the same way where
// a test needs its `/api/tags`. Boots are on throwaway data dirs; every session shares 127.0.0.1, so the
// per-IP identity cap is lifted.

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()?.();
  }
});

const BOT_ID = "llm.ollama.gemma4";
const KEY = "sk-or-v1-test-key";

async function makeApp(config?: unknown): Promise<LoamApp> {
  const dataDir = mkdtempSync(join(tmpdir(), "loam-llm-providers-"));
  if (config !== undefined) {
    writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));
  }
  const app = await buildApp({ requireRulesAcceptance: false, dataDir, logger: false, maxNewIdentitiesPerWindow: 1_000_000 });
  cleanups.push(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return app;
}

function sessionCookie(response: { headers: Record<string, unknown> }): string {
  const header = response.headers["set-cookie"];
  const first = Array.isArray(header) ? (header[0] as string) : (header as string | undefined);
  const cookie = first?.split(";")[0];
  if (!cookie?.startsWith("loam_session=")) {
    throw new Error("No session cookie in response");
  }
  return cookie;
}

/** The first session on a fresh node: an admin (`firstUser` bootstrap). */
async function adminSession(app: LoamApp): Promise<{ cookie: string; userId: string }> {
  const response = await app.server.inject({ method: "GET", url: "/api/config" });
  const body = response.json() as { currentUser: { id: string; isAdmin: boolean } };
  if (!body.currentUser.isAdmin) {
    throw new Error("the first session should be the admin");
  }
  return { cookie: sessionCookie(response), userId: body.currentUser.id };
}

type Seen = { path: string; authorization?: string; body?: { model?: string; stream?: boolean; messages?: unknown[] } };

/**
 * A mock OpenAI-compatible service. `POST /chat/completions` streams `deltas` as SSE chunks (with a
 * comment line first, as OpenRouter sends while a model loads) and ends with `[DONE]`; `GET /models` lists
 * `models`. Both answer 401 unless the bearer key is `key` (or `key` is undefined). Every request is
 * recorded with its Authorization header so a test can prove what the key did, and didn't, reach.
 */
function startChatService(opts: { deltas?: string[]; models?: string[]; key?: string; modelsStatus?: number } = {}) {
  const seen: Seen[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk));
    req.on("end", () => {
      void (async () => {
        // Real services live under a `/v1` prefix; the mock answers with or without it, so a test can
        // prove `joinUrl` keeps the prefix a base URL was saved with.
        const path = (req.url ?? "").replace(/^\/v1(?=\/)/, "");
        const entry: Seen = { path: req.url ?? "", authorization: req.headers.authorization };
        try {
          entry.body = JSON.parse(raw || "{}") as Seen["body"];
        } catch {
          // Irrelevant to the behaviour under test.
        }
        seen.push(entry);

        if (opts.key !== undefined && req.headers.authorization !== `Bearer ${opts.key}`) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Invalid API key" } }));
          return;
        }

        if (req.method === "GET" && path === "/models") {
          res.writeHead(opts.modelsStatus ?? 200, { "content-type": "application/json" });
          res.end(JSON.stringify({ object: "list", data: (opts.models ?? []).map((id) => ({ id, object: "model" })) }));
          return;
        }

        if (req.method === "POST" && path === "/chat/completions") {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(": OPENROUTER PROCESSING\n\n");
          for (const delta of opts.deltas ?? []) {
            res.write(`data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: { content: delta } }] })}\n\n`);
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          res.write(`data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
          res.end("data: [DONE]\n\n");
          return;
        }

        res.writeHead(404);
        res.end();
      })();
    });
  });
  const url = new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`));
  });
  // Our mock mounts at the root; the "/v1" suffix in the base URL is what real services use and what
  // `joinUrl` must strip nothing from, so the mock answers the un-prefixed paths and ignores "/v1".
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { url: url.then((u) => u.replace(/\/v1$/, "")), seen };
}

/** A mock Ollama answering only `GET /api/tags`. */
function startOllamaTags(models: string[]) {
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/api/tags") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: models.map((name) => ({ name, model: name })) }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const url = new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return url;
}

/** A `http://127.0.0.1:<port>` URL nothing is listening on. */
async function unusedLocalUrl(): Promise<string> {
  const probe = createServer();
  const url = await new Promise<string>((resolve) => {
    probe.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(probe.address() as AddressInfo).port}`));
  });
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return url;
}

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 4_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
}

type DmRow = { authorId: string; body: string; meta?: { streaming?: boolean; model?: string } };

async function botReplies(app: LoamApp, cookie: string): Promise<DmRow[]> {
  const response = await app.server.inject({ method: "GET", url: `/api/dms/${BOT_ID}`, headers: { cookie } });
  return (response.json() as DmRow[]).filter((row) => row.authorId === BOT_ID);
}

/** DM the bot and wait for its reply to finish streaming. */
async function askBot(app: LoamApp, cookie: string, body: string): Promise<DmRow | undefined> {
  const posted = await app.server.inject({
    method: "POST",
    url: "/api/messages",
    headers: { cookie },
    payload: { type: "dm", recipientUserId: BOT_ID, body },
  });
  expect(posted.statusCode).toBe(201);
  await waitFor(async () => (await botReplies(app, cookie)).some((row) => row.meta?.streaming === false));
  return (await botReplies(app, cookie)).find((row) => row.meta?.streaming === false);
}

async function adminConfig(
  app: LoamApp,
  cookie: string,
): Promise<{ security: { profile: string }; llm: { openai: { enabled: boolean; apiKey?: string; apiKeySet?: boolean; baseUrl: string } } }> {
  const response = await app.server.inject({ method: "GET", url: "/api/admin/config", headers: { cookie } });
  return response.json();
}

/** The config row as the DB holds it: the one place the key is meant to be. */
function storedConfig(app: LoamApp): { llm: { openai: { apiKey?: string; apiKeySet?: boolean } } } {
  return JSON.parse(app.store.getConfigValue("config") ?? "{}");
}

async function assistantAdvertised(app: LoamApp): Promise<boolean> {
  const response = await app.server.inject({ method: "GET", url: "/api/bootstrap" });
  return (response.json() as { networkConfig: { enableLLMChat: boolean } }).networkConfig.enableLLMChat;
}

async function listModels(app: LoamApp, cookie: string, payload: Record<string, unknown>) {
  return await app.server.inject({ method: "POST", url: "/api/admin/llm/models", headers: { cookie }, payload });
}

describe("the OpenAI-compatible chat service", () => {
  it("answers a DM through /chat/completions with the bearer key, converging to one reply labelled with its model", async () => {
    const service = startChatService({ deltas: ["Hello", " there", "."], key: KEY });
    const app = await makeApp({ llm: { openai: { enabled: true, baseUrl: `${await service.url}/v1`, model: "test/model", apiKey: KEY } } });
    const { cookie } = await adminSession(app);

    const reply = await askBot(app, cookie, "hi");
    expect(reply?.body).toBe("Hello there.");
    expect(reply?.meta?.model).toBe("test/model");

    const chat = service.seen.find((entry) => entry.path === "/v1/chat/completions");
    expect(chat?.authorization).toBe(`Bearer ${KEY}`);
    expect(chat?.body).toMatchObject({ model: "test/model", stream: true });
    expect(chat?.body?.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("sends no Authorization header when no key is set (a local server)", async () => {
    const service = startChatService({ deltas: ["ok"] });
    const app = await makeApp({ llm: { openai: { enabled: true, baseUrl: await service.url, model: "local" } } });
    const { cookie } = await adminSession(app);

    expect((await askBot(app, cookie, "hi"))?.body).toBe("ok");
    expect(service.seen[0]?.authorization).toBeUndefined();
  });

  it("takes precedence over Ollama when both are enabled", async () => {
    const service = startChatService({ deltas: ["from the service"] });
    const app = await makeApp({
      llm: {
        ollama: { enabled: true, baseUrl: await unusedLocalUrl() },
        openai: { enabled: true, baseUrl: await service.url, model: "svc" },
      },
    });
    const { cookie } = await adminSession(app);
    const reply = await askBot(app, cookie, "hi");
    expect(reply?.body).toBe("from the service");
    expect(reply?.meta?.model).toBe("svc");
  });

  it("shows the member one plain sentence when the service refuses the key; the detail stays off the wire", async () => {
    const service = startChatService({ deltas: ["never"], key: KEY });
    const app = await makeApp({ llm: { openai: { enabled: true, baseUrl: await service.url, model: "m", apiKey: "wrong" } } });
    const { cookie } = await adminSession(app);

    const reply = await askBot(app, cookie, "hi");
    expect(reply?.body).toContain("could not answer");
    expect(reply?.body).not.toMatch(/401|Invalid API key|127\.0\.0\.1/);
  });
});

describe("the chat service's API key", () => {
  it("is never returned by the admin API or the host API, which say only whether one is set", async () => {
    const app = await makeApp({ llm: { openai: { enabled: false, baseUrl: "https://openrouter.ai/api/v1", model: "m", apiKey: KEY } } });
    const { cookie } = await adminSession(app);

    const config = await adminConfig(app, cookie);
    expect(config.llm.openai.apiKey).toBeUndefined();
    expect(config.llm.openai.apiKeySet).toBe(true);
    expect(JSON.stringify(config)).not.toContain(KEY);

    const hostView = app.host.config();
    expect(hostView.llm.openai.apiKey).toBeUndefined();
    expect(hostView.llm.openai.apiKeySet).toBe(true);
  });

  it("is kept by a save that leaves it out, cleared by an empty string, and never stored as apiKeySet", async () => {
    const service = startChatService({ models: ["b-model", "a-model"], key: KEY });
    const app = await makeApp({ llm: { openai: { enabled: false, baseUrl: await service.url, model: "m", apiKey: KEY } } });
    const { cookie } = await adminSession(app);

    // The admin screen round-trips the redacted block (no apiKey, apiKeySet: true) with an edit.
    const saved = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie },
      payload: { llm: { openai: { enabled: true, baseUrl: await service.url, model: "a-model", apiKeySet: true } } },
    });
    expect(saved.statusCode).toBe(200);
    expect((await adminConfig(app, cookie)).llm.openai.apiKeySet).toBe(true);
    expect(storedConfig(app).llm.openai.apiKey).toBe(KEY);
    expect(storedConfig(app).llm.openai.apiKeySet).toBeUndefined();

    // The stored key is what a test without a key in the request uses.
    const listed = await listModels(app, cookie, { provider: "openai" });
    expect(listed.json()).toEqual({ ok: true, models: ["a-model", "b-model"] });

    const cleared = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie },
      payload: { llm: { openai: { apiKey: "" } } },
    });
    expect(cleared.statusCode).toBe(200);
    expect((await adminConfig(app, cookie)).llm.openai.apiKeySet).toBe(false);
    expect(storedConfig(app).llm.openai.apiKey).toBeUndefined();
    expect((await listModels(app, cookie, { provider: "openai" })).json()).toEqual({ ok: false, code: "llm_unauthorized" });
  });
});

describe("POST /api/admin/llm/models", () => {
  it("lists Ollama's tags and a chat service's models, sorted, for the saved or the given connection", async () => {
    const ollamaUrl = await startOllamaTags(["qwen3", "gemma4", "gemma4"]);
    const service = startChatService({ models: ["z", "a"], key: KEY });
    const app = await makeApp({ llm: { ollama: { baseUrl: ollamaUrl } } });
    const { cookie } = await adminSession(app);

    expect((await listModels(app, cookie, { provider: "ollama" })).json()).toEqual({ ok: true, models: ["gemma4", "qwen3"] });
    // The chat service isn't saved yet: the screen tests the connection it is about to save.
    const given = await listModels(app, cookie, { provider: "openai", baseUrl: await service.url, apiKey: KEY });
    expect(given.json()).toEqual({ ok: true, models: ["a", "z"] });
    expect(service.seen[0]?.path).toBe("/models");
  });

  it("answers a code, not the service's words, when the backend is unreachable or refuses", async () => {
    const service = startChatService({ models: ["a"], key: KEY });
    const app = await makeApp();
    const { cookie } = await adminSession(app);

    expect((await listModels(app, cookie, { provider: "ollama", baseUrl: await unusedLocalUrl() })).json()).toEqual({ ok: false, code: "llm_unreachable" });
    expect((await listModels(app, cookie, { provider: "openai", baseUrl: await service.url, apiKey: "wrong" })).json()).toEqual({ ok: false, code: "llm_unauthorized" });
    const broken = startChatService({ modelsStatus: 500 });
    expect((await listModels(app, cookie, { provider: "openai", baseUrl: await broken.url })).json()).toEqual({ ok: false, code: "llm_bad_response" });
  });

  it("is admin-only and validates its body", async () => {
    const app = await makeApp();
    const admin = await adminSession(app);
    const member = await app.server.inject({ method: "GET", url: "/api/config" });

    const refused = await listModels(app, sessionCookie(member), { provider: "ollama" });
    expect(refused.statusCode).toBe(403);
    const invalid = await listModels(app, admin.cookie, { provider: "carrier-pigeon" });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: "invalid_llm_models_request" });
  });

  it("is reachable from the host API with the same answer", async () => {
    const ollamaUrl = await startOllamaTags(["llama3"]);
    const app = await makeApp();
    expect(await app.host.llmModels({ provider: "ollama", baseUrl: ollamaUrl })).toEqual({ ok: true, models: ["llama3"] });
  });
});

describe("a hardened network and a cloud assistant", () => {
  it("holds Ollama to the same rule as a service: an address off the local network is refused, a local one allowed", async () => {
    const app = await makeApp();
    const { cookie } = await adminSession(app);

    const cloud = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie },
      payload: { security: { profile: "hardened" }, llm: { ollama: { enabled: true, baseUrl: "https://ollama.example.com", model: "m" } } },
    });
    expect(cloud.statusCode).toBe(400);
    expect(cloud.json()).toMatchObject({ code: "llm_cloud_not_allowed" });
    expect((await adminConfig(app, cookie)).security.profile).toBe("custom");
    expect(await assistantAdvertised(app)).toBe(false);

    const local = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie },
      payload: { security: { profile: "hardened" }, llm: { ollama: { enabled: true, baseUrl: "http://192.168.1.20:11434", model: "m" } } },
    });
    expect(local.statusCode).toBe(200);
    expect(await assistantAdvertised(app)).toBe(true);

    // A hardened node booted from a hand-edited config.json pairing them advertises no assistant and won't
    // probe the public address either.
    const booted = await makeApp({ security: { profile: "hardened" }, llm: { ollama: { enabled: true, baseUrl: "https://ollama.example.com", model: "m" } } });
    expect(await assistantAdvertised(booted)).toBe(false);
    expect(booted.host.config().llm.ollama.enabled).toBe(true);
    expect(await booted.host.llmModels({ provider: "ollama", baseUrl: "https://ollama.example.com" })).toEqual({ ok: false, code: "llm_not_allowed" });
  });

  it("never follows a redirect off a local address on a hardened network, and follows one elsewhere", async () => {
    const target = startChatService({ models: ["behind-the-redirect"], deltas: ["followed"] });
    const targetUrl = await target.url;
    // A local address that answers every request with a redirect to the target: the locality check passes on
    // the address the admin typed, so the redirect is where the conversation would leak.
    const redirector = createServer((req, res) => {
      res.writeHead(307, { location: `${targetUrl}${req.url ?? ""}` });
      res.end();
    });
    const redirectorUrl = await new Promise<string>((resolve) => {
      redirector.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(redirector.address() as AddressInfo).port}`));
    });
    cleanups.push(() => new Promise<void>((resolve) => redirector.close(() => resolve())));

    const hardened = await makeApp({ security: { profile: "hardened" }, llm: { openai: { enabled: true, baseUrl: redirectorUrl, model: "m" } } });
    expect(await hardened.host.llmModels({ provider: "openai", baseUrl: redirectorUrl })).toEqual({ ok: false, code: "llm_unreachable" });
    expect(target.seen).toHaveLength(0);

    const open = await makeApp({ llm: { openai: { enabled: true, baseUrl: redirectorUrl, model: "m" } } });
    expect(await open.host.llmModels({ provider: "openai", baseUrl: redirectorUrl })).toEqual({ ok: true, models: ["behind-the-redirect"] });
    const { cookie } = await adminSession(open);
    expect((await askBot(open, cookie, "hi"))?.body).toBe("followed");
    expect(target.seen.map((entry) => entry.path)).toEqual(["/models", "/chat/completions"]);
  });
});

describe("a hardened network and a cloud chat service (OpenAI-compatible)", () => {
  it("refuses to save a cloud service under the hardened profile, but allows a local one", async () => {
    const app = await makeApp();
    const { cookie } = await adminSession(app);

    const cloud = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie },
      payload: { security: { profile: "hardened" }, llm: { openai: { enabled: true, baseUrl: "https://openrouter.ai/api/v1", model: "m" } } },
    });
    expect(cloud.statusCode).toBe(400);
    expect(cloud.json()).toMatchObject({ code: "llm_cloud_not_allowed" });
    expect((await adminConfig(app, cookie)).security.profile).toBe("custom");
    expect(await assistantAdvertised(app)).toBe(false);

    const local = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie },
      payload: { security: { profile: "hardened" }, llm: { openai: { enabled: true, baseUrl: "http://localhost:1234/v1", model: "m" } } },
    });
    expect(local.statusCode).toBe(200);
    expect(await assistantAdvertised(app)).toBe(true);

    // Switching to hardened later, with a cloud service already on, is refused the same way.
    const switched = await makeApp({ llm: { openai: { enabled: true, baseUrl: "https://api.openai.com/v1", model: "m", apiKey: KEY } } });
    const session = await adminSession(switched);
    const harden = await switched.server.inject({ method: "PATCH", url: "/api/admin/config", headers: { cookie: session.cookie }, payload: { security: { profile: "hardened" } } });
    expect(harden.statusCode).toBe(400);
  });

  it("boots with the assistant off (nothing advertised) when config.json pairs them, and won't list a cloud service's models", async () => {
    const service = startChatService({ models: ["a"] });
    const app = await makeApp({
      security: { profile: "hardened" },
      llm: { openai: { enabled: true, baseUrl: "https://openrouter.ai/api/v1", model: "m", apiKey: KEY } },
    });

    // Hardened requires transport encryption, so this test speaks through the host API, not a cookie session.
    expect(await assistantAdvertised(app)).toBe(false);
    expect(app.host.config().llm.openai.enabled).toBe(true);
    expect(await app.host.llmModels({ provider: "openai", baseUrl: "https://openrouter.ai/api/v1" })).toEqual({ ok: false, code: "llm_not_allowed" });
    // A local service is still listed under hardened.
    expect(await app.host.llmModels({ provider: "openai", baseUrl: await service.url })).toEqual({ ok: true, models: ["a"] });
  });
});

/** A mock Ollama answering `POST /api/chat` with newline-delimited JSON deltas; every request body is kept. */
function startOllamaChat(deltas: string[]) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk));
    req.on("end", () => {
      if (req.method !== "POST" || req.url !== "/api/chat") {
        res.writeHead(404);
        res.end();
        return;
      }
      seen.push({ path: req.url, body: JSON.parse(raw || "{}") as Seen["body"] });
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      for (const delta of deltas) {
        res.write(`${JSON.stringify({ message: { role: "assistant", content: delta }, done: false })}\n`);
      }
      res.end(`${JSON.stringify({ message: { role: "assistant", content: "" }, done: true })}\n`);
    });
  });
  const url = new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { url, seen };
}

async function advertisedDestination(app: LoamApp): Promise<unknown> {
  const response = await app.server.inject({ method: "GET", url: "/api/bootstrap" });
  return (response.json() as { networkConfig: { assistantDestination?: unknown } }).networkConfig.assistantDestination;
}

/** DM the bot and wait until it has finished `replies` replies in this conversation. */
async function askBotFor(app: LoamApp, cookie: string, body: string, replies: number): Promise<void> {
  const posted = await app.server.inject({
    method: "POST",
    url: "/api/messages",
    headers: { cookie },
    payload: { type: "dm", recipientUserId: BOT_ID, body },
  });
  expect(posted.statusCode).toBe(201);
  const done = await waitFor(async () => (await botReplies(app, cookie)).filter((row) => row.meta?.streaming === false).length >= replies);
  expect(done).toBe(true);
}

/** The destination record the history cut keys on. */
function destinationRecord(app: LoamApp): { key: string; since: number } | undefined {
  const raw = app.store.getConfigValue("assistantDestination");
  return raw === undefined ? undefined : (JSON.parse(raw) as { key: string; since: number });
}

describe("where the assistant's replies come from", () => {
  it("is advertised to every member: none while off, then this computer, the local network or an online service by hostname", async () => {
    expect(await advertisedDestination(await makeApp())).toBeUndefined();

    const local = startChatService();
    expect(await advertisedDestination(await makeApp({ llm: { openai: { enabled: true, baseUrl: await local.url, model: "m" } } }))).toEqual({
      kind: "host",
    });
    expect(
      await advertisedDestination(await makeApp({ llm: { ollama: { enabled: true, baseUrl: "http://localhost:11434", model: "m" } } })),
    ).toEqual({ kind: "host" });
    expect(
      await advertisedDestination(await makeApp({ llm: { ollama: { enabled: true, baseUrl: "http://192.168.1.20:11434", model: "m" } } })),
    ).toEqual({ kind: "lan" });
    // Named by hostname alone: no scheme, port or path (a path can carry an account or a deployment name).
    expect(
      await advertisedDestination(
        await makeApp({ llm: { openai: { enabled: true, baseUrl: "https://OpenRouter.ai:443/api/v1", model: "m", apiKey: KEY } } }),
      ),
    ).toEqual({ kind: "online", host: "openrouter.ai" });
    expect(
      await advertisedDestination(await makeApp({ llm: { ollama: { enabled: true, baseUrl: "https://ollama.example.com:8443/x", model: "m" } } })),
    ).toEqual({ kind: "online", host: "ollama.example.com" });
    expect(await advertisedDestination(await makeApp({ llm: { onDevice: { enabled: true } } }))).toEqual({ kind: "onDevice" });

    // Nothing was sent anywhere: advertising a destination is config only.
    expect(local.seen).toHaveLength(0);
  });

  it("follows a config save, and is gone when the assistant is turned off", async () => {
    const app = await makeApp({ llm: { ollama: { enabled: true, baseUrl: "http://127.0.0.1:11434", model: "m" } } });
    const { cookie } = await adminSession(app);
    expect(await advertisedDestination(app)).toEqual({ kind: "host" });

    const online = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie },
      payload: { llm: { openai: { enabled: true, baseUrl: "https://api.groq.com/openai/v1", model: "m" } } },
    });
    expect(online.statusCode).toBe(200);
    expect(await advertisedDestination(app)).toEqual({ kind: "online", host: "api.groq.com" });

    const off = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie },
      payload: { llm: { openai: { enabled: false }, ollama: { enabled: false } } },
    });
    expect(off.statusCode).toBe(200);
    expect(await advertisedDestination(app)).toBeUndefined();
  });
});

describe("the assistant's history across a change of destination", () => {
  it("sends the new destination only what was written after the change, and a restart keeps the cut", async () => {
    const before = startOllamaChat(["local answer"]);
    const after = startChatService({ deltas: ["service answer"] });
    const dataDir = mkdtempSync(join(tmpdir(), "loam-llm-destination-"));
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ llm: { ollama: { enabled: true, baseUrl: await before.url, model: "m" } } }));
    const boot = () => buildApp({ requireRulesAcceptance: false, dataDir, logger: false, maxNewIdentitiesPerWindow: 1_000_000 });
    let app = await boot();
    cleanups.push(async () => {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    });
    const { cookie } = await adminSession(app);

    // An unchanged assistant keeps everything it was told before this record existed.
    expect(destinationRecord(app)).toEqual({ key: `ollama:127.0.0.1`, since: 0 });
    await askBotFor(app, cookie, "first, said locally", 1);
    await askBotFor(app, cookie, "second, said locally", 2);
    expect(before.seen.at(-1)?.body?.messages).toHaveLength(3);

    const switched = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie },
      payload: { llm: { openai: { enabled: true, baseUrl: await after.url, model: "svc" } } },
    });
    expect(switched.statusCode).toBe(200);
    const record = destinationRecord(app);
    expect(record?.key).toBe("openai:127.0.0.1");
    expect(record?.since).toBeGreaterThan(0);

    await askBotFor(app, cookie, "third, after the switch", 3);
    expect(after.seen.at(-1)?.body?.messages).toEqual([{ role: "user", content: "third, after the switch" }]);

    // Same destination after a restart: the record and its cut-off stand.
    await app.close();
    app = await boot();
    expect(destinationRecord(app)).toEqual(record);
    await askBotFor(app, cookie, "fourth, after a restart", 4);
    expect(after.seen.at(-1)?.body?.messages).toEqual([
      { role: "user", content: "third, after the switch" },
      { role: "assistant", content: "service answer" },
      { role: "user", content: "fourth, after a restart" },
    ]);
    expect(JSON.stringify(after.seen)).not.toContain("said locally");
  });

  it("keeps the history when the same assistant is turned off and on again", async () => {
    const service = startChatService({ deltas: ["ok"] });
    const app = await makeApp({ llm: { openai: { enabled: true, baseUrl: await service.url, model: "m" } } });
    const { cookie } = await adminSession(app);
    await askBotFor(app, cookie, "before the pause", 1);

    for (const enabled of [false, true]) {
      const saved = await app.server.inject({ method: "PATCH", url: "/api/admin/config", headers: { cookie }, payload: { llm: { openai: { enabled } } } });
      expect(saved.statusCode).toBe(200);
    }
    expect(destinationRecord(app)?.since).toBe(0);

    await askBotFor(app, cookie, "after the pause", 2);
    expect(service.seen.at(-1)?.body?.messages).toEqual([
      { role: "user", content: "before the pause" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "after the pause" },
    ]);
  });
});

describe("the assistant's first destination record", () => {
  function record(app: LoamApp): { key: string; since: number } | undefined {
    const raw = app.store.getConfigValue("assistantDestination");
    return raw === undefined ? undefined : (JSON.parse(raw) as { key: string; since: number });
  }

  it("keeps an unchanged local assistant's history (since 0) but starts an online service's at the moment it is chosen", async () => {
    // A node upgraded with a local assistant on: its memory is kept.
    const local = await makeApp({ llm: { ollama: { enabled: true, baseUrl: "http://127.0.0.1:11434", model: "m" } } });
    expect(record(local)).toEqual({ key: "ollama:127.0.0.1", since: 0 });

    // A node upgraded with the assistant OFF (no record), whose members wrote to a local model under the old
    // version: the day the host picks an online service, those turns must not be uploaded.
    const before = Date.now();
    const switched = await makeApp();
    expect(record(switched)).toBeUndefined();
    const { cookie } = await adminSession(switched);
    const saved = await switched.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie },
      payload: { llm: { openai: { enabled: true, baseUrl: "https://openrouter.ai/api/v1", model: "m" } } },
    });
    expect(saved.statusCode).toBe(200);
    const online = record(switched);
    expect(online?.key).toBe("openai:openrouter.ai");
    expect(online?.since).toBeGreaterThanOrEqual(before);
  });
});

describe("an older wipe-journal snapshot", () => {
  it("gets the chat service block filled in (off) rather than failing validation", () => {
    const { llm, ...rest } = defaultLoamConfig();
    const { openai: _absent, ...olderLlm } = llm;
    void _absent;
    const { json, repairs } = sanitizeLegacyFullConfigJson({ ...rest, llm: olderLlm });
    expect((json as { llm: { openai: { enabled: boolean } } }).llm.openai).toEqual(defaultLoamConfig().llm.openai);
    expect(repairs.some((repair) => repair.includes("llm.openai"))).toBe(true);
  });
});

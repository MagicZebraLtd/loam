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

describe("a hardened network and a cloud chat service", () => {
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

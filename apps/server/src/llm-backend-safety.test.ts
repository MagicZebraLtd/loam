import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp, type LoamApp } from "./app.js";
import { defaultLoamConfig } from "./config.js";
import type { AppOptions } from "./types.js";
import {
  ASSISTANT_FAILURE_BODY,
  ASSISTANT_REPLY_CUT_OFF_NOTE,
  ASSISTANT_REPLY_MAX_CHARS,
  classifyBackendUrl,
  CLOUD_ASSISTANT_REFUSED,
  llmProviderRefusal,
} from "./llm.js";
import { assistantRevision } from "./test-support/app-harness.js";

// What an assistant backend can and can't make the node do: follow a redirect, hold an answer of any size,
// receive the saved API key at an address it wasn't saved for, or pass a `*.localhost` name off as this
// computer. Backends are tiny local `node:http` servers that record every request (with its Authorization
// header) and whether the node closed the connection; boots are on throwaway data dirs with the default
// (non-hardened) config unless a test says otherwise.

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (cleanups.length) {
    await cleanups.pop()?.();
  }
  delete (globalThis as { __loamOnDeviceChat?: unknown }).__loamOnDeviceChat;
});

const BOT_ID = "llm.ollama.gemma4";
const KEY = "sk-or-v1-saved-key";

/** A throwaway data dir, removed after the test. */
function dataDirWith(config?: unknown): string {
  const dataDir = mkdtempSync(join(tmpdir(), "loam-llm-safety-"));
  if (config !== undefined) {
    writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));
  }
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}

/**
 * Boot an app on `dataDir`, closed after the test unless the test closed it first (a restart). Every session
 * shares 127.0.0.1, so the identity cap is lifted.
 */
async function boot(dataDir: string, options: Partial<AppOptions> = {}): Promise<LoamApp> {
  const app = await buildApp({ requireRulesAcceptance: false, dataDir, logger: false, maxNewIdentitiesPerWindow: 1_000_000, ...options });
  const close = app.close.bind(app);
  let closing: Promise<void> | undefined;
  app.close = () => (closing ??= close());
  cleanups.push(() => app.close());
  return app;
}

async function makeApp(config?: unknown, options: Partial<AppOptions> = {}): Promise<LoamApp> {
  return boot(dataDirWith(config), options);
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
async function adminCookie(app: LoamApp): Promise<string> {
  const response = await app.server.inject({ method: "GET", url: "/api/config" });
  if (!(response.json() as { currentUser: { isAdmin: boolean } }).currentUser.isAdmin) {
    throw new Error("the first session should be the admin");
  }
  return sessionCookie(response);
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

type DmRow = { authorId: string; body: string; meta?: { streaming?: boolean } };

async function botReplies(app: LoamApp, cookie: string): Promise<DmRow[]> {
  const response = await app.server.inject({ method: "GET", url: `/api/dms/${BOT_ID}`, headers: { cookie } });
  return (response.json() as DmRow[]).filter((row) => row.authorId === BOT_ID);
}

/** DM the bot and wait for its reply to finish (streaming cleared). */
async function askBot(app: LoamApp, cookie: string, body: string, replies = 1): Promise<DmRow | undefined> {
  const posted = await app.server.inject({
    method: "POST",
    url: "/api/messages",
    headers: { cookie },
    payload: { type: "dm", recipientUserId: BOT_ID, body, assistantDestinationRevision: await assistantRevision(app) },
  });
  expect(posted.statusCode).toBe(201);
  const finished = async () => (await botReplies(app, cookie)).filter((row) => row.meta?.streaming === false);
  expect(await waitFor(async () => (await finished()).length >= replies)).toBe(true);
  return (await finished()).at(-1);
}

type Seen = { method: string; path: string; authorization?: string };

/**
 * A backend driven by `handle`. Every request is recorded, and `closed` counts responses whose connection
 * went away before the handler ended them (the node hanging up mid-answer).
 */
function startBackend(handle: (req: IncomingMessage, res: ServerResponse) => void) {
  const seen: Seen[] = [];
  let closed = 0;
  const server = createServer((req, res) => {
    seen.push({ method: req.method ?? "", path: req.url ?? "", authorization: req.headers.authorization });
    res.on("close", () => {
      if (!res.writableEnded) {
        closed += 1;
      }
    });
    req.resume();
    req.on("end", () => handle(req, res));
  });
  const url = new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { url, seen, closed: () => closed };
}

/** A backend that answers both the Ollama and the OpenAI-compatible shapes with one short reply. */
function startWorkingBackend() {
  return startBackend((req, res) => {
    const path = req.url ?? "";
    if (req.method === "GET" && path.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "reached" }] }));
    } else if (req.method === "GET" && path.endsWith("/api/tags")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [{ name: "reached" }] }));
    } else if (path.endsWith("/chat/completions")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "reached" } }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    } else if (path.endsWith("/api/chat")) {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.end(`${JSON.stringify({ message: { content: "reached" }, done: true })}\n`);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
}

/** One SSE chunk carrying `content`. */
function sseDelta(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`;
}

describe("a backend that answers with a redirect", () => {
  for (const status of [307, 308]) {
    it(`is never followed (${status}): the target gets nothing, a DM fails plainly and a model list is a bad response`, async () => {
      const target = startWorkingBackend();
      const targetUrl = await target.url;
      const redirector = startBackend((req, res) => {
        res.writeHead(status, { location: `${targetUrl}${req.url ?? ""}` });
        res.end();
      });
      const redirectorUrl = await redirector.url;

      const ollama = await makeApp({ llm: { ollama: { enabled: true, baseUrl: redirectorUrl, model: "m" } } });
      const ollamaCookie = await adminCookie(ollama);
      expect((await askBot(ollama, ollamaCookie, "my question"))?.body).toBe(ASSISTANT_FAILURE_BODY);
      expect(await ollama.host.llmModels({ provider: "ollama" })).toEqual({ ok: false, code: "llm_bad_response" });

      const service = await makeApp({ llm: { openai: { enabled: true, baseUrl: redirectorUrl, model: "m", apiKey: KEY } } });
      const serviceCookie = await adminCookie(service);
      expect((await askBot(service, serviceCookie, "my question"))?.body).toBe(ASSISTANT_FAILURE_BODY);
      expect(await service.host.llmModels({ provider: "openai" })).toEqual({ ok: false, code: "llm_bad_response" });

      expect(redirector.seen.map((entry) => `${entry.method} ${entry.path}`)).toEqual([
        "POST /api/chat",
        "GET /api/tags",
        "POST /chat/completions",
        "GET /models",
      ]);
      expect(target.seen).toHaveLength(0);
    });
  }

  it("is refused the same way when it points back at the same origin", async () => {
    const backend = startBackend((req, res) => {
      if ((req.url ?? "").startsWith("/moved")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "reached" }] }));
        return;
      }
      res.writeHead(308, { location: `/moved${req.url ?? ""}` });
      res.end();
    });
    const app = await makeApp({ llm: { openai: { enabled: true, baseUrl: await backend.url, model: "m" } } });
    const cookie = await adminCookie(app);

    expect((await askBot(app, cookie, "hi"))?.body).toBe(ASSISTANT_FAILURE_BODY);
    expect(await app.host.llmModels({ provider: "openai" })).toEqual({ ok: false, code: "llm_bad_response" });
    expect(backend.seen.map((entry) => entry.path)).toEqual(["/chat/completions", "/models"]);
  });

  it("logs the status and the target's hostname, never its credentials or path", async () => {
    const backend = startBackend((_req, res) => {
      res.writeHead(307, { location: "https://someone:hunter2@elsewhere.example/private-path?token=abc" });
      res.end();
    });
    const logs: string[] = [];
    const app = await makeApp(
      { llm: { openai: { enabled: true, baseUrl: await backend.url, model: "m" } } },
      { logger: true, logStream: { write: (line) => void logs.push(line) } },
    );
    const cookie = await adminCookie(app);
    expect((await askBot(app, cookie, "hi"))?.body).toBe(ASSISTANT_FAILURE_BODY);

    const logged = logs.join("\n");
    expect(logged).toContain("answered 307 with a redirect to elsewhere.example");
    expect(logged).toContain("does not follow redirects");
    expect(logged).not.toMatch(/hunter2|someone|private-path|token=abc/);
  });
});

describe("what a backend can make the node hold", () => {
  it("refuses a streamed line longer than the limit without waiting for its newline, and stores nothing oversized", async () => {
    // One Ollama line that would be a valid 270 000-character reply, if the node buffered it to the end.
    const backend = startBackend((_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write(`{"message":{"content":"${"x".repeat(270_000)}`);
      // ...and never a newline, nor an end.
    });
    const app = await makeApp({ llm: { ollama: { enabled: true, baseUrl: await backend.url, model: "m" } } });
    const cookie = await adminCookie(app);

    const reply = await askBot(app, cookie, "hi");
    expect(reply?.body).toBe(ASSISTANT_FAILURE_BODY);
    expect(app.store.loadMessages().every((message) => !("body" in message) || message.body.length < 1_000)).toBe(true);
    expect(await waitFor(() => backend.closed() === 1)).toBe(true);
  });

  it("refuses a streamed line longer than the limit that arrives whole with its newline", async () => {
    // Over a socket a 270 000-character line comes in several reads, the first of which the unterminated
    // check already catches; a fetch that hands the whole line and its newline over in one read is the
    // case left. Only the backend's address is answered this way.
    const backendUrl = "http://127.0.0.1:9";
    const line = `{"message":{"content":"${"x".repeat(270_000)}"},"done":false}\n{"done":true}\n`;
    const realFetch = globalThis.fetch;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      if (!String(input instanceof Request ? input.url : input).startsWith(backendUrl)) {
        return realFetch(input, init);
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(line));
          controller.close();
        },
      });
      return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson" } }));
    });
    cleanups.push(() => fetchSpy.mockRestore());
    const app = await makeApp({ llm: { ollama: { enabled: true, baseUrl: backendUrl, model: "m" } } });
    const cookie = await adminCookie(app);

    const reply = await askBot(app, cookie, "hi");
    expect(reply?.body).toBe(ASSISTANT_FAILURE_BODY);
  });

  it("cuts a reply at ASSISTANT_REPLY_MAX_CHARS: keeps what fits plus a note, ends the stream and hangs up on the backend", async () => {
    const chunk = "abcdefghij".repeat(100);
    const backend = startBackend((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      // 66 000 characters in 66 deltas, then the connection is held open as a runaway model's would be.
      for (let index = 0; index < 66; index += 1) {
        res.write(sseDelta(chunk));
      }
    });
    const app = await makeApp({ llm: { openai: { enabled: true, baseUrl: await backend.url, model: "m" } } });
    const cookie = await adminCookie(app);
    const address = await app.server.listen({ port: 0, host: "127.0.0.1" });
    const events: { type?: string; messageId?: string; text?: string }[] = [];
    const socket = new (WebSocket as unknown as new (url: string, opts: unknown) => WebSocket)(`${address.replace("http", "ws")}/ws`, {
      headers: { cookie },
    });
    cleanups.push(() => socket.close());
    socket.addEventListener("message", (event) => void events.push(JSON.parse(String((event as MessageEvent).data))));
    await new Promise((resolve) => socket.addEventListener("open", resolve));

    const reply = await askBot(app, cookie, "write me a novel");
    const kept = chunk.repeat(64);
    expect(kept.length).toBe(ASSISTANT_REPLY_MAX_CHARS);
    expect(reply?.body).toBe(`${kept}\n\n${ASSISTANT_REPLY_CUT_OFF_NOTE}`);
    expect(reply?.body.length).toBeLessThanOrEqual(ASSISTANT_REPLY_MAX_CHARS + 2 + ASSISTANT_REPLY_CUT_OFF_NOTE.length);

    // The members' clients got exactly the kept text, then the end of the stream.
    expect(await waitFor(() => events.some((event) => event.type === "end"))).toBe(true);
    expect(
      events
        .filter((event) => event.type === "delta")
        .map((event) => event.text)
        .join(""),
    ).toBe(kept);
    expect(events.filter((event) => event.type === "end")).toHaveLength(1);
    expect(events.some((event) => event.type === "error")).toBe(false);

    expect(await waitFor(() => backend.closed() === 1)).toBe(true);
  });

  it("cuts an on-device reply too, finalising it before waiting for the phone's model to stop", async () => {
    let finish: () => void = () => undefined;
    (globalThis as { __loamOnDeviceChat?: unknown }).__loamOnDeviceChat = (
      _messages: unknown,
      callbacks: { onDelta: (text: string) => void; onEnd: () => void },
    ) => {
      for (let index = 0; index < 70; index += 1) {
        callbacks.onDelta("y".repeat(1_000));
      }
      // The phone's model keeps going: it ends only when the test lets it.
      finish = callbacks.onEnd;
    };
    const app = await makeApp({ llm: { onDevice: { enabled: true, model: "phone" } } });
    const cookie = await adminCookie(app);

    const reply = await askBot(app, cookie, "hi");
    expect(reply?.body).toBe(`${"y".repeat(ASSISTANT_REPLY_MAX_CHARS)}\n\n${ASSISTANT_REPLY_CUT_OFF_NOTE}`);
    finish();
  });

  it("answers llm_bad_response for a model list over the byte cap", async () => {
    const pad = "z".repeat(8 * 1024 * 1024 + 1_024);
    const backend = startBackend((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(`{"data":[{"id":"listed"}],"pad":"${pad}"}`);
    });
    const app = await makeApp();
    expect(await app.host.llmModels({ provider: "openai", baseUrl: await backend.url })).toEqual({ ok: false, code: "llm_bad_response" });
  });

  it("reads only the start of a failed answer's body, for both a model list and a chat reply", async () => {
    const backend = startBackend((_req, res) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.write(`model not loaded\n${"e".repeat(1024 * 1024)}`);
      // ...and the body never ends.
    });
    const url = await backend.url;
    const app = await makeApp({ llm: { ollama: { enabled: true, baseUrl: url, model: "m" } } });

    const listed = await Promise.race([
      app.host.llmModels({ provider: "ollama" }),
      new Promise((resolve) => setTimeout(() => resolve("still reading"), 3_000)),
    ]);
    expect(listed).toEqual({ ok: false, code: "llm_bad_response" });

    const cookie = await adminCookie(app);
    expect((await askBot(app, cookie, "hi"))?.body).toBe(ASSISTANT_FAILURE_BODY);
    expect(await waitFor(() => backend.closed() === 2)).toBe(true);
  });
});

describe("a backend's error text and the host's log", () => {
  // A member's question, long and with every part distinct, so any 201-character run of it is unambiguous.
  const PROMPT = Array.from({ length: 60 }, (_, index) => `secret${String(index).padStart(2, "0")}`).join(" ");

  /** Ways a backend can fail by quoting the question back. */
  const failures: { name: string; provider: "ollama" | "openai"; handle: (res: ServerResponse) => void }[] = [
    {
      name: "an HTTP error from Ollama",
      provider: "ollama",
      handle: (res) => {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(`model failed on: ${PROMPT}`);
      },
    },
    {
      name: "an HTTP error from a chat service",
      provider: "openai",
      handle: (res) => {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `bad request: ${PROMPT}` } }));
      },
    },
    {
      name: "an error Ollama streamed",
      provider: "ollama",
      handle: (res) => {
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        res.end(`${JSON.stringify({ error: `model failed on: ${PROMPT}` })}\n`);
      },
    },
    {
      name: "an error a chat service streamed",
      provider: "openai",
      handle: (res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`data: ${JSON.stringify({ error: { message: `model failed on: ${PROMPT}` } })}\n\n`);
      },
    },
    {
      name: "a streamed line that is not JSON",
      provider: "ollama",
      handle: (res) => {
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        res.end(`${PROMPT}\n`);
      },
    },
  ];

  for (const failure of failures) {
    it(`keeps the question out of every line above debug, and logs at most 200 characters of it at debug: ${failure.name}`, async () => {
      const backend = startBackend((_req, res) => failure.handle(res));
      const logs: string[] = [];
      const app = await makeApp(
        { llm: { [failure.provider]: { enabled: true, baseUrl: await backend.url, model: "m" } } },
        { logger: true, logStream: { write: (line) => void logs.push(line) } },
      );
      app.host.setLogLevel("debug");
      const cookie = await adminCookie(app);

      // What the member sees is unchanged.
      expect((await askBot(app, cookie, PROMPT))?.body).toBe(ASSISTANT_FAILURE_BODY);

      const lines = logs.map((line) => JSON.parse(line) as { level: number });
      const above = lines.filter((line) => line.level > 20).map((line) => JSON.stringify(line));
      const debug = lines.filter((line) => line.level === 20).map((line) => JSON.stringify(line));
      expect(above.some((line) => line.includes("LLM backend error"))).toBe(true);
      expect(above.filter((line) => line.includes("secret"))).toEqual([]);
      expect(debug.some((line) => line.includes("secret00"))).toBe(true);
      for (let start = 0; start + 201 <= PROMPT.length; start += 1) {
        const run = PROMPT.slice(start, start + 201);
        expect(debug.some((line) => line.includes(run))).toBe(false);
      }
    });
  }
});

describe("the saved API key and the address it was saved for", () => {
  async function adminConfig(app: LoamApp, cookie: string): Promise<{ llm: { openai: { apiKeySet?: boolean; baseUrl: string } } }> {
    return (await app.server.inject({ method: "GET", url: "/api/admin/config", headers: { cookie } })).json();
  }

  function storedKey(app: LoamApp): string | undefined {
    return (JSON.parse(app.store.getConfigValue("config") ?? "{}") as { llm?: { openai?: { apiKey?: string } } }).llm?.openai?.apiKey;
  }

  async function patch(app: LoamApp, cookie: string, payload: Record<string, unknown>) {
    return await app.server.inject({ method: "PATCH", url: "/api/admin/config", headers: { cookie }, payload });
  }

  it("a model list only sends the saved key to the saved origin; a key typed into the request goes where it was asked", async () => {
    const saved = startWorkingBackend();
    const other = startWorkingBackend();
    const savedUrl = await saved.url;
    const otherUrl = await other.url;
    const app = await makeApp({ llm: { openai: { enabled: false, baseUrl: savedUrl, model: "m", apiKey: KEY } } });

    expect(await app.host.llmModels({ provider: "openai", baseUrl: otherUrl })).toEqual({ ok: true, models: ["reached"] });
    expect(other.seen.at(-1)?.authorization).toBeUndefined();

    // Same origin, another path: still the service the key was saved for.
    expect(await app.host.llmModels({ provider: "openai", baseUrl: `${savedUrl}/v1/` })).toEqual({ ok: true, models: ["reached"] });
    expect(saved.seen.at(-1)).toMatchObject({ path: "/v1/models", authorization: `Bearer ${KEY}` });
    expect(await app.host.llmModels({ provider: "openai" })).toEqual({ ok: true, models: ["reached"] });
    expect(saved.seen.at(-1)?.authorization).toBe(`Bearer ${KEY}`);

    expect(await app.host.llmModels({ provider: "openai", baseUrl: otherUrl, apiKey: "sk-typed" })).toEqual({ ok: true, models: ["reached"] });
    expect(other.seen.at(-1)?.authorization).toBe("Bearer sk-typed");
  });

  it("a save that moves the address to another origin without a key drops the saved key; a path change keeps it", async () => {
    const first = startWorkingBackend();
    const second = startWorkingBackend();
    const firstUrl = await first.url;
    const secondUrl = await second.url;
    const app = await makeApp({ llm: { openai: { enabled: true, baseUrl: firstUrl, model: "m", apiKey: KEY } } });
    const cookie = await adminCookie(app);

    // A path change on the same origin: the key stays and still goes with the chat request.
    expect((await patch(app, cookie, { llm: { openai: { baseUrl: `${firstUrl}/v1`, apiKeySet: true } } })).statusCode).toBe(200);
    expect((await adminConfig(app, cookie)).llm.openai.apiKeySet).toBe(true);
    expect((await askBot(app, cookie, "one"))?.body).toBe("reached");
    expect(first.seen.at(-1)).toMatchObject({ path: "/v1/chat/completions", authorization: `Bearer ${KEY}` });

    // Another origin, the screen echoing `apiKeySet: true` and no key: the saved key is gone.
    expect((await patch(app, cookie, { llm: { openai: { baseUrl: secondUrl, apiKeySet: true } } })).statusCode).toBe(200);
    expect((await adminConfig(app, cookie)).llm.openai.apiKeySet).toBe(false);
    expect(storedKey(app)).toBeUndefined();
    expect((await askBot(app, cookie, "two", 2))?.body).toBe("reached");
    expect(second.seen.at(-1)).toMatchObject({ path: "/chat/completions" });
    expect(second.seen.at(-1)?.authorization).toBeUndefined();

    // Another origin with a new key: that key is the one stored and sent.
    expect((await patch(app, cookie, { llm: { openai: { baseUrl: firstUrl, apiKey: "sk-new-key" } } })).statusCode).toBe(200);
    expect(storedKey(app)).toBe("sk-new-key");
    expect((await askBot(app, cookie, "three", 3))?.body).toBe("reached");
    expect(first.seen.at(-1)?.authorization).toBe("Bearer sk-new-key");
    expect(JSON.stringify(second.seen)).not.toContain(KEY);
  });

  it("the host API's save follows the same rule", async () => {
    const app = await makeApp({ llm: { openai: { enabled: false, baseUrl: "https://openrouter.ai/api/v1", model: "m", apiKey: KEY } } });

    const pathOnly = app.host.updateConfig({ llm: { openai: { baseUrl: "https://openrouter.ai/api/v2" } } });
    expect(pathOnly.ok && pathOnly.value.llm.openai.apiKeySet).toBe(true);
    const moved = app.host.updateConfig({ llm: { openai: { baseUrl: "https://api.groq.com/openai/v1" } } });
    expect(moved.ok && moved.value.llm.openai.apiKeySet).toBe(false);
    expect(storedKey(app)).toBeUndefined();
  });

  /** A data dir whose config.json saves the chat service at `baseUrl` with `KEY`, booted with an admin. */
  async function bootWithFileKey(baseUrl: string) {
    const dataDir = dataDirWith({ llm: { openai: { enabled: true, baseUrl, model: "m", apiKey: KEY } } });
    const app = await boot(dataDir);
    return { dataDir, app, cookie: await adminCookie(app) };
  }

  /** Close `app` and boot the same data dir again; the admin's session cookie still holds. */
  async function restart(app: LoamApp, dataDir: string): Promise<LoamApp> {
    await app.close();
    return boot(dataDir);
  }

  it("a key cleared by a save that moved the address to another origin stays cleared after a restart", async () => {
    const first = startWorkingBackend();
    const second = startWorkingBackend();
    const secondUrl = await second.url;
    const node = await bootWithFileKey(await first.url);

    expect((await patch(node.app, node.cookie, { llm: { openai: { baseUrl: secondUrl, apiKeySet: true } } })).statusCode).toBe(200);
    expect((await adminConfig(node.app, node.cookie)).llm.openai.apiKeySet).toBe(false);

    const app = await restart(node.app, node.dataDir);
    expect((await adminConfig(app, node.cookie)).llm.openai).toMatchObject({ baseUrl: secondUrl, apiKeySet: false });
    expect((await askBot(app, node.cookie, "hi"))?.body).toBe("reached");
    expect(second.seen.at(-1)?.authorization).toBeUndefined();
    expect(JSON.stringify(second.seen)).not.toContain(KEY);
  });

  it("a path change on the same origin keeps config.json's key after a restart", async () => {
    const first = startWorkingBackend();
    const firstUrl = await first.url;
    const node = await bootWithFileKey(firstUrl);

    expect((await patch(node.app, node.cookie, { llm: { openai: { baseUrl: `${firstUrl}/v1`, apiKeySet: true } } })).statusCode).toBe(200);

    const app = await restart(node.app, node.dataDir);
    expect((await adminConfig(app, node.cookie)).llm.openai).toMatchObject({ baseUrl: `${firstUrl}/v1`, apiKeySet: true });
    expect((await askBot(app, node.cookie, "hi"))?.body).toBe("reached");
    expect(first.seen.at(-1)).toMatchObject({ path: "/v1/chat/completions", authorization: `Bearer ${KEY}` });
  });

  it("a key saved through the admin API for a new origin survives a restart", async () => {
    const first = startWorkingBackend();
    const second = startWorkingBackend();
    const secondUrl = await second.url;
    const node = await bootWithFileKey(await first.url);

    expect((await patch(node.app, node.cookie, { llm: { openai: { baseUrl: secondUrl, apiKey: "sk-new-key" } } })).statusCode).toBe(200);

    const app = await restart(node.app, node.dataDir);
    expect((await adminConfig(app, node.cookie)).llm.openai).toMatchObject({ baseUrl: secondUrl, apiKeySet: true });
    expect((await askBot(app, node.cookie, "hi"))?.body).toBe("reached");
    expect(second.seen.at(-1)?.authorization).toBe("Bearer sk-new-key");
  });

  it("a stored address never takes config.json's key to another origin; a key stored with the address is kept", async () => {
    const fileBackend = startWorkingBackend();
    const savedBackend = startWorkingBackend();
    const fileUrl = await fileBackend.url;
    const savedUrl = await savedBackend.url;

    // The key comes from config.json, the address on another origin from an admin edit persisted without it.
    const fromFile = dataDirWith({ llm: { openai: { enabled: true, baseUrl: fileUrl, model: "m", apiKey: KEY } } });
    let app = await boot(fromFile);
    app.store.setConfigValue("config", JSON.stringify({ llm: { openai: { enabled: true, baseUrl: savedUrl, model: "m" } } }));
    await app.close();
    app = await boot(fromFile);
    let cookie = await adminCookie(app);
    expect((await adminConfig(app, cookie)).llm.openai).toMatchObject({ baseUrl: savedUrl, apiKeySet: false });
    expect((await askBot(app, cookie, "hi"))?.body).toBe("reached");
    expect(savedBackend.seen.at(-1)?.authorization).toBeUndefined();

    // A full snapshot an older version wrote after moving the address and keeping the key.
    const snapshot = defaultLoamConfig();
    snapshot.llm.openai = { enabled: true, baseUrl: savedUrl, model: "m", apiKey: KEY };
    const fromRow = dataDirWith({ llm: { openai: { baseUrl: fileUrl } } });
    app = await boot(fromRow);
    app.store.setConfigValue("config", JSON.stringify(snapshot));
    await app.close();
    app = await boot(fromRow);
    cookie = await adminCookie(app);
    expect((await adminConfig(app, cookie)).llm.openai).toMatchObject({ baseUrl: savedUrl, apiKeySet: true });
  });
});

describe("a *.localhost backend name", () => {
  it("is an online service, not this computer; only localhost and loopback literals are", () => {
    expect(classifyBackendUrl("http://ollama.localhost:11434")).toEqual({ kind: "online", host: "ollama.localhost" });
    expect(classifyBackendUrl("http://localhost:11434")).toEqual({ kind: "host" });
    expect(classifyBackendUrl("http://127.0.0.1:1234/v1")).toEqual({ kind: "host" });
    expect(classifyBackendUrl("http://[::1]:1234/v1")).toEqual({ kind: "host" });

    const hardened = defaultLoamConfig();
    hardened.security.profile = "hardened";
    hardened.llm.ollama = { ...hardened.llm.ollama, enabled: true, baseUrl: "http://ollama.localhost:11434" };
    expect(llmProviderRefusal(hardened)).toBe(CLOUD_ASSISTANT_REFUSED);
    for (const baseUrl of ["http://localhost:11434", "http://127.0.0.1:11434"]) {
      hardened.llm.ollama.baseUrl = baseUrl;
      expect(llmProviderRefusal(hardened), baseUrl).toBeUndefined();
    }
  });

  it("is refused on a hardened network when saved and at boot; localhost is still allowed", async () => {
    const app = await makeApp();
    const cookie = await adminCookie(app);
    const refused = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie },
      payload: { security: { profile: "hardened" }, llm: { ollama: { enabled: true, baseUrl: "http://ollama.localhost:11434", model: "m" } } },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ code: "llm_cloud_not_allowed" });
    const allowed = await app.server.inject({
      method: "PATCH",
      url: "/api/admin/config",
      headers: { cookie },
      payload: { security: { profile: "hardened" }, llm: { ollama: { enabled: true, baseUrl: "http://localhost:11434", model: "m" } } },
    });
    expect(allowed.statusCode).toBe(200);

    const booted = await makeApp({ security: { profile: "hardened" }, llm: { ollama: { enabled: true, baseUrl: "http://ollama.localhost:11434", model: "m" } } });
    const bootstrap = (await booted.server.inject({ method: "GET", url: "/api/bootstrap" })).json() as { networkConfig: { enableLLMChat: boolean } };
    expect(bootstrap.networkConfig.enableLLMChat).toBe(false);
    expect(await booted.host.llmModels({ provider: "ollama" })).toEqual({ ok: false, code: "llm_not_allowed" });
  });
});

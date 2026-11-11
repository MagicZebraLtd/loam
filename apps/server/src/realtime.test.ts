import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { openTransport, sealTransport, transportClientDerive, transportClientHello } from "@loam/crypto";
import { TransportHandshakeResponseSchema } from "@loam/schema";

import { buildApp, type LoamApp } from "./app.js";
import { WS_HEARTBEAT_INTERVAL_MS } from "./realtime.js";

// WebSocket heartbeat: every ADMITTED socket gets a content-free
// `{ type: "ping" }` immediately and then every WS_HEARTBEAT_INTERVAL_MS — sealed + sequenced on an
// encrypted socket, never before its key confirmation — so the client's watchdog can detect a dead
// connection. Only setInterval is faked; sockets, timeouts and I/O stay real.

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  vi.useRealTimers();
  while (cleanups.length) {
    await cleanups.pop()?.();
  }
});

async function makeApp(config?: unknown): Promise<LoamApp> {
  const dataDir = mkdtempSync(join(tmpdir(), "loam-realtime-test-"));
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

type RawWebSocket = {
  addEventListener: (event: string, listener: (event: unknown) => void) => void;
  send: (data: string) => void;
  close: () => void;
};

function openWs(url: string, cookie?: string): RawWebSocket {
  const socket = new (WebSocket as unknown as new (url: string, opts?: unknown) => RawWebSocket)(
    url,
    cookie ? { headers: { cookie } } : undefined,
  );
  cleanups.push(() => socket.close());
  return socket;
}

async function opened(socket: RawWebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("ws failed to connect")));
  });
}

async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(check()).toBe(true);
}

const isPing = (payload: string): boolean => (JSON.parse(payload) as { type?: unknown }).type === "ping";

describe("WebSocket heartbeat", () => {
  it("a plaintext socket gets a ping on admission and then every interval", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "optional" } });
    const config = await app.server.inject({ method: "GET", url: "/api/config" });
    const cookie = String(config.headers["set-cookie"]).split(";")[0]!;
    const baseUrl = await app.server.listen({ port: 0, host: "127.0.0.1" });

    const frames: string[] = [];
    const socket = openWs(`${baseUrl.replace("http", "ws")}/ws`, cookie);
    socket.addEventListener("message", (event) => frames.push(String((event as MessageEvent).data)));
    await opened(socket);

    await waitFor(() => frames.filter(isPing).length === 1); // the admission beat
    expect(frames.filter(isPing)).toEqual(['{"type":"ping"}']); // content-free

    vi.advanceTimersByTime(WS_HEARTBEAT_INTERVAL_MS);
    await waitFor(() => frames.filter(isPing).length === 2);
    vi.advanceTimersByTime(WS_HEARTBEAT_INTERVAL_MS);
    await waitFor(() => frames.filter(isPing).length === 3);
  });

  it("an encrypted socket gets NO ping before key confirmation, then sealed, sequenced pings", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "required" } });
    const baseUrl = await app.server.listen({ port: 0, host: "127.0.0.1" });

    // Handshake + bind an identity (docs/20) so the socket is admissible under `required`.
    const hello = transportClientHello();
    const handshake = TransportHandshakeResponseSchema.parse(
      (await app.server.inject({ method: "POST", url: "/api/transport/handshake", payload: { clientEphemeralPublic: hello.ephemeralPublic } })).json(),
    );
    const key = transportClientDerive({
      clientEphemeralSecret: hello.ephemeralSecret,
      hostPublic: handshake.hostPublicKey,
      hostEphemeralPublic: handshake.hostEphemeralPublic,
    });
    const resume = await app.server.inject({
      method: "POST",
      url: "/api/session/resume",
      headers: { "x-loam-enc": handshake.sessionId, "content-type": "application/json" },
      payload: { enc: sealTransport(key, JSON.stringify({ s: 1, b: {} }), "POST /api/session/resume") },
    });
    expect(resume.statusCode).toBe(200);

    const raw: string[] = [];
    const payloads: { q: number; f: string }[] = [];
    let connectionId = "";
    let challenge: { connectionId: string; nonce: string } | undefined;
    const socket = openWs(`${baseUrl.replace("http", "ws")}/ws?enc=${handshake.sessionId}`);
    socket.addEventListener("message", (event) => {
      const text = String((event as MessageEvent).data);
      raw.push(text);
      if (!connectionId) {
        const opened = openTransport(key, text, "loam.ws.challenge.v1");
        if (opened) {
          challenge = JSON.parse(opened) as { connectionId: string; nonce: string };
        }
        return;
      }
      const frame = openTransport(key, text, `loam.ws.frame.v1 ${connectionId}`);
      if (frame) {
        payloads.push(JSON.parse(frame) as { q: number; f: string });
      }
    });
    await opened(socket);
    await waitFor(() => challenge !== undefined);

    // Unconfirmed: a whole interval passes and nothing but the challenge arrives.
    vi.advanceTimersByTime(WS_HEARTBEAT_INTERVAL_MS);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(raw).toHaveLength(1);

    connectionId = challenge!.connectionId;
    socket.send(
      sealTransport(key, JSON.stringify({ type: "proof", connectionId, nonce: challenge!.nonce }), "loam.ws.proof.v1"),
    );
    await waitFor(() => payloads.some((entry) => isPing(entry.f)));
    vi.advanceTimersByTime(WS_HEARTBEAT_INTERVAL_MS);
    await waitFor(() => payloads.filter((entry) => isPing(entry.f)).length === 2);

    // Never plaintext on the wire, and sequenced like every other frame.
    expect(raw.some((text) => text.includes("ping"))).toBe(false);
    // Strictly increasing: a repeated sequence number is exactly what a replayed frame would look like.
    const seqs = payloads.map((entry) => entry.q);
    expect(seqs.length).toBeGreaterThanOrEqual(2);
    for (let index = 1; index < seqs.length; index += 1) {
      expect(seqs[index]).toBeGreaterThan(seqs[index - 1]!);
    }
  });

  it("stops beating once the socket closes", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "optional" } });
    const config = await app.server.inject({ method: "GET", url: "/api/config" });
    const cookie = String(config.headers["set-cookie"]).split(";")[0]!;
    const baseUrl = await app.server.listen({ port: 0, host: "127.0.0.1" });
    const intervalsBefore = vi.getTimerCount(); // the app's own intervals (reapers etc.)

    let pings = 0;
    const socket = openWs(`${baseUrl.replace("http", "ws")}/ws`, cookie);
    socket.addEventListener("message", (event) => {
      if (isPing(String((event as MessageEvent).data))) {
        pings += 1;
      }
    });
    await opened(socket);
    await waitFor(() => pings === 1);
    expect(vi.getTimerCount()).toBe(intervalsBefore + 1); // this socket's heartbeat

    socket.close();
    await waitFor(() => vi.getTimerCount() === intervalsBefore); // cleared on close — no leaked interval
  });
});

/** A fresh cookie identity: `/api/config` with no cookie mints one. */
async function mintCookie(app: LoamApp): Promise<string> {
  const config = await app.server.inject({ method: "GET", url: "/api/config" });
  return String(config.headers["set-cookie"]).split(";")[0]!;
}

type Frame = { type?: string; code?: string; onlineUserIds?: string[] };

/** A plaintext cookie socket that records every frame it receives and whether it has closed. */
async function recordingSocket(baseUrl: string, cookie: string) {
  const frames: Frame[] = [];
  let closed = false;
  const socket = openWs(`${baseUrl.replace("http", "ws")}/ws`, cookie);
  socket.addEventListener("message", (event) => frames.push(JSON.parse(String((event as MessageEvent).data)) as Frame));
  socket.addEventListener("close", () => {
    closed = true;
  });
  await opened(socket);
  return { socket, frames, isClosed: () => closed };
}

/** Handshake, bind an identity and open a key-confirmed socket; records the decrypted application frames. */
async function boundSocket(app: LoamApp, baseUrl: string) {
  const hello = transportClientHello();
  const handshake = TransportHandshakeResponseSchema.parse(
    (await app.server.inject({ method: "POST", url: "/api/transport/handshake", payload: { clientEphemeralPublic: hello.ephemeralPublic } })).json(),
  );
  const key = transportClientDerive({
    clientEphemeralSecret: hello.ephemeralSecret,
    hostPublic: handshake.hostPublicKey,
    hostEphemeralPublic: handshake.hostEphemeralPublic,
  });
  const resume = await app.server.inject({
    method: "POST",
    url: "/api/session/resume",
    headers: { "x-loam-enc": handshake.sessionId, "content-type": "application/json" },
    payload: { enc: sealTransport(key, JSON.stringify({ s: 1, b: {} }), "POST /api/session/resume") },
  });
  expect(resume.statusCode).toBe(200);
  return { ...(await provenSocket(baseUrl, key, handshake.sessionId)), key, sessionId: handshake.sessionId };
}

/** Open a socket on an existing transport session and answer its key-confirmation challenge. */
async function provenSocket(baseUrl: string, key: string, sessionId: string, options: { waitForPing?: boolean } = {}) {
  const frames: Frame[] = [];
  let connectionId = "";
  let closed = false;
  const socket = openWs(`${baseUrl.replace("http", "ws")}/ws?enc=${sessionId}`);
  socket.addEventListener("message", (event) => {
    const text = String((event as MessageEvent).data);
    if (!connectionId) {
      const challenge = openTransport(key, text, "loam.ws.challenge.v1");
      if (challenge) {
        const parsed = JSON.parse(challenge) as { connectionId: string; nonce: string };
        connectionId = parsed.connectionId;
        socket.send(sealTransport(key, JSON.stringify({ type: "proof", connectionId, nonce: parsed.nonce }), "loam.ws.proof.v1"));
      }
      return;
    }
    const frame = openTransport(key, text, `loam.ws.frame.v1 ${connectionId}`);
    if (frame) {
      frames.push(JSON.parse((JSON.parse(frame) as { f: string }).f) as Frame);
    }
  });
  socket.addEventListener("close", () => {
    closed = true;
  });
  await opened(socket);
  if (options.waitForPing !== false) {
    await waitFor(() => frames.some((frame) => frame.type === "ping"));
  }
  return { socket, frames, isClosed: () => closed };
}

const presenceOf = (frames: Frame[]): Frame[] => frames.filter((frame) => frame.type === "presence");

describe("WebSocket admission caps (review F-003)", () => {
  async function makeCappedApp(webSocketLimits: NonNullable<Parameters<typeof buildApp>[0]>["webSocketLimits"]) {
    const dataDir = mkdtempSync(join(tmpdir(), "loam-realtime-test-"));
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ security: { profile: "custom", transportEncryption: "optional" } }));
    const app = await buildApp({
      requireRulesAcceptance: false,
      dataDir,
      logger: false,
      maxNewIdentitiesPerWindow: 1_000_000,
      webSocketLimits,
    });
    cleanups.push(async () => {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    });
    return { app, baseUrl: await app.server.listen({ port: 0, host: "127.0.0.1" }) };
  }

  it("refuses a socket past the per-identity cap, and other identities still connect", async () => {
    const { app, baseUrl } = await makeCappedApp({ perIdentity: 2 });
    const cookie = await mintCookie(app);
    await recordingSocket(baseUrl, cookie);
    await recordingSocket(baseUrl, cookie);
    const third = await recordingSocket(baseUrl, cookie);
    await waitFor(third.isClosed);
    expect(third.frames).toContainEqual(expect.objectContaining({ type: "error", code: "too_many_attempts" }));
    expect(app.sockets.size).toBe(2);

    const other = await recordingSocket(baseUrl, await mintCookie(app));
    await waitFor(() => other.frames.some((frame) => frame.type === "ping"));
    expect(other.isClosed()).toBe(false);
    expect(app.sockets.size).toBe(3);
  });

  it("refuses a socket past the per-address and total caps", async () => {
    const perAddress = await makeCappedApp({ perAddress: 2 });
    await recordingSocket(perAddress.baseUrl, await mintCookie(perAddress.app));
    await recordingSocket(perAddress.baseUrl, await mintCookie(perAddress.app));
    const refused = await recordingSocket(perAddress.baseUrl, await mintCookie(perAddress.app));
    await waitFor(refused.isClosed);
    expect(refused.frames).toContainEqual(expect.objectContaining({ code: "too_many_attempts" }));

    const total = await makeCappedApp({ total: 1 });
    await recordingSocket(total.baseUrl, await mintCookie(total.app));
    const overTotal = await recordingSocket(total.baseUrl, await mintCookie(total.app));
    await waitFor(overTotal.isClosed);
    expect(total.app.sockets.size).toBe(1);
  });

  it("a socket still mid-challenge doesn't count against an identity's cap, which is checked again at proof", async () => {
    const { app, baseUrl } = await makeCappedApp({ perIdentity: 2 });
    const victim = await boundSocket(app, baseUrl);
    // Someone who saw the session id opens sockets on it that can never prove the key.
    let challenges = 0;
    const unproven = [0, 1].map(() => {
      const socket = openWs(`${baseUrl.replace("http", "ws")}/ws?enc=${victim.sessionId}`);
      socket.addEventListener("message", () => {
        challenges += 1;
      });
      return socket;
    });
    await waitFor(() => challenges === 2); // both admitted to the challenge, so both are mid-challenge now

    // The member's next tabs still get past connect. Two opened together both pass it (one admitted socket,
    // and the unproven ones don't count), so the cap of two has to hold when they prove: one gets in.
    const tabs = await Promise.all([0, 1].map(() => provenSocket(baseUrl, victim.key, victim.sessionId, { waitForPing: false })));
    await waitFor(() => tabs.some((tab) => tab.isClosed()) && app.sockets.size === 2);
    const refused = tabs.find((tab) => tab.isClosed())!;
    const admitted = tabs.find((tab) => !tab.isClosed())!;
    expect(refused.frames).toContainEqual(expect.objectContaining({ type: "error", code: "too_many_attempts" }));
    await waitFor(() => admitted.frames.some((frame) => frame.type === "ping"));
    unproven.forEach((socket) => socket.close());
  });

  it("a closed socket frees its place under the cap", async () => {
    const { app, baseUrl } = await makeCappedApp({ perIdentity: 1 });
    const cookie = await mintCookie(app);
    const first = await recordingSocket(baseUrl, cookie);
    await waitFor(() => first.frames.some((frame) => frame.type === "ping"));
    first.socket.close();
    await waitFor(() => app.sockets.size === 0);
    const second = await recordingSocket(baseUrl, cookie);
    await waitFor(() => second.frames.some((frame) => frame.type === "ping"));
    expect(second.isClosed()).toBe(false);
  });
});

describe("presence fan-out (review F-003)", () => {
  it("broadcasts presence only when the online set changes; a second tab is told on its own", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "optional" } });
    const baseUrl = await app.server.listen({ port: 0, host: "127.0.0.1" });
    const alice = await mintCookie(app);

    const tab1 = await recordingSocket(baseUrl, alice);
    await waitFor(() => presenceOf(tab1.frames).length === 1);

    // Alice's second tab: the online set is unchanged, so only the new tab hears presence.
    const tab2 = await recordingSocket(baseUrl, alice);
    await waitFor(() => presenceOf(tab2.frames).length === 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(presenceOf(tab1.frames)).toHaveLength(1);

    // Closing one of her tabs changes nothing either.
    tab2.socket.close();
    await waitFor(() => app.sockets.size === 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(presenceOf(tab1.frames)).toHaveLength(1);

    // Bob coming online does change it: everyone hears.
    const bob = await recordingSocket(baseUrl, await mintCookie(app));
    await waitFor(() => presenceOf(tab1.frames).length === 2);
    expect(presenceOf(tab1.frames).at(-1)?.onlineUserIds).toHaveLength(2);
    expect(presenceOf(bob.frames)).toHaveLength(1);
  });
});

describe("stalled sockets (review F-003)", () => {
  it("terminates a socket whose unsent frames pile up instead of sending it more", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "optional" } });
    const send = vi.fn();
    const terminate = vi.fn();
    const stalled = {
      socket: { OPEN: 1, readyState: 1, send, close: vi.fn(), terminate, bufferedAmount: 8 * 1024 * 1024, on: vi.fn() },
      userId: "user.stalled",
    };
    app.sockets.add(stalled);
    expect(app.host.updateConfig({ node: { name: "Renamed" } }).ok).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(app.sockets.has(stalled)).toBe(false);
  });
});

describe("switching to required at runtime (review F-010)", () => {
  it("closes plaintext sockets before the config broadcast and keeps bound ones", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "optional" } });
    const baseUrl = await app.server.listen({ port: 0, host: "127.0.0.1" });
    const plaintext = await recordingSocket(baseUrl, await mintCookie(app));
    await waitFor(() => plaintext.frames.some((frame) => frame.type === "ping"));
    const bound = await boundSocket(app, baseUrl);

    expect(app.host.updateConfig({ security: { transportEncryption: "required" } }).ok).toBe(true);

    await waitFor(plaintext.isClosed);
    expect(plaintext.frames).toContainEqual(expect.objectContaining({ type: "error", code: "encrypted_session_required" }));
    // The config change never reached the plaintext socket in the clear.
    expect(plaintext.frames.some((frame) => frame.type === "configUpdated")).toBe(false);

    await waitFor(() => bound.frames.some((frame) => frame.type === "configUpdated"));
    expect(bound.isClosed()).toBe(false);
    expect(app.sockets.size).toBe(1);
  });

  it("the hardened profile closes them too", async () => {
    const app = await makeApp({ security: { profile: "custom", transportEncryption: "optional" } });
    const baseUrl = await app.server.listen({ port: 0, host: "127.0.0.1" });
    const plaintext = await recordingSocket(baseUrl, await mintCookie(app));
    await waitFor(() => plaintext.frames.some((frame) => frame.type === "ping"));

    expect(app.host.updateConfig({ security: { profile: "hardened" } }).ok).toBe(true);
    await waitFor(plaintext.isClosed);
  });
});

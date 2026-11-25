import { createTransportIdentity, openTransport, sealTransport, transportServerAccept } from "@loam/crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  captureJoinKey,
  clearCachedHostPublicKey,
  clearStoredIdentityToken,
  encryptedFetch,
  ensureSession,
  getCachedHostPublicKey,
  getHostKeyMismatch,
  getImageTransportMode,
  getPendingHostKeyChange,
  getSession,
  handleWsFrame,
  isHostKeyPinBroken,
  joinKeyPresentAtStartup,
  mayFallBackToPlaintext,
  resetTransportStateForTests,
  resumeIdentity,
  setMintSuppressed,
  snapshotForWipe,
  subscribeSessionReplaced,
  TransportNeedsQrError,
  wipeServerCredentials,
  wsUrl,
} from "./transport";

// Review 2026-11-18: a pinned client before its session exists, sockets that outlive their session, the
// socket challenge's freshness, gaps in the frame sequence, key spellings, and the device wipe's revocation.

const PIN_KEY = (): string => `loam.transportHostKey.${window.location.origin}`;
const PIN_BROKEN_KEY = (): string => `loam.transportPinBroken.${window.location.origin}`;
const TOKEN_KEY = (): string => `loam.identityToken.v2.${window.location.origin}`;
const WS_CHALLENGE_AAD = "loam.ws.challenge.v1";
const WS_PROOF_AAD = "loam.ws.proof.v1";
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

type Host = ReturnType<typeof createTransportIdentity>;

/** A handshake reply as `host`, naming `advertised` as the host key (the real key unless a test says otherwise). */
function handshakeReply(host: Host, init: RequestInit, advertised = host.publicKey): { response: Response; sessionKey: string } {
  const { clientEphemeralPublic } = JSON.parse(init.body as string) as { clientEphemeralPublic: string };
  const accepted = transportServerAccept({ hostSecret: host.secretKey, clientEphemeralPublic });
  return {
    sessionKey: accepted.sessionKey,
    response: new Response(
      JSON.stringify({ sessionId: "sess", hostEphemeralPublic: accepted.hostEphemeralPublic, hostPublicKey: advertised }),
      { status: 200 },
    ),
  };
}

/** A fetch stub that answers only handshakes, as `host`. */
function handshakeOnly(host: Host) {
  return vi.fn(async (_url: string, init: RequestInit) => handshakeReply(host, init).response);
}

/** Another spelling of the same 32-byte key: the last character's two unused low bits set. */
function respelled(key: string): string {
  return key.slice(0, 42) + BASE64URL[BASE64URL.indexOf(key[42]!) | 1];
}

/** The `cn` a `wsUrl` result carries. */
function clientNonceOf(url: string): string | null {
  return new URLSearchParams(url.split("?")[1] ?? "").get("cn");
}

/** The server's challenge for one socket, sealed under the session key. */
function challengeFor(key: string, connectionId: string, cn: string | null | undefined): string {
  return sealTransport(key, JSON.stringify({ type: "challenge", connectionId, nonce: "n-" + connectionId, ...(cn ? { cn } : {}) }), WS_CHALLENGE_AAD);
}

/** One sealed application frame for `connectionId`. */
function frameFor(key: string, connectionId: string, q: number, f: string): string {
  return sealTransport(key, JSON.stringify({ q, f }), `loam.ws.frame.v1 ${connectionId}`);
}

beforeEach(() => {
  resetTransportStateForTests();
  localStorage.clear();
  window.location.hash = "";
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (window as { __loamHostTransportKey?: unknown }).__loamHostTransportKey;
  localStorage.clear();
  window.location.hash = "";
});

describe("a pinned client never sends or accepts plaintext before its session exists", () => {
  it("a stored pin refuses a POST before the first ensureSession, and nothing reaches fetch", async () => {
    localStorage.setItem(PIN_KEY(), createTransportIdentity().publicKey);
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(encryptedFetch("POST", "/api/messages", { body: "typed before the node answered" })).rejects.toThrow(
      /encrypted session/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a stored pin refuses a plaintext socket and a plaintext frame", () => {
    localStorage.setItem(PIN_KEY(), createTransportIdentity().publicKey);

    expect(() => wsUrl("ws://x/ws")).toThrow(/encrypted session/);
    expect(handleWsFrame('{"type":"wipe"}')).toEqual({});
  });

  it("the launcher's injected key alone is enough to refuse plaintext", async () => {
    (window as { __loamHostTransportKey?: unknown }).__loamHostTransportKey = createTransportIdentity().publicKey;
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(encryptedFetch("POST", "/api/typing", { channelId: "general" })).rejects.toThrow(/encrypted session/);
    expect(() => wsUrl("ws://x/ws")).toThrow(/encrypted session/);
    expect(handleWsFrame('{"type":"wipe"}')).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
    // The two checks that already looked at the pin use the same rule.
    expect(mayFallBackToPlaintext("optional")).toBe(false);
    expect(getImageTransportMode()).toBe("pending");
  });

  it("with no pin and no launcher key an unpinned client still talks plaintext before boot (optional and off nodes)", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await encryptedFetch("POST", "/api/messages", { body: "hi" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(wsUrl("ws://x/ws")).toBe("ws://x/ws");
    expect(handleWsFrame('{"type":"ping"}')).toEqual({ payload: '{"type":"ping"}' });
  });
});

describe("a socket opened under a session never takes a plaintext frame", () => {
  it("a forged handshake that breaks the pin, then a resync: the socket owner is told and a plaintext wipe frame is ignored", async () => {
    const real = createTransportIdentity();
    const impostor = createTransportIdentity();
    localStorage.setItem(PIN_KEY(), real.publicKey);
    let handshakes = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (url === "/api/transport/handshake") {
          handshakes += 1;
          return handshakeReply(handshakes === 1 ? real : impostor, init).response;
        }
        return new Response(null, { status: 401 }); // a forged, unsealed 401
      }),
    );

    await ensureSession("optional", real.publicKey);
    expect(wsUrl("ws://x/ws")).toContain("enc=");
    const replaced = vi.fn();
    subscribeSessionReplaced(replaced);

    // The forged 401 makes the client re-handshake; the forged handshake names another key and breaks the pin.
    await expect(encryptedFetch("GET", "/api/channels")).rejects.toThrow();
    expect(isHostKeyPinBroken()).toBe(true);

    // The next resync drops the session and gates on a rescan.
    await expect(ensureSession("optional", real.publicKey)).rejects.toBeInstanceOf(TransportNeedsQrError);
    expect(getSession()).toBeUndefined();
    expect(replaced).toHaveBeenCalled();
    expect(handleWsFrame('{"type":"wipe"}')).toEqual({});
  });

  it("an unpinned socket opened sealed takes no plaintext frame after the advertised mode drops the session", async () => {
    const host = createTransportIdentity();
    vi.stubGlobal("fetch", handshakeOnly(host));

    await ensureSession("optional", host.publicKey);
    expect(wsUrl("ws://x/ws")).toContain("enc=");
    const replaced = vi.fn();
    subscribeSessionReplaced(replaced);

    // A plaintext bootstrap (attacker-mutable) now says `off`.
    await ensureSession("off");
    expect(getSession()).toBeUndefined();
    expect(replaced).toHaveBeenCalledTimes(1);
    expect(handleWsFrame('{"type":"wipe"}')).toEqual({});

    // A socket opened in the clear from here on is a plaintext socket, and passes its frames through.
    expect(wsUrl("ws://x/ws")).toBe("ws://x/ws");
    expect(handleWsFrame('{"type":"ping"}')).toEqual({ payload: '{"type":"ping"}' });
  });

  it("dropping a session that was never there tells nobody (an off node's resync must not close its plaintext socket)", async () => {
    const replaced = vi.fn();
    subscribeSessionReplaced(replaced);
    await ensureSession("off");
    await ensureSession("optional");
    expect(replaced).not.toHaveBeenCalled();
  });
});

describe("a new socket proves it is new", () => {
  async function liveSessionKey(): Promise<string> {
    const host = createTransportIdentity();
    vi.stubGlobal("fetch", handshakeOnly(host));
    await ensureSession("optional", host.publicKey);
    return getSession()!.key;
  }

  it("every socket URL carries its own random cn of at least 22 base64url characters", async () => {
    await liveSessionKey();
    const first = clientNonceOf(wsUrl("ws://x/ws"));
    const second = clientNonceOf(wsUrl("ws://x/ws"));
    expect(first).toMatch(/^[A-Za-z0-9_-]{22,}$/);
    expect(second).toMatch(/^[A-Za-z0-9_-]{22,}$/);
    expect(second).not.toBe(first);
  });

  it("the first socket's challenge replayed onto a second socket of the same session gets no proof", async () => {
    const key = await liveSessionKey();
    const firstNonce = clientNonceOf(wsUrl("ws://x/ws"));
    const firstChallenge = challengeFor(key, "conn-1", firstNonce);
    expect(handleWsFrame(firstChallenge).proof).toBeDefined();

    // A new socket: someone on the path ends it and replays the previous connection's challenge.
    wsUrl("ws://x/ws");
    expect(handleWsFrame(firstChallenge)).toEqual({});
    // ...and the first connection's frames don't open either, since nothing was confirmed.
    expect(handleWsFrame(frameFor(key, "conn-1", 1, '{"type":"ping"}'))).toEqual({});
  });

  it("a challenge that names no cn, or another one, gets no proof; the one this socket sent does", async () => {
    const key = await liveSessionKey();
    const nonce = clientNonceOf(wsUrl("ws://x/ws"));
    expect(handleWsFrame(challengeFor(key, "conn-1", undefined))).toEqual({});
    expect(handleWsFrame(challengeFor(key, "conn-1", "A".repeat(22)))).toEqual({});

    const answered = handleWsFrame(challengeFor(key, "conn-1", nonce));
    expect(JSON.parse(openTransport(key, answered.proof!, WS_PROOF_AAD)!)).toEqual({
      type: "proof",
      connectionId: "conn-1",
      nonce: "n-conn-1",
    });
  });
});

describe("a missing frame is noticed", () => {
  it("frames 1, 2 then 4: the third reports the gap and yields no payload, and nothing more is taken on that socket", async () => {
    const host = createTransportIdentity();
    vi.stubGlobal("fetch", handshakeOnly(host));
    await ensureSession("optional", host.publicKey);
    const key = getSession()!.key;
    const nonce = clientNonceOf(wsUrl("ws://x/ws"));
    expect(handleWsFrame(challengeFor(key, "conn-1", nonce)).proof).toBeDefined();

    expect(handleWsFrame(frameFor(key, "conn-1", 1, "one"))).toEqual({ payload: "one" });
    expect(handleWsFrame(frameFor(key, "conn-1", 2, "two"))).toEqual({ payload: "two" });
    expect(handleWsFrame(frameFor(key, "conn-1", 4, "four"))).toEqual({ gap: true });
    // The skipped frame turning up late is not applied either: the socket is finished.
    expect(handleWsFrame(frameFor(key, "conn-1", 3, "three"))).toEqual({});
    // A replay is still just ignored, not a gap.
    const next = clientNonceOf(wsUrl("ws://x/ws"));
    expect(handleWsFrame(challengeFor(key, "conn-2", next)).proof).toBeDefined();
    const first = frameFor(key, "conn-2", 1, "one");
    expect(handleWsFrame(first)).toEqual({ payload: "one" });
    expect(handleWsFrame(first)).toEqual({});
  });
});

describe("one key has one spelling", () => {
  it("a handshake answer that spells the pinned key differently is the same key: the pin holds", async () => {
    const host = createTransportIdentity();
    localStorage.setItem(PIN_KEY(), host.publicKey);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => handshakeReply(host, init, `${host.publicKey}=`).response),
    );

    await ensureSession("optional", host.publicKey);
    expect(getSession()?.hostPublicKey).toBe(host.publicKey);
    expect(isHostKeyPinBroken()).toBe(false);
  });

  it("a #k= that respells the pinned key is a quiet rescan of the same key, even with the pin broken", async () => {
    const host = createTransportIdentity();
    localStorage.setItem(PIN_KEY(), host.publicKey);
    localStorage.setItem(PIN_BROKEN_KEY(), "1");
    window.location.hash = `#k=${respelled(host.publicKey)}`;
    vi.stubGlobal("fetch", handshakeOnly(host));

    captureJoinKey();
    await ensureSession("optional", host.publicKey);
    expect(getPendingHostKeyChange()).toBeUndefined();
    expect(isHostKeyPinBroken()).toBe(false);
    expect(getCachedHostPublicKey()).toBe(host.publicKey);
    expect(getSession()?.hostPublicKey).toBe(host.publicKey);
  });

  it("an advertised key spelled differently is not a mismatch, and the launcher's key is stored in its one spelling", async () => {
    const host = createTransportIdentity();
    (window as { __loamHostTransportKey?: unknown }).__loamHostTransportKey = respelled(host.publicKey);
    vi.stubGlobal("fetch", handshakeOnly(host));

    captureJoinKey();
    expect(getCachedHostPublicKey()).toBe(host.publicKey);
    await ensureSession("optional", `${host.publicKey}=`);
    expect(getHostKeyMismatch()).toBe(false);
    expect(getSession()?.hostPublicKey).toBe(host.publicKey);
  });

  it("a #k= or launcher value that is not 32 bytes is ignored as if absent", () => {
    const short = createTransportIdentity().publicKey.slice(0, 42); // 31 bytes
    window.location.hash = `#k=${short}`;
    captureJoinKey();
    expect(getCachedHostPublicKey()).toBeUndefined();
    expect(joinKeyPresentAtStartup()).toBe(false);

    resetTransportStateForTests();
    (window as { __loamHostTransportKey?: unknown }).__loamHostTransportKey = short;
    captureJoinKey();
    expect(getCachedHostPublicKey()).toBeUndefined();
    expect(joinKeyPresentAtStartup()).toBe(false);
  });
});

describe("a device wipe can still revoke its token", () => {
  it("a QR-pinned client whose session died: a fresh handshake, the sealed logout, and nothing of the pin or token left", async () => {
    const host = createTransportIdentity();
    window.location.hash = `#k=${host.publicKey}`;
    const sessionKeys = new Map<string, string>();
    let handshakes = 0;
    const logouts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const sessionId = (init.headers as Record<string, string> | undefined)?.["x-loam-enc"];
        if (url === "/api/transport/handshake") {
          handshakes += 1;
          const { clientEphemeralPublic } = JSON.parse(init.body as string) as { clientEphemeralPublic: string };
          const accepted = transportServerAccept({ hostSecret: host.secretKey, clientEphemeralPublic });
          const id = `sess-${handshakes}`;
          sessionKeys.set(id, accepted.sessionKey);
          return new Response(JSON.stringify({ sessionId: id, hostEphemeralPublic: accepted.hostEphemeralPublic, hostPublicKey: host.publicKey }));
        }
        const key = sessionId ? sessionKeys.get(sessionId) : undefined;
        if (!key) {
          return new Response(null, { status: url === "/api/session/end" ? 200 : 401 });
        }
        const enc = (JSON.parse(init.body as string) as { enc: string }).enc;
        if (url === "/api/session/resume") {
          const { s, b } = JSON.parse(openTransport(key, enc, "POST /api/session/resume")!) as { s: number; b: { token?: string } };
          const reply = { s, m: "POST", p: "/api/session/resume", currentUser: { id: "user.me" }, token: b.token ?? "token-1" };
          return new Response(JSON.stringify({ enc: sealTransport(key, JSON.stringify(reply), `loam.transport.response.v2 ${JSON.stringify(["POST", "/api/session/resume", s, 200])}`) }), {
            headers: { "x-loam-enc": "1" },
          });
        }
        if (url === "/api/session/logout") {
          expect(openTransport(key, enc, "POST /api/session/logout")).not.toBeNull();
          logouts.push(sessionId!);
          return new Response(JSON.stringify({ enc: sealTransport(key, JSON.stringify({ ok: true }), "POST /api/session/logout") }), {
            headers: { "x-loam-enc": "1" },
          });
        }
        return new Response(null, { status: 404 });
      }),
    );

    captureJoinKey();
    await ensureSession("required", host.publicKey);
    await resumeIdentity();
    expect(localStorage.getItem(TOKEN_KEY())).not.toBeNull();
    // The node forgets this session (a restart, the TTL): the next sealed request is refused unsealed.
    sessionKeys.delete("sess-1");

    // What `purgeLocalData` does for a device wipe, in its order: snapshot, then erase local state at once,
    // then revoke on the node.
    snapshotForWipe();
    setMintSuppressed(true);
    clearStoredIdentityToken();
    clearCachedHostPublicKey();
    await wipeServerCredentials(2_000);

    expect(handshakes).toBe(2);
    expect(logouts).toEqual(["sess-2"]);
    expect(localStorage.getItem(PIN_KEY())).toBeNull();
    expect(localStorage.getItem(PIN_BROKEN_KEY())).toBeNull();
    expect(localStorage.getItem(TOKEN_KEY())).toBeNull();
    expect(getCachedHostPublicKey()).toBeUndefined();
  });

  it("the wipe's handshake against a node holding another key leaves no broken-pin marker behind", async () => {
    const host = createTransportIdentity();
    const rotated = createTransportIdentity();
    window.location.hash = `#k=${host.publicKey}`;
    let handshakes = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (url === "/api/transport/handshake") {
          handshakes += 1;
          return handshakeReply(handshakes === 1 ? host : rotated, init).response;
        }
        if (url === "/api/session/resume") {
          return new Response(null, { status: 500 });
        }
        return new Response(null, { status: 401 });
      }),
    );

    captureJoinKey();
    await ensureSession("required", host.publicKey);
    localStorage.setItem(TOKEN_KEY(), JSON.stringify({ k: host.publicKey, t: "token-1" }));
    snapshotForWipe();
    setMintSuppressed(true);
    clearStoredIdentityToken();
    clearCachedHostPublicKey();
    await wipeServerCredentials(2_000);

    expect(handshakes).toBe(2);
    expect(localStorage.getItem(PIN_KEY())).toBeNull();
    expect(localStorage.getItem(PIN_BROKEN_KEY())).toBeNull();
    expect(localStorage.getItem(TOKEN_KEY())).toBeNull();
  });
});

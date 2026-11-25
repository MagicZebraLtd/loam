import { createTransportIdentity, openTransport, sealTransport, transportServerAccept } from "@loam/crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { encryptedFetch, ensureSession, getSession, resetTransportStateForTests, resumeIdentity } from "./transport";

// A sealed direct reply reads only as the answer it is (review 2026-11-18, docs/08 "Response binding"). The
// node used to seal under strings built from the raw request target (`METHOD url#seq#status`, `METHOD
// url!status`), and a target with a `#` or a `!` in it could make one form read as another. The client now
// asks with `r: 2` and opens only the labelled v2 forms below.

/** The v2 aad of a reply to a request that asked with `r: 2`. */
function responseAad(method: string, url: string, seq: number, status: number): string {
  return `loam.transport.response.v2 ${JSON.stringify([method, url, seq, status])}`;
}

/** The v2 aad of a refusal sent before the request's sequence was authenticated (`encStatus2`). */
function refusalAad(method: string, url: string, status: number): string {
  return `loam.transport.refusal.v2 ${JSON.stringify([method, url, status])}`;
}

const RESUME_PATH = "/api/session/resume";
const RESUME_AAD = `POST ${RESUME_PATH}`;

/** Where the module keeps this origin's identity token record, `{ k: hostKey, t: token }`. */
function tokenRecordKey(): string {
  return `loam.identityToken.v2.${window.location.origin}`;
}

/**
 * A fake node for `host`: handshakes like the real one, and hands every other request, with the session key
 * and the envelope the client sealed, to `answer`.
 */
function fakeNode(
  host: ReturnType<typeof createTransportIdentity>,
  answer: (request: { url: string; init: RequestInit; key: string; envelope: { s: number; r?: unknown; b?: unknown } }) => Response,
) {
  let key: string | undefined;
  return vi.fn(async (url: string, init: RequestInit) => {
    if (url === "/api/transport/handshake") {
      const { clientEphemeralPublic } = JSON.parse(init.body as string) as { clientEphemeralPublic: string };
      const accepted = transportServerAccept({ hostSecret: host.secretKey, clientEphemeralPublic });
      key = accepted.sessionKey;
      return new Response(JSON.stringify({ sessionId: "sess-1", hostEphemeralPublic: accepted.hostEphemeralPublic, hostPublicKey: host.publicKey }), { status: 200 });
    }
    const method = init.method ?? "GET";
    const headers = (init.headers ?? {}) as Record<string, string>;
    const sealed = init.body === undefined ? headers["x-loam-seq"] : (JSON.parse(init.body as string) as { enc: string }).enc;
    const opened = openTransport(key!, sealed ?? "", `${method} ${url}`);
    return answer({ url, init, key: key!, envelope: JSON.parse(opened ?? "{}") as { s: number; r?: unknown; b?: unknown } });
  });
}

/** A sealed reply carrying the given fields, `x-loam-enc: 1` and `status`. */
function sealedReply(fields: Record<string, string>, status: number): Response {
  return new Response(JSON.stringify(fields), { status, headers: { "x-loam-enc": "1" } });
}

describe("a sealed direct reply reads only as the answer it is (review 2026-11-18)", () => {
  beforeEach(() => {
    resetTransportStateForTests();
    localStorage.clear();
    window.location.hash = "";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    window.location.hash = "";
  });

  it("keeps the identity token when a real resume is answered with replies sealed for #1#401 and !401 targets", async () => {
    // What an on-path attacker could make the node produce without any key: `POST /api/session/resume#1#401`
    // answered with `enc` under that bare string, and `POST /api/session/resume!401` answered with `enc` under
    // that one. Served as the reply to the member's real resume (sequence 1) with the outer status set to 401.
    const host = createTransportIdentity();
    window.location.hash = `#k=${host.publicKey}`;
    localStorage.setItem(tokenRecordKey(), JSON.stringify({ k: host.publicKey, t: "real-token" }));
    const presented: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      fakeNode(host, ({ key, envelope }) => {
        presented.push((envelope.b as { token?: unknown } | undefined)?.token);
        const refusal = JSON.stringify({ error: "Invalid identity token", code: "invalid_token" });
        return sealedReply(
          {
            enc: sealTransport(key, refusal, `${RESUME_AAD}#${envelope.s}#401`),
            encStatus: sealTransport(key, refusal, `${RESUME_AAD}!401`),
          },
          401,
        );
      }),
    );

    await ensureSession("required", host.publicKey);
    await expect(resumeIdentity()).rejects.toThrow("Identity resume failed: 401");
    // Treated as forged: the token is still stored and no tokenless retry minted a new person.
    expect(JSON.parse(localStorage.getItem(tokenRecordKey())!)).toEqual({ k: host.publicKey, t: "real-token" });
    expect(presented).toEqual(["real-token"]);
  });

  it("asks a resume with r: 2 and takes its reply only under the v2 form", async () => {
    const host = createTransportIdentity();
    window.location.hash = `#k=${host.publicKey}`;
    let form: "v2" | "v1" = "v1";
    const asked: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      fakeNode(host, ({ key, envelope }) => {
        asked.push(envelope.r);
        const body = JSON.stringify({ s: envelope.s, m: "POST", p: RESUME_PATH, currentUser: { id: "user.me" }, token: "fresh" });
        const aad = form === "v2" ? responseAad("POST", RESUME_PATH, envelope.s, 200) : `${RESUME_AAD}#${envelope.s}#200`;
        return sealedReply({ enc: sealTransport(key, body, aad) }, 200);
      }),
    );

    await ensureSession("required", host.publicKey);
    // The old `#seq#status` form no longer opens.
    await expect(resumeIdentity()).rejects.toThrow("Identity resume response could not be decrypted");
    form = "v2";
    await expect(resumeIdentity()).resolves.toEqual({ currentUser: { id: "user.me" } });
    expect(asked).toEqual([2, 2]);
  });

  it("asks direct requests with r: 2, the GET header form included, and opens only the v2 response form", async () => {
    const host = createTransportIdentity();
    let form: "v2" | "v1" = "v2";
    const asked: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      fakeNode(host, ({ url, init, key, envelope }) => {
        asked.push(envelope.r);
        const method = init.method ?? "GET";
        const aad = form === "v2" ? responseAad(method, url, envelope.s, 200) : `${method} ${url}#${envelope.s}#200`;
        return sealedReply({ enc: sealTransport(key, JSON.stringify({ ok: url }), aad) }, 200);
      }),
    );

    await ensureSession("optional", host.publicKey);
    expect(await (await encryptedFetch("GET", "/api/channels")).json()).toEqual({ ok: "/api/channels" });
    expect(await (await encryptedFetch("POST", "/api/messages", { body: "hi" })).json()).toEqual({ ok: "/api/messages" });
    expect(asked).toEqual([2, 2]);

    // A reply under the old form is not an answer any more (a mutation is never retried).
    form = "v1";
    await expect(encryptedFetch("POST", "/api/messages", { body: "again" })).rejects.toThrow("Transport session expired");
  });

  it("takes a refusal made before the sequence was read only from encStatus2, and only with an error status", async () => {
    const host = createTransportIdentity();
    let respond: (key: string, url: string, method: string) => Response = () => new Response(null, { status: 500 });
    vi.stubGlobal("fetch", fakeNode(host, ({ url, init, key }) => respond(key, url, init.method ?? "GET")));
    await ensureSession("optional", host.publicKey);
    const refusal = JSON.stringify({ error: "Too many requests", code: "rate_limited" });

    // The node sends all three; the client reads `encStatus2`.
    respond = (key, url, method) =>
      sealedReply(
        {
          enc: sealTransport(key, refusal, `${method} ${url}`),
          encStatus: sealTransport(key, refusal, `${method} ${url}!429`),
          encStatus2: sealTransport(key, refusal, refusalAad(method, url, 429)),
        },
        429,
      );
    const limited = await encryptedFetch("POST", "/api/messages", { body: "x" });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "Too many requests", code: "rate_limited" });

    // Without `encStatus2`, the old `!status` form is no longer opened.
    respond = (key, url, method) =>
      sealedReply({ enc: sealTransport(key, refusal, `${method} ${url}`), encStatus: sealTransport(key, refusal, `${method} ${url}!429`) }, 429);
    await expect(encryptedFetch("POST", "/api/messages", { body: "y" })).rejects.toThrow("Transport session expired");

    // A refusal form never stands in for a success, even sealed for the status it arrives with.
    respond = (key, url, method) => sealedReply({ encStatus2: sealTransport(key, JSON.stringify({ messages: ["old"] }), refusalAad(method, url, 200)) }, 200);
    await expect(encryptedFetch("POST", "/api/messages", { body: "z" })).rejects.toThrow("Transport session expired");
    expect(getSession()).toBeDefined();
  });
});

describe("a read that must not start a session (noRehandshake)", () => {
  beforeEach(() => {
    resetTransportStateForTests();
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("gives an unsealed 401 or an unopenable reply back to the caller without a handshake or a resume", async () => {
    const host = createTransportIdentity();
    localStorage.setItem(`loam.transportHostKey.${window.location.origin}`, host.publicKey);
    let unsealed = true;
    const node = fakeNode(host, () => (unsealed ? new Response(null, { status: 401 }) : sealedReply({ enc: "garbage" }, 200)));
    vi.stubGlobal("fetch", node);
    await ensureSession("optional", host.publicKey);
    const calls = () => node.mock.calls.map(([url]) => url);
    expect(calls()).toEqual(["/api/transport/handshake"]);

    await expect(encryptedFetch("GET", "/api/config", undefined, { noRehandshake: true })).rejects.toThrow("Transport session expired");
    unsealed = false;
    await expect(encryptedFetch("GET", "/api/config", undefined, { noRehandshake: true })).rejects.toThrow("Transport session expired");
    expect(calls()).toEqual(["/api/transport/handshake", "/api/transport/tunnel", "/api/transport/tunnel"]);
  });
});

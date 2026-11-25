/**
 * A fake node's side of the path-hiding tunnel (`POST /api/transport/tunnel`, docs/08), shared by the client
 * test files so every fake reads a tunnel request and seals its reply the way the real node does, from one place.
 */
import { openTransport, sealTransport } from "@loam/crypto";

/** The tunnel's one opaque endpoint. */
export const TUNNEL_PATH = "/api/transport/tunnel";

/** The associated data a client seals its tunnel request envelope under (the bare request target). */
export const TUNNEL_REQUEST_AAD = `POST ${TUNNEL_PATH}`;

/** The real request a tunnel envelope carries. */
export interface TunnelInner {
  m: string;
  p: string;
  body?: unknown;
}

/** A tunnel request envelope as the client seals it. */
export interface TunnelEnvelope {
  s: number;
  r?: unknown;
  b: TunnelInner;
}

/**
 * Open the sealed envelope of one tunnel request.
 *
 * @returns The envelope, or undefined when the body is missing or does not open under `sessionKey`.
 */
export function openTunnelRequest(sessionKey: string, init: RequestInit | undefined): TunnelEnvelope | undefined {
  const { enc } = JSON.parse(String(init?.body ?? "{}")) as { enc?: string };
  const opened = typeof enc === "string" ? openTransport(sessionKey, enc, TUNNEL_REQUEST_AAD) : null;
  return opened === null ? undefined : (JSON.parse(opened) as TunnelEnvelope);
}

/** The associated data the node seals its answer to the tunnel request at `seq` under, when it asked with `r: 2`. */
export function tunnelResponseAad(seq: number, status: number): string {
  return `loam.transport.response.v2 ${JSON.stringify(["POST", TUNNEL_PATH, seq, status])}`;
}

/** The associated data of a tunnel refusal the node made before it read the request's sequence (`encStatus2`). */
export function tunnelRefusalAad(status: number): string {
  return `loam.transport.refusal.v2 ${JSON.stringify(["POST", TUNNEL_PATH, status])}`;
}

/** A sealed answer to the tunnel request at `seq`: `payload` sealed for that sequence and the outer `status`. */
export function sealedTunnelReply(sessionKey: string, seq: number, payload: string, status = 200): Response {
  return new Response(JSON.stringify({ enc: sealTransport(sessionKey, payload, tunnelResponseAad(seq, status)) }), {
    status,
    headers: { "content-type": "application/json", "x-loam-enc": "1" },
  });
}

/**
 * The node's answer to a tunnelled request that reached its route: a `{ s, m, p, status, contentType, bodyB64 }`
 * descriptor echoing the envelope, sealed for the envelope's sequence under an outer 200.
 */
export function tunnelDescriptorReply(
  sessionKey: string,
  envelope: TunnelEnvelope,
  inner: { status: number; bodyB64: string; contentType?: string },
): Response {
  const descriptor = {
    s: envelope.s,
    m: envelope.b.m,
    p: envelope.b.p,
    status: inner.status,
    contentType: inner.contentType ?? "application/json",
    bodyB64: inner.bodyB64,
  };
  return sealedTunnelReply(sessionKey, envelope.s, JSON.stringify(descriptor));
}

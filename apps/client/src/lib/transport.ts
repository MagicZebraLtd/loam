/**
 * QR-bootstrapped app-layer transport encryption (docs/08). LOAM serves plain HTTP on the LAN (no
 * secure context, so no WebCrypto/TLS); this module mirrors the server's app-layer AEAD session so
 * plain HTTP carries only ciphertext for message/DM/config content. Trust is rooted in the join QR,
 * which delivers the host's static X25519 public key out-of-band via the URL fragment `#k=<b64url>`
 * (never sent to the server) — an active-MITM-resistant channel a bare token can't provide.
 *
 * When `transportEncryption` is `off` (the default) every export here is a byte-for-byte
 * pass-through: same request/response shape as the pre-transport-encryption client. This module owns
 * the one live session (module-scoped — a tab talks to exactly one node) and is the single place
 * that knows the wire framing; callers never touch `sealTransport`/`openTransport` directly.
 */
import { openTransport, sealTransport, transportClientDerive, transportClientHello, transportFingerprint } from "@loam/crypto";
import { TransportHandshakeResponseSchema, type TransportEncryption, type TransportHandshakeResponse } from "@loam/schema";

/** localStorage key for an operator-configured server origin override (Android host / advanced
 * self-hosters); empty/absent means same-origin requests. Shared with `app.tsx`. */
export const SERVER_URL_KEY = "loam.serverUrl";

/** Where the QR-delivered host public key is cached, namespaced per server origin so switching
 * nodes (a different `SERVER_URL_KEY`, or a different origin entirely) doesn't leak one node's key
 * into another's slot. */
const HOST_KEY_STORAGE_PREFIX = "loam.transportHostKey.";

/** Build an absolute request URL for a server-relative API path (e.g. `/api/messages`), honouring an
 * optional configured server origin override. The single place that knows how to reach the server —
 * used for both `fetch` calls and non-fetch resource URLs (`<img src>`, `<a href>`). During a wipe it
 * falls back to the captured origin snapshot: a sibling tab may have already removed the shared
 * `SERVER_URL_KEY`, and the initiating tab's revocation calls must still reach the RIGHT origin (docs/20)
 * — a wrong-origin logout/`session/end` would be useless or redirected. */
export function apiUrl(path: string): string {
  const base = wipeServerUrlSnapshot ?? readStorage(SERVER_URL_KEY) ?? "";
  return `${base}${path}`;
}

/**
 * Thrown by `ensureSession` when transport encryption is `required` but no host public key is
 * available from either the QR (this load's `#k=` fragment or a previously cached one) or the
 * server's advertised config key. The caller should render a "scan the join QR" gate instead of the
 * main app — there is no safe way to talk to a `required` node without it.
 */
export class TransportNeedsQrError extends Error {
  /**
   * Why a scan is needed: `"missing"` — no host key at all; `"changed"` — the key this client had pinned
   * (a cached QR key) no longer matches the key the node actually holds (the node rotated it, e.g. an
   * Emergency Reset, or the cached poster is stale), so the cache was dropped and a fresh scan is the
   * only way back.
   */
  readonly reason: "missing" | "changed";

  constructor(reason: "missing" | "changed" = "missing") {
    super(
      reason === "changed"
        ? "This node's key no longer matches the one you scanned (the host may have restarted or reset it, or this network is not what it claims); scan its current join QR to reconnect."
        : "This node requires a scanned join QR to connect securely.",
    );
    this.name = "TransportNeedsQrError";
    this.reason = reason;
  }
}

/** The live transport session: a handshake-derived key, its server-side session id, the host public
 * key it was derived against (for the fingerprint UI), and a monotonic per-session request counter.
 * `seq` is bumped for every sealed REST request and carried inside the authenticated envelope so the
 * server can reject replays within the session's lifetime (docs/08); it resets to 0 on every fresh
 * handshake because the server starts each session's replay window empty. */
interface Session {
  sessionId: string;
  key: string;
  hostPublicKey: string;
  seq: number;
  /** Whether this session has completed a sealed identity resume (docs/20) — its identity is the
   * session key, not a cookie, so every request omits credentials and reaches content via the tunnel. */
  bound: boolean;
  /** The current WS connection's id, learned from the server's key-confirmation challenge (docs/20 §7);
   * `undefined` before a challenge is answered on this connection. Reset per new socket by `wsUrl`. */
  wsConnectionId?: string;
  /** Highest accepted server→client WS frame sequence for the current connection (docs/20 §7 replay
   * window) — a frame at or below this is a replay and dropped. */
  wsServerSeq: number;
}

let session: Session | undefined;

/** Where the per-origin secure identity token (docs/20) is cached, as JSON `{ k, t }`: the token `t` and the
 * host public key `k` of the session it was issued over. Namespaced per server origin like the host key, so
 * switching origins never cross-presents one node's token to another, and bound to the key because two
 * different networks can sit at the same origin (the same address at different times or places): the token
 * is only ever sealed to a session with that same key. A node's key and its identity tokens are wiped
 * together, so a token is never valid under another key and the binding loses nothing. It's a bearer secret
 * at rest (same trust level as the host-key cache); the network threat model is what this defends — device
 * compromise is covered by the encrypted-at-rest DB + wipe, not by hiding this from same-origin JS. One
 * record per origin: a token minted under a newly accepted key replaces the old network's. */
const IDENTITY_TOKEN_STORAGE_PREFIX = "loam.identityToken.v2.";

/** Where earlier releases kept the bare token for an origin, with no key beside it. Read only to migrate it
 * (`migrateLegacyIdentityToken`), and removed wherever the token is cleared. */
const LEGACY_IDENTITY_TOKEN_STORAGE_PREFIX = "loam.identityToken.";

/** A stored identity token and the host public key it was issued under (see `IDENTITY_TOKEN_STORAGE_PREFIX`). */
interface IdentityTokenRecord {
  k: string;
  t: string;
}

/** An in-memory snapshot of the identity token record, captured before a wipe clears it from localStorage
 * (docs/20): the wipe erases local state FIRST, but the server-side revocation still needs the token to
 * re-establish + retry if the bound session died. `storedIdentityToken()` falls back to this during the
 * wipe (only for a session under the snapshot's key), and `storeIdentityToken` is gated by `mintSuppressed`
 * so the snapshot can't be written back. */
let wipeTokenSnapshot: IdentityTokenRecord | undefined;
/** In-memory snapshot of the configured server origin, captured alongside the token so the wipe's server
 * revocation reaches the right origin even if a sibling tab has already removed `SERVER_URL_KEY` from the
 * shared localStorage (docs/20). `apiUrl` prefers it while set. */
let wipeServerUrlSnapshot: string | undefined;
/** In-memory snapshot of the pinned host key, captured with the token. The wipe erases the pin before it asks
 * the node to revoke the token, so a session that died in between can only be re-established (and the token
 * revoked over it) against this copy. `doReHandshake` falls back to it; `wipeServerCredentials` clears it. */
let wipeHostKeySnapshot: string | undefined;

/** Capture the token record, the server-origin override and the pinned host key into in-memory wipe snapshots
 * BEFORE local erasure (or any cross-tab announce) clears them from shared localStorage, so
 * `wipeServerCredentials`'s stale-session recovery can still handshake, present the token and reach the right
 * origin (docs/20). MUST be called before `announceWipe()`: a sibling tab receiving the announce clears them
 * from localStorage. */
export function snapshotForWipe(): void {
  migrateLegacyIdentityToken();
  wipeTokenSnapshot = readIdentityTokenRecord();
  wipeServerUrlSnapshot = readStorage(SERVER_URL_KEY);
  wipeHostKeySnapshot = getCachedHostPublicKey();
}

/**
 * Parse a stored identity token record. Anything but a JSON object with a non-empty string `k` and `t` is
 * unreadable and counts as no token at all.
 */
function parseIdentityTokenRecord(raw: string | undefined): IdentityTokenRecord | undefined {
  if (raw === undefined) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (value !== null && typeof value === "object") {
      const { k, t } = value as { k?: unknown; t?: unknown };
      if (typeof k === "string" && k !== "" && typeof t === "string" && t !== "") {
        return { k, t };
      }
    }
  } catch {
    // Not JSON: treated as absent.
  }
  return undefined;
}

/**
 * This page load's copy of a token record the browser refused to store (`storeIdentityToken`), with the origin
 * it belongs to. Without it, a browser whose reads work but whose writes throw (a full quota, a WebView with
 * none) would resume without a token on every boot pass and be handed a new identity each time. Memory only:
 * like the in-memory pin, it never outlives the page.
 */
let memoryTokenRecord: { origin: string; record: IdentityTokenRecord } | undefined;

/** This origin's identity token record: the page's own copy of one the browser refused to store, else the stored
 * one if it is readable. The page's copy wins, as the in-memory pin does: it is newer than whatever storage kept. */
function readIdentityTokenRecord(): IdentityTokenRecord | undefined {
  const origin = keyStorageOrigin();
  if (memoryTokenRecord?.origin === origin) {
    return memoryTokenRecord.record;
  }
  return parseIdentityTokenRecord(readStorage(IDENTITY_TOKEN_STORAGE_PREFIX + origin));
}

/**
 * Move a bare token an earlier release stored for this origin into a key-bound record. It was issued under
 * the pin stored for the origin at the time, so it is bound to the STORED pin (never the in-memory one, which
 * may already be a newly scanned key). Runs before anything can replace the pin (`captureJoinKey`, the top of
 * `adoptHostKey`) and again on every read. A token with no stored pin can't be attributed to any key and is
 * deleted; an existing readable record wins over it. The legacy key is removed even if writing the record
 * fails, so it can never be bound later to a pin that replaced the one it was issued under. Never throws.
 */
function migrateLegacyIdentityToken(): void {
  try {
    const origin = keyStorageOrigin();
    const legacyKey = LEGACY_IDENTITY_TOKEN_STORAGE_PREFIX + origin;
    const token = localStorage.getItem(legacyKey);
    if (token === null) {
      return;
    }
    try {
      const pin = localStorage.getItem(HOST_KEY_STORAGE_PREFIX + origin);
      if (token !== "" && pin && readIdentityTokenRecord() === undefined) {
        const record: IdentityTokenRecord = { k: pin, t: token };
        localStorage.setItem(IDENTITY_TOKEN_STORAGE_PREFIX + origin, JSON.stringify(record));
      }
    } finally {
      localStorage.removeItem(legacyKey);
    }
  } catch {
    // Storage blocked or full: nothing more can be done, and nothing readable is left behind to misattribute.
  }
}

/**
 * The stored secure identity token for the current origin, if it was issued under `hostKey` (the host key of
 * the session it is about to be sealed to) — or the in-memory wipe snapshot's, under the same rule, while a
 * wipe is clearing/has cleared localStorage. A token issued under any other key is never returned.
 */
function storedIdentityToken(hostKey: string): string | undefined {
  migrateLegacyIdentityToken();
  if (wipeTokenSnapshot?.k === hostKey) {
    return wipeTokenSnapshot.t;
  }
  const record = readIdentityTokenRecord();
  return record?.k === hostKey ? record.t : undefined;
}

/** Whether any identity token is held for this origin (stored or in the wipe snapshot), whatever its key. */
function hasStoredIdentityToken(): boolean {
  migrateLegacyIdentityToken();
  return wipeTokenSnapshot !== undefined || readIdentityTokenRecord() !== undefined;
}

/** Store `token` as this origin's identity token, bound to `hostKey`, the host key of the session that issued
 * it. Replaces any record for the origin, whatever its key. */
function storeIdentityToken(token: string, hostKey: string): void {
  // Never persist a token while a wipe is in progress (docs/20): an in-flight resume that resolves AFTER
  // the wipe cleared local storage would otherwise re-write the credential we just erased. `mintSuppressed`
  // is set for the whole wipe, so this closes that repopulation race for the identity token.
  if (mintSuppressed) {
    return;
  }
  const record: IdentityTokenRecord = { k: hostKey, t: token };
  const origin = keyStorageOrigin();
  try {
    localStorage.setItem(IDENTITY_TOKEN_STORAGE_PREFIX + origin, JSON.stringify(record));
    memoryTokenRecord = undefined;
  } catch {
    // Storage refused the write: this page load keeps the token, so its next resume presents it.
    memoryTokenRecord = { origin, record };
  }
}

/** Drop the stored identity token (invalid/revoked token, or explicit logout/wipe), in both the current and
 * the earlier storage format, and the page's own copy of one storage refused. Never throws. */
export function clearStoredIdentityToken(): void {
  memoryTokenRecord = undefined;
  try {
    const origin = keyStorageOrigin();
    localStorage.removeItem(IDENTITY_TOKEN_STORAGE_PREFIX + origin);
    localStorage.removeItem(LEGACY_IDENTITY_TOKEN_STORAGE_PREFIX + origin);
  } catch {
    // Storage blocked: nothing durable to clear.
  }
}

/** Credentials mode for a fetch on the live session: a `bound`/required session NEVER sends the cookie
 * (docs/20 — the cookie is not its credential; the un-sniffable session key is), so it omits it. An
 * anonymous optional session keeps cookie auth. */
function sessionCredentials(): RequestCredentials {
  return lastParams?.mode === "required" ? "omit" : "include";
}

/**
 * Set when the QR-delivered key (this boot's `#k=` hash, or a previously cached one for this origin)
 * disagrees with the server's advertised `transportPublicKey` — e.g. a swapped join-QR poster.
 * Surfaced so Settings can warn the user; the QR key is still the one trusted for the handshake.
 */
let hostKeyMismatch = false;

/**
 * Set for the duration of a device wipe (docs/20): while true, `resumeAttempt` REFUSES to mint a new
 * identity (it throws instead). The wipe revokes the existing identity and clears local state; any
 * re-handshake it triggers along the way (revoking a token over a revived session, or the cookie
 * `session/end` fallback) must NOT silently mint a fresh orphan identity to replace the one being wiped.
 */
let mintSuppressed = false;

/** Enter/leave the wipe window where new-identity minting is suppressed (docs/20). */
export function setMintSuppressed(value: boolean): void {
  mintSuppressed = value;
}

/**
 * Whether the live session's host key came from the QR (this boot's `#k=` fragment, or a previously
 * cached key for this origin) rather than only from the server's advertised `transportPublicKey`.
 * The QR is out-of-band-authenticated (MITM-resistant); the config-advertised key is delivered over
 * the same plain-HTTP channel it's meant to protect, so trusting it alone gives no MITM resistance —
 * Settings uses this to distinguish "verified" from merely "encrypted" in the UI.
 */
let sessionQrVerified = false;

/** The mode/host-key an `ensureSession` call last used, so a decrypt-failure/401 retry can
 * transparently re-handshake without the caller re-supplying context. */
let lastParams: { mode: TransportEncryption; hostKey?: string } | undefined;

/** The server origin a cached host key is namespaced under — the configured override if set, else
 * this page's own origin. */
function keyStorageOrigin(): string {
  try {
    return localStorage.getItem(SERVER_URL_KEY) || window.location.origin;
  } catch {
    // Storage entirely blocked (a browser with site data disabled): the page origin is the only origin.
    return window.location.origin;
  }
}

/** The join QR's key fragment, exactly: `#k=` + one base64url key and nothing else. */
const HASH_KEY_PATTERN = /^#k=([A-Za-z0-9_-]+)$/;

/** The base64url alphabet in value order (character i stands for the 6-bit value i). */
const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * The one spelling of a host public key, or undefined when `value` is not a 32-byte key. The base64url decoder
 * in `@loam/crypto` accepts several spellings of the same bytes (it stops at the first `=` and drops the unused
 * low bits of the last character), so comparing keys as strings would let a padded or respelled copy of the
 * pinned key look like a different key. This decodes the same way, requires 32 bytes and re-encodes unpadded:
 * 32 bytes are exactly 43 characters before any `=`, the first 42 carry whole 6-bit groups, and the last one
 * carries 4 bits, so its 2 low bits are cleared. Applied wherever a key enters this module (a `#k=`, the
 * launcher's global, the node's handshake and bootstrap answers) before it is stored or compared.
 */
function canonicalHostKey(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const padAt = value.indexOf("=");
  const body = padAt < 0 ? value : value.slice(0, padAt);
  if (body.length !== 43) {
    return undefined;
  }
  for (const char of body) {
    if (!BASE64URL_ALPHABET.includes(char)) {
      return undefined;
    }
  }
  return body.slice(0, 42) + BASE64URL_ALPHABET[BASE64URL_ALPHABET.indexOf(body[42]!) & 0x3c];
}

/** This page's `#k=` key in its one spelling, or undefined when there is none or it is not a 32-byte key. */
function hashJoinKey(): string | undefined {
  const match = HASH_KEY_PATTERN.exec(window.location.hash);
  return match ? canonicalHostKey(match[1]) : undefined;
}

/**
 * Read a `#k=<b64url>` fragment left by the join QR, cache it for this origin, and strip it from the
 * visible URL/history (the fragment is never sent to the server, but it's still a secret-shaped value
 * that shouldn't linger in the address bar or back-button history). Safe to call repeatedly — only
 * acts when the hash is actually present. A `#k=` that is not a 32-byte key is stripped and otherwise
 * ignored, as if there were none.
 */
function consumeHashKey(): string | undefined {
  if (!HASH_KEY_PATTERN.test(window.location.hash)) {
    return undefined;
  }

  const key = hashJoinKey();
  const url = new URL(window.location.href);
  url.hash = "";
  window.history.replaceState(window.history.state, "", url.toString());
  if (key === undefined) {
    return undefined;
  }

  // A `#k=` can arrive from ANY same-origin navigation, not only a scanned QR — a link someone posted in a
  // channel, say. So it only ever ESTABLISHES a pin silently; it never
  // silently REPLACES a different one. Replacing it would let any member lock others out (their next
  // handshake mismatches the node's real key → a pin-broken rescan gate), or — with an on-path position —
  // swap in an attacker's key. A different key is parked as a pending change: it is dropped silently if the
  // current pin still handshakes (the node has exactly one key), and offered to the user only once the pin
  // is broken — and acceptable only if it equals the key the node itself reported (`getPendingHostKeyChange`
  // / `acceptPendingHostKey`).
  const current = getCachedHostPublicKey();
  if (current !== undefined && current !== key) {
    pendingHostKey = key;
    return undefined;
  }

  adoptHostKey(key);
  return key;
}

/**
 * Pin `key` as this origin's trusted host key and clear any "pin broken" marker left by a mismatching
 * handshake (see `handshake`). Kept in memory as well as localStorage so a storage failure (quota, blocked
 * site data) can't downgrade a just-scanned join to an unpinned one for this load. A bare token from an
 * earlier release is bound to the pin being replaced first, so it is never attributed to the new key.
 */
function adoptHostKey(key: string): void {
  migrateLegacyIdentityToken();
  memoryHostKey = key;
  memoryPinBroken = false;
  pendingHostKey = undefined;
  observedHostKey = undefined;
  try {
    localStorage.setItem(HOST_KEY_STORAGE_PREFIX + keyStorageOrigin(), key);
    localStorage.removeItem(PIN_BROKEN_STORAGE_PREFIX + keyStorageOrigin());
  } catch {
    // In-memory copy still pins this load.
  }
}

/** A `#k=` that differed from the pin already held for this origin, awaiting the user's decision. Memory
 * only: a reload without re-opening the link simply drops it (the existing pin stays in force). */
let pendingHostKey: string | undefined;

/** The host key the node itself reported in a handshake that contradicted the pin (this load, memory only).
 * A pending `#k=` may replace the pin only if it equals this key: a link whose key the node doesn't hold can
 * only be someone else's key (a planted link or QR sticker), and pinning it would lock the user out — or,
 * for an on-path attacker, hand them the session. */
let observedHostKey: string | undefined;

/**
 * The key change a `#k=` link proposed this load — offered ONLY while the current pin is broken (the node's
 * handshake contradicted it); with a healthy pin a differing link is simply dropped. Carries both emoji
 * fingerprints so the UI can show the user what they'd be trusting, and `matchesNode`: whether the link's
 * key is the one the node actually reported. When it isn't, the change can't be accepted — the user must
 * rescan the QR shown at the host. `undefined` when there is nothing to decide.
 */
export function getPendingHostKeyChange(): { current: string; next: string; matchesNode: boolean } | undefined {
  const current = getCachedHostPublicKey();
  if (pendingHostKey === undefined || current === undefined || current === pendingHostKey || !isHostKeyPinBroken()) {
    return undefined;
  }
  return {
    current: transportFingerprint(current),
    next: transportFingerprint(pendingHostKey),
    matchesNode: observedHostKey === pendingHostKey,
  };
}

/**
 * The user explicitly accepted the pending key (they just scanned the node's current QR in person — e.g.
 * after an Emergency Reset or a restart rotated it). Refused unless the pin is broken AND the pending key is
 * exactly the key the node reported (see `observedHostKey`). Pins it, clears the broken marker, and drops the
 * live session (it was derived against the old key) so the next boot/reconnect pass handshakes against the
 * new one; the socket owner is told so a socket sealed under the old session is reopened.
 */
export function acceptPendingHostKey(): boolean {
  const next = pendingHostKey;
  if (next === undefined || !isHostKeyPinBroken() || next !== observedHostKey) {
    return false;
  }
  adoptHostKey(next);
  if (session && session.hostPublicKey !== next) {
    dropSession();
  }
  return true;
}

/** The user kept their current pin: forget the proposed key. */
export function rejectPendingHostKey(): void {
  pendingHostKey = undefined;
}

/** In-memory mirrors of the per-origin pin state, so the pin survives a localStorage failure within a
 * page load (never across loads — that is what the storage copy is for). */
let memoryHostKey: string | undefined;
let memoryPinBroken = false;

/** Where "the node's handshake reported a different key than this client's pin" is durably recorded.
 * While set, the pinned key is neither trusted for a handshake nor replaced by the
 * node's advertised key: the client gates on a fresh `#k=` scan, the only channel that can legitimately
 * re-establish trust. Cleared when a key is (re)adopted — a first `#k=` for this origin, the same key
 * rescanned, or an explicitly accepted key change (`adoptHostKey`). */
const PIN_BROKEN_STORAGE_PREFIX = "loam.transportPinBroken.";

function readStorage(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

/** The cached (or just-scanned-this-load) host public key for the current server origin, if any. */
export function getCachedHostPublicKey(): string | undefined {
  // The in-memory copy wins: it is set only by a scan on THIS load, so it is never staler than the stored
  // copy — and if the storage write failed, the stored copy may be a PREVIOUS key that must not outrank
  // the one just scanned (it would break the new pin as "changed").
  return memoryHostKey ?? readStorage(HOST_KEY_STORAGE_PREFIX + keyStorageOrigin());
}

/** Whether the pinned key for this origin has been contradicted by the node (see `handshake`). */
export function isHostKeyPinBroken(): boolean {
  return memoryPinBroken || readStorage(PIN_BROKEN_STORAGE_PREFIX + keyStorageOrigin()) === "1";
}

function markHostKeyPinBroken(): void {
  memoryPinBroken = true;
  try {
    localStorage.setItem(PIN_BROKEN_STORAGE_PREFIX + keyStorageOrigin(), "1");
  } catch {
    // The in-memory flag still gates this load.
  }
}

/**
 * Forget the pinned host public key (and any broken-pin marker) for the current origin. Used ONLY by a
 * wipe: a node wipe rotates the host's transport key, a device wipe discards this browser's relationship
 * with the node, and either way the verified rejoin needs a fresh `#k=` scan. A
 * MISMATCHING handshake deliberately does NOT call this — dropping the pin there would let an on-path
 * attacker convert a QR-pinned client into an unpinned one that then trusts the advertised key.
 */
export function clearCachedHostPublicKey(): void {
  memoryHostKey = undefined;
  memoryPinBroken = false;
  pendingHostKey = undefined;
  observedHostKey = undefined;
  try {
    localStorage.removeItem(HOST_KEY_STORAGE_PREFIX + keyStorageOrigin());
    localStorage.removeItem(PIN_BROKEN_STORAGE_PREFIX + keyStorageOrigin());
  } catch {
    // Nothing durable to clear.
  }
}

/** Whether the QR-delivered key and the node's advertised config key disagree (see `hostKeyMismatch`). */
export function getHostKeyMismatch(): boolean {
  return hostKeyMismatch;
}

/**
 * Whether the live session's host key is QR-verified (see `sessionQrVerified`) — `false` when there is
 * no live session, or when the session was established using only the server-advertised config key.
 */
export function isSessionQrVerified(): boolean {
  return !!session && sessionQrVerified;
}

/** The live transport session, if any (`undefined` when transport encryption is `off`, or `optional`
 * with no host key available yet). */
export function getSession(): Session | undefined {
  return session;
}

/**
 * The join URL to encode in a QR: appends the host's transport public key as a `#k=<b64url>` fragment
 * (docs/08) so a scanner learns the key **out-of-band** — the physical QR, not the network — which is
 * what makes the handshake MITM-resistant at join. The fragment is never sent to the server; the
 * *displayed* URL text should stay the plain `joinUrl` (this is for the QR image only). Returns
 * `joinUrl` unchanged when transport encryption is off / no key is available.
 */
export function joinQrUrl(joinUrl: string, transportPublicKey?: string): string {
  return transportPublicKey ? `${joinUrl}#k=${transportPublicKey}` : joinUrl;
}

/**
 * The host key to embed in a join QR THIS client shows to others (invite modal, Settings), and whether the
 * QR must be withheld. Only a key this client itself verified out-of-band —
 * the live session's key when it came from a scanned QR — may be vouched for: the advertised
 * `networkConfig.transportPublicKey` arrives over the unauthenticated plaintext bootstrap, so re-publishing
 * it as a `#k=` would let an on-path attacker pin every newcomer to THEIR key. With no verified key the QR
 * carries the plain join URL (the scanner joins unpinned, as if they'd typed it); when the advertised key
 * contradicts this client's pin (`getHostKeyMismatch`) something is wrong on the network, so the QR is
 * suppressed entirely.
 */
export function inviteQrHostKey(): { key?: string; suppressed: boolean } {
  if (hostKeyMismatch) {
    return { suppressed: true };
  }
  return { key: session && sessionQrVerified ? session.hostPublicKey : undefined, suppressed: false };
}

/** Emoji fingerprint of a host public key (docs/08) — defaults to the live session's host key. */
export function fingerprint(hostPublicKey?: string): string | undefined {
  const key = hostPublicKey ?? session?.hostPublicKey;
  return key ? transportFingerprint(key) : undefined;
}

/** Listeners told when the live session is REPLACED by a transparent re-handshake (see
 * `subscribeSessionReplaced`) — the WebSocket owner uses this to drop a socket sealed under the old key. */
const sessionReplacedListeners = new Set<() => void>();

/**
 * Subscribe to "the module session was replaced by a re-handshake". A socket confirmed under the previous
 * session key would otherwise decrypt every later frame against the wrong key and go silently deaf while
 * the server (which still holds the old session) keeps it open and the UI shows "live" — a single forged
 * unsealed 401 on a GET is enough to trigger a re-handshake. The subscriber closes its socket
 * so the normal reconnect path reopens one under the current session. Returns an unsubscribe.
 */
export function subscribeSessionReplaced(listener: () => void): () => void {
  sessionReplacedListeners.add(listener);
  return () => {
    sessionReplacedListeners.delete(listener);
  };
}

function notifySessionReplaced(): void {
  for (const listener of sessionReplacedListeners) {
    try {
      listener();
    } catch {
      // A listener failure must never break the re-handshake that just succeeded.
    }
  }
}

/**
 * Forget the live session, and tell the socket owner when there was one (`subscribeSessionReplaced`): a socket
 * opened under it must be closed, not left open with no key to check its frames against. Every path that drops
 * the session goes through here. Nothing is said when there was no session, so the resync of a node running
 * without encryption never closes its plaintext socket.
 */
function dropSession(): void {
  const hadSession = session !== undefined;
  session = undefined;
  sessionQrVerified = false;
  if (hadSession) {
    notifySessionReplaced();
  }
}

/**
 * Run the X25519 handshake against `hostPublicKey`. `qrPinned` says whether that key came from the join
 * QR (fresh `#k=` or the per-origin cache) rather than the node's own advertisement. The node returns the
 * public key it actually used; if that differs from the one we derived against, the session key is wrong
 * and nothing sealed under it can ever open — so rather than let the caller's retry paths loop forever on
 * `400 Malformed encrypted request` (as after an Emergency Reset rotates the key) we fail here.
 * For a QR-pinned key the pin is marked BROKEN (kept, not dropped): the live session — if any — is left
 * exactly as it was, and the caller is told a fresh scan is needed. The pin must never be discarded or
 * replaced from this path, and the returned key is NEVER adopted for the derivation: either would let
 * an on-path attacker who forges one handshake response turn a QR-pinned client into one that trusts
 * the advertised key, the downgrade the QR exists to prevent. A merely advertised (config) key just
 * errors, so the optional-mode caller retries later.
 */
async function handshake(hostPublicKey: string, qrPinned: boolean): Promise<void> {
  const hello = transportClientHello();
  const parsed = await postHandshake(hello.ephemeralPublic);

  if (parsed.hostPublicKey !== hostPublicKey) {
    if (qrPinned) {
      // Remember what the node says it holds: a pending `#k=` may replace the pin only if it matches.
      observedHostKey = parsed.hostPublicKey;
      markHostKeyPinBroken();
      throw new TransportNeedsQrError("changed");
    }
    throw new Error("Transport handshake returned a different host key than advertised");
  }

  const key = transportClientDerive({
    clientEphemeralSecret: hello.ephemeralSecret,
    hostPublic: hostPublicKey,
    hostEphemeralPublic: parsed.hostEphemeralPublic,
  });

  session = { sessionId: parsed.sessionId, key, hostPublicKey, seq: 0, bound: false, wsServerSeq: 0 };
}

/** POST one `/api/transport/handshake` and return the validated reply, its `hostPublicKey` in its one spelling
 * (`canonicalHostKey`). Throws on any network or validation failure, including a host key that is not 32 bytes. */
async function postHandshake(clientEphemeralPublic: string): Promise<TransportHandshakeResponse> {
  const response = await fetch(apiUrl("/api/transport/handshake"), {
    method: "POST",
    // The handshake is anonymous bootstrap; a bound/required client omits the cookie here too (docs/20).
    credentials: sessionCredentials(),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientEphemeralPublic }),
  });

  if (!response.ok) {
    throw new Error(`Transport handshake failed: ${response.status}`);
  }

  const parsed = TransportHandshakeResponseSchema.safeParse(await response.json().catch(() => undefined));
  const hostPublicKey = parsed.success ? canonicalHostKey(parsed.data.hostPublicKey) : undefined;

  if (!parsed.success || hostPublicKey === undefined) {
    throw new Error("Transport handshake returned an invalid response");
  }
  return { ...parsed.data, hostPublicKey };
}

/**
 * Learn which host key the node currently reports, without deriving or keeping a session. Used on a load
 * that starts with a broken pin AND a pending `#k=`, so the user may accept the link only if it is the
 * node's real key. Best effort: a failure leaves `observedHostKey` unset, so Accept stays unavailable.
 */
async function observeNodeHostKey(): Promise<void> {
  try {
    observedHostKey = (await postHandshake(transportClientHello().ephemeralPublic)).hostPublicKey;
  } catch {
    // Unreachable node: nothing observed this pass.
  }
}

/**
 * The host transport key the Android launcher injected into ITS OWN WebView (`window.__loamHostTransportKey`,
 * docs/04). The launcher read it from its embedded server over loopback, so inside that WebView it is as
 * authoritative as a scanned QR, and it must win over a stale pin: a node with an ephemeral DB key mints a
 * new transport key on every boot, which would otherwise break the host's own pin (gate + "different key"
 * prompt) on every launch. A LAN browser never has this global — only the host's WebView injects it, and that
 * WebView is pinned to the loopback origin — and a page on another origin can't set a global on this one. A
 * non-string value (DOM clobbering) is ignored.
 */
/**
 * This load's `#k=` key, read at start-up by {@link captureJoinKey} (before routing can rewrite the URL)
 * and taken once by the first {@link ensureSession}.
 */
let startupHashKey: string | undefined;

/**
 * Whether this page load began with a host key from an out-of-band source: a syntactically valid `#k=`
 * fragment (a scanned join QR, whether it was then adopted or parked as a pending change), or the Android
 * launcher's injected key in the host's own WebView. Recorded by {@link captureJoinKey}, which strips the
 * fragment from the URL, so this is the only way the app can learn afterwards that a QR was scanned
 * (re-reading the hash would find it gone, so a wiped device could never rejoin by rescanning).
 */
let startupJoinKeyPresent = false;

/** Adopt the Android launcher's key, if this is the host's own WebView (see `ensureSession`). */
function adoptLauncherKey(): void {
  const launcherKey = launcherHostKey();
  if (launcherKey !== undefined && (getCachedHostPublicKey() !== launcherKey || isHostKeyPinBroken())) {
    adoptHostKey(launcherKey);
  }
}

/**
 * Read (and pin) the join QR's `#k=` key at start-up, before anything else touches the URL. The router
 * replaces `/` with `/channels` on first render, which drops the fragment: read any later, a scanned QR's
 * key was simply gone, so a `required` node showed "Scan the join QR" to someone who just had, and an
 * `optional` one connected without the pin the QR is there to give. Call once, before rendering.
 */
export function captureJoinKey(): void {
  // Bind any bare token an earlier release stored to the pin it was issued under, before this load's
  // launcher key or `#k=` can replace that pin.
  migrateLegacyIdentityToken();
  adoptLauncherKey();
  // Remember the scan BEFORE `consumeHashKey` strips the fragment (and whether or not it adopts the key: a
  // `#k=` that differs from a held pin is parked, yet it is still the user's explicit act of scanning).
  startupJoinKeyPresent = hashJoinKey() !== undefined || launcherHostKey() !== undefined;
  startupHashKey = consumeHashKey();
}

/**
 * Whether a host key arrived out-of-band at THIS page load (see `startupJoinKeyPresent`): a scanned join
 * QR's `#k=`, or the launcher's injected key inside the Android host's own WebView, which is as deliberate
 * as a scan (the host has no QR to rescan). A wipe tombstone treats this as a rejoin attempt and lets boot
 * proceed to the handshake; the tombstone itself is lifted only once that handshake succeeds.
 */
export function joinKeyPresentAtStartup(): boolean {
  return startupJoinKeyPresent;
}

/** The launcher's injected key in its one spelling, or undefined when absent, not a string or not a 32-byte
 * base64url key. */
function launcherHostKey(): string | undefined {
  const value: unknown = (window as { __loamHostTransportKey?: unknown }).__loamHostTransportKey;
  return typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value) ? canonicalHostKey(value) : undefined;
}

/**
 * Establish (or refresh) a transport session for the given mode. `off` clears any session and is
 * otherwise a no-op. In `required` mode ONLY the QR-delivered key (this boot's `#k=` fragment, else a
 * previously cached one for this origin) is ever trusted for the handshake — falling back to the
 * server-advertised `configHostKey` would let an active MITM simply hand out its own key over the same
 * plain-HTTP channel the QR is meant to protect, defeating the reason `required` mode exists. In
 * `optional` mode `configHostKey` stays a fallback (best-effort encryption without the MITM guarantee)
 * when no QR key is available. When both a QR key and a config key are present and disagree, the QR
 * key is what gets used either way (see `getHostKeyMismatch`) — the QR is the out-of-band-authenticated
 * channel, config is not. When `required` and no QR key is available, throws `TransportNeedsQrError`.
 *
 * REUSES a live session bound to the same host key rather than re-handshaking (docs/20). This is called
 * on every boot/reconnect resync; a blind re-handshake would mint a NEW session object and orphan a
 * WebSocket already sealed under the current one — the socket would then decrypt every inbound frame
 * against the wrong key and go silently deaf. If the reused session is actually dead, the REST/resume
 * retry paths (`reHandshake`, and `loadConfig`'s resume recovery) force a fresh handshake to recover.
 */
export async function ensureSession(mode: TransportEncryption, configHostKey?: string): Promise<void> {
  const before = getImageTransportMode();
  const pending = ensureTransportSession(mode, configHostKey);
  const during = getImageTransportMode();
  if (during !== before) notifyImageTransportChanged();
  try {
    await pending;
  } finally {
    if (getImageTransportMode() !== during) notifyImageTransportChanged();
  }
}

async function ensureTransportSession(mode: TransportEncryption, advertisedHostKey?: string): Promise<void> {
  // The bootstrap's key in its one spelling, so a respelled copy of the pin is never a "mismatch"; a value
  // that is not a 32-byte key counts as no advertised key at all.
  const configHostKey = canonicalHostKey(advertisedHostKey);
  // Inside the Android host's own WebView the launcher-provided key is trusted directly (`launcherHostKey`):
  // adopt it before the `#k=` is read, so the launcher's own fragment is a quiet confirmation rather than a
  // "different key" prompt on every boot of an ephemeral-key node.
  adoptLauncherKey();
  const hashKey = consumeHashKey() ?? startupHashKey;
  startupHashKey = undefined;
  const qrKey = hashKey ?? getCachedHostPublicKey();

  // A QR key pins this join to an encrypted, MITM-authenticated session. `/api/config` is
  // unauthenticated, so its `transportEncryption` value is attacker-mutable — a network MITM could
  // flip it to `off` to strip encryption while the user believes their scanned QR protected them.
  // Presence of a QR key (freshly scanned `#k=` or one cached from a prior verified join) overrides
  // the advertised mode: we treat the join as `required` and never fall back to plaintext once the
  // operator has handed out a key out-of-band. `lastParams` stores the *effective* mode so a later
  // `reHandshake` keeps the pin instead of degrading on reconnect.
  const effectiveMode: TransportEncryption = qrKey ? "required" : mode;
  lastParams = { mode: effectiveMode, hostKey: configHostKey };

  // A pinned key the node has contradicted (see `handshake`) is neither trusted nor replaced: gate until a
  // fresh scan. A `#k=` consumed on THIS load already cleared the marker, so this only fires for a cached
  // pin — the post-Emergency-Reset case, or an attacker who forged a handshake response earlier.
  if (qrKey && !hashKey && isHostKeyPinBroken()) {
    dropSession();
    if (pendingHostKey !== undefined) {
      // A differing `#k=` came with this load: learn whether it is the node's real key, so the gate can offer
      // it (and only then) instead of a dead end.
      await observeNodeHostKey();
    }
    throw new TransportNeedsQrError("changed");
  }

  if (effectiveMode === "off") {
    dropSession();
    hostKeyMismatch = false;
    return;
  }

  hostKeyMismatch = !!qrKey && !!configHostKey && qrKey !== configHostKey;
  const hostPublicKey = effectiveMode === "required" ? qrKey : (qrKey ?? configHostKey);

  if (!hostPublicKey) {
    if (effectiveMode === "required") {
      // No QR key on a required join — DROP any existing (possibly `optional`/config-key, non-QR-verified)
      // session so a later `resumeIdentity` can't bind a secret token over it (docs/20), then gate the app.
      dropSession();
      throw new TransportNeedsQrError();
    }

    dropSession();
    return;
  }

  // Reuse a live session already bound to this host key — don't re-handshake and orphan a live WS (above).
  if (session && session.hostPublicKey === hostPublicKey) {
    sessionQrVerified = hostPublicKey === qrKey;
    dropPendingIfPinHealthy(hostPublicKey, qrKey);
    return;
  }

  await handshake(hostPublicKey, hostPublicKey === qrKey);
  sessionQrVerified = hostPublicKey === qrKey;
  dropPendingIfPinHealthy(hostPublicKey, qrKey);
}

/** The pinned key just handshook (or its live session was reused), so the node holds it; a differing `#k=`
 * parked this load can't be the node's key and is dropped without asking. */
function dropPendingIfPinHealthy(hostPublicKey: string, qrKey: string | undefined): void {
  if (qrKey !== undefined && hostPublicKey === qrKey) {
    pendingHostKey = undefined;
  }
}

/**
 * Whether a boot that could not establish a transport session may proceed in plaintext under the
 * node's ADVERTISED mode. Only when the advertisement is `optional` AND this client
 * holds no QR key: a QR key pins the join to `required` (see `ensureSession`'s `effectiveMode`), and the
 * advertisement comes from the unauthenticated bootstrap, so an on-path attacker who fails one handshake
 * POST must not be able to drop a QR-joined client into plaintext + cookie identity with no warning. Call
 * only after `ensureSession` has run (it records the effective mode even when it throws).
 */
export function mayFallBackToPlaintext(advertisedMode: TransportEncryption): boolean {
  return advertisedMode === "optional" && !plaintextRefused();
}

/**
 * Whether this client must never send or accept plaintext, session or no session: the last `ensureSession`
 * settled on `required`, or this origin holds a pinned host key, or the Android launcher injected one. The pin
 * and the launcher key are read directly, so the rule holds from the first moment of a page load, before
 * `/api/bootstrap` has answered and `ensureSession` has run (a slow node, a tab reloaded off the hotspot: the
 * cached conversation is on screen with a live composer by then), and a storage hiccup that left `lastParams`
 * stale can never authorise plaintext for a pinned origin. The fetch path, the socket URL, the socket frame
 * handler, the image mode, the plaintext fallback and the boot's cookie config all ask this.
 */
export function plaintextRefused(): boolean {
  return lastParams?.mode === "required" || getCachedHostPublicKey() !== undefined || launcherHostKey() !== undefined;
}

/** Thrown by the fetch/WebSocket entry points when the effective mode is `required` but no session exists
 * (the QR gate is showing, or a pin was broken mid-session): plaintext is never an option there. */
function requiredSessionMissing(): Error {
  return new Error("This node requires an encrypted session and none is established. Scan its join QR to reconnect.");
}

/** A single in-flight re-handshake, shared by all concurrent callers (docs/20 §5.6/§9). Without this, a
 * burst of parallel requests all 401ing on an expired session would each handshake AND resume, minting
 * several fresh identities and fragmenting the client. */
let reHandshakeInFlight: Promise<boolean> | undefined;

/** Re-run the last `ensureSession` call's mode/host key after a session apparently expired
 * server-side. Best-effort: returns `false` on any failure so the caller's own error path takes over.
 * Mirrors `ensureSession`'s trust rule: `required` mode only ever re-handshakes against the QR-cached
 * key, never falling back to the config-advertised one. Concurrent calls share ONE in-flight op. */
async function reHandshake(): Promise<boolean> {
  if (reHandshakeInFlight) {
    return reHandshakeInFlight;
  }
  reHandshakeInFlight = doReHandshake();
  try {
    return await reHandshakeInFlight;
  } finally {
    reHandshakeInFlight = undefined;
  }
}

async function doReHandshake(): Promise<boolean> {
  if (!lastParams || lastParams.mode === "off") {
    return false;
  }

  const storedPin = getCachedHostPublicKey();
  // During a device wipe the pin is already erased when the token is revoked: the snapshot taken before the
  // erasure is the key to re-establish over, so a session that died in the meantime can still be replaced
  // and the token revoked over it.
  const cachedKey = storedPin ?? wipeHostKeySnapshot;
  const hostPublicKey = lastParams.mode === "required" ? cachedKey : (cachedKey ?? lastParams.hostKey);

  if (!hostPublicKey) {
    return false;
  }

  try {
    // Only a key still pinned in storage is treated as the pin by a mismatching answer (marked broken, so the
    // next boot gates on a rescan). The wipe snapshot is not: marking it would write a pin-broken record back
    // into the storage the wipe just cleared, so a mismatch there is a plain failure and the revocation gives up.
    await handshake(hostPublicKey, hostPublicKey === storedPin);
    sessionQrVerified = hostPublicKey === cachedKey;
    // A fresh transport session starts `anonymous` server-side; a bound/required client must re-bind
    // its identity before content or the WebSocket will work again (docs/20). Re-resume with the stored
    // token — silently (a lost identity just re-mints), so the caller's retry proceeds on a bound session.
    // Only a token issued under this session's host key is presented (see `resumeAttempt`).
    if (lastParams.mode === "required" && session) {
      try {
        await resumeAttempt(session, {}, false);
      } catch {
        // `handshake` has ALREADY replaced the module session — the socket owner must still be told, or a
        // socket confirmed under the previous key stays open and deaf.
        notifySessionReplaced();
        return false;
      }
    }
    // The module session is now a different one: tell the socket owner so a socket confirmed under the
    // old key is closed and reopened under this one (see `subscribeSessionReplaced`).
    notifySessionReplaced();
    return true;
  } catch {
    return false;
  }
}

/** Path + direction-separated AAD for the sealed identity resume (docs/20 §5). */
const RESUME_PATH = "/api/session/resume";
const RESUME_AAD = "POST /api/session/resume";

/**
 * The associated data a node seals its reply to a request that asked with `r: 2` under (docs/08 "Response
 * binding"): method, path, sequence and status as one JSON array behind a fixed label. The node seals a
 * bare `METHOD url` under the raw request target, which can never start with `loam.`, and JSON keeps the
 * four fields apart, so no target a stranger sends can produce a ciphertext that opens here.
 */
function boundResponseAad(method: string, path: string, seq: number, status: number): string {
  return `loam.transport.response.v2 ${JSON.stringify([method, path, seq, status])}`;
}

/** The associated data of a refusal a node sent before it had read the request's sequence (`encStatus2`). */
function refusalResponseAad(method: string, path: string, status: number): string {
  return `loam.transport.refusal.v2 ${JSON.stringify([method, path, status])}`;
}

/**
 * Open a sealed resume reply only under the binding the request asked for (`r: 2`), `boundResponseAad` for
 * this sequence and status. Unlike `openBoundResponse` this never falls back to the refusal seal, because
 * the client acts on what a resume reply says (a 401 discards the stored identity token), so only an
 * answer to THIS request with THIS status may count.
 *
 * @returns The plaintext, or null when the payload is missing or does not open under that binding.
 */
function openBoundResumeReply(key: string, payload: unknown, seq: number, status: number): string | null {
  const enc = payload && typeof payload === "object" ? (payload as { enc?: unknown }).enc : undefined;
  return typeof enc === "string" ? openTransport(key, enc, boundResponseAad("POST", RESUME_PATH, seq, status)) : null;
}

/**
 * Bind this transport session to a persistent secure identity (docs/20). Seals `{ token? }` to the
 * DIRECT `/api/session/resume` endpoint (credentials omitted — the cookie is never a bound credential),
 * verifies the sealed reply is bound to the exact request it answers (`s/m/p`, §9), stores the returned
 * 256-bit token per origin, bound to this session's host key, and marks the session `bound`. With no token
 * stored for that key (none yet, or the user accepted a different key) the server mints a fresh identity; a
 * stored-but-rejected token is cleared and a fresh identity minted once. Returns the
 * authenticated `currentUser`. Requires a live transport session (call after `ensureSession`).
 */
export async function resumeIdentity(init: EncryptedFetchInit = {}): Promise<{ currentUser: unknown }> {
  const active = session;
  if (!active) {
    throw new Error("Cannot resume an identity without a transport session");
  }
  // Enforce the docs/20 §3 invariant HERE, not just by caller convention: the long-lived token is only
  // ever sent over a session whose host key came from the QR (out-of-band-authenticated). Key this on the
  // ACTUAL session's `sessionQrVerified`, NOT `lastParams.mode` — a prior `optional`/config-key session
  // can still be live after a later `ensureSession("required")` that threw for want of a QR key (which
  // sets `lastParams.mode="required"` before it throws), and resuming over THAT unverified session would
  // seal the secret token to a possibly-MITM-substituted key.
  if (!sessionQrVerified) {
    throw new Error("Refusing to bind a secure identity over a non-QR-verified session");
  }
  return resumeAttempt(active, init, false);
}

/**
 * One sealed resume over `active`. The token presented is the one stored for `active`'s own host key (none
 * after a key change, so the server mints a fresh identity), and a returned token is stored bound to that
 * key. `retriedFreshMint` is the one tokenless retry after the server rejected the stored token.
 */
async function resumeAttempt(
  active: Session,
  init: EncryptedFetchInit,
  retriedFreshMint: boolean,
): Promise<{ currentUser: unknown }> {
  const token = retriedFreshMint ? undefined : storedIdentityToken(active.hostPublicKey);
  // A resume with no token asks the server to MINT a fresh identity. During a wipe that must never happen
  // (docs/20) — the identity is being discarded, not replaced — so refuse rather than spawn an orphan.
  if (token === undefined && mintSuppressed) {
    throw new Error("Identity minting is suppressed (wipe in progress)");
  }
  const seq = ++active.seq;
  // `r: 2` asks the server to seal its answer under `boundResponseAad` for this sequence and status (docs/08
  // "Response binding"), so the outer status, which travels in the clear, can't be relabelled.
  const envelope = JSON.stringify(token === undefined ? { s: seq, r: 2, b: {} } : { s: seq, r: 2, b: { token } });
  const response = await fetch(apiUrl(RESUME_PATH), {
    method: "POST",
    credentials: "omit",
    headers: { "content-type": "application/json", "x-loam-enc": active.sessionId },
    signal: init.signal,
    body: JSON.stringify({ enc: sealTransport(active.key, envelope, RESUME_AAD) }),
  });

  const payload: unknown =
    response.headers.get("x-loam-enc") === "1" ? await response.json().catch(() => undefined) : undefined;
  const opened = openBoundResumeReply(active.key, payload, seq, response.status);

  // A 401 that OPENS under this request's sequence and status came from the resume handler after it
  // decrypted our body: the token itself was rejected (unknown or revoked). Clear it and mint a brand-new
  // identity exactly once, rather than stranding the client on a dead token. Any other 401 (unsealed, or
  // sealed but not openable under that binding) is `onRequest` refusing an expired transport session, or
  // a forgery: the outer status and the `x-loam-enc` header are outside the AEAD, so an on-path attacker
  // can fake both. Never discard the identity on one; let it propagate so the caller re-handshakes with
  // the token still stored.
  if (response.status === 401) {
    if (opened === null) {
      throw new Error("Identity resume failed: 401");
    }
    if (token !== undefined && !retriedFreshMint) {
      clearStoredIdentityToken();
      return resumeAttempt(active, init, true);
    }
    throw new Error("Identity resume rejected");
  }

  if (response.status !== 200) {
    throw new Error(`Identity resume failed: ${response.status}`);
  }
  if (opened === null) {
    throw new Error("Identity resume response could not be decrypted");
  }

  let result: { s?: unknown; m?: unknown; p?: unknown; currentUser?: unknown; token?: unknown };
  try {
    result = JSON.parse(opened) as typeof result;
  } catch {
    throw new Error("Malformed identity resume response");
  }

  // Response binding (docs/20 §9): the resume reply carries the secret token and is sealed under a
  // CONSTANT aad, so confirm it answers the exact { s, m, p } we sent before trusting/storing the token —
  // an attacker can't cross-feed a different sealed resume reply.
  if (result.s !== seq || result.m !== "POST" || result.p !== RESUME_PATH) {
    throw new Error("Identity resume response did not match the request");
  }

  if (typeof result.token === "string") {
    storeIdentityToken(result.token, active.hostPublicKey);
  }
  active.bound = true;
  return { currentUser: result.currentUser };
}

/** Re-establish the transport session (handshake + re-bind if required) for the WS reconnect path, where
 * an expired session id would otherwise loop. Best-effort — returns `false` on any failure. */
export async function reestablishSession(): Promise<boolean> {
  return reHandshake();
}

/** The `aad` bound into a REST frame: exactly `${METHOD} ${path}` — `path` is the same path+query
 * string handed to `fetch`, matching `${request.method} ${request.url}` server-side. */
function restAad(method: string, path: string): string {
  return `${method} ${path}`;
}

/**
 * Open a direct sealed response (docs/08, "Response binding"). The server seals the answer to a request
 * under `boundResponseAad`: the sequence that request carried, so a response captured earlier on the same
 * route can't be passed off as this one, and the status it was sent with, so the outer status (outside the
 * AEAD) can't be relabelled. The one exception is a refusal the server made before it could authenticate the
 * request's sequence (a 429 from the rate limiter, a 400 for a malformed envelope, a 409 for a replay): its
 * `encStatus2` is sealed under `refusalResponseAad`, and is accepted only with an error status, so the worst
 * a replay of one can do is fail a request, never feed it old data. The bare-aad `enc` and the `!status`
 * `encStatus` that ride beside it are for older clients and are never opened here: both are built from the
 * raw request target, which a stranger chooses.
 *
 * @returns The plaintext, or null when neither opens.
 */
function openBoundResponse(key: string, payload: unknown, method: string, path: string, seq: number, status: number): string | null {
  const record = payload && typeof payload === "object" ? (payload as { enc?: unknown; encStatus2?: unknown }) : {};
  const bound = typeof record.enc === "string" ? openTransport(key, record.enc, boundResponseAad(method, path, seq, status)) : null;
  if (bound !== null) {
    return bound;
  }
  return status >= 400 && typeof record.encStatus2 === "string"
    ? openTransport(key, record.encStatus2, refusalResponseAad(method, path, status))
    : null;
}

export interface EncryptedFetchInit {
  signal?: AbortSignal;
  /** Never re-handshake (and so never resume) to retry this request: a failure is the caller's to handle.
   *  For a best-effort read that must not start a new session, such as `reloadNetworkConfig`. */
  noRehandshake?: boolean;
}

/** Methods that never mutate server state — safe to retry after ANY kind of failure, including one
 * where the server may already have processed the request (see `attemptFetch`'s decrypt-failure
 * branch). */
const SAFE_METHODS = new Set(["GET", "HEAD"]);

/** Re-handshake once the per-session request sequence gets within this of the safe-integer ceiling, so
 * the counter never loses precision. Vast headroom — this is never hit in a real session. */
const SEQ_REHANDSHAKE_THRESHOLD = Number.MAX_SAFE_INTEGER - 1024;

/**
 * The single REST entry point every call site uses instead of a bare `fetch(apiUrl(path), …)`. With
 * no live session (mode `off`, or `optional` with no key yet) this is a byte-for-byte pass-through —
 * same method/credentials/headers/body shape as the pre-transport-encryption client. With a live
 * session: the body is sealed as `{ enc }` (even an empty payload, for any non-GET/HEAD method — see
 * below), the `x-loam-enc: <sessionId>` header asks the server to seal the response too, and the
 * response is transparently unsealed back into a normal `Response` the caller can `.json()` / check
 * `.ok` on exactly as before. A 401 or a decrypt failure (the session likely expired) triggers exactly
 * one re-handshake + retry before giving up — but see `attemptFetch` for why a decrypt failure only
 * retries for safe methods.
 *
 * @param method - HTTP method, exactly as it will appear on the wire (e.g. `"POST"`).
 * @param path - The server-relative path + query string (e.g. `/api/messages`, `/api/search?q=x`).
 * @param body - Optional JSON-serializable request body.
 * @param init - Optional `AbortSignal` to wire into the underlying `fetch`, and `noRehandshake` to skip the
 *   re-handshake retry (the request then counts as already retried).
 */
export async function encryptedFetch(
  method: string,
  path: string,
  body?: unknown,
  init: EncryptedFetchInit = {},
): Promise<Response> {
  return attemptFetch(method, path, body, init, init.noRehandshake === true);
}

async function attemptFetch(
  method: string,
  path: string,
  body: unknown,
  init: EncryptedFetchInit,
  retried: boolean,
): Promise<Response> {
  const active = session;

  if (!active) {
    // FAIL CLOSED: under an effective `required` mode (the node requires it, or this client is
    // QR-pinned, which holds before the first `ensureSession` too) a missing session must never degrade
    // to a plaintext cookie request, or a forged 401 + forged handshake could open exactly that hole.
    // `off`/unpinned-`optional` keep the pass-through shape.
    if (plaintextRefused()) {
      throw requiredSessionMissing();
    }
    return fetch(apiUrl(path), {
      method,
      credentials: "include",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      signal: init.signal,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  // Re-handshake (resetting the per-session sequence to 0) well before the counter could approach the
  // safe-integer ceiling, past which it would lose precision/monotonicity. Unreachable in
  // practice — a 12h session cannot issue 2^53 requests — but correct, and near-free to check.
  if (active.seq >= SEQ_REHANDSHAKE_THRESHOLD && !retried && (await reHandshake())) {
    return attemptFetch(method, path, body, init, true);
  }

  // `required` mode (the hardened profile, always the case for a QR-pinned join) routes every request
  // through the opaque tunnel so the real path + query — e.g. a search term, or which channel is being
  // read — never appear on the wire. `optional` keeps the lighter per-route body sealing below.
  if (lastParams?.mode === "required") {
    return tunnelFetch(active, method, path, body, init, retried);
  }

  const isSafe = SAFE_METHODS.has(method.toUpperCase());
  const aad = restAad(method, path);
  // Every request carries a sealed `{ s, r: 2, b? }` envelope: `s` is this session's next monotonic
  // sequence number (for the server's replay window), `r: 2` asks the server to bind its response to that
  // sequence and to its status under `boundResponseAad` (docs/08, "Response binding"), and `b` is the actual
  // body (omitted when there is none).
  // `++active.seq` is atomic under JS's single thread, so concurrent in-flight requests each get a
  // distinct, ever-increasing number. A safe (GET/HEAD) call with no body can't carry one in the body, so
  // the envelope rides the `x-loam-seq` header instead. Every other method is ALWAYS sealed in the body,
  // even with an empty payload: the server requires a sealed `{ enc }` body from any mutation presented
  // under a live session, so a bodyless mutation still proves it went through the session.
  const seq = ++active.seq;
  const envelope = JSON.stringify(body === undefined ? { s: seq, r: 2 } : { s: seq, r: 2, b: body });
  const inHeader = isSafe && body === undefined;
  const requestBody = inHeader ? undefined : JSON.stringify({ enc: sealTransport(active.key, envelope, aad) });
  const headers: Record<string, string> = { "content-type": "application/json", "x-loam-enc": active.sessionId };
  if (inHeader) {
    headers["x-loam-seq"] = sealTransport(active.key, envelope, aad);
  }

  const response = await fetch(apiUrl(path), {
    method,
    credentials: sessionCredentials(),
    headers,
    signal: init.signal,
    body: requestBody,
  });

  if (response.headers.get("x-loam-enc") === "1") {
    const payload: unknown = await response.json().catch(() => undefined);
    const opened = openBoundResponse(active.key, payload, method, path, seq, response.status);

    if (opened === null) {
      // The server replied `x-loam-enc: 1` — i.e. its handler already ran and produced a response —
      // and we simply can't decrypt it (e.g. the session key changed between request and response).
      // Retrying is only safe here for methods that don't mutate state: retrying a POST/PATCH/DELETE
      // would re-apply a mutation the server already committed.
      if (isSafe && !retried && (await reHandshake())) {
        return attemptFetch(method, path, body, init, true);
      }

      throw new Error("Transport session expired");
    }

    return new Response(opened, { status: response.status, statusText: response.statusText });
  }

  // A 401 USUALLY means the server refused the request in `onRequest`, BEFORE any handler ran (expired
  // session) — safe to retry. But the outer status is OUTSIDE the AEAD: a network middleman could forge a
  // 401 on a request the server actually PROCESSED, stripping `x-loam-enc` so we think the handler never
  // ran. Retrying then would REPLAY the mutation (duplicate message / repeated admin op, docs/20). So
  // only auto-retry SAFE (GET/HEAD) methods here; a mutation surfaces the 401 to the caller unretried.
  if (response.status === 401 && isSafe && !retried && (await reHandshake())) {
    return attemptFetch(method, path, body, init, true);
  }

  // Under a live session the server seals everything it answers once it has looked the session up, so an
  // unsealed reply can only be one of the refusals it makes before that (`unsealedRefusal`). Any other
  // unsealed reply is refused: passing it through would let an on-path attacker strip the seal and serve
  // forged plaintext (messages, a mesh identity card), which would make the response binding moot.
  const refusal = unsealedRefusal(response.status);
  if (refusal) {
    return refusal;
  }
  throw new UnsealedResponseError(response.status);
}

/**
 * The refusals a node sends UNSEALED to a client that holds a live session, because it makes them before it
 * has resolved that session's key: a 401 for a session it doesn't know (a restart, the 12 h TTL), a 421 for
 * a Host name it doesn't serve, a 503 while an Emergency Reset is in flight.
 */
const UNSEALED_REFUSAL_CODES: ReadonlyMap<number, { error: string; code: string }> = new Map([
  [401, { error: "Transport session expired", code: "session_invalid" }],
  [421, { error: "This address isn't served by this LOAM node", code: "host_not_allowed" }],
  [503, { error: "This network is resetting. Try again in a moment.", code: "node_resetting" }],
]);

/**
 * A content-free stand-in for an unsealed refusal (see `UNSEALED_REFUSAL_CODES`), or undefined for any other
 * status. The wire body is dropped: it is unauthenticated, so its text never reaches the screen. The caller
 * gets the status and the stable code, which is all those refusals carry.
 */
function unsealedRefusal(status: number): Response | undefined {
  const body = UNSEALED_REFUSAL_CODES.get(status);
  return body
    ? new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
    : undefined;
}

/** The single opaque endpoint every `required`-mode request is tunnelled through (docs/08). */
const TUNNEL_PATH = "/api/transport/tunnel";

/** The statuses a `Response` may not carry a body with (the Fetch standard's null body statuses). */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 103, 204, 205, 304]);

/** Decode standard base64 (the tunnel descriptor's `bodyB64`, from Node's `Buffer.toString("base64")`)
 * into a raw `ArrayBuffer`, so a tunnelled binary response (images) reconstructs losslessly while a
 * JSON one still `.json()`s. `atob` is available in an insecure context (unlike most of WebCrypto). */
function base64ToBytes(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const buffer = new ArrayBuffer(binary.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i += 1) {
    view[i] = binary.charCodeAt(i);
  }
  return buffer;
}

/**
 * Send a request through the metadata-hiding tunnel (docs/08 v2). The real `{ method, path, body }` is
 * sealed inside the `{ s, r: 2, b }` anti-replay envelope and POSTed to the single opaque
 * `/api/transport/tunnel`, so the path/query (a search term, which channel is read) never hit the wire.
 * The reply opens only as the answer to this request (`openBoundResponse`, docs/08 "Response binding"), and
 * is a `{ status, contentType, bodyB64 }` descriptor rebuilt into a normal `Response`, or the tunnel route's
 * own refusal, returned with the outer status it was sealed for. Mirrors `attemptFetch`'s one-shot re-handshake retry (safe methods only, on a decrypt
 * failure or an unsealed 401), delegating the retry back through `attemptFetch` so it re-tunnels under the
 * fresh session.
 */
async function tunnelFetch(
  active: Session,
  method: string,
  path: string,
  body: unknown,
  init: EncryptedFetchInit,
  retried: boolean,
): Promise<Response> {
  const aad = restAad("POST", TUNNEL_PATH);
  const inner = body === undefined ? { m: method, p: path } : { m: method, p: path, body };
  const seq = ++active.seq;
  // `r: 2` asks for the reply sealed under `boundResponseAad` for this sequence and the outer status, as on the
  // direct path: every tunnel request shares one route, so a bare-aad reply to one would open as the answer to
  // any other, and the tunnel route's own refusals (401, 409, 429) would lose their status.
  const requestBody = JSON.stringify({
    enc: sealTransport(active.key, JSON.stringify({ s: seq, r: 2, b: inner }), aad),
  });

  const response = await fetch(apiUrl(TUNNEL_PATH), {
    method: "POST",
    credentials: sessionCredentials(),
    headers: { "content-type": "application/json", "x-loam-enc": active.sessionId },
    signal: init.signal,
    body: requestBody,
  });

  const isSafe = SAFE_METHODS.has(method.toUpperCase());

  if (response.headers.get("x-loam-enc") === "1") {
    const payload: unknown = await response.json().catch(() => undefined);
    const opened = openBoundResponse(active.key, payload, "POST", TUNNEL_PATH, seq, response.status);

    if (opened === null) {
      if (isSafe && !retried && (await reHandshake())) {
        return attemptFetch(method, path, body, init, true);
      }
      throw new Error("Transport session expired");
    }

    let descriptor: { s?: unknown; m?: unknown; p?: unknown; status?: unknown; contentType?: unknown; bodyB64?: unknown };
    try {
      descriptor = JSON.parse(opened) as typeof descriptor;
    } catch {
      throw new Error("Malformed tunnel response");
    }
    // The tunnel route's own refusals (a bad target, an unbound session, a replay, the rate limiter) reply
    // with a sealed errorBody, NOT a `{ status, contentType, bodyB64 }` descriptor. It opened under this
    // request's binding for the outer status, so that status is the node's own: hand the refusal over with
    // it rather than crashing on `base64ToBytes(undefined)`.
    if (typeof descriptor.status !== "number" || typeof descriptor.bodyB64 !== "string") {
      return new Response(opened, { status: response.status, headers: { "content-type": "application/json" } });
    }
    // Response binding (docs/20 §9): the descriptor also echoes the exact { s, m, p } we sent. The seal
    // already binds the sequence; checking the method and path as well keeps a descriptor that names another
    // request from ever rendering as this one's. A mismatch is fatal (never a silent wrong render).
    if (descriptor.s !== seq || descriptor.m !== method || descriptor.p !== path) {
      throw new Error("Tunnel response did not match the request");
    }
    const contentType = typeof descriptor.contentType === "string" ? descriptor.contentType : "application/octet-stream";
    // Rebuild a normal Response from the raw bytes (an ArrayBuffer is a valid BodyInit), so the caller's
    // `.json()` / `.blob()` work exactly as on a direct response, text and binary (images) alike. A
    // null-body status (a 204 from a delete or `/api/typing`) must get a null body: the constructor throws
    // on any body for those, even an empty one.
    const nullBody = NULL_BODY_STATUSES.has(descriptor.status);
    return new Response(nullBody ? null : base64ToBytes(descriptor.bodyB64), {
      status: descriptor.status,
      headers: { "content-type": contentType },
    });
  }

  // Only auto-retry SAFE methods on an unsealed outer 401 (docs/20): the status is outside the AEAD, so
  // a middleman could forge it on an already-processed request and a retry would replay the mutation.
  if (response.status === 401 && isSafe && !retried && (await reHandshake())) {
    return attemptFetch(method, path, body, init, true);
  }

  // NEVER hand an unsealed body to the caller. Everything the real server
  // answers on a live tunnel session is sealed, except the pre-handler refusals (an expired session's 401,
  // the post-reset 503, a replay 409, a malformed-envelope 400, a rate-limit 429) — and those carry no
  // content the caller needs. Passing any other unsealed reply through would let an on-path attacker forge
  // it: a fake `GET /api/mesh/identity` card (mesh contact key substitution), fake messages, fake images.
  // So an unsealed reply is only ever a typed error, never a Response.
  throw new UnsealedResponseError(response.status);
}

/**
 * Thrown when a reply to a request made under a live session arrives WITHOUT the session seal (see
 * `tunnelFetch` and `attemptFetch`). Carries the outer status for diagnostics only — it is unauthenticated,
 * so callers must not branch on it for anything that matters; the message is a fixed, human-readable
 * description.
 */
export class UnsealedResponseError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(
      status === 401
        ? "Transport session expired"
        : status === 503
          ? "The node is restarting; try again in a moment."
          : status === 429
            ? "Too many requests; try again in a moment."
            : `The node sent an unencrypted reply (${status}), which was refused.`,
    );
    this.name = "UnsealedResponseError";
    this.status = status;
  }
}

/** Whether requests are currently being tunnelled (required mode with a live session). When true, the
 * server refuses a direct `<img>` GET for avatars/attachments, so images must be fetched through the
 * tunnel and rendered from a `blob:` URL — see `encryptedImageUrl`. */
export function isTunnelActive(): boolean {
  return !!session && lastParams?.mode === "required";
}

/** A QR pin requires a tunnel even before a handshake finishes on an Optional node. */
export function getImageTransportMode(): "direct" | "pending" | "tunnel" {
  if (isTunnelActive() && sessionQrVerified && !isHostKeyPinBroken()) return "tunnel";
  return plaintextRefused() ? "pending" : "direct";
}

const imageTransportListeners = new Set<() => void>();

export function subscribeImageTransportChanged(listener: () => void): () => void {
  imageTransportListeners.add(listener);
  const unsubscribeSession = subscribeSessionReplaced(listener);
  return () => {
    imageTransportListeners.delete(listener);
    unsubscribeSession();
  };
}

function notifyImageTransportChanged(): void {
  for (const listener of imageTransportListeners) listener();
}

/** Bounded cache of tunnelled image object URLs (`path → blob: URL`), so an avatar that appears in
 * dozens of rows is fetched once. Evicting (or resetting) revokes the URL to release the blob. */
const imageObjectUrls = new Map<string, string>();
/** How many mounted elements currently hold each path's URL (`retainImageUrl`/`releaseImageUrl`). An entry
 * with holders is never evicted: revoking a `blob:` URL an `<img>` still points at breaks the image the
 * next time the browser re-reads it. */
const imageUrlHolders = new Map<string, number>();

/** Mark `path`'s image URL as in use by one more element (call before resolving it, release on unmount). */
export function retainImageUrl(path: string): void {
  imageUrlHolders.set(path, (imageUrlHolders.get(path) ?? 0) + 1);
}

/** Drop one holder of `path`'s image URL; once none remain it becomes evictable again. */
export function releaseImageUrl(path: string): void {
  const remaining = (imageUrlHolders.get(path) ?? 0) - 1;
  if (remaining > 0) {
    imageUrlHolders.set(path, remaining);
  } else {
    imageUrlHolders.delete(path);
  }
}

/** Evict the oldest cached image URL nobody holds, if the cache is full. When every entry is held the cache
 * briefly exceeds its bound instead — it's bounded by what is actually on screen. */
function evictImageUrlIfFull(): void {
  if (imageObjectUrls.size < IMAGE_URL_CACHE_MAX) {
    return;
  }
  for (const [path, url] of imageObjectUrls) {
    if (!imageUrlHolders.has(path)) {
      URL.revokeObjectURL(url);
      imageObjectUrls.delete(path);
      return;
    }
  }
}
/** In-flight fetches by path, so N rows requesting the same avatar on first paint share ONE tunnel
 * fetch instead of racing N of them (each of which would create — and mostly leak — a blob URL). */
const imageUrlInFlight = new Map<string, Promise<string>>();
const IMAGE_URL_CACHE_MAX = 200;

/**
 * Resolve an image path to a render-ready `src`. With the tunnel active (required mode) the raw
 * endpoint refuses a direct `<img>` GET, so the bytes are fetched through the tunnel (coming back
 * sealed) and handed back as a cached `blob:` object URL. Otherwise returns the plain same-origin URL
 * unchanged only if the client does not require a tunnel. Concurrent callers for the same path share
 * a single in-flight fetch.
 *
 * FAILS CLOSED (docs/20 §11): when the tunnel is active and the fetch fails, it returns an empty string
 * — NEVER the raw `apiUrl(path)`. Falling back to the raw URL would make the browser issue a direct,
 * UNENCRYPTED `<img>` GET on a `required` node (leaking which avatar/attachment is being viewed, and
 * relying on plaintext bytes), defeating the tunnel. A missing image beats a downgraded one.
 */
export async function encryptedImageUrl(path: string): Promise<string> {
  const mode = getImageTransportMode();
  if (mode === "direct") return apiUrl(path);
  if (mode === "pending") return "";
  const cached = imageObjectUrls.get(path);
  if (cached) {
    return cached;
  }
  const inFlight = imageUrlInFlight.get(path);
  if (inFlight) {
    return inFlight;
  }

  const generation = imageCacheGeneration;
  const pending = (async () => {
    try {
      const response = await encryptedFetch("GET", path);
      if (!response.ok) {
        return ""; // fail closed — no direct, unencrypted fallback GET
      }
      const blob = await response.blob();
      if (generation !== imageCacheGeneration) {
        // The cache was cleared (a wipe or an identity change) while this was in flight: don't bring the
        // old identity's image back into it.
        return "";
      }
      const objectUrl = URL.createObjectURL(blob);
      evictImageUrlIfFull();
      imageObjectUrls.set(path, objectUrl);
      return objectUrl;
    } catch {
      return ""; // fail closed
    } finally {
      // After a clear the map may already hold a NEWER fetch for this path; leave that one alone.
      if (generation === imageCacheGeneration) {
        imageUrlInFlight.delete(path);
      }
    }
  })();

  imageUrlInFlight.set(path, pending);
  return pending;
}

/** Bumped by every `clearImageObjectUrls`. An image fetch that started under an older generation doesn't
 * cache its result, and `useEncryptedImage` re-resolves mounted images when it changes. */
let imageCacheGeneration = 0;
const imageCacheListeners = new Set<() => void>();

/** The current image-cache generation (see `clearImageObjectUrls`). */
export function getImageCacheGeneration(): number {
  return imageCacheGeneration;
}

/** Be told when the image cache is cleared, so a mounted image re-resolves its now-revoked URL. Returns an
 * unsubscribe. */
export function subscribeImageCacheCleared(listener: () => void): () => void {
  imageCacheListeners.add(listener);
  return () => {
    imageCacheListeners.delete(listener);
  };
}

/**
 * Revoke every cached image object URL (wipe, identity change, test reset) so blobs aren't leaked. Holder
 * counts are KEPT: those elements are still mounted, and each releases exactly once when it unmounts or
 * re-resolves — clearing the counts here would let those later releases drive other paths' counts wrong.
 * Instead the generation is bumped and listeners told, so every mounted
 * image drops its revoked `blob:` URL and resolves again.
 */
export function clearImageObjectUrls(): void {
  for (const url of imageObjectUrls.values()) {
    URL.revokeObjectURL(url);
  }
  imageObjectUrls.clear();
  imageUrlInFlight.clear();
  imageCacheGeneration += 1;
  for (const listener of imageCacheListeners) {
    try {
      listener();
    } catch {
      // A listener failure must not stop the others from re-resolving.
    }
  }
}

/**
 * What this module knows about the socket `wsUrl` was last called for. Like the per-connection state on the
 * session, it assumes one live socket per tab, and every `wsUrl` call starts it afresh.
 *  - `sealed`: the socket was opened under a session (an `enc=` URL). Such a socket never yields a plaintext
 *    frame, whatever has happened to the session since.
 *  - `clientNonce`: the `cn` this socket sent; its challenge must name it (`handleWsFrame`).
 *  - `gap`: a frame on this socket skipped a sequence number, so nothing more is taken from it.
 */
let wsSocket: { sealed: boolean; clientNonce?: string; gap: boolean } = { sealed: false, gap: false };

/** A fresh `cn` for a new socket: 16 random bytes (`crypto.getRandomValues`, the source `@loam/crypto` draws
 * from too), as 22 unpadded base64url characters. */
function newClientNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Append the live session's `?enc=<sessionId>` to a WebSocket URL (docs/08), so the server knows to
 * seal inbound frames; unchanged when no session is active. Also RESETS the per-connection
 * key-confirmation state (docs/20 §7): every new socket gets a fresh challenge with a fresh connection
 * id, so `handleWsFrame` must forget the previous connection's id + sequence. A sealed socket also sends
 * `cn=<random>`, which the server repeats inside the sealed challenge: a challenge without it can't be the
 * answer to THIS socket, so a previous connection's challenge and frames replayed onto a new socket under
 * the same session are refused. */
export function wsUrl(base: string): string {
  if (session) {
    session.wsConnectionId = undefined;
    session.wsServerSeq = 0;
  }
  // Same fail-closed rule as `attemptFetch`: no plaintext socket under an effective `required` mode, or for
  // a pinned client before its session exists.
  if (!session && plaintextRefused()) {
    wsSocket = { sealed: false, gap: false };
    throw requiredSessionMissing();
  }
  if (!session) {
    wsSocket = { sealed: false, gap: false };
    return base;
  }
  const clientNonce = newClientNonce();
  wsSocket = { sealed: true, clientNonce, gap: false };
  return `${base}${base.includes("?") ? "&" : "?"}enc=${encodeURIComponent(session.sessionId)}&cn=${clientNonce}`;
}

/** Direction-separated AADs for the reflection-safe WS key-confirmation (docs/20 §7). */
const WS_CHALLENGE_AAD = "loam.ws.challenge.v1";
const WS_PROOF_AAD = "loam.ws.proof.v1";
function wsFrameAad(connectionId: string): string {
  return `loam.ws.frame.v1 ${connectionId}`;
}

/**
 * Handle one inbound WebSocket frame (docs/20 §7). Returns exactly one of:
 *  - `{ proof }`:   a sealed key-confirmation proof the caller must send straight back over the socket
 *                   (the reply to the server's challenge). Until this is sent the socket receives nothing.
 *  - `{ payload }`: a decoded application-frame payload (a `ClientEvent` JSON string) to process.
 *  - `{ gap }`:     a frame skipped a sequence number (one was lost or dropped on the way). The caller must
 *                   close the socket and reconnect, which resyncs; nothing more is taken from this socket.
 *  - `{}`:          ignore (undecryptable, malformed, replayed, or a pre-confirmation frame).
 * With no live session the raw frame passes straight through as `{ payload }`, but only on a socket that was
 * opened in the clear by a client that may talk plaintext (`plaintextRefused`): a socket opened under a session
 * that has since been dropped, or any socket of a pinned client, yields nothing.
 */
export function handleWsFrame(raw: unknown): { proof?: string; payload?: string; gap?: true } {
  const active = session;
  if (!active) {
    if (wsSocket.sealed || plaintextRefused()) {
      return {};
    }
    return { payload: typeof raw === "string" ? raw : String(raw) };
  }
  if (wsSocket.gap) {
    return {};
  }
  const text = String(raw);

  // Not yet confirmed on this connection: the only thing we accept is the server's challenge, sealed
  // under the challenge aad. Anything else (including a reflected app frame) fails to open and is ignored.
  if (active.wsConnectionId === undefined) {
    const opened = openTransport(active.key, text, WS_CHALLENGE_AAD);
    if (opened === null) {
      return {};
    }
    let challenge: { type?: unknown; connectionId?: unknown; nonce?: unknown; cn?: unknown };
    try {
      challenge = JSON.parse(opened) as typeof challenge;
    } catch {
      return {};
    }
    if (challenge.type !== "challenge" || typeof challenge.connectionId !== "string" || typeof challenge.nonce !== "string") {
      return {};
    }
    // The challenge must repeat the `cn` this socket sent (see `wsUrl`). Without it, it could be an earlier
    // connection's challenge replayed onto this socket by someone on the path, followed by that connection's
    // frames up to a point of their choosing (a deleted message back, an edit undone).
    if (wsSocket.clientNonce === undefined || challenge.cn !== wsSocket.clientNonce) {
      return {};
    }
    active.wsConnectionId = challenge.connectionId;
    active.wsServerSeq = 0;
    // Answer under the SEPARATE proof aad — a keyless attacker can only reflect the challenge bytes,
    // which won't open under this aad server-side, so reflection can never confirm.
    const proof = sealTransport(
      active.key,
      JSON.stringify({ type: "proof", connectionId: challenge.connectionId, nonce: challenge.nonce }),
      WS_PROOF_AAD,
    );
    return { proof };
  }

  // Confirmed: an application frame is `{ q, f }` sealed under the connection-bound aad. Reject a frame
  // whose sequence doesn't advance (a replay, or one captured on another connection — different aad).
  const opened = openTransport(active.key, text, wsFrameAad(active.wsConnectionId));
  if (opened === null) {
    return {};
  }
  let envelope: { q?: unknown; f?: unknown };
  try {
    envelope = JSON.parse(opened) as typeof envelope;
  } catch {
    return {};
  }
  if (typeof envelope.q !== "number" || typeof envelope.f !== "string" || envelope.q <= active.wsServerSeq) {
    return {};
  }
  // The server numbers every frame on a connection 1, 2, 3, ... and never skips one (`wsSend`), so a jump
  // means a frame was lost or held back on the way: a delete or a moderator removal the client would never
  // hear about. Report it once and take nothing more from this socket; the reconnect resyncs.
  if (envelope.q !== active.wsServerSeq + 1) {
    wsSocket.gap = true;
    return { gap: true };
  }
  active.wsServerSeq = envelope.q;
  return { payload: envelope.f };
}

/** Path + AAD for the sealed logout / device-wipe revocation (docs/20 §8). */
const LOGOUT_PATH = "/api/session/logout";
const LOGOUT_AAD = "POST /api/session/logout";

/** One logout attempt on the CURRENT session. Returns `true` ONLY when a sealed `{ ok:true }` reply is
 * decrypted — the actual, outcome-based confirmation the server revoked the token. An unsealed reply (a
 * dead-session 401) or a decrypt/parse failure returns `false`. Callers wrap this in an ordered wipe. */
async function attemptSecureLogout(init: EncryptedFetchInit): Promise<boolean> {
  const active = session;
  if (!active?.bound) {
    return false;
  }
  const seq = ++active.seq;
  const response = await fetch(apiUrl(LOGOUT_PATH), {
    method: "POST",
    credentials: "omit",
    headers: { "content-type": "application/json", "x-loam-enc": active.sessionId },
    signal: init.signal,
    body: JSON.stringify({ enc: sealTransport(active.key, JSON.stringify({ s: seq, b: {} }), LOGOUT_AAD) }),
  });
  if (response.headers.get("x-loam-enc") !== "1") {
    return false; // unsealed → onRequest refused it (dead session); nothing was revoked
  }
  const payload: unknown = await response.json().catch(() => undefined);
  const enc = payload && typeof payload === "object" ? (payload as { enc?: unknown }).enc : undefined;
  const opened = typeof enc === "string" ? openTransport(active.key, enc, LOGOUT_AAD) : null;
  if (opened === null) {
    return false;
  }
  try {
    return (JSON.parse(opened) as { ok?: unknown }).ok === true;
  } catch {
    return false;
  }
}

/**
 * Revoke this device's secure identity SERVER-SIDE (docs/20 §8) before a local wipe/logout clears
 * storage. OUTCOME-driven, so it can't leave the token silently unrevoked:
 *
 *  1. Try the sealed logout on the current session; a `true` return means the server confirmed revocation.
 *  2. If that didn't confirm (the transport session had died — e.g. expired/evicted while the client still
 *     believed it was bound), **re-establish + rebind with the stored token and retry once**, so the
 *     revocation actually lands rather than being skipped on the strength of a stale local `bound` flag.
 *  3. Clear the local token regardless (a wiped device must not retain it).
 *
 * Minting is expected to be suppressed (`setMintSuppressed`) for the whole wipe, so the re-establish in
 * step 2 can't mint a fresh orphan if the stored token is already dead. Returns `true` ONLY when
 * revocation was CONFIRMED (informational — `wipeServerCredentials` clears the legacy cookie
 * UNCONDITIONALLY regardless, since the two credentials are independent).
 */
export async function logoutSecureIdentity(init: EncryptedFetchInit = {}): Promise<boolean> {
  let revoked = false;
  try {
    revoked = await attemptSecureLogout(init);
    if (!revoked && hasStoredIdentityToken()) {
      // The current session may be dead — revive a fresh bound session with the stored token, then retry.
      if (await reHandshake()) {
        revoked = await attemptSecureLogout(init);
      }
    }
  } catch {
    // Best effort — the local clear below still runs (the network is the threat model).
  } finally {
    clearStoredIdentityToken();
    if (session) {
      session.bound = false;
    }
  }
  return revoked;
}

/**
 * Run `op` under a REAL deadline (docs/20). Resolves within `timeoutMs` EVEN IF `op` never settles: `op`'s
 * internal fetches may ignore the abort signal (the logout recovery chain re-handshakes, and those
 * handshake/resume fetches aren't wired to it), so a network blackhole could hang the promise forever.
 * We therefore RACE `op` against a timer rather than trusting the abort to end it — a hung `op` keeps
 * running in the background, which is fine during a wipe (the page is torn down). `op`'s errors are
 * swallowed (best effort); the abort still fires to cancel whatever fetch IS wired to the signal.
 */
async function withDeadline<T>(op: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T | undefined> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(undefined);
    }, timeoutMs);
  });
  try {
    return await Promise.race([op(controller.signal).catch(() => undefined), deadline]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Clear this device's SERVER-side credentials for a wipe (docs/20): revoke the bound secure identity
 * token AND clear any legacy `loam_session` cookie, as two INDEPENDENT, each-deadline-bounded steps with
 * minting suppressed throughout. Crucially it always SETTLES (within ~2×`timeoutMs`) even if the network
 * blackholes a step — so the caller's local purge always proceeds. The two steps are separate credentials
 * (§3): the sealed logout omits the cookie; the bare `session/end` sends and clears it.
 *
 * Best-effort: the `session/end` reply is UNSEALED, so an active LAN attacker could forge a 200 while the
 * real request is blocked — meaning we must NOT treat it as a security confirmation (docs/20).
 * The durable wipe tombstone is therefore NOT lifted here; it stays until a VERIFIED explicit rejoin (a
 * QR-pinned handshake that actually succeeds).
 */
export async function wipeServerCredentials(timeoutMs: number): Promise<void> {
  setMintSuppressed(true);
  try {
    // The logout (and its stale-session re-establish/retry) reads `storedIdentityToken()`, which falls back
    // to the pre-erasure snapshot for a session under the snapshot's key — so revocation still works even though local storage was
    // already cleared. Mint suppression keeps that snapshot from being written back.
    await withDeadline((signal) => logoutSecureIdentity({ signal }), timeoutMs);
    await withDeadline(
      (signal) => fetch(apiUrl("/api/session/end"), { method: "POST", credentials: "include", signal }),
      timeoutMs,
    );
  } finally {
    wipeTokenSnapshot = undefined;
    wipeServerUrlSnapshot = undefined;
    wipeHostKeySnapshot = undefined;
  }
}

/** Test-only: reset all module state between tests. Never called from app code. */
export function resetTransportStateForTests(): void {
  session = undefined;
  hostKeyMismatch = false;
  sessionQrVerified = false;
  lastParams = undefined;
  memoryHostKey = undefined;
  memoryPinBroken = false;
  pendingHostKey = undefined;
  observedHostKey = undefined;
  startupHashKey = undefined;
  startupJoinKeyPresent = false;
  reHandshakeInFlight = undefined;
  mintSuppressed = false;
  wipeTokenSnapshot = undefined;
  wipeServerUrlSnapshot = undefined;
  wipeHostKeySnapshot = undefined;
  memoryTokenRecord = undefined;
  wsSocket = { sealed: false, gap: false };
  clearImageObjectUrls();
  imageUrlHolders.clear();
}

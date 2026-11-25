// The optional LLM assistant: the bot user, the Ollama / OpenAI-compatible / on-device backends, and the
// DM-driven assistant reply, behind the shared `Runtime` view.
import { randomBytes } from "node:crypto";

import {
  activeLlmProvider,
  type AssistantDestination,
  isLocalNetworkUrl,
  LLM_MODEL_MAX_LENGTH,
  type LlmModelsRequest,
  type LlmModelsResponse,
  type LlmProvider,
  type LoamConfig,
  type Message,
  MessageSchema,
  sameUrlOrigin,
  type User,
  UserSchema,
} from "@loam/schema";
import { isRecord } from "./config.js";
import { ASSISTANT_DESTINATION_CONFIG_KEY } from "./db.js";
import { MAX_LLM_CONTEXT_MESSAGES } from "./defaults.js";
import { makeBotUser } from "./identity.js";
import { newMessageId } from "./ids.js";
import type { OnDeviceChatHook } from "./types.js";
import type { Runtime } from "./runtime.js";

/**
 * How many assistant replies may stream at once across the whole node. Each one holds an Ollama request
 * (or the host's on-device model) for up to 5 minutes; without a bound, a handful of users — or one user
 * firing DMs — could queue unbounded generations on a Pi/phone host. Per user the limit is one.
 */
export const MAX_CONCURRENT_ASSISTANT_REPLIES = 2;

/** The body an assistant reply is left with when it was cut off (crash/restart mid-stream) before any text. */
export const INTERRUPTED_ASSISTANT_BODY = "(No response: the assistant was interrupted.)";
/** What a DM shows when the model backend fails; the backend's own words go to the log, never to a member. */
export const ASSISTANT_FAILURE_BODY = "(The assistant could not answer this time. Please try again later.)";

/** How long one streamed reply may take, whichever backend answers. */
const CHAT_TIMEOUT_MS = 5 * 60 * 1000;
/** How long a "which models do you have" request may take. */
const MODELS_TIMEOUT_MS = 15 * 1000;
/** Most model names a backend's list is trimmed to (OpenRouter offers several hundred). */
const MODELS_MAX = 500;
/** Most bytes of a model list read from a backend; a bigger answer is `llm_bad_response`. */
const MODELS_MAX_BYTES = 8 * 1024 * 1024;
/** Most bytes of a failed response's body read for the log line (`errorDetail`); the rest is never read. */
const ERROR_DETAIL_MAX_BYTES = 4 * 1024;
/** Most characters a streamed reply may hold since its last newline: no Ollama or SSE line comes near it, so
 * a service that streams on without one is refused rather than buffered for ever (`streamLines`). */
const STREAM_LINE_MAX_CHARS = 256 * 1024;

/**
 * Most characters of an assistant reply the node keeps. A runaway or hostile backend could otherwise make the
 * node store and broadcast a reply of any size; past this the reply is finalised with
 * `ASSISTANT_REPLY_CUT_OFF_NOTE` and the backend is no longer read.
 */
export const ASSISTANT_REPLY_MAX_CHARS = 64_000;
/** What follows a reply cut at `ASSISTANT_REPLY_MAX_CHARS`, after a blank line. */
export const ASSISTANT_REPLY_CUT_OFF_NOTE = "(The answer was cut off here because it was too long.)";

/** The message `applyConfigUpdate` refuses with (mapped to `llm_cloud_not_allowed` in errors.ts). */
export const CLOUD_ASSISTANT_REFUSED = "A cloud assistant is not allowed on a hardened network";
/** The message `applyConfigUpdate` refuses with when a network that requires encryption is pointed at an
 * assistant over plain HTTP on another machine (mapped to `llm_unencrypted_not_allowed` in errors.ts). */
export const UNENCRYPTED_ASSISTANT_REFUSED = "An assistant on another computer must use HTTPS on this network";

/** What the launcher forces on top of the config (`AppOptions`), as the assistant checks need it. */
export type LlmLauncherPolicy = { requireTransportEncryption?: boolean };

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

/**
 * Most characters of DM history (system prompt aside) sent to the Android phone's on-device model. Its
 * context is 4096 tokens with no context shift, so 40 turns of up to 8000 characters can't fit; the phone
 * trims to the exact token budget with the model's own tokenizer (apps/app `llm-context-budget.ts`), and
 * this coarser bound keeps the request over the launcher bridge small. Roughly four times what fits.
 */
export const ON_DEVICE_CONTEXT_MAX_CHARS = 16_000;

/**
 * The newest turns of `history` whose bodies add up to at most `maxChars` characters, always keeping the
 * newest turn (the message being answered), and never opening on an assistant turn (Gemma's chat template
 * refuses a conversation that doesn't alternate from a user turn).
 */
export function capHistoryByChars(history: ChatMessage[], maxChars: number = ON_DEVICE_CONTEXT_MAX_CHARS): ChatMessage[] {
  let start = history.length;
  let total = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const next = total + history[index].content.length;
    if (next > maxChars && start < history.length) {
      break;
    }
    total = next;
    start = index;
  }
  let kept = history.slice(start);
  while (kept.length > 1 && kept[0].role === "assistant") {
    kept = kept.slice(1);
  }
  return kept;
}

/**
 * Why `config`'s assistant backend may not run, or undefined when it may: a `hardened` network keeps every
 * message on the local network, so a network-backed assistant there must run on this computer or the LAN
 * (LM Studio, llama.cpp, Ollama on a laptop), never behind a public address (docs/09, docs/29 Track 3). Ollama
 * is held to the same rule as an OpenAI-compatible service: it answers wherever its address points, so an
 * Ollama address on the internet is a cloud assistant too. Only the on-device model is local by construction.
 * Checked before a save is persisted and again at boot, so a hand-edited config.json can't route a hardened
 * network's DMs to the internet either.
 */
export function llmProviderRefusal(config: LoamConfig, policy: LlmLauncherPolicy = {}): string | undefined {
  const baseUrl = activeBackendUrl(config.llm);
  if (baseUrl === undefined) {
    return undefined;
  }
  if (config.security.profile === "hardened" && !isLocalNetworkUrl(baseUrl)) {
    return CLOUD_ASSISTANT_REFUSED;
  }
  if (unencryptedBackendRefused(baseUrl, policy)) {
    return UNENCRYPTED_ASSISTANT_REFUSED;
  }
  return undefined;
}

/**
 * Whether a network whose launcher requires transport encryption (the Android host) must refuse `baseUrl`:
 * the assistant gets members' messages, so on such a network they may leave this machine only over HTTPS.
 * Plain HTTP is allowed to a loopback address, which never leaves the machine. Applies to Ollama and an
 * OpenAI-compatible service alike, since both answer wherever their address points.
 */
export function unencryptedBackendRefused(baseUrl: string, policy: LlmLauncherPolicy): boolean {
  if (!policy.requireTransportEncryption) {
    return false;
  }
  let protocol: string;
  try {
    protocol = new URL(baseUrl).protocol;
  } catch {
    return true;
  }
  return protocol !== "https:" && !isLoopbackLiteral(backendHostname(baseUrl));
}

/**
 * Whether `host` (as `backendHostname` gives it) is this machine by its spelling alone: `localhost`, 127/8,
 * `::1` or an IPv4-mapped 127/8. Not a `*.localhost` name: Node's `fetch` and Android's resolver look such a
 * name up in DNS like any other (only `localhost` is in the hosts file), so it can answer from another
 * machine.
 */
function isLoopbackLiteral(host: string): boolean {
  return (
    host === "localhost" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
    host === "::1" ||
    // URL parsing spells an IPv4-mapped loopback (`[::ffff:127.0.0.1]`) in hex (`::ffff:7f00:1`).
    /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(host)
  );
}

/**
 * The active network backend as a save changes it: provider and address. Two configs with the same key send
 * members' messages to the same place, so a save that keeps an already-refused key changes nothing about
 * where they could go.
 */
export function activeBackendKey(llm: LoamConfig["llm"]): string {
  return `${activeLlmProvider(llm)} ${activeBackendUrl(llm) ?? ""}`;
}

/** The address the active network-backed assistant answers from; undefined for the on-device model or off. */
export function activeBackendUrl(llm: LoamConfig["llm"]): string | undefined {
  switch (activeLlmProvider(llm)) {
    case "ollama":
      return llm.ollama.baseUrl;
    case "openai":
      return llm.openai.baseUrl;
    default:
      return undefined;
  }
}

/**
 * Whether a backend answered with a redirect. No backend request follows one, on any network: a 307 or 308
 * keeps the POST body, so a redirect could carry a member's question and DM history to an origin other than
 * the one members were told (`NetworkConfig.assistantDestination`), past the locality and encryption checks
 * made on the configured address. Requests use `redirect: "manual"`, so Node's `fetch` hands back the 3xx
 * itself (with its `Location`) and nothing is sent to the target.
 */
function isRedirect(response: Response): boolean {
  return response.status >= 300 && response.status < 400;
}

/**
 * The log line for a redirect a backend answered with: the status and the target's hostname only (a
 * `Location` can carry credentials or a path), resolved against the request's address.
 */
function redirectMessage(what: string, url: string, response: Response): string {
  const location = response.headers.get("location");
  let target = "another address";
  if (location) {
    try {
      target = backendHostname(new URL(location, url).href);
    } catch {
      // An unparseable Location names nothing worth logging.
    }
  }
  return `${what} answered ${response.status} with a redirect to ${target}; the assistant does not follow redirects, so set the service's final address`;
}

/**
 * The hostname a backend address names: lower-cased, without port or IPv6 brackets. An address `new URL`
 * can't parse (the schema validates it as a URL, so this is defensive) gives whatever precedes its first
 * `/`, `:`, `?` or `#`, so it is still named, never treated as local.
 */
function backendHostname(baseUrl: string): string {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    host = (baseUrl.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(/[/:?#]/)[0] ?? "").toLowerCase();
  }
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  return host.slice(0, 253) || "unknown";
}

/**
 * The endpoint a backend address names, as the history cut identifies a recipient (docs/06): scheme,
 * hostname, port when given, and path without a trailing slash (`https://openrouter.ai/api/v1`,
 * `http://127.0.0.1:11434`), never the credentials or query an address might carry. Two tenants on one host
 * (`/tenant-a/v1`, `/tenant-b/v1`) are two recipients, and so are `http://` and `https://` on one host (plain
 * HTTP can be read and redirected on the way); the same service written with or without a trailing slash is
 * one.
 */
function backendEndpoint(baseUrl: string): string {
  try {
    return `${new URL(baseUrl).protocol}//${schemelessBackendEndpoint(baseUrl)}`;
  } catch {
    return schemelessBackendEndpoint(baseUrl);
  }
}

/** `backendEndpoint` without the scheme: how versions before the scheme counted spelled a destination,
 * kept so a record they wrote for the same destination is recognised (`currentDestinationRecord`). */
function schemelessBackendEndpoint(baseUrl: string): string {
  const host = backendHostname(baseUrl);
  try {
    const url = new URL(baseUrl);
    const path = url.pathname.replace(/\/+$/, "");
    return `${host}${url.port ? `:${url.port}` : ""}${path}`;
  } catch {
    return host;
  }
}

/**
 * Where a network-backed assistant at `baseUrl` answers from, as members are told it (docs/06): this
 * computer (a loopback address by its spelling, `isLoopbackLiteral`), another computer on the local network
 * (`isLocalNetworkUrl`), or an online service named by its hostname. A `*.localhost` name is resolved like
 * any other name, so it is an online service here.
 */
export function classifyBackendUrl(baseUrl: string): AssistantDestination {
  const host = backendHostname(baseUrl);
  if (isLoopbackLiteral(host)) {
    return { kind: "host" };
  }
  return isLocalNetworkUrl(baseUrl) ? { kind: "lan" } : { kind: "online", host };
}

/** The record under `ASSISTANT_DESTINATION_CONFIG_KEY`: which destination the assistant last answered from,
 * since when (ms epoch; 0 = since before this record existed), and a random revision minted with it (absent
 * from a record an earlier version wrote, until it is next read). */
type AssistantDestinationRecord = { key: string; since: number; rev?: string };

/** Parse a stored destination record; undefined when it is absent or unreadable. */
function parseDestinationRecord(raw: string | undefined): AssistantDestinationRecord | undefined {
  if (raw === undefined) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed) && typeof parsed.key === "string" && typeof parsed.since === "number" && Number.isFinite(parsed.since)) {
      const rev = typeof parsed.rev === "string" && /^[0-9a-f]{32}$/.test(parsed.rev) ? parsed.rev : undefined;
      return { key: parsed.key, since: parsed.since, rev };
    }
  } catch {
    // Unreadable: treated as a change (see currentDestinationRecord).
  }
  return undefined;
}

/** Resolve a path against a backend's base URL, whatever trailing slashes it was saved with. */
function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

/** The headers an OpenAI-compatible service gets: JSON, and the bearer key when one is set. */
function openAiHeaders(apiKey: string | undefined): Record<string, string> {
  return apiKey ? { "content-type": "application/json", authorization: `Bearer ${apiKey}` } : { "content-type": "application/json" };
}

/**
 * A failure a backend reported. `message` is a fixed line naming the backend and the HTTP status, or saying
 * that its stream reported an error: nothing in it comes from the backend, so it may go in the default log.
 * `detail` is the backend's own text, cut to 200 characters, and is logged at debug level only: a service
 * may quote the member's question in its error, and the host's log outlives an Emergency Reset.
 */
class BackendError extends Error {
  readonly detail: string;

  constructor(message: string, detail: string) {
    super(message);
    this.detail = detail;
  }
}

/** A backend's own text cut for the debug log: 200 characters, anything shaped like an API key replaced
 * (a service's 401 text can quote the start of the key it refused, as OpenAI's does). */
function backendText(text: string): string {
  return text.slice(0, 200).replace(/\b(?:sk|or|gsk)[-_][A-Za-z0-9_*.-]{6,}/g, "[key]");
}

/** A fetch error's name is all a member-facing path needs; the rest is for the log. */
function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * POST a streaming chat request and yield the response body one line at a time (trimmed, blank lines
 * dropped), for the newline-delimited JSON Ollama streams and the SSE `data:` lines an OpenAI-compatible
 * service streams. One timeout covers the whole exchange; the reader is cancelled however the caller leaves.
 * A redirect is refused (`isRedirect`), and so is a line longer than `STREAM_LINE_MAX_CHARS`.
 */
async function* streamLines(url: string, headers: Record<string, string>, body: unknown, what: string): AsyncGenerator<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
  let response: Response;

  try {
    response = await fetch(url, { method: "POST", headers, signal: controller.signal, body: JSON.stringify(body), redirect: "manual" });
  } catch (error) {
    clearTimeout(timeout);
    throw isAbort(error) ? new Error(`${what} request timed out before streaming started.`) : error;
  }

  if (isRedirect(response)) {
    clearTimeout(timeout);
    void response.body?.cancel().catch(() => undefined);
    throw new Error(redirectMessage(what, url, response));
  }

  if (!response.ok || !response.body) {
    // Read the failure's first line under the same timeout: a service that answers 500 and never closes
    // the body must not hold the assistant's slot for ever.
    let detail = "";
    try {
      detail = await errorDetail(response);
    } finally {
      clearTimeout(timeout);
    }
    throw new BackendError(`${what} request failed: ${response.status}`, detail.trim());
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        // A read can hold a whole over-long line with its newline, which the check below never sees.
        if (line.length > STREAM_LINE_MAX_CHARS) {
          throw new Error(`${what} sent a line that is too long (over ${STREAM_LINE_MAX_CHARS} characters).`);
        }

        const trimmed = line.trim();

        if (trimmed) {
          yield trimmed;
        }
      }

      // Whatever is held now has no newline yet: past the limit it never will be a line worth reading.
      if (buffer.length > STREAM_LINE_MAX_CHARS) {
        throw new Error(`${what} sent a line that is too long (over ${STREAM_LINE_MAX_CHARS} characters).`);
      }
    }

    const rest = buffer.trim();

    if (rest) {
      yield rest;
    }
  } catch (error) {
    throw isAbort(error) ? new Error(`${what} request timed out while streaming.`) : error;
  } finally {
    clearTimeout(timeout);
    void reader.cancel().catch(() => undefined);
  }
}

/**
 * The first line of a failed response's body, for the debug log (a model name, a quota message); never a
 * member, and never the default log (`BackendError`). Cut and key-scrubbed by `backendText`. Only the first
 * `ERROR_DETAIL_MAX_BYTES` are read; the rest of the body is cancelled.
 */
async function errorDetail(response: Response): Promise<string> {
  try {
    const text = (await readTextUpTo(response, ERROR_DETAIL_MAX_BYTES)).text.trim().split("\n")[0] ?? "";
    return text ? ` ${backendText(text)}` : "";
  } catch {
    return "";
  }
}

/**
 * Read at most `maxBytes` of a response body as UTF-8 text, cancelling the body once it goes past them, so a
 * backend can't make the node buffer an answer of any size. `complete` is false when the body was longer
 * (the text then holds its first `maxBytes`, a split character at the cut decoded as U+FFFD).
 */
async function readTextUpTo(response: Response, maxBytes: number): Promise<{ text: string; complete: boolean }> {
  if (!response.body) {
    return { text: "", complete: true };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return { text: Buffer.concat(chunks).toString("utf8"), complete: true };
      }
      if (total + value.byteLength > maxBytes) {
        chunks.push(value.subarray(0, maxBytes - total));
        return { text: Buffer.concat(chunks).toString("utf8"), complete: false };
      }
      total += value.byteLength;
      chunks.push(value);
    }
  } finally {
    // A no-op once the body has ended; otherwise the rest is never read.
    void reader.cancel().catch(() => undefined);
  }
}

/** Build the LLM layer over the runtime view: bot user, backend selection, and the streaming assistant reply. */
export function createLlmLayer(rt: Runtime) {
  /** Users with an assistant reply currently streaming (at most one each; the set size is the global count). */
  const repliesInFlight = new Set<string>();

  /** The backend that answers (`activeLlmProvider`), or `off` when none is enabled or the enabled one is
   * refused on this network (`llmProviderRefusal`). */
  function activeProvider(): LlmProvider {
    return llmProviderRefusal(rt.appConfig, rt.options) ? "off" : activeLlmProvider(rt.appConfig.llm);
  }

  /** Whether any LLM backend is active: Ollama, an OpenAI-compatible service or the on-device model. The
   * bot DM contact, streaming, and all LLM routes are gated on this, so it stays off unless the operator
   * explicitly enables a backend (all default off). */
  function llmEnabled(): boolean {
    return activeProvider() !== "off";
  }

  /**
   * Where the assistant's replies come from, for `NetworkConfig.assistantDestination`; undefined while no
   * backend is active, so it is present exactly when `enableLLMChat` is.
   */
  function assistantDestination(): AssistantDestination | undefined {
    const provider = activeProvider();
    if (provider === "off") {
      return undefined;
    }
    if (provider === "onDevice") {
      return { kind: "onDevice" };
    }
    const baseUrl = activeBackendUrl(rt.appConfig.llm);
    return baseUrl === undefined ? undefined : classifyBackendUrl(baseUrl);
  }

  /** The active destination's identity for the history cut: provider plus endpoint with its scheme
   * (`backendEndpoint`; `onDevice` alone for the phone's model); undefined while no backend is active. A
   * change of either means a different recipient. */
  function destinationKey(): string | undefined {
    const provider = activeProvider();
    if (provider === "off") {
      return undefined;
    }
    if (provider === "onDevice") {
      return "onDevice";
    }
    const baseUrl = activeBackendUrl(rt.appConfig.llm);
    return baseUrl === undefined ? undefined : `${provider}:${backendEndpoint(baseUrl)}`;
  }

  /** The active destination's key as versions before the scheme counted spelled it (no scheme), for
   * recognising a record they wrote; undefined for the phone's model, whose key never changed. */
  function schemelessDestinationKey(): string | undefined {
    const provider = activeProvider();
    const baseUrl = provider === "off" || provider === "onDevice" ? undefined : activeBackendUrl(rt.appConfig.llm);
    return baseUrl === undefined ? undefined : `${provider}:${schemelessBackendEndpoint(baseUrl)}`;
  }

  /** The provider and hostname the active destination answers from, for the log: never its port, path or
   * scheme. */
  function destinationLogName(): string {
    const provider = activeProvider();
    const baseUrl = provider === "off" || provider === "onDevice" ? undefined : activeBackendUrl(rt.appConfig.llm);
    return baseUrl === undefined ? provider : `${provider}:${backendHostname(baseUrl)}`;
  }

  /**
   * The cut-off for a destination record written now: the later of the clock and one past the newest DM to
   * or from the assistant. A host clock that went back (no network time, a manual change) would otherwise
   * date the cut before turns already written to the old destination, and send them to the new one.
   */
  function cutOffNow(): number {
    const botId = rt.appConfig.llm.ollama.botId;
    let newest = -Infinity;
    for (const message of rt.data.messages) {
      if (message.type === "dm" && (message.authorId === botId || message.recipientUserId === botId) && message.createdAt > newest) {
        newest = message.createdAt;
      }
    }
    return Math.max(Date.now(), newest + 1);
  }

  /**
   * Record the assistant's destination, and when it changed, in the config table, and return the time from
   * which DM history may be sent to it (`llmMessagesForUser`). A conversation held with one destination is
   * never forwarded to another: switching a local model to an online service must not upload the turns
   * members wrote while it was local. While no backend is active nothing is touched, so turning the same
   * assistant off and on again keeps its memory. The first record (an upgrade, or a fresh node) starts at 0
   * so an unchanged assistant keeps its history; an unreadable record counts as a change. Runs from
   * `ensureBotUser` (boot and every config save) and again before each reply.
   *
   * @returns The cut-off (ms epoch), or undefined while no backend is active.
   */
  function syncAssistantDestination(): number | undefined {
    return currentDestinationRecord()?.since;
  }

  /**
   * The assistant's destination record, brought up to date first: written anew when the destination changed
   * (see `syncAssistantDestination` for what `since` then means), and given a revision when an earlier
   * version wrote it without one (its cut-off is kept). A record an earlier version keyed without the scheme
   * (`schemelessDestinationKey`) for the same destination is rewritten under the current key with its cut-off
   * and revision, so the upgrade itself cuts nobody's history. Undefined while no backend is active.
   */
  function currentDestinationRecord(): Required<AssistantDestinationRecord> | undefined {
    const key = destinationKey();
    if (key === undefined) {
      return undefined;
    }
    const raw = rt.store.getConfigValue(ASSISTANT_DESTINATION_CONFIG_KEY);
    const parsed = parseDestinationRecord(raw);
    const rekeyed = parsed !== undefined && parsed.key !== key && parsed.key === schemelessDestinationKey();
    const stored = rekeyed ? { ...parsed, key } : parsed;
    if (stored?.key === key) {
      if (stored.rev !== undefined && !rekeyed) {
        return { key, since: stored.since, rev: stored.rev };
      }
      const upgraded = { key, since: stored.since, rev: stored.rev ?? newDestinationRevision() };
      rt.store.setConfigValue(ASSISTANT_DESTINATION_CONFIG_KEY, JSON.stringify(upgraded));
      return upgraded;
    }
    // A first record keeps an unchanged local assistant's memory (`since: 0`: an upgrade, or a fresh node). An
    // ONLINE destination's first record starts now instead: a node upgraded with its assistant off, whose
    // members wrote to a local model under the old version, must not upload those turns the day the host
    // picks an online service.
    const firstRecord = raw === undefined;
    const online = assistantDestination()?.kind === "online";
    const next = { key, since: firstRecord && !online ? 0 : cutOffNow(), rev: newDestinationRevision() };
    rt.store.setConfigValue(ASSISTANT_DESTINATION_CONFIG_KEY, JSON.stringify(next));
    if (next.since !== 0) {
      // Logged as provider + hostname only: the key itself carries the endpoint's scheme, port and path.
      rt.log.info(`The assistant now answers from ${destinationLogName()}; earlier conversations will not be sent to it`);
    }
    return next;
  }

  /** A fresh revision for a destination record: 128 random bits as 32 hex characters. */
  function newDestinationRevision(): string {
    return randomBytes(16).toString("hex");
  }

  /**
   * The revision of the assistant's destination record, for `NetworkConfig.assistantDestinationRevision`: a
   * random value minted each time the destination changes (`currentDestinationRecord`, read here so the
   * record is current) and stored with it. It is random, not derived from the destination, so it says only
   * that something changed and can't be used to check a guess at the service's address or path. The same
   * across restarts and across saves that keep the destination; different after any change, including a
   * switch away and back. Undefined while no backend is active, and while the record can't be read (a store
   * an incomplete Emergency Reset left closed), so `NetworkConfig` and the host API's status still answer;
   * every check treats that as stale. A DM to the assistant must name it (`assistantDestinationStale`).
   */
  function destinationRevision(): string | undefined {
    try {
      return currentDestinationRecord()?.rev;
    } catch (error) {
      rt.log.debug(error, "The assistant's destination record could not be read");
      return undefined;
    }
  }

  /**
   * Whether a DM from `authorId` to `recipientUserId` is to the active assistant and names a destination
   * revision other than the current one (`presentedRevision` missing counts). `POST /api/messages` checks
   * this BEFORE the busy check and before creating the DM, and answers 409, so a question written for one
   * destination never goes to another the sender wasn't shown (docs/06). A DM to a person, or any DM while
   * no backend is active, is never stale; one to the assistant while its record can't be read always is.
   */
  function assistantDestinationStale(recipientUserId: string, authorId: string, presentedRevision: string | undefined): boolean {
    const bot = activeBotUser();

    if (!bot || recipientUserId !== bot.id || authorId === bot.id) {
      return false;
    }

    const current = destinationRevision();
    return current === undefined || presentedRevision !== current;
  }

  /** The model label shown on assistant replies: whichever backend answers. */
  function activeLlmModel(): string {
    switch (activeProvider()) {
      case "onDevice":
        return rt.appConfig.llm.onDevice.model ?? "on-device";
      case "openai":
        return rt.appConfig.llm.openai.model;
      default:
        return rt.appConfig.llm.ollama.model;
    }
  }

  /**
   * Ensures the assistant bot user exists in the in-memory user store and is up to date. The bot's
   * identity (id, display name) is shared from `llm.ollama` regardless of which backend answers, so
   * switching between the laptop-Ollama and on-device backends keeps the same DM contact.
   *
   * If no LLM backend is enabled, no changes are made.
   *
   * @returns The bot `User` after creation or update, or `undefined` when no backend is enabled.
   */
  function ensureBotUser(): User | undefined {
    const refusal = llmProviderRefusal(rt.appConfig, rt.options);

    if (refusal && activeLlmProvider(rt.appConfig.llm) !== "off") {
      // A save can't introduce this (applyConfigUpdate refuses it, though it keeps one a network already had,
      // such as an Android host upgraded with a LAN Ollama over plain HTTP); a hand-edited config.json can.
      // The admin screen says why (`llm.refusal` on the redacted config).
      // The hostname only: an address may carry a path or credentials, and the log outlives the setting.
      const url = activeBackendUrl(rt.appConfig.llm);
      rt.log.warn(`LLM assistant disabled: ${refusal.toLowerCase()} (${url === undefined ? "no address" : backendHostname(url)})`);
    }

    if (!llmEnabled()) {
      return undefined;
    }

    syncAssistantDestination();

    // Non-fatal by design: this runs at boot (loadData) and after every config save, and a bad bot config
    // must never take the node down — it just means no assistant contact until the config is fixed.
    const configError = botConfigError(rt.appConfig);

    if (configError) {
      rt.log.warn(`LLM assistant disabled: ${configError}`);
      return undefined;
    }

    try {
      const existing = rt.data.users.find((user) => user.id === rt.appConfig.llm.ollama.botId);

      if (existing) {
        const parsedExisting = UserSchema.parse(existing);
        const next = UserSchema.parse({
          ...parsedExisting,
          displayName: rt.appConfig.llm.ollama.botDisplayName,
          type: "bot" as const,
          isAdmin: false,
          avatar: parsedExisting.avatar ?? {
            seed: rt.appConfig.llm.ollama.botId,
            mode: "pattern" as const,
          },
        });

        if (JSON.stringify(parsedExisting) !== JSON.stringify(next)) {
          rt.store.upsertUser(next);
          Object.assign(existing, next);
          rt.broadcast({ type: "userUpserted", user: existing });
        }

        return existing;
      }

      const user = makeBotUser(rt.appConfig.llm.ollama);
      rt.store.upsertUser(user);
      rt.data.users.push(user);
      rt.broadcast({ type: "userUpserted", user });
      return user;
    } catch (error) {
      rt.log.error(error, "LLM assistant disabled: could not create the bot user");
      return undefined;
    }
  }

  /**
   * Why `config`'s assistant bot can't be applied, or undefined when it can. `botId` must not name any
   * existing NON-bot user: `ensureBotUser` rewrites whatever record holds the id into a bot with
   * `isAdmin: false`, so pointing it at a person would hijack their account (and demote an admin past the
   * deliberate no-demote rule). The bot record itself must also validate (e.g. its display name bound).
   * `PATCH /api/admin/config` refuses such a config before persisting it; at boot `ensureBotUser` skips
   * the bot instead of failing.
   */
  function botConfigError(config: LoamConfig): string | undefined {
    const { botId } = config.llm.ollama;
    const holder = rt.data.users.find((user) => user.id === botId);

    if (holder && holder.type !== "bot") {
      return `llm.ollama.botId "${botId}" belongs to an existing ${holder.type} user`;
    }

    try {
      makeBotUser(config.llm.ollama);
    } catch {
      return "the configured bot identity is not a valid user record";
    }

    return undefined;
  }

  /** The assistant bot user, when an LLM backend is on and the configured id really is a bot. */
  function activeBotUser(): User | undefined {
    if (!llmEnabled()) {
      return undefined;
    }

    const bot = rt.data.users.find((user) => user.id === rt.appConfig.llm.ollama.botId);
    return bot?.type === "bot" ? bot : undefined;
  }

  /**
   * Whether a DM from `authorId` to `recipientUserId` would start an assistant reply that the concurrency
   * bound (`MAX_CONCURRENT_ASSISTANT_REPLIES`, one per user) can't take right now. `POST /api/messages`
   * checks this BEFORE creating the DM and answers 429, so a refused request leaves no unanswered message.
   */
  function assistantBusyFor(recipientUserId: string, authorId: string): boolean {
    const bot = activeBotUser();

    if (!bot || recipientUserId !== bot.id || authorId === bot.id) {
      return false;
    }

    return repliesInFlight.has(authorId) || repliesInFlight.size >= MAX_CONCURRENT_ASSISTANT_REPLIES;
  }

  /**
   * Build a sequence of chat messages for the active backend from the DM history between a bot and a user:
   * only turns written since the assistant's destination last changed (`syncAssistantDestination`), plus the
   * message being answered whatever its time (a change noticed only now must not drop the question itself).
   */
  function llmMessagesForUser(botId: string, userMessage: Message & { type: "dm" }): ChatMessage[] {
    const since = syncAssistantDestination() ?? Date.now();
    const history = rt.dmMessages(botId, userMessage.authorId).flatMap((message) => {
      if (message.type !== "dm" || !message.body.trim()) {
        return [];
      }

      if (message.createdAt < since && message.id !== userMessage.id) {
        return [];
      }

      return [
        {
          role: message.authorId === botId ? ("assistant" as const) : ("user" as const),
          content: message.body,
        },
      ];
    });

    // Bound the context to the most-recent turns: mapping the ENTIRE DM history every turn grows the
    // request each time and eventually overflows the model's context window (the model then errors or
    // silently drops the oldest tokens anyway). Keep the newest `MAX_LLM_CONTEXT_MESSAGES` and always keep
    // the system prompt. A message-count bound (not a token budget) is the same hardcoded-limit style as the
    // 5-minute Ollama timeout below; a token budget + summarisation is the documented fuller version
    // (docs/25 P2). A single pathological message can still be large; that is left to the fuller version.
    // The phone's on-device model has a small fixed context, so its history is also capped by characters
    // (`capHistoryByChars`); the phone then trims to its exact token budget before generating.
    const recent = history.slice(-MAX_LLM_CONTEXT_MESSAGES);
    const messages = activeProvider() === "onDevice" ? capHistoryByChars(recent) : recent;

    return rt.appConfig.llm.ollama.systemPrompt
      ? [{ role: "system" as const, content: rt.appConfig.llm.ollama.systemPrompt }, ...messages]
      : messages;
  }

  /** Stream a reply from Ollama's own `/api/chat`: newline-delimited JSON, one object per delta. */
  async function* streamOllamaChat(messages: ChatMessage[]): AsyncGenerator<string> {
    const { baseUrl, model } = rt.appConfig.llm.ollama;
    const lines = streamLines(
      joinUrl(baseUrl, "/api/chat"),
      { "content-type": "application/json" },
      { model, stream: true, messages },
      "Ollama",
    );

    for await (const line of lines) {
      const parsed: unknown = JSON.parse(line);

      if (!isRecord(parsed)) {
        continue;
      }

      if (typeof parsed.error === "string") {
        throw new BackendError("Ollama's stream reported an error", backendText(parsed.error));
      }

      const message = isRecord(parsed.message) ? parsed.message : undefined;
      const content = message && typeof message.content === "string" ? message.content : "";

      if (content) {
        yield content;
      }

      if (parsed.done === true) {
        return;
      }
    }
  }

  /**
   * Stream a reply from an OpenAI-compatible service's `/chat/completions`: server-sent events whose
   * `data:` payloads are chat-completion chunks (`choices[0].delta.content`), ended by `data: [DONE]`.
   * Comment lines (`: keep-alive`, which OpenRouter sends while a model loads) and other event fields
   * are skipped. The key goes in the `Authorization` header and nowhere else.
   */
  async function* streamOpenAiChat(messages: ChatMessage[]): AsyncGenerator<string> {
    const { baseUrl, model, apiKey } = rt.appConfig.llm.openai;
    const lines = streamLines(
      joinUrl(baseUrl, "/chat/completions"),
      openAiHeaders(apiKey),
      { model, stream: true, messages },
      "Chat service",
    );

    for await (const line of lines) {
      if (!line.startsWith("data:")) {
        continue;
      }

      const payload = line.slice("data:".length).trim();

      if (payload === "[DONE]") {
        return;
      }

      const parsed: unknown = JSON.parse(payload);

      if (!isRecord(parsed)) {
        continue;
      }

      if (isRecord(parsed.error)) {
        throw new BackendError(
          "The chat service's stream reported an error",
          typeof parsed.error.message === "string" ? backendText(parsed.error.message) : "",
        );
      }

      const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : undefined;
      const delta = isRecord(choice) && isRecord(choice.delta) ? choice.delta : undefined;
      const content = delta && typeof delta.content === "string" ? delta.content : "";

      if (content) {
        yield content;
      }
    }
  }

  /**
   * Stream a reply from the **on-device** model. Inference doesn't run in this (embedded Node)
   * process — it runs in the Android host's RN/native layer, reachable via a hook the launcher
   * (`nodejs-project-template/main.js`) installs on `globalThis.__loamOnDeviceChat` before requiring
   * the server bundle. On any other host (desktop, Pi, CI) the hook is simply absent, so enabling the
   * on-device backend there yields a clean error rather than a crash — messaging is never affected.
   * The callback-style hook is adapted into the same `AsyncGenerator<string>` shape as Ollama so the
   * assistant flow below is backend-agnostic.
   */
  async function* streamOnDeviceChat(
    messages: { role: "system" | "user" | "assistant"; content: string }[],
  ): AsyncGenerator<string> {
    const hook = (globalThis as { __loamOnDeviceChat?: OnDeviceChatHook }).__loamOnDeviceChat;

    if (typeof hook !== "function") {
      throw new Error("The on-device model is not available on this host.");
    }

    const queue: string[] = [];
    let finished = false;
    let failure: Error | undefined;
    let wake: (() => void) | undefined;
    const signal = () => {
      wake?.();
      wake = undefined;
    };
    // Resolves once the host reports the end (or an error), or the timeout below gives up on it.
    let settle: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });

    // Bound the request like the Ollama path: if the host hook goes silent (a wedged model, a dropped
    // rn-bridge round-trip) the generator would otherwise hang forever. After 5 minutes, fail it.
    const timeout = setTimeout(
      () => {
        if (!finished) {
          failure = new Error("The on-device model timed out.");
          finished = true;
          signal();
        }
        settle();
      },
      5 * 60 * 1000,
    );

    hook(messages, {
      onDelta: (text) => {
        if (text) {
          queue.push(text);
        }
        signal();
      },
      onEnd: () => {
        finished = true;
        signal();
        settle();
      },
      onError: (message) => {
        failure = new Error(message || "The on-device model failed.");
        finished = true;
        signal();
        settle();
      },
    });

    try {
      while (true) {
        if (queue.length) {
          yield queue.shift() as string;
          continue;
        }
        if (failure) {
          throw failure;
        }
        if (finished) {
          return;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      // The consumer stopped early (a moderator removed the reply, or an Emergency Reset): the launcher
      // bridge has no cancel, so the phone's model keeps generating until its own end/error. Don't return
      // until then (bounded by the timeout above): the caller holds the assistant's in-flight slot across
      // this, so an abort can't let a second generation start on the phone beside the first.
      if (!finished) {
        await settled;
      }
      clearTimeout(timeout);
    }
  }

  /** Stream from whichever LLM backend is active (`activeProvider`). */
  function streamChat(messages: ChatMessage[]): AsyncGenerator<string> {
    switch (activeProvider()) {
      case "onDevice":
        return streamOnDeviceChat(messages);
      case "openai":
        return streamOpenAiChat(messages);
      default:
        return streamOllamaChat(messages);
    }
  }

  /**
   * Ask a backend which models it offers, for the admin screens' Test button and model picker: Ollama's
   * `GET /api/tags` or an OpenAI-compatible `GET /models`. The request's connection details win over the
   * saved ones so an admin can test before saving; a key left out means the stored key, so a saved key can
   * be tested without typing it again, but only against the origin it was saved with (`sameUrlOrigin`): a
   * Test of another address carries no key unless the admin typed one. Names are deduplicated, sorted and
   * capped, and the answer is read through a byte cap. A redirect is not followed. Failures come back as a
   * code the UI can word (never the service's own text, which may echo the URL or the key's prefix); the
   * detail goes to the log at debug level.
   */
  async function listModels(request: LlmModelsRequest): Promise<LlmModelsResponse> {
    const { llm, security } = rt.appConfig;
    const baseUrl = request.baseUrl ?? (request.provider === "ollama" ? llm.ollama.baseUrl : llm.openai.baseUrl);
    let apiKey: string | undefined;
    if (request.provider === "openai") {
      if (request.apiKey !== undefined) {
        // Typed into the request by the admin: sent where they asked ("" = explicitly no key).
        apiKey = request.apiKey || undefined;
      } else if (request.baseUrl === undefined || sameUrlOrigin(request.baseUrl, llm.openai.baseUrl)) {
        apiKey = llm.openai.apiKey;
      }
    }

    // The same locality rule as `llmProviderRefusal`, for both backends: a hardened network's admin can't
    // even probe a public address from here.
    if (security.profile === "hardened" && !isLocalNetworkUrl(baseUrl)) {
      return { ok: false, code: "llm_not_allowed" };
    }
    // And a network that requires encryption never sends the key (or, later, the messages) over plain HTTP.
    if (unencryptedBackendRefused(baseUrl, rt.options)) {
      return { ok: false, code: "llm_unencrypted" };
    }

    const url = joinUrl(baseUrl, request.provider === "ollama" ? "/api/tags" : "/models");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MODELS_TIMEOUT_MS);
    let response: Response;

    try {
      response = await fetch(url, {
        method: "GET",
        headers: openAiHeaders(apiKey),
        signal: controller.signal,
        redirect: "manual",
      });
    } catch (error) {
      clearTimeout(timeout);
      rt.log.debug(error, "LLM model list: the backend could not be reached");
      return { ok: false, code: "llm_unreachable" };
    }

    try {
      if (isRedirect(response)) {
        void response.body?.cancel().catch(() => undefined);
        rt.log.debug(`LLM model list: ${redirectMessage("the backend", url, response)}`);
        return { ok: false, code: "llm_bad_response" };
      }

      if (response.status === 401 || response.status === 403) {
        return { ok: false, code: "llm_unauthorized" };
      }

      if (!response.ok) {
        rt.log.debug(`LLM model list: the backend answered ${response.status}${await errorDetail(response)}`);
        return { ok: false, code: "llm_bad_response" };
      }

      const { text, complete } = await readTextUpTo(response, MODELS_MAX_BYTES);

      if (!complete) {
        rt.log.debug(`LLM model list: the backend's answer is over ${MODELS_MAX_BYTES} bytes`);
        return { ok: false, code: "llm_bad_response" };
      }

      const parsed: unknown = JSON.parse(text);
      const entries = isRecord(parsed) ? (request.provider === "ollama" ? parsed.models : parsed.data) : undefined;

      if (!Array.isArray(entries)) {
        return { ok: false, code: "llm_bad_response" };
      }

      const names = new Set<string>();

      for (const entry of entries) {
        const name = isRecord(entry) ? (request.provider === "ollama" ? entry.name : entry.id) : undefined;

        // A name is shown raw on the admin screens and in a terminal: control characters are refused.
        if (typeof name === "string" && name.length > 0 && name.length <= LLM_MODEL_MAX_LENGTH && !/[\u0000-\u001f\u007f-\u009f]/.test(name)) {
          names.add(name);
        }
      }

      return { ok: true, models: [...names].sort((a, b) => a.localeCompare(b)).slice(0, MODELS_MAX) };
    } catch (error) {
      rt.log.debug(error, "LLM model list: the backend's answer could not be read");
      return { ok: false, code: isAbort(error) ? "llm_unreachable" : "llm_bad_response" };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Triggers an LLM assistant reply to a direct message and streams the assistant's content into a
   * new DM message via StreamEvent deltas, persisting the final body once. Backend-agnostic — the
   * deltas come from `streamChat` (Ollama or the on-device model).
   *
   * @param userMessage - The incoming DM message that may trigger the bot response
   * @param acceptedRevision - The destination revision the route accepted the DM under
   *   (`assistantDestinationStale`); the reply contacts no backend unless it is still the current one
   */
  async function createAssistantResponse(userMessage: Message, acceptedRevision: string | undefined): Promise<void> {
    if (userMessage.type !== "dm") {
      return;
    }

    // Only a genuine bot record answers (a botId that names a person is refused/skipped — botConfigError).
    const bot = activeBotUser();

    if (!bot || userMessage.recipientUserId !== bot.id || userMessage.authorId === bot.id) {
      return;
    }

    // Defence in depth behind the route's 429: never exceed the concurrency bound, whatever the caller.
    if (assistantBusyFor(userMessage.recipientUserId, userMessage.authorId)) {
      return;
    }

    const requesterId = userMessage.authorId;
    // Reserved synchronously (before the first await), so two back-to-back requests can't both pass.
    repliesInFlight.add(requesterId);

    try {
      await streamAssistantReply(bot, userMessage, acceptedRevision);
    } finally {
      repliesInFlight.delete(requesterId);
    }
  }

  /** Stream one assistant reply to `userMessage` into a new bot DM (see createAssistantResponse). */
  async function streamAssistantReply(
    bot: User,
    userMessage: Message & { type: "dm" },
    acceptedRevision: string | undefined,
  ): Promise<void> {
    const assistantMessage = MessageSchema.parse({
      id: newMessageId("llm"),
      type: "dm",
      authorId: bot.id,
      recipientUserId: userMessage.authorId,
      body: "",
      createdAt: Date.now(),
      meta: {
        source: "llm",
        model: activeLlmModel(),
        markdown: true,
        streaming: true,
      },
    });
    rt.store.insertMessage(assistantMessage);
    rt.data.messages.push(assistantMessage);
    rt.broadcast({ type: "messageCreated", message: assistantMessage });

    const audience = new Set([bot.id, userMessage.authorId]);
    // An Emergency Reset mid-stream destroys this conversation; abandon the reply rather than keep
    // writing a pre-wipe message (today a no-op UPDATE, but never worth depending on).
    const generation = rt.wipeGeneration;
    const wiped = () => rt.wipeGeneration !== generation;
    // A moderator may remove the reply mid-stream (the honest tombstone blanks it and clears `streaming`),
    // or it may be deleted outright. Either way the writer must stop: writing the next delta or the final
    // body would silently restore removed content. Checked before EVERY write.
    const withdrawn = () =>
      assistantMessage.meta?.removedByModerator === true || !rt.data.messages.includes(assistantMessage);
    /** Stop streaming: tell the participants' clients the stream is over (unless the node was wiped). */
    const abandon = () => {
      if (!wiped()) {
        rt.broadcastStreamEvent(audience, { type: "end", messageId: assistantMessage.id });
      }
    };

    // The destination changed after the route accepted this DM (or its record can't be read): the question
    // was written for the one the sender was shown, so no backend is contacted and the reply ends as a failure.
    const currentRevision = destinationRevision();
    if (currentRevision === undefined || currentRevision !== acceptedRevision) {
      rt.log.warn("The assistant's destination changed before a reply started; nothing was sent to it");
      rt.updateMessage(assistantMessage, ASSISTANT_FAILURE_BODY, false);
      rt.broadcastStreamEvent(audience, { type: "error", messageId: assistantMessage.id, error: ASSISTANT_FAILURE_BODY });
      return;
    }

    let body = "";
    // Set once the reply is finalised at `ASSISTANT_REPLY_MAX_CHARS`, so nothing after it writes the message again.
    let cutOff = false;
    rt.broadcastStreamEvent(audience, { type: "start", messageId: assistantMessage.id });

    try {
      for await (const delta of streamChat(llmMessagesForUser(bot.id, userMessage))) {
        if (wiped() || withdrawn()) {
          abandon();
          return;
        }

        // Keep only what fits under the cap, never ending on half of a surrogate pair.
        let kept = delta.slice(0, ASSISTANT_REPLY_MAX_CHARS - body.length);
        if (kept.length < delta.length && /[\uD800-\uDBFF]$/.test(kept)) {
          kept = kept.slice(0, -1);
        }
        body += kept;

        // Keep the in-memory copy current for mid-stream REST reads, but defer persistence and the
        // full-message broadcast to the end — clients follow the incremental delta events instead.
        if ("body" in assistantMessage) {
          assistantMessage.body = body;
        }

        if (kept) {
          rt.broadcastStreamEvent(audience, { type: "delta", messageId: assistantMessage.id, text: kept });
        }

        if (kept.length < delta.length) {
          // Finalise BEFORE leaving the loop: leaving runs the generator's `finally`, and the on-device one
          // waits there (up to its timeout) for the phone's model to end. Leaving also cancels the backend's
          // body, so nothing more is read from it.
          cutOff = true;
          rt.updateMessage(assistantMessage, `${body.trim()}\n\n${ASSISTANT_REPLY_CUT_OFF_NOTE}`, false);
          rt.broadcastStreamEvent(audience, { type: "end", messageId: assistantMessage.id });
          return;
        }
      }

      if (wiped() || withdrawn()) {
        abandon();
        return;
      }

      rt.updateMessage(assistantMessage, body.trim() || "(No response.)", false);
      rt.broadcastStreamEvent(audience, { type: "end", messageId: assistantMessage.id });
    } catch (error) {
      if (cutOff) {
        // The reply is already final; a failure while the backend was being let go changes nothing.
        rt.log.debug(error, "LLM backend error after an over-long reply was cut off");
        return;
      }

      if (wiped() || withdrawn()) {
        abandon();
        return;
      }

      // The backend's error text (a URL, a model name, an HTTP status, a stack) is operator detail: log it and
      // show the member one plain sentence. Any partial reply already streamed stays above it. Text the
      // backend wrote, which may quote the member's question, goes to the debug log only: the error line
      // names the backend and the status (`BackendError`), and a line that isn't JSON is named as such,
      // since a JSON parse error's message quotes the line it failed on.
      if (error instanceof BackendError) {
        rt.log.error(`LLM backend error while answering a direct message: ${error.message}`);
        rt.log.debug(`LLM backend error detail: ${error.detail}`);
      } else if (error instanceof SyntaxError) {
        rt.log.error("LLM backend error while answering a direct message: the backend sent a line that is not JSON");
        rt.log.debug(`LLM backend error detail: ${backendText(error.message)}`);
      } else {
        rt.log.error(error, "LLM backend error while answering a direct message");
      }
      rt.updateMessage(assistantMessage, `${body}\n\n${ASSISTANT_FAILURE_BODY}`.trim(), false);
      rt.broadcastStreamEvent(audience, { type: "error", messageId: assistantMessage.id, error: ASSISTANT_FAILURE_BODY });
    }
  }

  return {
    llmEnabled,
    activeProvider,
    activeLlmModel,
    assistantDestination,
    ensureBotUser,
    botConfigError,
    assistantBusyFor,
    destinationRevision,
    assistantDestinationStale,
    createAssistantResponse,
    listModels,
  };
}

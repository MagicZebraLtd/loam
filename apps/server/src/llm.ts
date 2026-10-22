// The optional LLM assistant: the bot user, the Ollama / OpenAI-compatible / on-device backends, and the
// DM-driven assistant reply, behind the shared `Runtime` view.
import {
  activeLlmProvider,
  isLocalNetworkUrl,
  LLM_MODEL_MAX_LENGTH,
  type LlmModelsRequest,
  type LlmModelsResponse,
  type LlmProvider,
  type LoamConfig,
  type Message,
  MessageSchema,
  type User,
  UserSchema,
} from "@loam/schema";
import { isRecord } from "./config.js";
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

/** The message `applyConfigUpdate` refuses with (mapped to `llm_cloud_not_allowed` in errors.ts). */
export const CLOUD_ASSISTANT_REFUSED = "A cloud assistant is not allowed on a hardened network";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

/**
 * Why `config`'s assistant backend may not run, or undefined when it may: a `hardened` network keeps every
 * message on the local network, so an OpenAI-compatible service there must be a local one (LM Studio,
 * llama.cpp on this computer or the LAN), never a cloud API (docs/09, docs/29 Track 3). Ollama and the
 * on-device model are local by construction. Checked before a save is persisted and again at boot, so a
 * hand-edited config.json can't route a hardened network's DMs to the internet either.
 */
export function llmProviderRefusal(config: LoamConfig): string | undefined {
  if (
    config.security.profile === "hardened" &&
    activeLlmProvider(config.llm) === "openai" &&
    !isLocalNetworkUrl(config.llm.openai.baseUrl)
  ) {
    return CLOUD_ASSISTANT_REFUSED;
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

/** A fetch error's name is all a member-facing path needs; the rest is for the log. */
function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * POST a streaming chat request and yield the response body one line at a time (trimmed, blank lines
 * dropped), for the newline-delimited JSON Ollama streams and the SSE `data:` lines an OpenAI-compatible
 * service streams. One timeout covers the whole exchange; the reader is cancelled however the caller leaves.
 */
async function* streamLines(url: string, headers: Record<string, string>, body: unknown, what: string): AsyncGenerator<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
  let response: Response;

  try {
    response = await fetch(url, { method: "POST", headers, signal: controller.signal, body: JSON.stringify(body) });
  } catch (error) {
    clearTimeout(timeout);
    throw isAbort(error) ? new Error(`${what} request timed out before streaming started.`) : error;
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
    throw new Error(`${what} request failed: ${response.status}${detail}`);
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
        const trimmed = line.trim();

        if (trimmed) {
          yield trimmed;
        }
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

/** The first line of a failed response's body, for the log (a model name, a quota message); never a member. */
async function errorDetail(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim().split("\n")[0] ?? "";
    return text ? ` ${text.slice(0, 200)}` : "";
  } catch {
    return "";
  }
}

/** Build the LLM layer over the runtime view: bot user, backend selection, and the streaming assistant reply. */
export function createLlmLayer(rt: Runtime) {
  /** Users with an assistant reply currently streaming (at most one each; the set size is the global count). */
  const repliesInFlight = new Set<string>();

  /** The backend that answers (`activeLlmProvider`), or `off` when none is enabled or the enabled one is
   * refused on this network (`llmProviderRefusal`). */
  function activeProvider(): LlmProvider {
    return llmProviderRefusal(rt.appConfig) ? "off" : activeLlmProvider(rt.appConfig.llm);
  }

  /** Whether any LLM backend is active: Ollama, an OpenAI-compatible service or the on-device model. The
   * bot DM contact, streaming, and all LLM routes are gated on this, so it stays off unless the operator
   * explicitly enables a backend (all default off). */
  function llmEnabled(): boolean {
    return activeProvider() !== "off";
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
    const refusal = llmProviderRefusal(rt.appConfig);

    if (refusal && activeLlmProvider(rt.appConfig.llm) !== "off") {
      // A save can't persist this (applyConfigUpdate refuses it); a hand-edited config.json can.
      rt.log.warn(`LLM assistant disabled: ${refusal.toLowerCase()} (${rt.appConfig.llm.openai.baseUrl})`);
    }

    if (!llmEnabled()) {
      return undefined;
    }

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
   * Build a sequence of chat messages for the configured Ollama model from the DM history between a bot and a user.
   */
  function llmMessagesForUser(botId: string, currentUserId: string): ChatMessage[] {
    const history = rt.dmMessages(botId, currentUserId).flatMap((message) => {
      if (message.type !== "dm" || !message.body.trim()) {
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
    const messages = history.slice(-MAX_LLM_CONTEXT_MESSAGES);

    return rt.appConfig.llm.ollama.systemPrompt
      ? [{ role: "system" as const, content: rt.appConfig.llm.ollama.systemPrompt }, ...messages]
      : messages;
  }

  /** Stream a reply from Ollama's own `/api/chat`: newline-delimited JSON, one object per delta. */
  async function* streamOllamaChat(messages: ChatMessage[]): AsyncGenerator<string> {
    const { baseUrl, model } = rt.appConfig.llm.ollama;
    const lines = streamLines(joinUrl(baseUrl, "/api/chat"), { "content-type": "application/json" }, { model, stream: true, messages }, "Ollama");

    for await (const line of lines) {
      const parsed: unknown = JSON.parse(line);

      if (!isRecord(parsed)) {
        continue;
      }

      if (typeof parsed.error === "string") {
        throw new Error(parsed.error);
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
    const lines = streamLines(joinUrl(baseUrl, "/chat/completions"), openAiHeaders(apiKey), { model, stream: true, messages }, "Chat service");

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
        throw new Error(typeof parsed.error.message === "string" ? parsed.error.message : "the chat service reported an error");
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
   * be tested without typing it again. Names are deduplicated, sorted and capped. Failures come back as a
   * code the UI can word (never the service's own text, which may echo the URL or the key's prefix); the
   * detail goes to the log at debug level.
   */
  async function listModels(request: LlmModelsRequest): Promise<LlmModelsResponse> {
    const { llm, security } = rt.appConfig;
    const baseUrl = request.baseUrl ?? (request.provider === "ollama" ? llm.ollama.baseUrl : llm.openai.baseUrl);
    const apiKey = request.provider === "openai" ? (request.apiKey === undefined ? llm.openai.apiKey : request.apiKey || undefined) : undefined;

    if (request.provider === "openai" && security.profile === "hardened" && !isLocalNetworkUrl(baseUrl)) {
      return { ok: false, code: "llm_not_allowed" };
    }

    const url = joinUrl(baseUrl, request.provider === "ollama" ? "/api/tags" : "/models");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MODELS_TIMEOUT_MS);
    let response: Response;

    try {
      response = await fetch(url, { method: "GET", headers: openAiHeaders(apiKey), signal: controller.signal });
    } catch (error) {
      clearTimeout(timeout);
      rt.log.debug(error, "LLM model list: the backend could not be reached");
      return { ok: false, code: "llm_unreachable" };
    }

    try {
      if (response.status === 401 || response.status === 403) {
        return { ok: false, code: "llm_unauthorized" };
      }

      if (!response.ok) {
        rt.log.debug(`LLM model list: the backend answered ${response.status}${await errorDetail(response)}`);
        return { ok: false, code: "llm_bad_response" };
      }

      const parsed: unknown = await response.json();
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
   */
  async function createAssistantResponse(userMessage: Message): Promise<void> {
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
      await streamAssistantReply(bot, userMessage);
    } finally {
      repliesInFlight.delete(requesterId);
    }
  }

  /** Stream one assistant reply to `userMessage` into a new bot DM (see createAssistantResponse). */
  async function streamAssistantReply(bot: User, userMessage: Message & { type: "dm" }): Promise<void> {
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
    let body = "";
    rt.broadcastStreamEvent(audience, { type: "start", messageId: assistantMessage.id });

    try {
      for await (const delta of streamChat(llmMessagesForUser(bot.id, userMessage.authorId))) {
        if (wiped() || withdrawn()) {
          abandon();
          return;
        }

        body += delta;

        // Keep the in-memory copy current for mid-stream REST reads, but defer persistence and the
        // full-message broadcast to the end — clients follow the incremental delta events instead.
        if ("body" in assistantMessage) {
          assistantMessage.body = body;
        }

        rt.broadcastStreamEvent(audience, { type: "delta", messageId: assistantMessage.id, text: delta });
      }

      if (wiped() || withdrawn()) {
        abandon();
        return;
      }

      rt.updateMessage(assistantMessage, body.trim() || "(No response.)", false);
      rt.broadcastStreamEvent(audience, { type: "end", messageId: assistantMessage.id });
    } catch (error) {
      if (wiped() || withdrawn()) {
        abandon();
        return;
      }

      // The backend's error text (a URL, a model name, an HTTP status, a stack) is operator detail: log it and
      // show the member one plain sentence. Any partial reply already streamed stays above it.
      rt.log.error(error, "LLM backend error while answering a direct message");
      rt.updateMessage(assistantMessage, `${body}\n\n${ASSISTANT_FAILURE_BODY}`.trim(), false);
      rt.broadcastStreamEvent(audience, { type: "error", messageId: assistantMessage.id, error: ASSISTANT_FAILURE_BODY });
    }
  }

  return {
    llmEnabled,
    activeProvider,
    activeLlmModel,
    ensureBotUser,
    botConfigError,
    assistantBusyFor,
    createAssistantResponse,
    listModels,
  };
}

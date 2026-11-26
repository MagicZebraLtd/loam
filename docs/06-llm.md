# 06 — LLM support: improvements

## Current state (what exists)

All in `apps/server/src/llm.ts`, gated on a backend being enabled (`activeLlmProvider` in `@loam/schema`):

- **Three backends, one active at a time**, each off by default: `llm.ollama` (Ollama's own `/api/chat`,
  newline-delimited JSON), `llm.openai` (any **OpenAI-compatible** service's `/chat/completions`, streamed
  as SSE `data:` chunks: OpenRouter, OpenAI, Groq, Mistral, and local servers such as LM Studio or
  llama.cpp server), and `llm.onDevice` (the Android host's own model, below). Precedence when more than one
  is switched on: on-device, then the service, then Ollama; the admin screens switch exactly one on, so
  the two never disagree. One 5-minute timeout covers a streamed reply whichever backend answers
  (`streamLines` reads the body line by line for both parsers). See "The OpenAI-compatible service" below.
- **No redirect is followed**, on any network or profile: chat requests and the model list use
  `redirect: "manual"`, so a 3xx answer is refused, never sent on (a 307/308 keeps the POST body, and would
  carry a member's question and DM history to an origin other than the one members were told). A refused
  chat request logs the status and the redirect target's hostname only ("the assistant does not follow
  redirects, so set the service's final address"), and the member sees the plain failure line; the model
  list answers `llm_bad_response`. Configure the service's final address.
- **What a backend can make the node hold is bounded**: a streamed line longer than 256 Ki characters
  without a newline fails the reply; a reply is kept to `ASSISTANT_REPLY_MAX_CHARS` (64 000 characters,
  every backend, on-device included): past it the node keeps what fits, finalises the message with
  `ASSISTANT_REPLY_CUT_OFF_NOTE` after a blank line, ends the stream, and only then stops reading the backend
  (an on-device reply then holds its in-flight slot until the phone's model ends, as for any early stop). A
  model list is read through an 8 MiB cap (over it is `llm_bad_response`), and a failed response's body is
  read for its first 4 KiB only.
- **DM-only bot**: `createAssistantResponse()` fires when a user DMs the configured bot user (`type: "bot"`).
  There is no channel participation and no `@mention` support.
- **Bot identity is bounded**: `llm.ollama.botId` must be an `llm.*` id (`BotIdSchema`, ≤64 chars) and
  may not name an existing non-bot user — so pointing it at a person can't turn them (or an admin) into a
  bot. `PATCH /api/admin/config` validates this before persisting (`botConfigError`, 400); at boot an
  invalid persisted value is logged and the assistant is skipped (`ensureBotUser` is non-fatal).
  `botDisplayName` ≤80 (the user-record bound), `model` ≤120 (`LLM_MODEL_MAX_LENGTH`, also the
  `meta.model` cap).
- **Unbounded context**: `llmMessagesForUser()` maps the **entire** DM history to chat messages every
  turn (+ optional system prompt), now **capped to the most-recent `MAX_LLM_CONTEXT_MESSAGES` (40)** so a
  long chat no longer grows the request every turn. A message count is **not** a context bound: 40 turns
  of up to 8000 characters each are far more than a small model holds. That bit the **on-device** model,
  whose context is 4096 tokens with llama.rn's `ctx_shift` off: after a dozen or so exchanges every reply
  failed with "Context is full", and a prompt just under the limit stopped mid-reply and was saved as
  complete. The on-device path is now bounded twice: the server caps its history at
  `ON_DEVICE_CONTEXT_MAX_CHARS` (16 000 characters, newest turns kept, never opening on an assistant
  turn), and the phone (`apps/app/src/lib/llm-context-budget.ts`) formats the turns with the model's own
  chat template, counts them with its tokenizer and drops the oldest turns until the prompt plus the
  512-token reply fits (`ON_DEVICE_PROMPT_BUDGET`). A newest message too long to fit on its own is refused
  without generating. Ollama and OpenAI-compatible services still get the 40-turn window, since their
  context is set on their side; a token budget + summarization is still the fuller follow-up.
- ~~**Streaming is bandwidth-inefficient**~~ **(FIXED)**: streaming now uses the **`StreamEvent`** union
  (`start`/`delta`/`end`/`error`) — each delta carries only the *new* text to the DM participants, and the
  final body is persisted + broadcast **once** at `end` (a single `messageUpdated`, so non-streaming
  clients still converge). The old O(n²) per-token rebroadcast of the entire growing body is gone. See
  `broadcastStreamEvent` in `realtime.ts`; covered by `apps/server/src/llm.test.ts`.
- **Concurrency is bounded**: at most **one reply per user and two node-wide**
  (`MAX_CONCURRENT_ASSISTANT_REPLIES`). `POST /api/messages` checks this *before* creating the DM and
  answers **429 `assistant_busy`**, so a refused request leaves no unanswered message.
- **Streams stop when their message goes away**: the writer checks before every write and stops if a
  moderator removes the reply, it is deleted, or an Emergency Reset lands mid-stream (so a late delta can't
  restore removed content). A placeholder a crash/restart left with `meta.streaming: true` is
  **finalized at load** (`finalizeInterruptedStreams`: partial text kept, or a neutral "interrupted" body),
  so it no longer sits un-reapable and un-deletable.
- **Still missing**: user-initiated cancellation and a per-user rate limit/queue beyond the bound above.

## The OpenAI-compatible service (`llm.openai`): optional, off by default

Built 2026-10-22 (the "provider abstraction" item below, and docs/29 Track 3's provider part).
`llm.openai { enabled, baseUrl, model, apiKey? }`: `baseUrl` is the base of the service's OpenAI-style API
(`https://openrouter.ai/api/v1`, `https://api.openai.com/v1`, `http://localhost:1234/v1` for LM Studio);
`OPENAI_COMPATIBLE_PRESETS` in `@loam/schema` lists the services the screens offer by name, each marked
`cloud` or local. The bot's identity (`botId`, `botDisplayName`, `systemPrompt`) stays in `llm.ollama`,
shared by every backend, so switching keeps the same DM contact.

**The key is write-only.** It is stored with the node's config (in the clear, like `sync.token`: the node
has to present it), and never returned: `GET /api/admin/config` and the host API's `config()` replace it
with `apiKeySet: true|false` (`redactedConfig`). An update that leaves `apiKey` out keeps the stored key, an
empty string clears it, and the read-only `apiKeySet` a screen echoes back is stripped by `mergeConfig`.
**The key is only sent to the origin it was saved for:** an admin save (`PATCH /api/admin/config` or the
host API, both `applyConfigUpdate`) that moves `baseUrl` to another origin (scheme, host and port,
`sameUrlOrigin` in `@loam/schema`) without a new non-empty key drops the saved key; a change of path on the
same origin keeps it. Boot keeps the drop: when the DB row gives an address and no key, a key from
`config.json` is kept only if `config.json`'s own address has the same origin (`withoutFileKeyForOtherOrigin`
in `app.ts`). So a key a save cleared stays cleared after a restart, and a config an older version saved
with a `config.json` key under a DB address on another origin loses that key at boot and needs it entered
again. The web admin's key field then says no key is saved and offers no Clear, with a
line saying a saved key is only used with the address it was saved for; the TUI's address save says the
key was dropped.
The key goes in the `Authorization: Bearer` header of the two requests the node makes and nowhere else
(a `user:pass@host` base URL would ride in the request too; the schema allows it, so don't). A service's
error text (which can echo a key's prefix, the URL or the member's question) goes to the debug log only, cut
to 200 characters with key-shaped text replaced. At error level a failed chat request logs only the
provider and HTTP status, or that the backend's stream reported an error, or that it sent a line that is
not JSON. A failed model list logs at debug level. A member sees the plain `ASSISTANT_FAILURE_BODY`.
A fixed-key Emergency Reset strips the key from the config snapshot it carries
across the restart (`sanitizeConfigForRestart`, like `sync.token`) and switches the service off, so the
key never lands in `config.json` or `.loam-wipe-phase`; the admin pastes it again afterwards.

**`POST /api/admin/llm/models`** (admin only; the host API's `llmModels` for the TUI) asks a backend which
models it offers: Ollama's `GET /api/tags` or the service's `GET /models`, 15-second timeout, names
deduplicated, sorted and capped at 500. The request names the backend and may carry the connection to
try (`baseUrl`, `apiKey`), so a screen can test before saving; a key left out means the stored key, but
only when the request leaves `baseUrl` out too or gives one with the saved address's origin (a key typed
into the request is sent where the admin asked). A backend's failure is the answer, not an HTTP error: 200
with `{ ok: false, code }` where `code` is `llm_unreachable`, `llm_unauthorized` (401/403 from the
backend), `llm_bad_response` (also a redirect, or a list over 8 MiB) or `llm_not_allowed`.
(A 401 from this node would read to the client's transport as its own session expiring.)

**Hardened networks take only an address that reads as local.** Under `security.profile: "hardened"` the
service's address must be a local one by its text (`isLocalNetworkUrl`: loopback, the name `localhost`,
RFC 1918, link-local, `.local`, a bare host name; not a `*.localhost` name, which Node's `fetch` resolves like any other, so it can be another machine);
`PATCH /api/admin/config` refuses a cloud `baseUrl` with `llm_cloud_not_allowed` (also when switching an
already-cloud node to hardened), `ensureBotUser` treats a hand-edited config.json that pairs them as
"assistant off" with a boot warning, and the models endpoint answers `llm_not_allowed`. Ollama is held to
the same rule (its address can point anywhere); only the on-device model is local by construction. The check
reads the address and resolves nothing, so it is not a promise that traffic stays on the local network: a
bare host name that the system resolver maps to a public address (through a search domain, say) is
accepted like any other.

**Networks the Android app hosts reach another machine only over HTTPS.** The Android launcher sets
`LOAM_REQUIRE_TRANSPORT_ENCRYPTION=1` (`AppOptions.requireTransportEncryption`, see docs/08), and on such a
network `llmProviderRefusal` also refuses a plain `http://` address for either backend unless it is loopback
by its spelling (`localhost`, 127/8, `::1`; not a `*.localhost` name, which the phone looks up in DNS)
(`unencryptedBackendRefused`): a save that introduces one gets `llm_unencrypted_not_allowed`, a network
that already had one (a hand-edited config.json, or a phone upgraded with a LAN Ollama) boots with the
assistant off and a warning, the admin config carries the read-only `llm.refusal` code so the Assistant
panel says why, and a save that leaves that backend exactly as it was still goes through (otherwise no
other setting could be saved). The same holds for a hardened network's online service. The models endpoint answers `llm_unencrypted` (so the key never goes
over plain HTTP either), and, as on every network, no redirect is followed (one could turn HTTPS into HTTP). An Ollama or LM Studio
server on the LAN therefore needs HTTPS in front of it to serve a phone-hosted network.

**Where it is set up.** The web admin page's Assistant panel (`LlmPanel.tsx`: a "where the assistant runs"
picker, a service preset, address, key field with Clear, Test connection that fills a model list, and a
note naming the host the messages go to when the service is a cloud one); the `loamnet` TUI's Settings
screen (the same rows, the key typed blind, the model picked from the backend's list); the desktop host's
Settings has an Assistant card that opens the web admin page at that section (`openClient({ page:
"assistant" })` loads `/#/admin?section=llm`, the only non-home page the main process allows; the admin
page jumps to the section named in the route's `section` query once its config has loaded); the Android
host's model manager (menu, AI assistant) links to the same admin section, by setting the WebView's
`location.hash`, for hosts who'd rather use a laptop or a service.

**Still not built:** channel participation / `@mention` (docs/29 Track 3's consent model), a token
budget, cancellation, tool use.

## What members are told

Only the admin screens used to say where the assistant's messages go. Now every member sees it in the
assistant's own DM, whichever backend answers.

- **`NetworkConfig.assistantDestination`** (in `/api/bootstrap`, `/api/config` and every `configUpdated`;
  present exactly when `enableLLMChat` is): `{ kind: "onDevice" }` for the host phone's model, `host` for a
  loopback address by its spelling (`localhost`, `127.*`, `::1`), `lan` for any other `isLocalNetworkUrl`
  address, and `{ kind: "online", host }` otherwise, named by its lower-cased hostname alone (no scheme,
  port, path or credentials). `classifyBackendUrl` in `llm.ts` decides it. A `*.localhost` name is resolved
  like any other name, so `http://ollama.localhost:11434` is `{ kind: "online", host: "ollama.localhost" }`.
- **The DM header** shows it in place of presence ("Runs on the host's computer", "Answers come from
  openrouter.ai, an online service"). For an `online` destination the DM also carries a notice: what the
  member writes there and the chat's recent history go to that service under its own privacy policy, the
  host chose it, nothing else of theirs goes there. The composer stays disabled until they press "I
  understand"; after that the notice shrinks to one line. The acknowledgement is per service and per
  device (`loam.assistantAck.<host>` in localStorage, `lib/assistant-ack.ts`), so a switch to a different
  online service asks again, and it is cleared with the cached content by a wipe or identity change.
- **History never crosses a destination change.** The server keeps `{ key, since }` in the config table
  under `assistantDestination` (`key` = provider plus the endpoint: scheme, hostname, port and path, never
  credentials or query, as in `openai:https://host/path`, so two tenants on one host are two recipients and
  so are `http` and `https` on one host; or `onDevice`). A record an earlier version keyed without the
  scheme, for the same destination, is rewritten in place under the new key and keeps its cut-off and
  revision. `syncAssistantDestination`
  runs from `ensureBotUser` (boot and every config save) and before each reply: a key that differs from the
  stored one records a new `since` (logged as provider and hostname only): the later of the clock and one
  more than the newest DM to or from the assistant, so a host clock that went back can't let old turns
  through to the new destination. `llmMessagesForUser` then sends only
  DM turns written at or after `since` (still at most `MAX_LLM_CONTEXT_MESSAGES`, system prompt kept, and
  always the message being answered). Switching a local model to an online service therefore uploads
  none of the conversation members had while it was local. The first record (an upgrade, a fresh node)
  starts at 0, so an unchanged local assistant keeps its memory, except that a first record for an ONLINE
  destination starts now (a node upgraded with the assistant off may hold turns written to a local model); while the assistant is off nothing is touched,
  so turning the same one off and on again keeps it too; an unreadable record counts as a change.
  `wipeAll` deletes the record (it says when the host changed the assistant), and an encrypted reset's fresh
  database starts without one.
- **A message to the assistant names the destination its sender saw.** Beside `assistantDestination`,
  `NetworkConfig` carries `assistantDestinationRevision` (present exactly when it is): 32 random hex
  characters minted each time the destination changes and stored in the record above (`destinationRevision`
  in `llm.ts`; a record an earlier version wrote gets one when it is next read). It is the same across
  restarts and saves that keep the destination, and different after any change, including a switch away and
  back. It is random and not derived from the destination, so a member can't use it to check a guess at the
  service's address or path. The app sends it with every DM to the
  assistant. When it is missing or no longer current, `POST /api/messages` refuses the DM (409
  `assistant_destination_changed`) before anything is stored, broadcast or sent to a backend, and before the
  busy check, so a refusal never holds the assistant's slot. The field is never stored or broadcast with the
  message. The app keeps the draft, reads the config again (so the DM header, and the acknowledgement for an
  online service, show the new destination first) and says the assistant now answers from somewhere else.
  That read goes through the tunnel when the tunnel is active, and never starts a handshake or a resume; a
  pinned client whose tunnel is down keeps the config it has.
  This covers a switch the member's screen had not yet heard of (a reconnecting socket, a `configUpdated`
  still in flight). The reply checks once more just before it starts: if the destination changed after the
  DM was accepted, no backend is contacted and the reply ends with the usual failure sentence. A record
  that can't be read (a store an incomplete reset left closed) leaves the revision out and refuses every DM
  to the assistant. A DM to a person ignores the field, and nothing is checked while the assistant is off.

## On-device model (Android host) — optional, off by default

As an alternative to reaching a laptop's Ollama, the Android host can run a **small model on the phone
itself** (e.g. Gemma via llama.cpp). It's **optional and off by default** (lots of people dislike AI),
the model is **never shipped** — the operator adds a GGUF file on-device later if their phone can
handle it — and it must never affect crisis messaging, which always works with no model present.

**Config** (`packages/schema`, additive — existing Ollama config is untouched): `llm.onDevice
{ enabled, model?, modelPath?, contextSize? }`. The bot's *identity* (id, display name, system prompt)
is shared from `llm.ollama`, so switching backends keeps the same DM contact. The active backend is
derived server-side: on-device when `onDevice.enabled`, else Ollama when `ollama.enabled`, else none
(`llmEnabled()`, `activeLlmModel()`). Admin UI: a toggle + model-name field under LLM settings.

**Who owns `llm.onDevice`.** The launcher's model manager (`loam-model-set-active` in
`nodejs-project-template/main.js`) writes the whole `llm.onDevice` block into `config.json`. Because
the DB config layer (written in full by every admin save) sits above `config.json`, **`config.json` is
authoritative for `llm.onDevice` whenever it carries that block** — the DB layer's copy is dropped
(`withoutLauncherOwnedKeys`), so an admin save can't freeze the launcher's later activate/deactivate.
A desktop/Pi node whose `config.json` never mentions `llm.onDevice` keeps the admin's persisted value.

**Architecture** — reuses the existing streaming flow entirely. Inference does **not** run in the
embedded Node server; it runs in the RN/native layer, so no native dependency is added to
nodejs-mobile (avoiding the SQLCipher-class ABI problem). The path:

```
DM to bot → createAssistantResponse → streamChat → streamOnDeviceChat
  → global.__loamOnDeviceChat  (installed by nodejs-project-template/main.js, before requiring the server)
  → rn-bridge 'loam-llm-request'  → apps/app/src/lib/on-device-llm.ts (registerOnDeviceLlm)
  → runInference → streams 'loam-llm-delta'/'loam-llm-end'/'loam-llm-error' back
  → server emits the same StreamEvent start/delta/end/error as Ollama, persists once
```

On every non-Android host (desktop, Pi, CI) `global.__loamOnDeviceChat` is simply **absent**, so
enabling the on-device backend there yields a clean assistant error, never a crash — messaging is
unaffected. Correlation ids keep concurrent DMs from crossing streams.

**Built and unit-tested now** (no device needed): the server provider abstraction + config +
`enableLLMChat` derivation, the launcher bridge glue (`main.js`), the client admin UI, and the RN
listener (`registerOnDeviceLlm`). Server tests cover the on-device path via a faked
`globalThis.__loamOnDeviceChat` (streaming + the graceful absent-hook error + bot hidden when off).

**The one device-gated step — wiring real inference. _DONE._** `apps/app/src/lib/on-device-llm.ts`
fully wires `llama.rn` (model download with on-device SHA-256 verification, load, streaming
inference), verified on a physical Galaxy S21 Ultra (Android 15, 2026-08-04 device session:
download → verify → activate → coherent DM reply, CPU backend honestly reported — see docs/21).
Ongoing re-verification of new builds remains part of the docs/21 device checklist. The original
build plan is kept below for the record:

1. `pnpm --filter app add llama.rn expo-document-picker expo-file-system`, add the `llama.rn` Expo
   config plugin to `app.json` (verify the arm64-v8a prebuild against `with-loam-host.js`'s ABI pin).
2. Implement `runInference`: load the GGUF at `llm.onDevice.modelPath`, run a streaming completion
   built from `messages`, forward each token to `onDelta`, then `onEnd` (errors → `onError`).
3. Add a model-file picker (SAF via `expo-document-picker`) to the host UI that copies the GGUF into
   app-private storage and PATCHes `llm.onDevice.modelPath`; gate the offer on `Device.totalMemory`.

_(Historical caveat, since resolved: this step was deliberately held back until a physical arm64
phone and a GGUF model were available — that verification has now happened, see above.)_

Runtime choice: **`llama.rn`** (llama.cpp, GGUF) over MediaPipe LLM Inference (less mature RN bindings)
and over `node-llama-cpp` inside nodejs-mobile (a non-starter — an N-API addon cross-compiled for the
Node 18 / ABI-108 android-arm64 runtime, the same class of problem the on-device DB encryption had to
solve with a cross-compiled, vendored prebuild). GGUF is also the format users are most likely to find, and it's added later, not
shipped.

**Known gap: prompt tokens in the system log.** llama.rn 0.12.6, used as its prebuilt native library,
writes each prompt's token ids to Android's system log at info level (tag `RNLlama`,
`prompt_tokens = …`). Token ids decode to text with the model's public vocabulary, so the question and
the chat history sent to the on-device model can be read back from logcat (`adb logcat`, a bug report).
This holds until the library is built from source with that line removed (docs/04 "What the host phone
logs").

## Improvements to investigate (roughly ordered)

1. ~~**Provider abstraction.**~~ **Built (2026-10-22, above):** `streamChat` switches on
   `activeLlmProvider`; the OpenAI-compatible shape covers OpenRouter, OpenAI, Groq, Mistral, LM Studio,
   llama.cpp server, vLLM and Ollama's own `/v1`. Anthropic's native API is not a separate backend
   (OpenRouter fronts it). There is no `llm.provider` field: the three `enabled` flags stayed, because the
   Android launcher writes `llm.onDevice.enabled` itself; the schema helper derives the active one.
2. **Fix the streaming protocol.** Wire the existing `StreamEvent` schema over the WebSocket: emit
   `start` once, `delta` with only the new text per token, `end`/`error` to finish. Client appends deltas
   locally. Removes the O(n²) rebroadcast and matches what the schema already anticipates. Persist the
   final body once at `end` (fewer DB writes than per-token).
3. **Context management.** Bound the history sent to the model (last N turns / token budget), with
   optional rolling **summarization** of older turns. Prevents slowdowns and context overflow.
4. **Cancellation + limits.** Let a user stop a generation (abort the fetch); add a queue and a per-user
   rate limit on top of the concurrency bound (1 per user / 2 node-wide, done) so a Pi isn't overwhelmed.
5. **Channel participation / `@mention`.** Let the bot answer in channels when mentioned, not just DMs —
   a big fit for LOAM as an *information-sharing* app ("ask the assistant in #general"). Mind audience
   scoping so the bot can't leak other users' private data.
6. **RAG over local content — the standout off-grid feature.** Ground answers in local channels /
   announcements / uploaded docs so the assistant can answer "where's the meeting point?" from
   `#announcements` with no internet. Use local embeddings (Ollama `/api/embeddings`) + a vector store
   — **`sqlite-vec`** fits the SQLite direction ([01](01-sqlite-migration.md)), or a simple cosine over
   stored vectors to start. This also unlocks **semantic message search** (see [07](07-more-features.md)).
7. **Multiple models / bots.** Let admins ([03](03-admin-ui.md)) register several bots (each a
   `type:"bot"` User) with their own model, persona/system prompt, and temperature; users pick which to
   talk to.
8. **Tool use / function calling** (advanced). Ollama and OpenAI-compatible backends support tools; could
   let the assistant take structured actions (post to a channel, look up local info). Gate carefully.
9. **Safety.** Message bodies are untrusted input — harden against prompt injection (especially in
   channel/RAG mode), and never let the bot bypass DM/channel audience rules. (Output length is capped:
   `ASSISTANT_REPLY_MAX_CHARS`, above.)
10. **Backend health surfacing.** Report whether the LLM backend is reachable; the current error path
    appends an "LLM error" note — extend to a clear status in the UI.

## Interactions
- **[01 SQLite]** enables `sqlite-vec` for RAG/embeddings and cleaner message storage.
- **[03 Admin UI]** is where model/provider/persona config and enable/disable live (today it's text-file
  only).
- **[05 Auth]** the `authenticated`/website mode is where cloud LLM providers (with API keys) make sense;
  off-grid stays local-only.

## Quick wins vs. bigger bets
- **Quick wins:** ~~wire `StreamEvent`~~ (done), ~~bound context length~~ (done: 40 messages, plus a token fit on the on-device model),
  ~~a concurrency cap~~ (done); user cancellation remains.
- **Bigger bets:** provider abstraction, channel/@mention participation, and local RAG (the most
  differentiated feature for an off-grid information-sharing app).

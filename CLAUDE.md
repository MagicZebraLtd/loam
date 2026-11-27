# CLAUDE.md

Guidance for AI agents (and humans) working in the LOAM repo. Read this before making changes.

## What LOAM is

LOAM is a **local-first, off-grid messaging app**. A host runs it on a laptop, Raspberry Pi, or
phone hotspot; nearby people scan a QR code and join over the local network — no internet, no
accounts, no cloud. Users get an anonymous, ephemeral identity and can post to channels, reply in
threads, DM, react, and (optionally) chat with a local LLM. The client is an installable PWA that
keeps working offline against its local cache.

Priorities, in order: **simplicity** (no setup), **privacy** (anonymous/ephemeral), **resilience**
(low bandwidth, intermittent connectivity). It is transport-agnostic by design (WiFi today; LoRa
relay is a stated future goal).

**Positioning & governance.** LOAM is framed as *local communication for crowded or disrupted
environments* (emergencies, travel, community events) — see `MISSION.md`, `ACCEPTABLE_USE.md`, and the
translation policy in `docs/13`. Keep **user-facing/marketing copy** (site, README) accurate but
non-inflammatory (the node-wide wipe is "Emergency Reset" in public copy; code identifiers like
`killSwitch`/`/api/panic` and the blunt security docs stay as-is). The **security docs stay
technically honest** — the distinction is documenting privacy accurately vs. presenting
law-enforcement avoidance as the purpose.

**Opportunistic mesh / DTN** (`docs/16-opportunistic-mesh.md`) — delay-tolerant "carry my message"
(A→C→B) delivery. **Phases 0–2 + v2 secure addressing are BUILT & TESTED** (see the doc's
"Implementation status"): `packages/crypto` (`@loam/crypto`) is the Ed25519/X25519 sealed-sender
primitive; the server has a `sealed` `Message` arm, per-user mesh identities (`mesh_identities` DAL
table; minted only for local users — a v0.4 database gets a one-time `synced_users` backfill (unreachable,
footprint-free humans) — a row an older build minted for a synced user is deleted at boot and
its forged `identityKey` stripped), and bounded relay (TTL/hop/cap, no acks; mail is sealed with a hop budget drawn from the top three values (never below 2) and a stated send time up to min(ttl/5, 1 h, retention/5) early, and a relay stores and re-advertises carried mail under its own intake time, so first-hop carriers can't read origin off those fields alone; docs/16 §9 says what is still visible). `GET /api/mesh/outbound` hands the radio courier at most 200 blobs per answer, rotated across calls. The inner signature is version 2 (`loam.mesh.inner.v2`, then `from`, `fromKx`, `toKx`, `aad`, `pt`, each a 4-byte big-endian length + UTF-8 bytes; inner JSON `v: 2`). `toKx` is the recipient's canonical X25519 key, and the recipient verifies against the key it derives from its own secret, so a contact holding two people's cards can't re-seal one's mail to the other. `openMailbox` accepts only `v === 2` and refuses a `fromKx` that isn't a canonical 32-byte key; `sealMailbox` writes only v2 and refuses a non-canonical sender or recipient key (docs/16 item 10; a new inner field needs a new label). Mesh mail does not cross between this version and 0.3.0 to 0.7.x in either direction; mail an older build sealed is never delivered. The outer message id isn't covered by the seal, so
replay protection keys on a **hash of ciphertext + toTag + TTL** (`sealed.<sha256>`, stored beside the
id tombstones on delivery) as well as the id; relays dedupe carried mail by the same key, only the
canonical base64url spelling is accepted, and peer-supplied ids in the `sealed.` namespace are refused.
**v2** addresses mail by the recipient's
**self-certifying `mesh.` id** and exchanges keys via **mesh identity cards** — `GET /api/mesh/identity`
(your card: public keys + secret `mailboxToken`) → shown as a QR / pasted → `POST /api/mesh/contacts`
(re-verified server-side: `meshId===hash(sign)` + `kxSig` binding; stored per-user in the
`mesh_contacts` DAL table, private to each local user). `POST /api/mesh/messages {toMeshId,body}` seals
only to an **added contact**, so key-substitution is defeated; routing `toTag` derives from the secret
`mailboxToken` and the day, and sits in the sync digest: a **carrier** that lacks the token can't name the
recipient, but can group and count one day's mail to the same unnamed recipient; an authorized sender or a
compromised contact that holds the token can derive and correlate the tag. All gated on
`mesh.enabled` (default off; client UI shows only when `networkConfig.enableMesh`). It's **entirely
server-side** (LOAM's host is already trusted for its local users, so the E2E guarantee is against
carrier *nodes*), rides the existing sync transport, and doesn't touch public sync. An operator turns
it on and tunes it (relay/TTL/hop/caps) from the **admin UI Mesh panel** (`PATCH /api/admin/config`).
**Phase 3 (opportunistic transport) is SCAFFOLDED, native-unverified** (docs/16 status, docs/17): a new
`apps/app/modules/loam-mesh-transport` Expo module (Kotlin BLE advertise/scan + a fixed LOAM GATT
service, Wi-Fi Aware publish/subscribe + data-path socket, BLE-only chunked fallback = TODO), a TS
`MeshTransport` + `mesh-courier` RN↔launcher bridge (`apps/app/src/mesh/`), the launcher courier brain
(`nodejs-project-template/main.js`), and two **launcher-only** server endpoints (`GET /api/mesh/outbound`,
`POST /api/mesh/inbound`; loopback **and** the launcher's per-boot `x-loam-host-token` on every host —
loopback alone is reachable by every installed app on Android and by every LAN client behind a same-host
proxy — so a desktop/Pi node, which has no host token, has no bridge and 404s) that shuttle sealed blobs
between the radio and the existing relay — a radio-fed
mirror of `/api/sync/*` reusing `acceptSealedFromPeer` (desktop-tested; the Kotlin compiles in APK builds but has NOT been run
against radios — no CI hardware). **Still not built:** the Wi-Fi Aware handshake/port-exchange finish +
BLE fallback + Phase 4 background/battery duty-cycling (all real-device work), an in-band contact-request
flow, and group fan-out. Do not rush the unbuilt crypto/transport — that's the documented
way comparable apps (Bridgefy, FireChat) failed.

## Layout

pnpm workspace (`pnpm-workspace.yaml`: `apps/*`, `packages/*`). Node pinned to `24.15.0`
(`.node-version`), package manager `pnpm@10.30.2`.

| Path | Role |
|------|------|
| `apps/server` | Fastify backend: REST + WebSocket, SQLite persistence behind a DAL (`src/db.ts`), optional LLM assistant (Ollama, an OpenAI-compatible service, or the Android phone's model). `src/app.ts` is the composition root (`buildApp()`, testable via `inject`) plus the domain core; the transport layer, realtime, kill switch, store lifecycle, sync, mesh, LLM and per-domain routes are sibling modules over one `AppContext` (see "Server architecture"). `src/server.ts` is the thin entry point (env, listen, SIGINT). |
| `apps/client` | Preact + Vite PWA. Main app: `src/app.tsx` (~2.7k lines: `LoamApp` state, boot, WebSocket, routing). Screens in `src/views/`, components in `src/components/`, libs in `src/lib/`, styles in `src/styles/` (see `apps/client/DESIGN.md`). |
| `apps/app` | Expo SDK 57 / RN 0.86, the **Android host** (embedded Node server + hotspot + WebView, see `docs/04-android-host-app.md`). The Step-2 join address is **discovered, never assumed**: Android gives a LocalOnlyHotspot a random address (sticky within one phone boot, per AOSP; a reboot can change it, and joiners keyed to the old origin come back as new people) (`192.168.49.1` is Wi-Fi Direct's, not a hotspot's), so the Kotlin module enumerates interfaces (`hotspotAddressCandidates`, with upstream / pre-existing hints) and `src/lib/hotspot-address.ts` scores them; no confident pick → Step 2 shows the manual "Gateway" route, not a guess (docs/04 "The Step-2 address"). The share overlay has a persisted **host mode** (`HostMode = 'hotspot' \| 'wifi'`, SecureStore `loam.hostMode`, default hotspot): Wi-Fi mode starts no hotspot, never asks for location, and advertises the phone's Wi-Fi station address via the pure `pickWifiAddress` (`src/lib/host-mode.ts`; native `wifiStationInfo()`, whose `wired` flag lets a laptop with no Wi-Fi host on its wired network), see docs/04 "Hosting modes". **Large screens** (docs/04 "Large screens", docs/30): `orientation: "default"` (no lock), `android:resizeableActivity="true"` and an optional touchscreen (`OPTIONAL_FEATURES`) so it runs on tablets, foldables and Android laptops, with every native screen a scrolling column centred at `MaxContentWidth`. Has `scripts/bundle-server.mjs` (esbuild → `nodejs-assets/nodejs-project/loam-server.js`, gitignored; run `fetch:native` first; it fails without both SQLite prebuilds unless `LOAM_ALLOW_MISSING_NATIVE=1`) and the host UI (`HostPanel`, `QRCode`). Both android-arm64 SQLite prebuilds (plain `better-sqlite3` and `multiple-ciphers`) and their JS wrappers (`native-prebuilds/npm/`) are **vendored** under `native-prebuilds/`, sha256-pinned; nothing is downloaded from upstream releases or the registry. **Permissions:** on API 33+ the hotspot asks only for `NEARBY_WIFI_DEVICES`; fine + coarse location are requested only on API 31-32 and capped `maxSdkVersion="32"` in the manifest (`capLocationPermissions` in the plugin), so Wi-Fi mode can't show the network name on 13+. **Errors in the host's language:** the Kotlin modules reject with `ERR_HOTSPOT_*` codes (`src/lib/hotspot-errors.ts`) and main.js sends an `errorCode` beside each error (`src/lib/host-errors.ts`); `src/__tests__/native-strings.test.ts` fails on English literals in native screens. **Right-to-left:** in ar/fa/ur/prs/ps `t()` prefixes U+200F and isolates each filled-in value (U+2068/U+2069), and `ThemedText` aligns unaligned text right (`rtlTextAlign`). There is no web build (the Expo template's web target and unused template dependencies are gone). **No Google usage reports:** expo-camera's barcode scanner is ML Kit, which reports usage to Google through datatransport; `with-loam-host` removes datatransport's `cct` upload backend from the merged manifest so nothing is sent (docs/30 "No telemetry"). Keep it that way: nothing in the app reports to us. That is not Play's "No data collected": Google counts any transfer off the device, and messages, names and user ids leave the host phone for members' phones, so Data safety declares them collected (docs/30 "No telemetry" and its Data safety answers). The injected `__loamHostDeviceToken`, `__loamHostTransportKey` and `__loamHostNoLocalCache` are set only when `location.origin` is `http://127.0.0.1:3000` (`src/lib/host-injection.ts`), WebView messages from any other origin are ignored, and a foreign page the WebView reports is stopped and LOAM loaded again, since react-native-webview's `onShouldStartLoadWithRequest` lets a load through when JS doesn't answer within 250 ms. The WebView's `originWhitelist` is `['*']` on purpose: react-native-webview hands a URL that fails the whitelist straight to Android (`Linking.openURL`) and never asks `onShouldStartLoadWithRequest`, so `navigationDecision(url)` (`host-injection.ts`) decides every navigation: `load` for LOAM's origin, `external` (the system browser) for any other http(s) address, `block` for every other scheme (`intent:`, `tel:`, `blob:`, `about:blank`…). It reads the scheme from the text, since React Native's `URL` is a few regexes that neither validate nor lower-case. The server counts the host token only from loopback (admin claim and `hostDeviceUserId`); from any other address it is a wrong secret and counts against the attempt limiter. Passphrase fields opt out of autofill. **Message notifications** (docs/04): the host's WebView presents its host token on every page load, so the server knows the host phone's person (`hostDeviceUserId`); `broadcast` hands main.js (`__loamNotifyHost`) each new message that person's socket would receive, and `src/lib/message-notifier.ts` shows an Android notification (`MessageNotifications.kt`) only while LOAM is in the background, at the level the web client's Settings posts (`loam-alerts`). A notification is taken back when its message is deleted, edited, removed by a moderator or expired, or its author is shadow-banned, and a channel's when the host's person loses the channel: the server remembers up to 256 notified ids (`realtime.ts`, cleared by the kill switch; when full it evicts first an id a newer notice in the same conversation superseded, else the oldest, whose conversation's notification it takes back) and calls `__loamWithdrawHostNotice` → `loam-message-withdrawn` → `message-notifier.ts` `withdraw` → native `clearMessageNotification` (Kotlin not yet run on a device). Notifications are cleared when the host screen first starts (before the runtime) and when LOAM is swiped away (`LoamHostService.onTaskRemoved`), and are `setLocalOnly(true)`, so a paired watch never gets their text. Closing after an Emergency Reset run from the host deletes the setup record (`loam.setup`) and all of the WebView's cookies and storage natively (`deleteAllWebData`; waited for at most 1.5 s). `deleteWebOriginData` (`deleteBrowsingDataForSite`, falling back to `deleteOrigin` where it is missing or throws) now only clears the old `http://localhost:3000` origin at launch. A fixed-key reset's device-key clear comes in two kinds (`finishWipeKeyClear`, `src/lib/emergency-reset.ts`): main.js posts `loam-wipe-restart` with no payload for a **live** reset, and with `{ resume: true }` when it finds at its own boot a wipe journal still at `key-clear-ready`. A live clear deletes the setup record first, clears the key and acknowledges, then closes LOAM; a resumed one deletes the last shared file and the WebView's data, clears the key and acknowledges, and neither deletes the setup record nor closes, so the boot carries on with the setup just made. While a key clear is under way or has failed, the `loam-wipe` message's 1.5 s re-bootstrap does not run (`mayRebootstrapAfterWipe`). Only one key clear runs at a time (`lib/single-flight.ts`: a repeated `loam-wipe-restart` or Retry joins the one in flight), and `registerDbEncryption` resolves no key, so mints no device secret, until it has settled; a slow clear plus a retry could otherwise delete the new network's secret. The injected scripts build their literals with `jsStringLiteral` (`<`, U+2028 and U+2029 escaped). `message-notifier.ts` tracks up to 64 counted ids per conversation, so withdrawing an older message lowers the count. The `loam-db-start-fresh` handler arms no boot watchdog (`resolveDbEncryptionAndBoot` arms one on every attempt that loads the server), so a start-fresh that ends locked shows no `boot_timeout` five minutes later. All Kotlin in the three local modules compiles (`compileReleaseKotlin`); none of these changes has run on a phone (docs/21). The WebView is steered by setting `location.hash` (`src/lib/webview-route.ts`), and only when `location.origin` is LOAM's; a conversation waiting to open (a tapped notification) opens only after LOAM's own page has loaded (`pendingConversationAfterLoad`). **Setup screens** (`src/components/setup-wizard.tsx`, logic in `src/lib/setup.ts` + `new-network.ts`, docs/04 "Setup screens") run every launch before the runtime starts: language, kind of network (Private and short-lived / Community / Choose every setting myself = a security profile + identity/presence flags + DB encryption mode), name, Hotspot or Wi-Fi; later launches offer one-tap Continue or a hold-to-confirm new network. A new network rides every `loam-db-key-response` as `newNetwork {id, config}` until main.js acknowledges it; main.js (`new-network.js`) marks the folder `.loam-setup-pending`, empties it (keeping that marker and the mode hint), durably writes `config.json` and records the id (a repeat is a no-op), staying locked if that fails, and on every boot while the marker names an unapplied operation; setup also writes the chosen mode into the launcher's mode hint first, so a failed key handoff on a fresh install locks instead of booting plaintext. The host app has its own i18n (`src/lib/i18n`, all 15 locales, parity-tested). **Update news** (`modules/loam-updates`, `src/lib/app-updates.ts`, `components/update-notice.tsx`), on the opening setup screen only (never on a running network): the AAB is built with `-PloamDistribution=play` and asks the Play Store app (Google's `app-update` library, linked only in that build); the GitHub APK (`github`, the default) has a tap-only "Check for updates" against GitHub's latest-release API. Neither downloads anything. Has a vitest harness (`src/**/*.test.ts`, in `pnpm test`); also validate types with `pnpm --filter app typecheck` (a CI step). **GOTCHA: never put `*.test.*` files under `src/app/`**: that dir is the Expo Router root, whose `require.context` eagerly bundles EVERY file in it into the release APK, so a test's `vitest` import pulls `vite` into the bundle and breaks `assembleRelease` (debug is unaffected, so it hides until an APK build). Keep tests in `src/lib/` or `src/__tests__/`. |
| `apps/desktop` | `@loam/desktop`, the **desktop host** for macOS / Windows / Linux (Electron **45**, pinned to an exact version in its `package.json`; docs/24): the Android launcher's sibling, so the person who installs it RUNS a network and joiners use their phone browsers. The main process (`src/main/`, ESM) runs `startEmbeddedServer` **in-process** from `dist/main/loam-server.js` (the esbuild recipe shared with the CLI in `scripts/lib/bundle-server.mjs`), `NodeController` (`node-controller.ts`) is the state machine over it (setup / locked / starting / running / stopped / failed / resetting), and `src/shared/ipc.ts` is the typed contract with the windows (every handler checks the sender is the host window's own `file:` frame and parses its payload; the one sync channel, `hostInjection`, answers only the client window on the loopback origin). **Self-contained `dist/`**: electron-builder packs `dist/**` + `package.json` only (`dependencies: {}`, `npmRebuild` off, `.node` files `asarUnpack`ed, Electron fuses closed: no `runAsNode`, no `NODE_OPTIONS`, no inspect, `onlyLoadAppFromAsar`). **Drivers**: unencrypted = builtin `node:sqlite`; encrypted = `better-sqlite3-multiple-ciphers` v13, a Node-API addon whose prebuild `scripts/native.mjs` **copies** (not compiles) into `dist/main/node_modules/` (`--from-source` = `@electron/rebuild` in a temp copy). **Keys** mirror the Android launcher: a 32-byte device secret sealed by `safeStorage` in `userData/device-secret.enc` (`keys.ts`); `persistent` = the secret, `passphrase` = `SHA256(passphrase:secret)`, `ephemeral` = the literal `"ephemeral"`, `off` = none; never in `desktop.json`. A fixed-key Emergency Reset runs through the server's `__loamRequestWipeRestart` hook + the `.loam-wipe-phase` journal (`wipe-phase.ts`): the launcher destroys the secret, proves the journal gone, boots under a new one. Client window storage is an in-memory partition for `ephemeral`, on disk (outside the DB key) otherwise, but on every encrypted network the preload sets `window.__loamHostNoLocalCache` and the web client keeps no IndexedDB (`lib/local-store.ts`); neither partition has an HTTP cache. The client window closes when the node stops (a fixed-key reset handoff and a retry included) and forgets its origin, since another program could take the port; the host window or tray opens it again, and an in-process reset still reloads it. The main process holds a new network's passphrase to 8 characters (`MIN_PASSPHRASE` in `ipc.ts`); unlocking takes any length. A new-network discard (`newNetwork()`) writes a durable `discardPending` mark into `desktop.json` first, with `clientCopyStale` in the same write, before the reset of a running node (an attempt: one that throws is logged and the discard goes on) or any destructive step, and drops the mark with the network record in its last write (`finishDiscard` closes the node first and returns a failed state, never a throw, when the folder can't be emptied); `initialize()` and `start()` finish a pending discard (`finishDiscard`, every step idempotent) before anything boots, so a failure part-way can't boot an empty network under the old record. The launcher clears its own env (`LAUNCHER_ENV`, `LOAM_REQUIRE_TRANSPORT_ENCRYPTION` included, so the desktop keeps the profile's transport mode) before every boot. A crashed host window is reloaded at most 3 times per 60 s (`crash-reload.ts`), then destroyed so the tray opens a fresh one. The host window sends a navigation or window open to the browser only for `isKnownExternalUrl` (loamnet.com, the repo, ko-fi, or the running node's port on this computer's addresses; `windowOpenDecision` in `trust.ts`); the client window's rule is unchanged. A tag build stamps `dist/main/release-tag.txt` (`LOAM_RELEASE_TAG`, refused unless vX.Y.Z, -rc.N or -beta.N), which `installedVersion()` (`updates.ts`) reads, so a release candidate's update check sees the final release as newer. The assistant page opens as `/#/admin?section=llm`. Stopping is bounded and never abandoned: the server's `close()` destroys its connections (`forceCloseConnections: true`), a node that still hasn't closed in 10 s is `stop_timeout` and nothing boots over it. `electron . --smoke` (CI runs it on the packaged AppImage under xvfb with `LOAM_SMOKE_REQUIRE_ENCRYPTION=1`) boots a temp node and prints one JSON line. Gotchas: **electron is pinned exactly and in `onlyBuiltDependencies`**; CI's main job sets **`ELECTRON_SKIP_BINARY_DOWNLOAD=1`** (only `build-desktop.yml` downloads Electron); preloads are **`.cts` compiled to CJS `.cjs`** (a sandboxed preload can't be ESM); **never rebuild the SQLCipher driver in place** (the pnpm store copy is shared with `cli`); the **keychain is touched lazily** (`keychainProtects` decides `capabilities.keychain` without asking, `get()` reads it only for a persistent/passphrase network; smoke never does); never put a key in `desktop.json`. |
| `apps/site` | The loamnet.com website (Vite, static HTML pages, no framework; deployed to Vercel from `master`): the landing page, `/desktop`, `/privacy`, `/child-safety`, `/code-signing`. Vercel builds it only when something under `apps/site` differs from the branch's last deployment (`vercel.json` `ignoreCommand` → `scripts/vercel-ignore.sh`, which builds whenever it can't tell). |
| `cli` | `loamnet`, the npm package (command `loam`, Node 22.14+): `bin/loam.js` boots the bundled server (`dist/loam-server.js`) and serves the built PWA, opening the TUI on a terminal or `--plain` output otherwise; `better-sqlite3-multiple-ciphers` is an `optionalDependency` for `--encrypt` (docs/14). It defaults `NODE_ENV` to `production` before loading the bundle, deletes `LOAM_DB_KEY` from its environment once the server has started, and the TUI starts its URL opener with no `LOAM_` variables. A database that won't open (`db_encryption_unreadable`, usually a wrong passphrase; `db_encryption_plaintext_unconverted`) ends with a plain message and exit 1, never a stack trace. Plain mode's admin link is `bin/admin-link.js` (`createAdminLinkOffer`): it removes a leftover `admin-link.txt` on its first tick, mints no link while the node is resetting, and its tick never throws. Local links (this one, "Open on this device", the TUI's) use the port and an address the server listens on, never the advertised `CLIENT_PORT` (`packages/tui` `local-link.ts`). |
| `packages/schema` | **The client↔server contract.** Zod schemas + inferred TS types for users, channels, messages, config, stream events. |
| `packages/crypto` | `@loam/crypto`, on `@noble/*` 1.x: the transport handshake and sealing (X25519 + XChaCha20-Poly1305) and the mesh sealed sender (Ed25519/X25519 identities, `sealMailbox`/`openMailbox`, `mailboxTag`). |
| `packages/display-name` | Deterministic anonymous name from an id (`adjective.material.creature`), FNV-1a + mix32 hashed. The per-pack cache is emptied at 4096 entries (`DISPLAY_NAME_CACHE_LIMIT`). |
| `packages/avatar` | Deterministic SVG avatar from an id. Three modes: `face` (SVG template), `initial`, `pattern`. OKLCH colour derivation with WCAG contrast fixups. Has a standalone `demo/`. |
| `packages/qr` | Dependency-free QR encoder + SVG/terminal renderers and payload helpers. |
| `packages/tui` | `@loam/tui`, the `loamnet` terminal UI (no dependencies: alternate screen, raw keys, ANSI). Screens Join (QR kept on screen; `o` = open as admin via a one-time code, retired when the panel closes or after 10 minutes, and a second `o` while one is opening is ignored), Activity (pino log lines → `createLogBook`), People (make admin), Settings (live config via the host API; `cli.json` startup settings; the Model dialog opens only if Settings is still showing with no dialog up), Debug (its diagnostics redaction also covers `address:port` and `[v6]:port`, and drops every URL's query and fragment). Local links (`local-link.ts`: `localLinkHost`, `localOrigin`) use the port the server listens on (`LaunchInfo.listenPort`, not the advertised `CLIENT_PORT`) and an address it listens on (`listenHost`): `127.0.0.1` for a wildcard (`0.0.0.0`, `::`, unset), `127.0.0.1` or `localhost`, `[::1]` for `::1`, otherwise the listen host itself (bracketed when IPv6), never `localhost`; kiosk mode (scrypt-hashed password, backoff). Drives the node ONLY through the in-process host API (`LoamApp.host`, `HostApi` in `@loam/schema`, server `host-api.ts`). All text from others goes through `clean()` (no control chars reach the terminal). |
| `scripts/dev.ts` | Root dev launcher: prints a join QR + LAN URL, spawns server and client. |

## Commands

```bash
pnpm install          # install workspace deps
pnpm dev              # root: runs server + client together, prints join QR (see ports below)
pnpm build            # pnpm -r build: builds all packages, then server (tsc) and client (tsc -b && vite build)
pnpm test             # pnpm -r --if-present test (vitest in the 6 packages + apps/server + apps/client + apps/app + apps/desktop), then test:scripts (node --test over scripts/ and cli/test/)
```

There is **no lint script**. Type-checking happens as part of `build` (`tsc`), except `apps/app`,
which has a dedicated `typecheck` script (`pnpm --filter app typecheck`), `apps/desktop` (`pnpm --filter @loam/desktop typecheck`: main/preload/shared and the renderer, two `tsc` projects; a CI step), and the server's test files, which
`pnpm --filter @loam/server typecheck:test` checks (`tsconfig.test.json`; a CI step). A root `.editorconfig`
records the formatting. CI (`.github/workflows/ci.yml`) runs `node
scripts/check-versions.mjs` (every workspace `package.json`, `cli/package.json` and `app.json`
`expo.version` must agree), `pnpm build`, `pnpm test`, the apps/app and server-test typechecks, `pnpm audit --prod
--audit-level=high` (four advisories with no usable fix, three via Expo's CLI (picomatch's `GHSA-fc5q-39xc-vjpf` has no fixed release) and one via expo-router, are listed in `pnpm-workspace.yaml` `auditConfig.ignoreGhsas`),
then `pnpm smoke:cli` (packs + installs `loamnet` and drives the installed `loam`: port fallback, taken `--port`, `--encrypt` + reopen) on push/PR to
`master` (a newer push to a PR cancels the older run). `build-apk.yml` (tag builds) pins every action to a commit SHA, runs `check-versions
--release-tag vX.Y.Z[-rc.N|-beta.N]` (the tag's X.Y.Z == version, `versionCode` > every earlier release
tag's; a suffixed tag is published as a GitHub pre-release; tests in `scripts/check-versions.test.mjs`, run
by the root `pnpm test` via `node --test` along with `cli/test/`), build + test +
typecheck, then signs; an `attest` job records build provenance for the APK and AAB
(`actions/attest-build-provenance`), and a separate least-privilege release job attaches the APK with
`loam-host.apk.sha256` beside it. Tag builds also run `pnpm --filter
app aab` and upload the Play bundle as the `loam-host-aab` workflow artifact (never attached to the
Release). `build-desktop.yml` (the same `v*` tags, or manual) builds the desktop installers on native runners (`LOAM-mac-arm64.dmg`, `LOAM-mac-x64.dmg`, `LOAM-win-x64.exe`, `LOAM-linux-x64.AppImage`, `.deb`), smoke-tests the Linux AppImage, attests them and attaches them with `.sha256` files to the same Release; macOS signing uses the Apple secrets (`CSC_LINK`/`CSC_KEY_PASSWORD`/`APPLE_API_*`, set 2026-10-22, so macOS builds are signed and notarized): on a tag the packaging step fails unless `CSC_LINK` and the three App Store Connect secrets are all set, since an ad-hoc signed update can't read the keychain item the signed app made; a manual run keeps the ad-hoc fallback; the API key file is removed by a trap (Windows SignPath still pending). The release jobs of both tag workflows share the concurrency group `github-release-<ref>`, so they publish to the Release one after the other, and `build-apk.yml` sets `ELECTRON_SKIP_BINARY_DOWNLOAD` too. Dependabot (`.github/dependabot.yml`) bumps npm deps (with a separate npm entry for `/cli`, which is outside the workspace and has no lockfile) and the SHA-pinned `github-actions` weekly (1-day cooldown, matching
`minimumReleaseAge: 1440` in `pnpm-workspace.yaml`, so pnpm won't install a release under a day old).

**Tests**: `packages/*` (schema, display-name, avatar, qr, crypto, tui), `apps/desktop` (33 vitest files beside the main-process modules and renderer screens), `apps/server` (`src/db.test.ts` for the
DAL, route suites by subject driving `buildApp()` + `server.inject()` (`admin`, `sessions`, `channels`,
`messages`, `moderation`, `attachments`, `kill-switch`, `db-encryption`, `realtime-privacy`, `transport`,
`sync`, `mesh`, `assistant`… over a shared harness in `src/test-support/app-harness.ts`, whose header maps
the files; `test-support/` is excluded from the build) plus focused suites: `realtime`, `llm`, `mesh-bridge`,
`sync-transport`, `tombstone`, `net`, `embedded`), and `apps/client` (Vitest + jsdom: `src/lib/*.test.ts`
— markdown sanitizer/XSS, IndexedDB round-trips + kill-switch purge via `fake-indexeddb`, route/WS-event
parsers, transport, WS liveness — and a `.test.tsx` suite beside most components in `src/components/`).
Client tests use a standalone `vitest.config.ts` (jsdom + `@preact/preset-vite`, so `*.test.tsx` mount
real components into jsdom); `*.test.ts`/`*.test.tsx` are excluded from the `tsc -b` build. `apps/app`
has its own vitest suite (`src/**/*.test.ts`, included in `pnpm test`); also validate it with `pnpm
--filter app typecheck` (CI runs this as its own step).

## How dev mode wires together (important)

`pnpm dev` (`scripts/dev.ts`) starts two processes:

- **client** — Vite dev server on **:3000** (`CLIENT_PORT`).
- **server** — Fastify on **:3001** (`PORT`), via `tsx watch`.

The browser talks to the client origin. Vite (`apps/client/vite.config.ts`) **proxies** `/api` and
`/ws` to the server at `LOAM_API_PORT` (3001). So in dev there are two origins bridged by the proxy.

In **production** there is one origin: `apps/client` is built to `apps/client/dist`, and the server
serves it as static files (`registerStaticFiles`) with an SPA fallback to `index.html`. Run it with:

```bash
pnpm build && pnpm --filter @loam/server start   # node dist/server.js, defaults to PORT 3000
```

Env vars the server/dev script read: `PORT`, `CLIENT_PORT`, `HOST`, `LOAM_JOIN_HOST`,
`LOAM_DATA_DIR`, `LOAM_CONFIG_FILE`, `LOAM_CLIENT_DIST`, `LOAM_VERSION`, `LOAM_DB_KEY` /
`LOAM_DB_ENCRYPTION_MODE` (at-rest encryption), `LOAM_DEV_MODE` (see Developer Mode), `LOAM_API_PORT`
(client), `NODE_ENV` (`production` refuses Developer Mode; the cookie's `Secure` flag follows the real
request protocol, not `NODE_ENV`).

## Data model & the schema contract

`packages/schema` is the source of truth for wire types. Both ends validate with Zod:

- **Message** is a discriminated union on `type`: `channelPost`, `channelReply`, `dm`, `reaction`, and
  `sealed` (mesh mail, see the mesh paragraph above). Posts, replies and DMs may carry an optional
  `location` (`MessageLocationSchema`, coordinates; a message may be location-only), which `createMessage()`
  refuses unless `features.enableLocationSharing` (default off; `NetworkConfig.enableLocationSharing`).
  A `channelReply`'s parent must be a `channelPost` in the same channel (a reply to a reply, or to a post in
  another channel, is refused with `parent_not_found`, so a reply can't test whether an id exists in a channel
  the caller can't see; there is no `parent_wrong_channel`);
  `collectDeletionSet` still follows `parentMessageId` chains to any depth for rows an older build wrote.
  A separate `MessageCreateRequest` union is what clients POST (server assigns `id`, `authorId`,
  `createdAt`, `meta`).
- **Channel** carries `visibility` (`public` | `private`) and, for private channels, `memberUserIds`
  (the invite-only roster; the owner is always an implicit member). `ChannelCreateRequest` accepts
  `visibility`; `ChannelMemberAddRequest` is the invite payload.
- **User**: `{ id, displayName, avatar?, type: human|bot|system, isAdmin, createdAt, ephemeral }`.
  `avatar` is either generated (`seed`+`mode`) or an uploaded `image` (`imageId`+`mimeType`; `imageId`
  must be exactly `avt_<16hex>`).
- **Ids**: every record id on the wire goes through `IdSchema` (max `ID_MAX_LENGTH` = 128), so a client or
  sync peer can't persist megabyte ids.
- **StreamEvent**: `start | delta | end | error` — the LLM streaming protocol over the WebSocket.
  Deltas carry only the new text (sent just to the DM participants); the final complete message is
  persisted and broadcast once via `messageUpdated`, so non-streaming clients still converge.
- **NetworkConfig**: feature flags sent to the client from `/api/config` and the public, cookie-free
  `/api/bootstrap` (everything `/api/config` returns except `currentUser`; mints no identity), and
  re-broadcast live via the `configUpdated` WS event when an admin edits config. It carries the effective
  node retention (`messageTtlMs`) so clients prune by age. `/api/bootstrap` alone also answers a **loopback**
  caller on an **encrypted** node with `hostNoLocalCache: true` (never in `NetworkConfig`, which is broadcast):
  the `loamnet` operator's own browser then keeps no IndexedDB, like the desktop/Android windows under
  `window.__loamHostNoLocalCache` (`applyHostNoLocalCacheHint` in `lib/local-store.ts`, remembered in
  localStorage `loam.hostNoLocalCache`).
- **LoamConfig / LoamConfigUpdate**: the full node configuration (identity, features, llm, admin
  bootstrap, security profile) and its PATCH shape — shared by the server config loader, the
  `/api/admin/config` endpoints, and the client admin UI.

**Gotcha — build the schema package after editing it.** The server imports `@loam/schema` which
resolves to the compiled **`dist/`** (`package.json` `main`). `tsx watch` does *not* rebuild the
package, so schema edits are invisible to the running server until you rebuild it
(`pnpm --filter @loam/schema build`, or `pnpm -r build`). The **client** imports the same packages
via **Vite aliases to `src/`** (see `vite.config.ts` / `tsconfig.app.json` `paths`), so it picks up
edits live. This asymmetry applies to all `packages/*` (schema, avatar, display-name, qr).

## Server architecture (`apps/server/src/`)

`buildApp()` in `src/app.ts` (~2.75k lines) is the composition root plus the domain core (session identity,
users + moderation policy, channels, messages, the reapers, static files). Everything else is a sibling
module (2026-09-04 split of the former 9.4k-line monolith):

| Module | Owns |
|---|---|
| `app-context.ts` | `AppContext`, the composition seam: accessor-backed views of `buildApp`'s mutable state (`appConfig`, `data`, `store`, `adminSetupCode`, the wipe counters…), the shared containers, the subsystems, and every domain helper with its signature. `buildApp` builds one, hands it to every module below, and a compile-time check asserts the assembled object is complete. |
| `runtime.ts` | `Runtime`, the smaller live view handed to `llm.ts` / `mesh.ts` / `sync.ts`. |
| `store-lifecycle.ts` | Opening the DB under the resolved key (passphrase-derivation migration, unreadable / plaintext-unconverted recovery, the start-fresh marker), the durable wipe journal, boot-time wipe resume, `persistConfigForRestart`. |
| `kill-switch.ts` | Emergency Reset: the single-flight wipe, ephemeral-key rotation vs the fixed-key launcher handoff. |
| `transport-server.ts` | Host transport identity, sessions + replay windows, the internal tunnel token, request-auth helpers (`requestFromLoopback`, `syncPeerAuthorized`…), the global hooks + rate limiter, and the handshake / resume / logout / tunnel routes. |
| `realtime.ts` | Sockets, audience filtering, sealed WS frames, presence, and `/ws` with its key-confirmation. |
| `sync.ts` · `mesh.ts` · `llm.ts` | The node-to-node sync engine; the sealed-mail mesh layer; the LLM assistant. |
| `routes-session.ts` · `routes-users.ts` · `routes-channels.ts` · `routes-messages.ts` · `routes-sync-mesh.ts` · `routes-admin.ts` | REST routes by domain (users also covers moderation, reports, join approval, typing, attachments). |
| `config.ts` · `secrets.ts` · `identity.ts` · `media.ts` · `ids.ts` · `defaults.ts` · `errors.ts` · `types.ts` · `boot-bridge.ts` | Pure helpers with no closure state. |

Conventions for the modules: bodies reach shared state only through `ctx.<name>` (or `rt.<name>`), never a
captured copy — the mutable members are accessors, so `ctx.data = …` lands on the live binding. A new
helper that routes need goes into `AppContext` (with its signature) and the `base` literal in `buildApp`;
the completeness check fails to compile if a member is declared but never provided. The route test suites
still drive everything through `buildApp()` + `inject`, so the split is invisible to tests.

- **Storage**: reads are served from in-memory arrays (`data.users/channels/messages`) + a
  `sessions` Map; every mutation **writes through synchronously** to SQLite (`.loam/loam.db`, WAL
  mode) via the DAL in `src/db.ts` (`LoamStore`). `openStore(path, { encryptionKey })` selects the
  driver: default `node:sqlite` (ExperimentalWarning is expected; no native dep), or
  **better-sqlite3-multiple-ciphers** (SQLCipher, **encrypted at rest**) when a key is passed —
  lazy-`require`d, so only encrypted deployments load the native module (it's in
  `pnpm-workspace.yaml` `onlyBuiltDependencies`). Set via `buildApp({ dbEncryptionKey })` ←
  `LOAM_DB_KEY`; encrypted stores need a file path, not `:memory:`. After every keyed open the store
  checkpoints and `assertNotPlaintextSqliteFile` refuses a file that starts with the plaintext SQLite
  header (a codec-less driver build silently ignores `PRAGMA key`). Every store sets `PRAGMA temp_store =
  MEMORY`, so SQLite's temporary files (a large sort's spill, which the SQLCipher driver wrote unencrypted
  to the OS temp directory past about 16 MB of messages) never reach disk. **Fail closed**: an encrypted mode
  whose SQLCipher driver won't load never falls back to plaintext — the Android launcher locks with
  `db_encryption_driver_missing` (Retry, or a confirmed "Start without encryption"), the `loamnet`
  CLI probes the driver before prompting or booting, and the server itself (`store-lifecycle.ts`) raises
  the same fatal code when a keyed open fails and the driver won't load (no recovery chain; the embedded
  runtime stays alive to report it). A failed keyed open on a node with no prior database removes what
  the open created and rethrows, and the plaintext probe only runs on a file with the plaintext header —
  so a failed keyed open never leaves a plaintext file behind. (The pre-0.2 flat-JSON
  importer is gone: no released version wrote those files.) A stored user/channel/message row that no longer validates (e.g. an id an
  older release wrote past `ID_MAX_LENGTH`) is never fatal: a safe in-memory repair is applied when one
  exists (unusable avatar id dropped, invalid private-roster entries dropped, over-long `meta.model`
  truncated); otherwise the row is **quarantined**: not loaded, left on disk, its id in
  `store.quarantine()` (`ctx`/`rt.quarantine`), with messages under a quarantined channel/message
  quarantined too. No path may claim a quarantined id: the DAL writes throw `QuarantinedRowError`;
  seeding, channel-slug allocation, sync channel/author import and session minting skip it; quarantined
  message ids join the in-memory tombstone set. The retention reaper still deletes (and tombstones) expired
  quarantined message rows, read straight from disk. Open reports that fail `ReportSchema` are skipped and
  counted, and a quarantined user's mesh identity isn't loaded. One boot warning gives the counts (docs/01). `config.json` and the `avatars/` dir remain plain files. On POSIX `avatars/` and `attachments/` are 0700 (set again before every store open attempt, so a locked database or one that needs the legacy-key migration gets it too; an existing start-fresh recovery folder is set to 0700 on resume) and every media file is written 0600, so a data dir the operator made 0755 doesn't expose them; an existing data dir and an operator's own `config.json` keep their modes. There is no
  `markDirty`/flush interval any more — call the matching `store.*` method after mutating in-memory
  state, then `broadcast(...)`. `.loam/` is gitignored.
- **Sessions/identity**: two modes (docs/20). **Anonymous** (plaintext or `optional` without a pinned
  key): `getSessionUserId` reads the `loam_session` cookie; if absent it mints a `user.<16hex>` id (64
  random bits, retried until it collides with no user or session — `mintSessionUserId`) + a 256-bit
  base64url token and `Set-Cookie`s it (HttpOnly, SameSite=Lax). **Bound** (a QR-pinned client): a
  sealed `POST /api/session/resume` with a separate identity token promotes the transport session; its
  identity is the session key, never a cookie, and content is reachable only through the tunnel. A repeat
  resume on a bound session returns the same token but the user record as it is NOW (a claim or approval
  since binding must not be undone by the client's next boot pass). The
  client's locally generated id is a pre-hydration placeholder replaced by the server-confirmed
  `currentUser`. No route leaves a minted cookie without a user row: `POST /api/messages` creates the
  caller's record and answers a banned or pending caller 403 before the assistant's 409 and 429; `/ws`
  refuses a session whose user record doesn't exist. `POST /api/session/end` closes that identity's sockets that aren't on a bound
  transport session (admitted and mid-challenge) once no cookie session still maps to the user.
- **Admin**: comes only from the config-selected **bootstrap strategy** (`admin.bootstrap`):
  `firstUser` (default — the first session on a fresh node becomes admin), `setupCode` (a one-time
  code logged at startup, exchanged via `POST /api/admin/claim`, rate-limited + constant-time
  compared), `passphrase` (same endpoint, reusable secret from config), `hostDevice` (the Android
  host: the launcher mints a per-boot token — `LOAM_HOST_TOKEN` → `AppOptions.hostToken` — which
  forces this strategy as a read-time projection over the persisted one; only a claim presenting that
  token becomes admin, and only from loopback (from any other address it is a wrong secret and counts
  against the attempt limiter), and only the host's own WebView receives it, injected as
  `window.__loamHostDeviceToken` (never in a URL: anyone can craft one), so no LAN session can take
  `firstUser` during the boot window), or
  `none`. A successful claim persists `{isAdmin, pending:false}` (the reply is the `rolesVisibleUser` projection), so on an approval-policy node the
  claimer is an active admin. **`loamnet` mints a host token too** (`cli/bin/loam.js`), so it is always
  `hostDevice`: admin comes from the terminal UI's one-time claim codes (`admin-links.ts`: single-use,
  10 min, in memory, cleared by the kill switch; the local code the "Open as admin" panel opens is retired
  when the panel closes, and its link and every local link use the port the server listens on (never the
  advertised `CLIENT_PORT`) and `127.0.0.1` (or the one address it listens on; `packages/tui`
  `local-link.ts`), never `localhost`, which can resolve to `[::1]`, where another account could listen (open
  gap: with `HOST=localhost` the links use `127.0.0.1`, but Node may bind `[::1]` for that name); the claim route accepts one under `hostDevice`; the client
  reads `#…&a=<code>` in `lib/admin-link.ts`; a banned caller can't use one, an admin caller spends it), its
  People screen (`host.makeAdmin`), or plain mode's admin link (`cli/bin/admin-link.js`; printed on a TTY,
  else `admin-link.txt` 0600 in the data dir, never the log; a leftover file is removed at start, none is
  minted mid-reset, re-offered after a reset). The **host API** (`LoamApp.host`, `host-api.ts`) is in-process only (status, config
  via the shared `applyConfigUpdate`, `promoteUser`, link/invite/claim codes, join host, log level,
  Emergency Reset); never expose it over HTTP. The legacy demo users `user.1234`/`user.5678` are **deleted at boot** (their
  messages tombstoned via the normal delete path, sessions/identity tokens purged); a fresh node never
  creates them. Admin-only endpoints check `currentUser.isAdmin`; client gating is cosmetic.
- **Config**: layered defaults ← `config.json` ← DB-persisted admin edits (`config` table), all
  validated against the shared `LoamConfigSchema`. `PATCH /api/admin/config` merges, persists,
  hot-reloads, and broadcasts `configUpdated`. Feature flags are **enforced server-side** in
  `createMessage()`. Secrets (`admin.passphrase`, `killSwitch.panicToken`) are stored
  **scrypt-hashed** (`scrypt:<salt>:<hash>`) — plaintext from a config file or PATCH is hashed at
  merge time and verified with `verifySecret()`; never store or compare them in the clear.
  `security.transportEncryption: "off"` is refused by PATCH (400); an `"off"` in `config.json` or a
  persisted DB row is coerced to `"optional"` with a warning (`sanitizeLegacyConfigJson`, which also
  repairs a legacy bot id / over-long bot name / over-long model label, so an upgrade never fails boot). The launcher-owned
  `llm.onDevice` block is the exception to "DB wins": when `config.json` carries it, it is
  authoritative (the launcher's model activate/deactivate writes there), so an admin save can't freeze it;
  an admin PATCH that changes `llm.onDevice` is then written through to `config.json` (durably, other keys
  kept; a failed write refuses the save with a 500) so it survives a restart.
- **Rate limiting**: our own fixed-window limiter (`src/rate-limit.ts`, which replaced `@fastify/rate-limit`)
  runs globally (300/min/IP; IPv6 keyed by /64 via `rateLimitKey`, IPv4-mapped folded to IPv4) with per-route caps on uploads,
  sync, mesh, search, claim and panic via `config.rateLimit`; those per-route configs set `allowList: () => false` so tunnel
  re-dispatches (exempt from the global limiter) still count. The tunnel route itself has its own budget (`TUNNEL_REQUESTS_PER_MINUTE`, 1200): a code-joined member sends every request through it, one per picture, and under the shared 300 a channel of pictures locked them out for a minute. Claim/panic add their own semantic attempt
  limiters on top. Claim and panic (route limiter `perAddress: true` and the attempt limiters) and the WS
  pre-auth cap count each address on its own (`addressKey`), with a coarser per-/64 bound, so one IPv6 LAN
  device can't lock the rest out. The attempt limiter (`attemptRateLimited`) checks the /64 bound first and
  refuses a spent /64 without counting or creating an address entry. Invite redeem's route limiter is `perAddress: true` too (the code is 128 bits). A route's own `config.rateLimit` replaces the global limiter for that route, it does not add to it. It sends no `x-ratelimit-*` headers (they fingerprinted the panic route); a
  default refusal is a 429 with `retry-after` and `code: "rate_limited"`.
- **Logging**: tunnel re-dispatches are never request-logged (`loamLogController`, keyed on the
  internal token, since the inner URL is the path the tunnel hides), the `req` serializer (`loggedRequest`)
  logs the matched route pattern (`/api/dms/:userId`), `[page]` for anything the client build serves,
  `[unmatched]` or `[tunnelled]`, never the concrete path or query, a pino `logMethod` hook (`redactLogText`) drops the URL from Fastify's own
  double-send warnings and query strings from any other message text, and a 5xx inside the tunnel is logged
  path-free on the outer request.
  Unhandled errors return a generic 5xx body (`internal_error`); the detail goes to the log only. An
  assistant backend failure logs only the provider and HTTP status (or a stream error, or a non-JSON line)
  at error level; the backend's own text, cut to 200 characters, goes to debug only.
  `AppOptions.logStream` lets tests capture output.
- **Ephemeral messages** (off by default; `retention.messageTtlMs`): a 30s reaper (+ boot sweep)
  deletes expired messages and broadcasts `messageDeleted`; streaming LLM messages are spared until
  complete. A channel's own `messageTtlMs` is **admin-only** on `PATCH /api/channels/:id` (an owner sending
  it gets 403 `admin_required`) and can only **shorten** retention: the reaper applies
  `min(channelTtl, nodeTtl)`, so no channel outlives the node-wide TTL; with the node TTL off a channel TTL
  stands alone. Clients apply the same rule to what they hold (`lib/retention.ts`, `pruneExpiredMessages` in
  `app.tsx`): the node TTL from `NetworkConfig.messageTtlMs` (remembered in the `sync` store as `retention`
  for an offline start) and each channel's own, at hydration, on a TTL/channel change and every 60 s, with
  "now" = max(the node's clock as estimated, newest held `createdAt`): `/api/bootstrap` and `/api/config` carry `serverTime`, and `noteNodeClock`/`nodeNow` (`lib/retention.ts`) keep the difference from the device clock (remembered with the TTL), since every `createdAt` is the node's stamp and a host's clock can be hours off (a Pi has no battery clock).
- **Kill switch** (off by default; `killSwitch.enabled`): `executeKillSwitch()` deletes avatars,
  invalidates sessions, broadcasts `wipe` (clients purge IndexedDB/localStorage/SW caches and show a
  neutral disconnected screen), closes sockets, and re-seeds defaults. Config survives. The data
  wipe depends on encryption: **encrypted** (`LOAM_DB_KEY` set) → close store, delete DB files, and
  (ephemeral mode) rotate to a fresh key — a cryptographic wipe that makes flash remnants
  unreadable; the store is reopened so `app.store` is a **getter**, not a snapshot. **Unencrypted** →
  `store.wipeAll()` + `VACUUM` + checkpoint (the `config` row is rewritten only if one existed; a node set up by `config.json` alone gets just `{sync:{enabled:false}}`, and only when sync was on, so the file is still read afterwards) (plaintext stores run `PRAGMA secure_delete`, so the file keeps
  no deleted text, but it is **not** secure erasure on flash — docs/02). Every branch also sweeps
  `.loam-recovery-*` snapshots (a start-fresh's moved-aside DB + media): fail-closed in the encrypted
  branches, best-effort (warns on a survivor) in the plaintext one. A client that was offline during the
  wipe purges its cache on reconnect, because its server-confirmed identity changed (`lib/identity.ts`),
  but only at the same origin: a copy under an earlier address (a hotspot address that changed after a
  phone reboot, a stepped port) is never reached. A linked node keeps its copy of this node's public
  channels, which comes back once sync is turned on again (every branch pauses sync, below); the
  `loamnet` admin's own browser on an unencrypted node (an encrypted one tells a loopback browser to keep no
  copy, `hostNoLocalCache`) and OS backups aren't reached either
  (docs/02 "What a reset does not reach"). Optional unauthenticated panic token (`killSwitch.panicToken`)
  fires it via `POST /api/panic`, only while `killSwitch.enabled` is on. Panic attempts are counted whether
  or not a token is set, a caller over the attempt limit gets the uniform 404 before any scrypt, and scrypt
  runs only for attempts the limiter lets through (against a stand-in hash on a node with no token). The
  route records the wipe generation before scrypt; if a reset started or finished meanwhile it joins or
  reuses that reset (`ctx.latestWipe`, the most recent `executeKillSwitch` promise, never cleared), so two
  overlapping valid requests start one reset. A wipe result's `journaled` is false once the journal has been
  cleared. Every branch runs its in-memory
  lockdown before its first await (mirrors, sessions, identity tokens, transport sessions, peer and mesh
  state cleared, `wipe` broadcast, sockets closed), and a `preHandler` hook answers 503 to any request,
  tunnel re-dispatches included, while the gate is up or when a reset has started since the request was
  admitted (the wipe generation recorded in `onRequest`; `/api/health` exempt), so a request admitted
  before a reset can't write after it. `wipeAll()` also deletes the stored transport key
  (`transportIdentity` config row), so a power cut after a plaintext reset can't bring the old join QR
  back. Everything
  after the synchronous 503 gate runs in one try/catch: a throw (`wipeAll`, the reopen, `loadData`) goes through
  `lockDownAndReportIncomplete` and answers `{ complete: false }` (503, `wipe` broadcast, node locked), never a
  500. Every branch (plaintext and ephemeral too) writes the wipe journal (`.loam-wipe-phase`: intent + sanitized
  config) before its first destructive step, the in-process branches clear it after `loadData()`, and the boot-time
  resume (`resumeWipePhaseThenOpenStore`) finishes an interrupted wipe (delete DB files + media, restore
  config.json, fresh store) before serving, in-process on any node without a fixed device key, so a restart
  never serves pre-wipe data. **Every branch pauses sync** (`pauseSyncForReset`: `sync.enabled: false`, peers
  and, in-process, the token kept; the restart snapshot strips the token), since the wipe empties the tombstones
  and provenance and a linked peer would hand every public post back next round; it leaves a
  `.loam-sync-off-after-reset` note (JSON `{at, hadToken}`) that every boot logs and `GET /api/admin/sync`
  reports as `pausedByReset`, until an admin turns sync on again or removes every peer (`commitAdminConfig`
  clears it). Both
  entry points treat an undeclared real `LOAM_DB_KEY` as `passphrase` (`resolveDbEncryptionMode`), so
  `loamnet --encrypt` takes the journaled fixed-key branch; only a direct `buildApp` embedder with a key and no
  mode reaches the legacy branch.
- **Broadcast filtering**: `broadcast()` sends to all sockets but `socketCanReceiveEvent` restricts DM
  and DM-reaction events to their participants and **everything about a private channel (the channel
  upsert, its messages, and reactions on them) to its members** (`messageAudienceUserIds` resolves the
  member set; empty for a channel message whose channel record is missing); public channel messages and
  `userUpserted` go to everyone, and a recipient with no user record gets nothing but `wipe`. A member removed from a
  private channel gets a targeted `channelRemoved` event via `sendEventToUsers` (clients purge the
  channel + cached messages and navigate away).
- **Private channels**: `createChannelFromRequest` honours `visibility` (`private` requires the
  `enablePrivateChannels` flag; creator becomes owner + sole member). Enforcement is everywhere the
  data flows: `GET /api/channels` filters per-user; `GET /api/messages/:channelId` 404s identically
  for unknown and inaccessible channels (existence is never leaked, and posting as a non-member gets
  the same "Channel does not exist"); member management is
  `GET/POST /api/channels/:id/members` + `DELETE /api/channels/:id/members/:userId` (owner/admin
  invite+remove, self-remove = leave, the owner can never be removed) +
  `POST /api/channels/:id/transfer` (owner/admin hand ownership to another user; the new owner joins
  the private roster if absent, the old owner stays a member). **Node admins get no implicit
  read access** — they manage private channels (rename/archive via `/api/admin/channels`) without
  joining their audience, and can't add themselves: adding a person (invite, join-request approval, or
  transfer to a non-member) needs the caller already in the roster, else 403 `channel_members_only`. A
  non-member admin can still list members and join requests, deny a request, remove a member, rename,
  archive, delete, and transfer to an existing member, so it sees the channel's name, owner and roster
  (docs/12).
- **Search**: `GET /api/search?q=&limit=` — case-insensitive substring over message bodies, newest
  first, scoped to the caller (accessible channels, archived ones included, + own DMs, shadow-ban respected).
- **Attachments**: messages may carry ≤4 attachments (`attachments` on posts/replies/DMs;
  attachment-only messages are valid) — images (256KB, served inline) or allowlisted non-image files
  (1 MiB, stored as `.bin`, served octet-stream + `Content-Disposition: attachment`). `POST /api/attachments` mirrors the avatar pipeline (base64, magic-byte vs
  MIME, 256KB images / 1 MiB other files, rate-limited); ids are uploader-bound and consumed on first use, and the message stores the server's own record of the upload
  (`PendingUpload`), never the client's copy (an upload named more than once in a message is stored once); files served
  from `GET /api/attachments/:fileName` (unguessable ids, 60 random bits; like `GET /api/avatars/:fileName`
  served to anyone who knows the id, by design, with no check that the caller is a member), deleted with their message / kill switch. The
  orphan sweep re-checks live messages/owners right before each delete and gives owner-less files an
  mtime grace window, so it can't race an in-flight upload. A stored (and downloaded) file name has
  control and format characters removed and ends with an extension that fits its declared type
  (`update.apk` declared `text/plain` becomes `update.apk.txt`).
  Clients downscale to ≤1280px on-device first (`apps/client/src/lib/attachments.ts`, through
  `lib/image-encoding.ts` `encodeCanvasUnderLimit`, where a result counts only when its type is the one asked
  for): WebP 0.82, 0.72, 0.6, then PNG, then WebP 0.6 at 75% and 50% size; where the browser can't write WebP
  (Safari, every iOS browser) JPEG over a white background at 0.82, 0.72, 0.6, then at 75% and 50% size. The
  avatar editor uses the same encoder (WebP, then PNG; without WebP, PNG, then JPEG).
  `enableAttachments` flag, default on.
- **Network identity & presence**: `node.name` (default "LOAM local") is the operator-set network
  name in `NetworkConfig.nodeName` (client sidebar/join/tab title), editable via the admin Network
  panel. `enablePresence` (default on) makes the WS broadcast a `presence` event (online user ids,
  visible users only) whenever a connect/disconnect changes the online set (a socket that changes nothing
  is told on its own) — the client shows online dots; disable for high-risk deployments (it reveals who
  is connected). **Socket caps** (`realtime.ts`): admitted + mid-challenge sockets are capped at 16 per
  identity, 64 per address, 256 per IPv6 /64 and 1024 in all (`AppOptions.webSocketLimits` for tests); a
  connect past one is refused with a `too_many_attempts` error frame, never by closing an older socket. A
  socket with over 1 MiB unsent (`WS_MAX_BUFFERED_BYTES`) is terminated. `commitAdminConfig` closes every
  socket not on a bound session when the effective mode becomes `required` (`closeUnboundSockets`).
- **Admin promotion**: `POST /api/admin/users/:userId/promote` (admin-only) makes a member admin.
  Deliberately **one-way** — no demote route; admin removal is via re-bootstrap / kill switch, so a
  contested node can't fall into a mutual-demotion fight (see docs/12).
- **Node-to-node sync** (docs/11): `sync.{enabled,peers,intervalMs}` config; pull-based gossip of
  **public data only** via `GET /api/sync/digest` + `POST /api/sync/messages` (404 unless enabled).
  DMs/private channels/shadow-banned authors never export, and exported author records lose `banned`,
  `pending` and any uploaded-picture avatar too (`syncExportUser`; the file never syncs). Requests to a peer never follow a redirect (a 3xx fails the request). Imports are defensive (public-local
  channels only, users stripped of authority, edits only when newer, **only of a message this node
  imported** (`synced_messages` provenance — a peer can't rewrite a local user's post), never of a
  moderator-removed message nor a new reply/reaction under one (local moderation is sticky), **and only of the same message** —
  same arm/author/timestamp/routing, so a peer can't re-type a private id into the public flow — a
  message naming an attachment id another local message or pending upload owns is refused, attachments
  copied best-effort). Only the **author of an accepted message** is imported as a user (never every user
  in the payload), and `mesh.*`/`llm.*` ids and non-human author records are refused as users and as
  authors; an imported author loses `timeoutUntil` (`importPeerAuthor`). It never keeps an uploaded-picture
  avatar (one would name a missing file or a local person's, and keep it on disk and served after they
  changed it), a generated avatar whose seed breaks the local seed rule is dropped, and its name is stripped
  of control and format characters and replaced by the generated name for its id when it is empty or reads
  as another record's or the active assistant's (with part of the id added when that generated name is itself
  taken, `freeGeneratedName`; the shared rules in `identity.ts`:
  `displayNameTakenByOther`, `avatarSeedImpersonates`, `avatarNamesImage`, `activeAssistantName`). At boot
  `stripSyncedAvatarImages()` (in `loadData`) removes uploaded-picture avatars from synced users' rows an
  earlier build wrote. A post or reply with a location is refused while
  `enableLocationSharing` is off, one with attachments while `enableAttachments` is off, and a reaction on
  a reaction always. Local
  deletes write **tombstones** (DB table) so peers can't re-import them. Pulls are bounded: 200-id public
  / 40-id sealed batches under an 8 MiB response cap (the sealed cap allows for the 4/3 envelope), at
  most 4 000 public / `mesh.maxSealedPullPerRound` (default 80) sealed ids per round, and a batch that is
  too large or fails the schema is bisected down to the offending id — within a per-round budget of
  `2 × batches + 16` extra requests and 32 MiB of unusable bytes, past which the peer fails the round; a
  too-large answer shrinks that peer's batches. Public offers fetched and refused are remembered per peer in
  RAM (id + version, 1 h TTL, ≤20 000 per peer) so they aren't re-downloaded every round; the kill switch,
  every admin config save and a channel `archived`/`allowPosting`/`allowReplies` change forget them
  (`sync.forgetRefusedOffers()`), so the next round refetches.
  Every import check (`vetPeerImport`) runs again right before commit, after the attachment awaits, so a
  moderator removal/delete/archive/parent removal made mid-flight wins and the discarded import's files are
  deleted; a batch imports only the ids it requested, under the list it requested them on.
  The sealed puller fetches every admissible sealed offer (soonest expiry first), never just its own
  tags, so a serving peer can't learn where a recipient lives; every sealed id it fetched or took in over
  the radio bridge goes in the durable `sealed_offers_seen` table (keyed by id, with the mail's replay key
  alongside, kept tombstone horizon + 7-day TTL max + 2 days from intake, so it outlives any tombstone) and
  is skipped on **both** digest lists (with tombstoned and `sealed.` ids; sealed offers must be `seal_…` ids
  and public records may not, so the lists never share an id), whatever its outcome; mail whose replay key
  was seen is never carried, and a hop-spent copy taken in while relaying with room marks only its id (only the kill
  switch clears the record; ≤200 000 ids, ≤50 000 per source, then no new sealed pulls from that source, and
  the radio bridge refuses new blobs). A round imports its fetched sealed batches only after the whole sync
  loop's requests are done, and `/api/mesh/inbound` answers `{ ok: true }` whatever became of the blobs. With
  relay off and no local mesh identity it pulls no sealed mail. `sync.token` never rides a plaintext pull
  (unless this node itself is in Developer Mode); a `required` node refuses plaintext pulls; a peer that
  negotiated encryption this boot is never silently downgraded. Admin: `GET /api/admin/sync`,
  `POST /api/admin/sync/run`, and the admin-UI peers panel. A peer's join URL is its sync address.
  **Linking nodes** (`sync-links.ts`): only through a single-use, 10-minute link code an admin
  (`POST /api/admin/sync/link-code`, web admin "Link another node") or the host phone
  (`POST /api/host/link-code`, launcher-only; share screen "Link another LOAM node") chooses to show, as a
  QR `#k=<key>&l=<code>`. The new node (Android setup "Join another LOAM network", expo-camera; it accepts
  nothing else) starts with that peer pinned and `linkCode` set, and presents the code in a **sealed**
  `POST /api/sync/link {code, port, transportKey, name}`; a valid code adds the asker as a pinned peer
  (source address + port, loopback refused), turns sync on (shared `commitAdminConfig`), and returns the
  node's name + `sync.token` (a responder with no token and no other peer **mints** a 32-byte one on that
  fresh link, so a code-linked pair never runs open sync; the admin Sync panel warns when sync is on with no
  token); the asker then drops the spent code (an answer that comes back after an admin
  turned sync off or removed/changed that peer is ignored, so it can't reinstall a token). A repeat of a used
  link request (same address, port and key, a retry of a lost answer) is answered only while sync is on and
  that peer is still listed; otherwise it gets the same 403 as any used code, never the current token. Codes are in memory, ≤4, cleared by the
  kill switch; admin saves can't add or restore a `linkCode`.
- **Security headers**: an `onSend` hook sets `X-Content-Type-Options: nosniff` on every response and
  a strict CSP (`default-src 'self'`, `frame-ancestors 'none'`, no external origins) on the app shell
  (non-`/api/` navigations), whose `connect-src` is `'self' ws://<Host> wss://<Host>` for the request's own
  `Host`, or `'self'` alone for a `Host` the allowlist refuses or one with characters outside letters,
  digits, `.`, `-`, `:` and brackets (`connectSources`). Every `/api/` response (pictures included, on every node) is
  `Cache-Control: no-store`: a page can't clear the browser's HTTP cache, so an Emergency Reset couldn't
  reach what a typed-address joiner's browser cached. No HSTS — LOAM serves plain HTTP on the LAN by design. The session
  cookie's `Secure` flag tracks the real request protocol (`x-forwarded-proto`/TLS), not `NODE_ENV`.
  **Host allowlist** (DNS rebinding): the global `onRequest` hook serves a request only when its `Host`
  (port stripped, IPv6 brackets handled) is an IP literal, `localhost`/`*.localhost`, an mDNS `*.local`
  name, or the advertised join host (`currentJoinHost()`, so `LOAM_JOIN_HOST`/the TUI's pinned address);
  anything else gets 421 `host_not_allowed` before any identity is minted, and the request log replaces a
  non-allowlisted hostname with `[hostname]`. The `/ws` upgrade additionally refuses (403, before the
  upgrade) an `Origin` that isn't `http:`/`https:` on the request's `Host` name and on either the `Host`'s
  port or the advertised `clientPort` (a left-out port is the scheme's default; `originMatchesHost`), since
  cookies are shared across the ports of one host; `pnpm dev` passes because Vite's `/ws` proxy keeps the
  browser's `Host` (no `changeOrigin`). A client that sends no Origin is judged by its credentials alone.
  **CSRF** (`crossSiteRequestRefusal`, same `onRequest` hook, after the allowlist): any method but
  GET/HEAD/OPTIONS is refused (403 `invalid_request`) when its `Origin` fails the same `originMatchesHost`
  rule, or when it has no Origin but a `Sec-Fetch-Site` other than `same-origin`/`none`; a `text/plain`,
  urlencoded or multipart body is refused (415) whatever its Origin, since every route takes JSON. A
  request with neither header (curl, sync peers, the launcher) passes; tunnel re-dispatches never reach it.
  `@fastify/websocket` registers before these global hooks, so an upgrade they refuse (421/503) still has
  its socket closed.
- **Transport encryption** (docs/08, `security.transportEncryption` — `optional` **default (secure by
  default)** / `required`; `off` is no longer operator-settable, see below):
  QR-bootstrapped app-layer session encryption over plain HTTP (no WebCrypto/TLS in the
  insecure-context PWA, so it's `@loam/crypto`: X25519 handshake + XChaCha20-Poly1305). Host static
  key in the join QR `#k=` fragment (MITM-resistant for the protocol; the client's own HTML/JS still arrives
  over plain HTTP, so a LAN attacker who can rewrite the page load is NOT defended against, docs/08 threat 4);
  `POST /api/transport/handshake` derives a
  session; global `onRequest`/`preValidation`/`onSend` hooks transparently decrypt request bodies +
  encrypt responses (aad `METHOD url`). WS frames on `/ws?enc=<sid>&cn=<random>` (after a key-confirmation
  challenge `{ type: "challenge", connectionId, nonce, cn? }`, which repeats a well-formed client `cn`, 16 to
  64 base64url characters; the client sends 22 and refuses a challenge without its own) are sealed under a
  connection-bound aad (`loam.ws.frame.v1 <connectionId>`) inside a `{ q, f }` envelope with a monotonic
  per-connection sequence, so a frame can't be replayed onto another connection. A frame must be exactly the
  previous sequence plus one: a gap closes the socket, and the client reconnects and resyncs with a backoff
  that grows per gap in a row and resets after two clean heartbeats. The client routes all fetches/WS through `apps/client/src/lib/transport.ts`; `off` is a
  pure passthrough. **Anti-replay:** each sealed REST request carries a per-session
  monotonic sequence inside its `{ s, r, b }` envelope (a GET/HEAD carries it sealed in `x-loam-seq`); the
  server enforces a DTLS-style sliding window (`TRANSPORT_REPLAY_WINDOW`), 409 on replay/out-of-window.
  **Response binding** (docs/08): a request target containing `#` is refused with an unsealed 400
  `invalid_request` before the session lookup. The browser client sends `r: 2` in every direct envelope
  (body, GET/HEAD `x-loam-seq`, the sealed resume), and the reply is sealed under
  `"loam.transport.response.v2 " + JSON.stringify([METHOD, url, seq, status])` (a bodyless 204 comes back as a
  sealed empty 200). A refusal sent before the sequence is authenticated carries `enc` (bare `METHOD url`),
  `encStatus` (`METHOD url!status`) and `encStatus2` (`"loam.transport.refusal.v2 " +
  JSON.stringify([METHOD, url, status])`); the client opens only `enc` under the v2 response form and
  `encStatus2` for status >= 400, never the bare forms, and a bare `METHOD url` can't start with `loam.`, so
  no target makes one form read as another. The resume opens only the v2 response form; the client forgets
  its identity token only on a 401 sealed that way for its own sequence. `r: 1` (a tab left open across the
  update) still gets `METHOD url#seq#status`, no `r` the bare `METHOD url`, sync pulls `METHOD url#seq`;
  logout is unchanged. The tunnel envelope is `{ s, r: 2, b }` too, and its reply opens only through
  `openBoundResponse` (the v2 response form for its sequence and the outer status, or `encStatus2` for 400 and
  above), so a reply to one tunnel request can't open as another's and a refusal from the tunnel route itself
  (401, 409, 429) reaches the caller with its real status, not a flat 400; the descriptor's `{ s, m, p }` check
  stays (three tests in `apps/server/src/transport.test.ts` pin the server side). A tunnelled reply with a
  null-body status (101, 103, 204, 205, 304) is rebuilt with a null body. A sealed envelope carrying a `__proto__` key, or a
  `constructor` holding an object with a `prototype` key, is refused with the malformed-envelope 400. Under a
  live session the client refuses any unsealed reply on every path (`UnsealedResponseError`) except the
  pre-session 401/421/503, which reach the caller as status + code only. A client holding a pinned key
  (stored or the launcher's) refuses plaintext fetches, sockets and frames from page load, before
  `/api/bootstrap` answers, and never uses the cookie `/api/config` (one predicate, `plaintextRefused()`; a
  stored pin whose read throws counts as a pin until an `ensureSession` has gone through, and one that threw
  settles nothing);
  every path that drops the transport session tells the socket owner, a socket opened with `enc=` never
  yields a plaintext frame, and no socket is open while the rescan gate shows. A socket reconnect whose
  `reestablishSession()` fails with the pin broken (`isHostKeyPinBroken()`, e.g. an Emergency Reset the
  device slept through) opens no socket and runs the boot pass again (`setSyncTick`), which raises the rescan
  gate. `storeIdentityToken` keeps the token in memory for the page load when `localStorage.setItem` throws;
  `clearStoredIdentityToken`, `apiUrl` and `snapshotForWipe` don't throw on blocked storage. Host keys are canonicalised
  (32 bytes, unpadded, unused bits cleared) where they enter the client (`#k=`, the launcher global, the
  handshake and bootstrap answers) and where the stored pin and a token record's key are read; anything not
  32 bytes counts as absent. A resume answer that arrives after its session was replaced neither stores nor
  clears a token, and `reloadNetworkConfig` drops an answer a live `configUpdated` overtook. After its resume a bound client
  reads `version`, `joinUrl`, `websocketPath` and `networkConfig` from a tunnelled `GET /api/config`;
  `/api/bootstrap` gives it only the mode and advertised key for `ensureSession` and the `hostNoLocalCache`
  hint, and a failed tunnelled read fails the boot pass, which retries. The transport session map evicts, at its cap, the oldest
  session of the largest group (an identity token's bound sessions, or an anonymous source), one with no
  live socket first. One identity token binds at most 16 sessions: past that a bind drops the token's
  idle sessions, and is refused (429) rather than close a live one, since a browser's tabs share the token
  and closing a live tab would make it reconnect and close the next, forever. **Path-hiding tunnel (`required` mode, and
  every bound session):** the client tunnels every request through an opaque `POST /api/transport/tunnel`
  (sealed `{ m, p, body }`), re-dispatched server-side via `server.inject` with an unforgeable per-boot
  internal token (global-limiter-exempt) plus the caller's identity — `x-loam-user` for a bound session
  (never a cookie; an external `x-loam-user` is stripped), the cookie for an anonymous session on an
  `optional` node (under `required` an anonymous session gets 401) — and the
  response sealed back, so paths/queries are hidden too. On a live pinned session the client refuses an
  unsealed tunnel reply (except a GET/HEAD 401, which triggers one re-handshake). **Key pinning:** a `#k=`
  fragment only establishes a pin; a different key is never silently swapped — it is dropped if the pin
  still handshakes, offered (`PinChangePrompt`, both fingerprints, on the rescan gate) only once the pin is
  broken, and acceptable only if it equals the key the node reported. The Android host's WebView is handed
  the node key (`window.__loamHostTransportKey`, injected beside the host token) and adopts it over any
  pin, since an ephemeral-DB-key node mints a new transport key every boot. The bound identity token is stored with
  the host key it was issued under (`loam.identityToken.v2.<origin>` = `{ k, t }`) and is only sealed to a session
  with that key, so a newly accepted key (a pin change, or the launcher's key) starts a fresh identity and a
  different network at the same origin never receives the old one's token; a bare token from an earlier release
  is bound to the stored pin before any pin is replaced. Markdown drops the whole fragment from a message link that
  carries a start-up parameter (`k`, `a`, `i`, `l`), judged after URL parsing, and a client's invite QR carries `#k=` only from its own QR-verified session
  (hidden on an advertised-key mismatch). `optional`
  mode keeps per-route body sealing (paths visible). **Image encryption** (required mode): avatar/
  attachment routes are no longer exempt, so a direct `<img>` GET is 401'd — the client fetches images
  through the tunnel (`encryptedImageUrl`/`useEncryptedImage` → cached `blob:` URL). Encryption follows how
  the client joined: on an `optional` node a client holding the QR key treats the join as `required`
  (`ensureSession`'s `effectiveMode`) and a bound session is tunnel-only, so code joiners get images sealed
  too; only a typed-address client (and Developer Mode) loads images in clear. That client's cookie is also
  a plaintext header, so a passive listener can replay it as them (docs/08, docs/20 §12); the public copy
  says so. So required mode leaves "a tunnel request happened" + ciphertext size/timing, the page load
  (`GET /` and the build's files, since routes live in the fragment), `/api/bootstrap` and the handshake,
  and the path of an old path-form
  address or outside link opened once before the client rewrites it, as wire metadata. `required` is what `hardened` forces; `open`/`standard` both force `optional` (with
  identical enforced axes they now differ only in intent). **The Android host always requires it:** main.js
  sets `LOAM_REQUIRE_TRANSPORT_ENCRYPTION=1` → `AppOptions.requireTransportEncryption`, a read-time projection
  (like Developer Mode's, which still wins) that makes `effectiveTransportEncryption()` `required` whatever the
  profile; on such a network `llmProviderRefusal` also refuses a plain-`http://` assistant that isn't loopback
  (`llm_unencrypted_not_allowed`, models endpoint `llm_unencrypted`, no redirects; only a save that introduces
  or changes a refused backend is refused, and the redacted admin config's read-only `llm.refusal` code tells the
  Assistant panel why it is off; `*.localhost` names never count as loopback or local), so Play's Data safety can
  say "encrypted in transit" (docs/30). Desktop and `loamnet` keep the profile's mode. **Secure by default:** a fresh node defaults to
  `optional` — seamless because a QR-joiner (the normal path) gets the `#k=` key and encrypts automatically.
  Be precise about the guarantee: `optional` makes the **QR-join path** encrypted-by-default, but a client
  that skips the QR (a manually-typed URL, curl) can **still connect in plaintext** — `optional` accepts
  both. `required` is what refuses plaintext clients outright. So `optional` closes *accidental* plaintext
  for normal joiners at zero UX cost, without breaking odd clients; `required`/`hardened` is the strict
  posture. The client reads `#k=` (`captureJoinKey`, `main.tsx`) before the router's `/` → `/channels`
  redirect can drop the fragment. **`off` is not an operator-settable posture**: it's absent from the default, the profiles, and
  the admin UI. The ONLY plaintext-everything path is **Developer Mode** — see below.
- **Developer Mode** (`LOAM_DEV_MODE=1`): forces the *effective* `transportEncryption` to `off` and turns
  on verbose (`debug`) server logging, so wire traffic is inspectable while debugging. The override is a
  **read-time projection** (`effectiveTransportEncryption()` = `devMode ? "off" : configured`), NOT a
  mutation of `appConfig` — so the persisted config always keeps operator intent and a dev-mode PATCH/kill-
  switch can never bake plaintext into a later non-dev run of the same data dir. **Activation condition:**
  `LOAM_DEV_MODE` is `1` or `true` (or the test-only `AppOptions.devMode`), **and** `NODE_ENV !==
  "production"` — it logs an error and stays encrypted otherwise. The **Android host can never
  run it**: its bundle entry (`embedded-main.ts`) defaults `NODE_ENV` to `"production"`, so a shipped APK
  refuses dev mode regardless of env. On a desktop/Pi, plaintext requires an operator to *both* set
  `LOAM_DEV_MODE=1` *and* not set `NODE_ENV=production` (`loamnet` defaults it to `production` before
  loading the server, so there it takes an explicit non-production `NODE_ENV`, and an inherited
  `LOAM_DEV_MODE=1` alone does nothing). That is a deliberate act, not an accident (you can't set an
  env var by mistake), and one that self-announces. It is **self-announcing**: `NetworkConfig.devMode` is
  reported to every client, which shows a persistent red "messages are unencrypted" banner (`.dev-mode-banner`
  in `app.tsx`) + a console warning. This reconciles "keep an encryption-off path for debugging" with "secure
  by default, no silent plaintext."
- **REST endpoints**: `GET /api/health` (liveness, mints no identity — the Android launcher probes
  this so it can't consume the `firstUser` admin grant), `GET /api/bootstrap` (public, cookie-free),
  `GET /api/config`, `POST /api/session/resume|logout|end`, `GET/PATCH /api/users`, `PATCH /api/users/me`,
  `PUT /api/users/me/avatar-image`, `PATCH /api/users/:userId` (admin), `GET /api/avatars/:fileName`,
  `GET/POST /api/channels`, `PATCH /api/channels/:channelId` (owner or admin),
  `GET/POST /api/channels/:channelId/members`,
  `DELETE /api/channels/:channelId/members/:userId`, `GET /api/messages/:channelId`,
  `GET /api/dms` (the caller's DM inbox: partner, last message time and author, newest first — the sidebar lists only these), `GET /api/dms/:userId`, `POST /api/messages`, `PATCH/DELETE /api/messages/:messageId`,
  `GET /api/search` (400 on a malformed querystring), `GET /api/users/me/blocks` +
  `PUT/DELETE /api/users/me/blocks/:userId` (the caller's own block list; 30/min),
  `GET /api/moderation/users` +
  `PATCH /api/moderation/users/:userId` (admin/moderator ban + shadow-ban + timeout: `timeoutMs` is a
  duration, applied and clamped to 7 days on the server clock; the legacy absolute `timeoutUntil` is
  clamped too), `GET /api/access/pending` +
  `POST /api/access/users/:userId/approve|deny` (admin/greeter join approval),
  `PATCH /api/admin/users/:userId/roles` + `POST /api/admin/users/:userId/promote` (admin),
  `POST /api/attachments` + `GET /api/attachments/:fileName`, `GET /api/host/clients` (launcher-only: loopback + host token; the
  distinct non-loopback peer addresses of admitted sockets, for the share screen's "N phones connected" and
  hotspot-interface confirmation), `GET /api/host/invite` (launcher-only, same rule: the rotating invite code
  for the host's join QR on an approval-only node, else null; `invites.ts`, 10-minute windows, secret rotated
  by the kill switch), `POST /api/access/redeem` (a queued session redeems that code from the QR's `#…&i=`
  fragment, `apps/client/src/lib/invite.ts`; never lifts a ban), `POST /api/admin/claim`,
  `GET/PATCH /api/admin/config` (admin),
  `GET /api/admin/channels` (admin), `POST /api/admin/kill-switch`
  (admin + `killSwitch.enabled`), `POST /api/panic` (unauthenticated pre-shared token; 404 unless
  the token is set **and** `killSwitch.enabled`). WebSocket at `GET /ws` (an anonymous socket needs the session cookie already set; a bound
  one proves its session key via the challenge — the client opens it only after boot resolves). Every
  admitted socket gets a content-free `{"type":"ping"}` immediately and every 25 s
  (`WS_HEARTBEAT_INTERVAL_MS`) via `wsSend` — sealed + sequenced when encrypted, never before key
  confirmation.
- **Member rules + Welcome** (docs/30): `user.rulesVersion` vs `MEMBER_RULES_VERSION` (@loam/schema). `rulesError()`
  refuses a human's posts/reactions (`createMessage`), mesh mail (`POST /api/mesh/messages` and
  `/api/mesh/broadcast`, 403 `rules_not_accepted`), uploads, avatar images, typed names and channel creation
  until they agree (`POST /api/users/me/rules`); `POST /api/users/me/reroll` gives a new generated name + avatar
  seed, only before the first agreement. `AppOptions.requireRulesAcceptance` (default true; existing tests pass
  `false`, `member-rules.test.ts` covers it). Client: `WelcomeScreen` gates the shell once `config` is set,
  `/rules` = `views/RulesView.tsx`. Hosts get a one-time "You run this network" note (`apps/app/src/lib/host-ack.ts`
  in setup; `hostAck` in the TUI's cli.json; printed on every plain-mode start).
- **Report queue**: `GET /api/moderation/reports` returns `ModerationReport`s: open ones, plus `escalated` ones for
  admins; a message report carries the reported message read live (`reportedMessage`), or `messageGone`.
  "Escalate" sets `status: "escalated"` (admins only can then resolve). Resolving an already resolved report
  returns it unchanged (nothing written or broadcast, `resolvedAt` not moved), so no moderator can overwrite
  another's decision or keep it from expiring. Moderators/admins get a content-free
  `reportsChanged` socket event (never broadcast) that drives the People badge. `POST /api/reports` keeps ONE
  open report per (reporter, target): a repeat updates its reason/note (200), a new one is 201; at most 20 open
  reports per reporter and 2 000 node-wide (429 `too_many_attempts`). The `reports` table carries indexed
  `target_id` + `reporter_user_id` columns (migrated and backfilled from the JSON on older DBs), so
  `reportVisibleTo` is a targeted query and the queue is one pass over a `Map` of messages; a reported body
  longer than `REPORTED_MESSAGE_BODY_MAX_LENGTH` is cut with `truncated: true` rather than dropped. Resolved
  reports are deleted on the 30 s reaper tick once their resolution is older than the effective
  `retention.messageTtlMs`, or 30 days when messages are kept; open and escalated reports never expire.
- **User blocking** (docs/30 B3): a member's private block list in the `user_blocks` DAL table (write-
  through, read straight from the DB; `deleteUser` drops rows on both sides, `wipeAll`/kill switch clears
  it; never synced, broadcast or put on a user record; `UserBlockListSchema { blockedUserIds }`). Only a
  visible human can be blocked (self, bot, system and `mesh.` ids → 400 `block_not_allowed`; unknown,
  banned, pending → 404). `dmBlockError()` refuses new DMs, DM reactions and edits of old DMs in **both
  directions** (removing your own reaction and deleting stay allowed); `/api/typing` drops DM typing
  silently. The blocker gets `dm_blocked_by_you`; the blocked sender gets the generic `dm_unavailable`
  (it doesn't state the reason, but it doesn't disguise a block either: a DM to a **banned or pending**
  recipient also returns it — those used to be accepted — yet those users are hidden from the roster).
  An invite or ownership transfer naming a `mesh.` id, a pending or a banned person answers like an unknown
  id (400 `user_not_found`, `addableChannelMember` in `routes-channels.ts`), so an invite can't learn they
  exist. A private-channel invite or ownership transfer across a block (either direction) gets the generic 403
  `channel_member_unavailable`. Channel content is still delivered — the blocker's client hides it. Mesh
  mail bypasses `createMessage`, so mesh senders can't be blocked.
- **Moderator-removed messages** can't be edited by their author (403 `message_removed`) and take no new
  replies or reactions. `POST /api/moderation/messages/:id/remove` works only when the moderator (admins
  too) is in the message's audience or a report in their queue points at it; otherwise it answers like an
  unknown id.
- Audience on mutation: `PATCH`/`DELETE /api/messages/:id` from outside the message's audience answer
  like an unknown id (404 `message_not_found`; DELETE checks it before the "still being written" 409); an
  admin's delete of any message is unchanged. A reaction on a target the caller can't see, or on another
  reaction, gets 400 `target_not_found` (`reaction_not_allowed` is gone); the deletion cascade follows
  stored reaction chains to any depth.
- Mesh sender records (`mesh.` ids) are left out of `GET /api/moderation/users`; the moderation,
  roles, promote, admin edit, approve and deny routes answer for them like an unknown user, and a DM or user
  report from someone they never mailed answers like an unknown recipient or user. `applyUserModeration`
  broadcasts `userUpserted` only when the record as its owner and moderators see it changed, so a shadow
  ban (or lifting one) sends nothing.
- **Avatar uploads**: base64 JSON body, ≤128KB, magic-byte signature checked against declared MIME,
  written to `.loam/avatars/` under an `avt_<16hex>` id. Profile/admin edits may not name any image file
  but the user's current one. Original files never leave the browser (cropped client-side to 256×256). A
  changed or reset avatar deletes its old picture file at once; the orphaned-avatar sweep runs at boot and
  on every 30 s reaper tick (mtime grace + live re-check). Profile edits (own, and an admin's) refuse
  `display_name_taken` for a new name that copies another record's or, while a backend is active, the
  assistant's, compared after
  NFKC, control/format-character removal, whitespace collapse and lower-casing (`displayNameComparisonForm`,
  which removes the hidden characters before NFKC as well as after, since a joiner between a letter and its
  accent blocks composition, and also removes U+034F, the Hangul fillers U+115F, U+1160, U+3164 and U+FFA0, U+2800, the variation
  selectors U+FE00 to U+FE0F and U+E0100 to U+E01EF, and the tag characters U+E0000 to U+E007F, for
  comparison only: a stored name keeps them, since U+FE0F is part of emoji); a name that is empty in
  comparison form is invalid. An avatar seed may not be another user's id or current seed,
  nor start with `user.`, `llm.` or `mesh.` unless it is the person's own id; a seed they already have is
  kept.
- **LLM (optional)**: three backends, all off by default, one active at a time (`activeLlmProvider` in
  `@loam/schema`: the on-device model wins, then an OpenAI-compatible service, then Ollama). `llm.ollama`
  (Ollama's own `/api/chat`), `llm.openai` (any **OpenAI-compatible** `/chat/completions` service, streamed as
  SSE: OpenRouter, OpenAI, Groq, Mistral, LM Studio, llama.cpp server; `OPENAI_COMPATIBLE_PRESETS` fills the
  base URL), `llm.onDevice` (Android). The service's `apiKey` is **write-only**: stored with the config (in
  the clear, like `sync.token`), never returned by `GET /api/admin/config` or the host API (`apiKeySet`
  instead), kept by an update that omits it, cleared by `""`, and dropped by an admin save (`applyConfigUpdate`: PATCH or host API) that moves `baseUrl` to another origin without a new key (`sameUrlOrigin`), and boot keeps the drop (`withoutFileKeyForOtherOrigin` in `loadAppConfig`: a `config.json` key is never paired with a stored address on another origin); the models endpoint sends the saved key only to the saved origin. `POST /api/admin/llm/models` (admin; host API
  `llmModels`) lists a backend's models for the screens' Test button, answering 200 with `{ ok: false, code }`
  on failure. A **hardened** network refuses a cloud service (`llm_cloud_not_allowed` on PATCH; a hand-edited
  config.json boots with the assistant off) but allows a local one (`isLocalNetworkUrl`; only `localhost` and loopback literals count as this computer, a `*.localhost` name is an online service). No backend request follows a redirect, on any network (`redirect: "manual"`; a chat fails with the plain failure line, the models endpoint answers `llm_bad_response`). A reply is cut at `ASSISTANT_REPLY_MAX_CHARS` (64 000) with a note, a streamed line over 256 Ki characters fails it, the model list is read up to 8 MiB. When a backend is
  active, a bot user appears as a DM contact and DMing it streams a reply into a new assistant message,
  updated incrementally. Members are told where replies come from: `NetworkConfig.assistantDestination` (`onDevice` / `host` / `lan` /
  `online` + hostname) is shown in the bot DM's header, an `online` one gates the composer behind a per-service,
  per-device acknowledgement, and DM history written before a destination change is never sent to the new one (a
  `{ key, since, rev }` record under `assistantDestination` in the config table; docs/06 "What members are told"). The key includes the scheme (`openai:https://host/path`), so http to https on one host is a change; a record keyed the old way for the same destination is rewritten in place with its cut-off and revision. `since` is the later of the clock and one past the newest DM to or from the assistant, so a host clock that went back can't send old turns to the new destination. `rev` is 32 random hex characters minted with each change and sent as `NetworkConfig.assistantDestinationRevision`; a DM to the assistant must repeat it (`assistantDestinationRevision`, request-only, never stored or broadcast), or `POST /api/messages` answers 409 `assistant_destination_changed` before the busy check with nothing stored or sent, and the reply checks it again before contacting a backend. The client sends it with every DM to a bot, and on the 409 keeps the draft and re-reads the config (through the tunnel when it is active, never starting a handshake or resume; a pinned client whose tunnel is down keeps the config it has, else `/api/bootstrap`). Tests that DM the bot use the harness's `assistantRevision(app)`. Absent config = no bot, no LLM routes. `botId` must be an `llm.*` id (≤64) and may not name a
  non-bot user (PATCH 400; at boot an out-of-namespace id is dropped for the default with a warning, and
  one naming a person skips the bot). Only the configured bot is on the roster (`visibleUsers`): a bot
  record under an old or repaired id stays in the DB but is hidden (logged once when a repair orphans one); `botDisplayName` ≤80, `model` ≤120. At most one reply in flight per user and 2 node-wide (`429 assistant_busy`); a moderator
  removal/delete aborts the stream (an on-device reply keeps its in-flight slot until the phone's model
  reports its end/error or the 5-minute timeout, since the launcher bridge has no cancel), and a placeholder left streaming by a crash is finalized at boot.

**Feature-flag note**: the messaging flags (`enableReplies`, `enableDMs`, `enableReactions`,
`enablePublicChannels`, `enableMarkdown`, `enableLocationSharing`) are real config values enforced in
`createMessage()` (`enablePublicChannels` gates public channels only, `channelOpenUnderFlags`).
`enableUserChannels` gates user channel creation (`POST /api/channels`); `enablePrivateChannels`
(default **on**) gates the *creation* of private channels — existing private channels keep working
if it is later switched off. **`security.profile` is authoritative**: a named profile (`open`/`standard`/`hardened`)
forces a coherent bundle of the already-enforced axes — `access.joinPolicy`, `retention.messageTtlMs`,
`killSwitch.enabled` — onto the effective config at `mergeConfig()` time via `securityProfilePreset()`
(shared from `@loam/schema`). `custom` (**the default**) forces nothing, leaving those axes
individually configurable. A boot-time `reconcileLegacyProfile()` demotes an older persisted preset to
`custom` if its stored axes diverge, so the profile becoming authoritative never silently disarms a
kill switch. See `docs/09-security-profiles.md`.

## Client architecture (`apps/client/src/`)

- **Design system**: `apps/client/DESIGN.md` is the UI contract (tokens in `src/styles/`, the `Dialog`/`Menu`/`ScreenHeader`/`Avatar`/icon primitives, breakpoints, the fixed-shell keyboard fix in `src/lib/viewport.ts`); read it before adding UI.
- Preact, with routes in the URL fragment (`lib/location.tsx`: `LocationProvider`/`useLocation`, the shape
  the app used from `preact-iso`, which is no longer imported but still in package.json): `#/channels`,
  `#/channel/:id`, `#/channel/:id/thread/:tid`, `#/dm/:id`, `#/settings`, `#/admin` (a section deep link is
  `#/admin?section=<key>`), `#/people`, `#/search`, `#/mesh`, `#/rules`, `#/privacy`. The path part is always
  `/`, and a browser never sends the fragment, so a reload, a restored tab or a phone reloading an evicted
  tab asks only for `GET /`, also on a plain-HTTP LAN origin where the service worker can't register. An
  older path address or an outside link (`/dm/x`, `/privacy`) still opens: the server's app-shell fallback
  answers it (that first request carries the path once) and the client rewrites the address to `/#…` in
  place. A fragment not starting with `#/` is never a route (one that arrives in an open tab carrying `k`, `a`, `i` or `l` reloads the page, `LocationProvider`'s `moved()`, so a join link pasted over the address is read); the start-up parameters (`#k=`, `a=`, `i=`,
  `l=`) are read and stripped in `main.tsx` before the app renders, so a route's own query must never use
  the names `k`, `a`, `i` or `l`. The Android host steers its WebView by setting `location.hash`; the
  desktop opens `/#/admin?section=llm`. The admin, people, mesh, settings and search screens are keyed by
  the confirmed user id, so a different identity starts them empty. `parseRoute`
  maps path → `RouteState`. `route()` pushes no history entry for the address already shown, and `NavLink`
  and the admin section links leave modifier and non-primary clicks to the browser (`isPlainClick`). The
  shell gets `thread-open` only while the thread's parent post is held, so a narrow screen never blanks
  for a gone post. The admin area (`AdminView`; it keeps the server's copy beside its draft, saves
  only the changed fields via `lib/admin-config.ts` `configDelta` after re-reading and `rebaseConfig`-ing the
  draft, and re-reads on every `configUpdated` via the `configVersion` prop, so a stale form never reverts
  the TUI's, another admin's or a link code's changes; a cleared `llm.ollama.systemPrompt` is sent as `""`,
  and `rebaseConfig` keeps the server's read-only `llm.refusal`) and the claim form in settings appear per
  `currentUser.isAdmin` / `networkConfig.allowAdminClaim` — cosmetic only; the server enforces.
- State is plain `useState` in `LoamApp` (no store lib). Flow: hydrate from **IndexedDB**
  (`src/lib/local-store.ts`, db `loam-poc`) → `/api/bootstrap` (then a sealed resume and a tunnelled
  `/api/config` for a bound client, or the cookie `/api/config` for an anonymous one), `/api/channels`, `/api/users` → open WebSocket →
  apply live `messageCreated/Updated/Deleted` and `userUpserted` events. Reconnect uses exponential
  backoff (cap 30s). A per-socket liveness watchdog (`lib/ws-liveness.ts`, armed by the first server
  ping) declares a socket dead after ~60 s without a beat and reconnects; `online`/`visibilitychange`
  re-check it and skip the backoff. A reconnect that finds the pin broken runs the boot pass instead of
  opening a socket, so a QR-pinned client that missed an Emergency Reset reaches the rescan gate (see
  transport). An expired invite code's notice (`gate.inviteRefused`) is set whatever became of the boot
  pass, so it shows on a first visit.
- **Identity & roster reconcile**: `lib/identity.ts` stores the server-confirmed user id
  (`loam.confirmedUserId`); when it changes (e.g. an Emergency Reset the client missed) the local cache is
  purged, and other open tabs (a `storage` event on that key) drop their in-memory content and reload.
  `confirmIdentity` compares → purges → records LAST (a failed/killed purge leaves the old id so the next
  boot purges again; an unreadable store purges), and the shell shows a splash until the node confirms the
  identity, proves unreachable, or 1.5 s passes (`IDENTITY_GATE_MAX_MS`) — so hydrated content never flashes
  under a reset identity while staying offline-first. `lib/roster.ts` `reconcileRoster` drops users the full `/api/users` list no longer returns.
  An Emergency Reset or device wipe clears everything the page holds in memory, as an identity change does
  (DM inbox, read markers, typing, presence, toasts, the error banner). The device-wipe snapshot also holds
  the pinned host key, so a QR-pinned device whose session had died can re-handshake and revoke its token.
  Read markers (`sync` store record `conversationReads`) and `loam.lastConversation` are pruned on
  `channelRemoved`, after a resync for channels the node no longer lists, when the DM inbox lands for
  partners neither in it nor in DMs that arrived meanwhile, and in full for a banned or pending session.
- **Conversations**: `components/ConversationView.tsx` (header, `MessageList`, `ThreadPanel`) is keyed by
  conversation (`kind:id`; the thread panel by parent id), so drafts, pending attachments, report dialogs
  and scroll state never follow the user into another conversation. A `LiveChangeJournal`
  (`lib/messages.ts`) stops a history snapshot from resurrecting a message deleted, or undoing an edit
  applied, while the fetch was in flight. Read markers are the newest **server** `createdAt` on screen,
  not the client clock.
- **Errors**: `lib/api.ts` throws a typed `ApiError { status, code }` (branch on the code, never the
  message text); `ErrorBanner` is a top-of-viewport `role=alert` notice with a dismiss button (transient
  action errors auto-dismiss after 8 s); a top-level `ErrorBoundary` shows a recoverable screen.
  `MobileBackLink` / `PinChangePrompt` (see transport) live in `src/components/` too.
- All server payloads are re-validated client-side with the same Zod schemas (`parseSocketEvent`,
  `parseMessageResponse`). The channel list, user list, both history endpoints and the DM inbox are checked
  row by row: a failing row is dropped (and counts as not returned) with a count-only console warning, and
  an answer that isn't a list is a failed request.
- **Blocking** (`lib/blocks.ts`): the block list is fetched from `/api/users/me/blocks` at boot and cached
  in IndexedDB (the `sync` store, tagged with the confirmed identity), hydrated before the cached content
  so a cold/offline boot never shows blocked authors; the wipe deletes it and the identity-change purge
  clears it. A Block button sits beside
  "Report this user" in a human DM's header; a blocked DM shows a banner with Unblock and a disabled
  composer; in channels and search results a blocked author's posts/replies collapse to a placeholder with
  Show, and their reactions, typing, toasts, reply counts and unread counts are dropped. `BlockedUsersPanel` in Settings lists them for
  unblocking, and Settings links the privacy policy, which the node serves itself at `/privacy` (`views/PrivacyView.tsx`, text in `lib/privacy-policy.ts`, kept in step with `apps/site/privacy.html`; the Android host menu opens the same page in its WebView), so it reads offline and never sends anyone to another website.
- **New-message alerts** (`lib/alerts.ts`, Settings → `NotificationsPanel`): no browser notifications (they
  need a secure context), so a tone (Web Audio, unlocked on the first tap) and/or a vibration while the page
  is open, for direct messages (default), every message or nothing; per device in localStorage. In the host
  app's WebView the level is posted to the app (`loam-alerts`), which notifies natively while in the background.
- **Markdown**: `src/lib/markdown.ts` renders with `snarkdown`, escapes first, sanitises with
  `DOMPurify` as an allowlist (the tags snarkdown emits minus `img`, the `href` attribute only, `data-*` and
  `aria-*` off; `![alt](url)` shows its alt text, pictures go as attachments; cache key
  `JSON.stringify([id, editedAt, body])`), hardens links (safe protocols only, `rel=noreferrer target=_blank`) and drops a link's fragment when it
  carries a start-up parameter (`k`, `a`, `i`, `l`; judged after URL parsing, so tabs, case or percent-encoding
  don't get one through). Any new rendered-HTML path must go through this — never inject raw message HTML.
- **PWA**: `src/service-worker.ts` is bundled by the `loam:service-worker` Vite plugin into
  `dist/service-worker.js` AFTER the app, with the build's file list and a content hash defined in (cache
  `loam-shell-<hash>`; every other cache is dropped on activate, so a deploy refreshes the unhashed icons and
  manifest and evicts old bundles). Every navigation is answered from ONE request for `/` (network-first,
  cached under `/` only); on a plain-HTTP LAN origin it can't register, and the fragment routes are what keep
  conversation ids off the wire; build files are precached on install and served cache-first; `/api` and `/ws` are never touched.
  The pure decisions live in `src/lib/service-worker-routing.ts` (tested). Registered only in PROD
  (`main.tsx`). `manifest.webmanifest`'s `start_url` is `/` and its `id` stays `/channels`, the identity earlier installs have. `SearchView` keeps the search term out of the
  address (a `#/search?q=` deep link is read once, then replaced; the term waits in module memory,
  `pendingDeepLinkTerm`, and is searched once the app has its config, the `ready` prop).
- **Search results** (`views/SearchView.tsx`, `lib/search-results.ts`): the screen holds its own copy of what a
  search returned, so `app.tsx` publishes every delete, update and channel removal (`publishSearchChange`, from
  `removeMessage`, `upsertMessages` and `removeChannel`) and the screen folds them in, also over a response that
  was in flight. It prunes by the conversations' retention rule on the same interval, re-runs the search on
  screen after each finished resync (`resyncCount`), and is keyed by the current user id so a different
  confirmed identity starts it empty. A search never grows: a change removes or rewrites a row.
- **Avatar upload editor**: `components/AvatarImageEditor.tsx` — canvas crop/zoom/rotate with pointer
  gestures, re-encodes under 128KB before upload through `lib/image-encoding.ts` (WebP, then PNG; without
  WebP, PNG, then JPEG).

## Conventions

- TypeScript strict everywhere; `noUnusedLocals`/`noUnusedParameters`/`verbatimModuleSyntax` on. Use
  `import type` for type-only imports (enforced).
- ESM only (`"type": "module"`). Server uses `NodeNext` resolution; client uses bundler resolution.
- Named functions with JSDoc are the house style (see existing code). Match the surrounding density.
- Validate at boundaries with the shared Zod schemas rather than trusting `any`.
- After mutating server state, write through to the store (`store.upsertUser(...)`,
  `store.insertMessage(...)`, etc.) and `broadcast(...)` as the existing handlers do.
- Relative imports inside `packages/*/src` must use explicit `.js` extensions — the compiled `dist/`
  runs under Node ESM (the server consumes it), which rejects extensionless specifiers.

## Good first areas / known gaps

- `apps/client` has a Vitest+jsdom harness (lib tests + a rendered `.test.tsx` beside most of
  `src/components/`). `app.tsx` still holds `LoamApp`'s boot/socket/state logic (~2.7k lines), so
  extracting more of it into tested `src/lib/` helpers or components is high value.
- **Private channels are implemented** (membership, full server-side enforcement, member management
  UI, targeted `channelRemoved`) — see the server-architecture notes above. **Ownership transfer**
  landed too: `POST /api/channels/:id/transfer` (owner/admin only; the new owner is added to a private
  roster if absent, the old owner stays a member) with a "Make owner" control in the Members panel.
  Private-channel join requests (owner/admin approval) shipped in 0.4.0.
- Message search is server-side substring (`LIKE`-equivalent over the in-memory mirror); semantic
  search would fall out of the RAG embeddings (docs/06) if that lands.
- `security.profile` is wired (see the feature-flag note). Transport encryption is enforced, so now
  **every named profile encrypts**: `open` and `standard` both force `optional`, `hardened` forces
  `required`. `open`/`standard` therefore differ only in intent for now. Rotating invite codes (docs/08,
  `invites.ts`) are built but apply to any approval-only node rather than being a profile axis. Plaintext (`off`) is no longer any profile's posture.
- On-device SQLCipher (encrypted Android DB) now SHIPS: the multiple-ciphers ABI-108 android-arm64
  prebuild is cross-compiled + vendored (`apps/app/native-prebuilds/multiple-ciphers/`, sha256-pinned
  tarball + reproducible build recipe) and materialised by `fetch-native-modules.mjs` alongside the plain
  driver — also vendored (`native-prebuilds/better-sqlite3/`: the original digidem 12.10.0 binary, since
  upstream re-uploaded non-reproducible assets on 2026-08-17 and the pinned download stopped matching) —
  so `security.dbEncryption` modes key the DB on-device, failing closed if the driver won't load. The JS
  wrappers and their two runtime dependencies are vendored too, as sha256-pinned `npm pack` tarballs in
  `native-prebuilds/npm/`, so `fetch:native` never touches the npm registry.
  On-device runtime verification (actual `PRAGMA key`/rekey/wipe on a physical arm64 phone) is the
  remaining device-test item (docs/01, docs/04).
- LoRa / alternate transports: the node-to-node sync protocol (docs/11) is the transport-agnostic
  layer a LoRa link would carry; the LoRa framing/bandwidth work itself is unbuilt. **Sync peer
  authentication is now built**: an optional shared `sync.token` (stored in the clear — it's a bearer
  secret the node must present) is required via the `x-loam-sync-token` header on `/api/sync/*` when
  set, and sent when pulling — inside the sealed envelope, never on a plaintext pull (except from a
  Developer Mode node); a missing/wrong token 404s identically to sync being off. Unset = open (the
  pre-token behaviour). Sync pulls ride the same transport encryption as clients (docs/08, docs/11).
- **Anonymous-user creation is bounded**: `getSessionUserId` mints a new identity only within a per-IP
  budget (`maxNewIdentitiesPerWindow`, default 60 / 10 min; `AppOptions`), throwing a `429` past it —
  a client that keeps its session cookie never touches it, and on a LAN each device has its own IP. The budget counts the address (`addressKey`, an IPv4-mapped address as IPv4) and, for IPv6, the /64 at `subnetIdentityFactor` (8) times it, in two LRU-bounded tables; a /64 that has spent its bound is refused before its address is counted, so its refused requests can't evict another caller's window. **Ghost
  identities are reaped**: `reapUnusedIdentities()` (on the 30 s reaper tick) deletes a human user who never
  agreed to the rules, holds no role or moderation state, has no
  open or escalated report filed, authored or received no message, owns or belongs to no channel, is on no
  socket and holds no live bound transport session, and is older than `unusedIdentityMaxAgeMs` (24 h;
  `AppOptions`), measured from admission for someone let in from the queue (`users.admitted_at`, a
  server-only column). A `pending` identity (a greeter's queue entry, which can't agree to the rules yet) is
  reaped only after `pendingIdentityMaxAgeMs` (7 days); a block does not count as use. It drops its sessions/tokens, mesh
  keypair and (via `store.deleteUser`) its block-list rows, join requests and mesh address book in one
  transaction; nothing is broadcast (clients drop it on the next `reconcileRoster`). A no-op when
  `requireRulesAcceptance` is off.
- **Release signing**: `pnpm --filter app keystore` generates a real signing key;
  `plugins/with-release-signing.js` injects the release `signingConfig` at prebuild **only when
  `keystore.properties` exists**. Without it, `pnpm --filter app aab` refuses to build (sets
  `LOAM_REQUIRE_RELEASE_SIGNING`, so prebuild fails too) and `apk` prints a loud debug-signing banner
  unless acknowledged with `--debug-signed` / `LOAM_ALLOW_DEBUG_SIGNING=1`.
- **Stale-prebuild guard** (`apps/app`): prebuild stamps `android/loam-prebuild.sha256` with a hash of
  `app.json` + `plugins/*.js`, and `app/build.gradle` fails `preBuild` on a mismatch — re-run prebuild
  (`pnpm --filter app apk` does; `-PloamSkipPrebuildCheck` bypasses it for local native debugging only).

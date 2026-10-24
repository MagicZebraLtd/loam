# 24 — Desktop host app (macOS / Windows / Linux)

> **Status: implemented, unreleased; the first release ships with 0.7.0.** `apps/desktop` is an Electron app
> that runs a LOAM network from a Mac, a Windows PC or a Linux laptop: setup screens, a host screen with the
> join QR, and the web client in its own window with the host already admin. It is the sibling of the Android
> host ([docs/04](04-android-host-app.md)) and the `loamnet` terminal app ([docs/14](14-distribution.md)), for
> people who want to double-click an icon rather than open a terminal. The Windows and Linux builds, and the
> real keychain flow, have not yet been run on real machines (see [Not yet verified](#not-yet-verified)).
> Read [`CLAUDE.md`](../CLAUDE.md) and docs/04 first; this document does not repeat them.

## What it is

The person who installs it **runs a network**. Everyone else joins from the browser on their phone or laptop
by scanning the QR code, exactly as for an Android or `loamnet` host. Nothing changed in the web client or the
server's protocol: the app wraps the same `startEmbeddedServer()` the CLI and the Android launcher use
(`apps/server/src/embedded.ts`), in the Electron main process, and drives it through the in-process host API
(`LoamApp.host`, `HostApi` in `@loam/schema`) that the terminal UI uses. Anything the TUI does, the desktop
shell does through IPC.

- **Setup** (first run, one page): the network's name; the kind of network (Private and short-lived,
  Community, or Choose every setting myself, the same three presets as the phone, now shared from
  `@loam/schema`'s `setup-presets.ts`); how its messages are stored (below); a passphrase when that is the
  choice; and the one-time "You run this network" note (the same text and version number as the TUI's
  `HOST_ACK_VERSION`).
- **Network** (running): the name, a large join QR, the join address with Copy, how many devices are connected,
  **Open LOAM** (the web client as the host), **Display mode** (the QR fills the window until Esc), **Link another
  LOAM node** (the single-use link-code QR, as on the Android share screen), and **Stop network**. A network
  that keeps its messages only while it runs asks for a hold-to-confirm to stop, because stopping erases it.
- **People**: the roster with pending join requests, and **Make admin** (`host.makeAdmin`), as in the TUI.
- **Activity**: the node's log (in memory only), an errors-only toggle and Copy. A finished Emergency Reset, or
  starting a new network, forgets the log with the network it belonged to, as in the TUI: one line says so.
- **Settings**: the port for the next start; the join address (automatic, or one of this computer's
  addresses); the log level; the storage mode (read-only); Check for updates; Open data folder; **Emergency
  Reset** and **Start a new network**, each a hold-to-confirm.
- **Unlock** (a passphrase network at launch) and **Failed** (the error in plain words, with Retry, and for a
  key or driver failure the choice to start a new network).

English only for now, like the client and the TUI; every string is in one table
(`src/renderer/lib/strings.ts`, and `src/main/strings.ts` for the tray) so translation is a one-file job later.

## Architecture

Three kinds of process, one contract.

| Piece | Where | Role |
|---|---|---|
| **Main process** | `src/main/` → `dist/main/index.js` (ESM) | The launcher. Owns the node (`node-controller.ts`), the keys (`keys.ts`), the settings file, the windows and tray, and every IPC handler. Runs the server **in the same process**. |
| **Server bundle** | `src/server-entry.ts` → `dist/main/loam-server.js` | The LOAM server, built by the esbuild recipe shared with the CLI (`scripts/lib/bundle-server.mjs`): ESM, `node24` target, a banner that recreates `require`/`__dirname`, `@loam/*` inlined from their `dist/`, the three SQLite drivers external. It re-exports `startEmbeddedServer`, `firstLanIPv4`, and the TUI's `createLogBook` and `clean`. The main process imports it lazily (a variable specifier, so esbuild leaves it alone) at the first boot. |
| **Host preload** | `src/preload/host.cts` → `dist/preload/host.cjs` | Exposes `window.loamDesktop` (the `DesktopBridge`) to the host shell and nothing else of Electron. |
| **Client preload** | `src/preload/client.cts` → `dist/preload/client.cjs` | Asks the main process, synchronously, for this boot's host token and the node's transport key and exposes them as `window.__loamHostDeviceToken` and `window.__loamHostTransportKey`, which the web client already reads on Android. |
| **Host shell** | `src/renderer/` → `dist/renderer/` | Preact + Vite, sharing the client's design tokens (`apps/client/src/styles/`) and following `apps/client/DESIGN.md`. Native fonts, light and dark by `prefers-color-scheme`. Loaded from `file://`. |
| **Web client** | copied from `apps/client/dist` → `dist/client/` | What the node serves to joiners and to the host's own window. |

Preloads are `.cts` and compiled to CommonJS `.cjs`: a sandboxed preload cannot be an ES module, and `electron`
is the only module it may require. Electron 44.7.2 is pinned exactly (a bump means a native re-check); its Node
is 24.21 and its Chromium 152, so the main process is built for `node24` and the renderer for `chrome120`.

### The IPC contract

`src/shared/ipc.ts` is the contract between the main process and its windows: the `IPC` channel names, the
`DesktopState` the main process pushes (a phase plus `capabilities`, the `network` record and the settings
view), the error catalogue (`DESKTOP_ERROR_CODES`), the Zod request schemas and the `DesktopBridge` type.

- **Phases:** `setup`, `locked` (a passphrase network needs its passphrase), `starting`, `running` (with a
  `NodeInfo`: the host status, the join URL, the transport key, this computer's addresses), `stopped`, `failed`
  (with an error code) and `resetting`.
- **Error codes:** `port_in_use`, `port_unavailable`, `db_encryption_driver_missing`, `db_encryption_locked`,
  `db_unreadable`, `keychain_unavailable`, `client_missing`, `reset_incomplete`, `stop_timeout`, `unknown`. The
  renderer's `ERROR_COPY` is a full record over them, so a new code does not compile until it has words.
- **Every handler checks the sender and the payload.** `invoke` channels are answered only when the request
  comes from the host window's own top frame while it shows a `file:` page; the client window, which is a web
  page the LAN also gets, cannot drive the launcher. Each payload is parsed against its schema first.
  `openExternal` opens only pages LOAM knows (see below).
- **The one synchronous channel, `desktop:hostInjection`,** is answered only to the client window's top frame
  while it shows the node's loopback origin (origins are compared as parsed, so a node on port 80 matches the
  page's `http://127.0.0.1`); anyone else gets `null`. The answer carries the host token, the transport key and
  `noLocalCache`, true on every encrypted network (below, "Storage partition").
- **Pushes:** `desktop:state` (on every change, and every 2 s while running if the node's status moved) and
  `desktop:logEntry`.

### The node controller

`NodeController` is a state machine with every side effect injected (the server, the keychain, the settings
file, the port probe, the clock), so its tests drive each transition with a fake server and never boot
Electron. Operations are serialised, so a double-clicked Start cannot boot two servers. A boot is:

1. Check `dist/client/index.html` exists (`client_missing` otherwise), create the data folder (mode 0700), and
   finish an interrupted reset if the journal says `key-clear-ready` (below).
2. Resolve the database key for the network's mode (below). For any encrypted mode, check the SQLCipher driver
   loads **before** booting (`driver.ts`, the same probe as the CLI), so a missing driver is reported as such
   rather than as a failed open.
3. Pick the port: the saved one, else 3000, stepping past a taken one (up to 120 ports, so a Windows reserved block is crossed, probing the wildcard and
   both loopback addresses, a port of `cli/bin/port.js`). A saved port this computer will not allow falls back
   to 3000.
4. Clear the env the launcher owns, then set exactly what the server reads: `NODE_ENV=production`,
   `LOAM_DATA_DIR`, `LOAM_CLIENT_DIST`, `PORT`, `HOST=0.0.0.0`, `LOAM_VERSION`, `LOAM_DB_ENCRYPTION_MODE`,
   `LOAM_DB_KEY` when there is one, and `LOAM_JOIN_HOST` when a saved join address is still on this computer.
   `LOAM_DB_KEY` is deleted from the env again as soon as the server has read it, so nothing the app launches
   later (a browser, the file manager) inherits it.
5. `startEmbeddedServer({ hostToken, logStream, handleSignals: false })`. The host token is 32 random bytes,
   base64url, new on every boot. A node that reports no transport key (Developer Mode) is stopped: the join QR
   and the window's pin both need it.

**Stopping is bounded, never abandoned.** `close()` on the embedded server destroys its connections (Fastify's
`forceCloseConnections: true`, a server-wide setting: the default waited for every in-flight request, which a
stalled upload could hold open for ever) and then closes the store. The controller waits 10 s for it; a node
that still has not closed is reported as `stop_timeout` (Stop fails rather than report stopped; "Start a new
network" refuses to destroy the key or empty the folder under it), its close is remembered, and **nothing
boots until it has finished**: the next Start waits for it again, bounded the same way. Once a given-up node
does finish, the screen moves to Stopped by itself. Quit stays bounded on its own (`before-quit` exits after
10 s whatever the node did).

`NODE_ENV=production` is also set at the top of `index.ts`, before the server bundle is ever imported, so the
shipped app refuses Developer Mode exactly as the Android host does.

**The log** is the TUI's in-memory log book (`createLogBook`): capped, never written to disk. Every text field
goes through `clean()` before it leaves the main process, because a display name or a request path can carry
what someone else typed.

## The data folder and `desktop.json`

Electron's `userData` folder is named **`LOAM`** (`LOAM (development)` for an unpackaged `electron .`, so a
development run can never touch a real network). Under the OS's application-data directory that is
`~/Library/Application Support/LOAM` on macOS, `%APPDATA%\LOAM` on Windows and `~/.config/LOAM` on Linux.

| Path (under `userData`) | What |
|---|---|
| `node/` | The node's data folder (`LOAM_DATA_DIR`, mode 0700): `loam.db`, `config.json`, media, avatars, the wipe journal. |
| `desktop.json` | The launcher's own settings (mode 0600, written beside and renamed over): the network record (preset, name, encryption mode, creation time), the preferred port, the pinned join address, the log level, the host-note version acknowledged. **Never a key and never a passphrase.** Read tolerantly: a bad field is dropped; a malformed network record is dropped, which sends the host back to setup rather than booting under a guessed mode. |
| `device-secret.enc` | The device secret, sealed by the OS keychain through `safeStorage` (below). Absent until a persistent or passphrase network needs it. |
| `device-secret.key` | The device secret **in the clear**, used only on a computer with no keychain and only by a passphrase network (below). |
| `*.tmp` beside the three above | The name each file is written under (fsynced) before being renamed over the final one (`durable-files.ts`). Destroying the secret removes the temporary names too and fsyncs the folder, so an interrupted write never leaves a copy of a destroyed key. |
| Electron's own profile | Cookies and the client window's storage partition (below); no HTTP cache. |

"Open data folder" in Settings opens `node/`.

## Encryption modes and keys

The mirror of the Android launcher (`apps/app/src/lib/db-encryption.ts`). A random 32-byte **device secret**
(hex) is the root; `LOAM_DB_ENCRYPTION_MODE` is always set to the mode.

| Mode (Setup wording) | `LOAM_DB_KEY` | Driver |
|---|---|---|
| `off` (No encryption) | none | `node:sqlite` |
| `ephemeral` (Only while running) | the literal `"ephemeral"`: the server makes a random key that lives only in memory | SQLCipher |
| `passphrase` (With a passphrase) | `SHA-256(passphrase + ":" + deviceSecret)`, hex | SQLCipher |
| `persistent` (Kept in this computer's keychain) | the device secret itself | SQLCipher |

The unencrypted driver is `node:sqlite`, built into Electron's Node (verified working under Electron 44.7.2),
so an unencrypted network has no native dependency, as with the CLI. Presets pick the default: **Private**
is `ephemeral`; **Community** and **Choose every setting myself** are `persistent`, or `passphrase` when this
computer has no keychain.

**The passphrase** is typed at Setup (minimum 8 characters) and on every start, held in memory only and dropped
on Stop. The hash includes the device secret, so the passphrase alone opens nothing, and destroying the secret
makes the database unreadable even to someone who knows the passphrase. The SHA-256 only mixes the secret in:
the server hands that value to SQLCipher as a text key, and SQLCipher derives the real key from it with its own
PBKDF2, so guessing a passphrase costs the driver's key derivation per guess, not one hash. A wrong passphrase maps to the Unlock
screen saying so; a lost device secret under a device-held mode maps to `db_encryption_locked`.

**The keychain is touched lazily.** `capabilities.keychain` is decided at launch **without** asking the OS
(`keychainProtects`): macOS and Windows are always `true`, and on Linux it follows
`safeStorage.getSelectedStorageBackend()`, where `basic_text` or `unknown` means no keychain. The reason: on
macOS even `isEncryptionAvailable()` reads the keychain item and can raise a "LOAM wants to use your
confidential information" prompt for a network that never needs a stored key. The keychain is read or written
only by `fileDeviceSecretStore.get()`, which runs when a persistent or passphrase network is set up or started.
Ephemeral and unencrypted networks, and `--smoke`, never touch it.

Honest caveats:

- **Only a signed macOS build keeps "Always Allow" across updates.** The release builds are signed with the
  Developer ID certificate (see [Signing](#signing)), so their code identity is stable and one "Always Allow"
  holds. A local or fork build without the certificate is ad-hoc signed, which gives every build a new identity,
  so macOS asks again after each update.
- **No keychain, no persistent mode.** On a Linux desktop with no secret service (GNOME Keyring, KWallet),
  `persistent` is not offered, Community defaults to `passphrase`, and the Setup screen says why. A
  passphrase network there stores the device secret in `device-secret.key` unprotected: the passphrase is the
  protection, and the secret still gives Emergency Reset its "destroy the key" property. That file is left
  as it is even when a later session does have a keychain (a graphical login after an SSH start, or the other
  way round): sealing it then would make the network unreadable in the next session without one, which an
  earlier build did (`keys.ts` sealed a plain secret "once this computer has a keychain").
- **A persistent key is never written in the clear.** The capability flag decides what Setup offers; the key
  store decides what it will do. When a `persistent` network needs its secret and the keychain can't seal it
  at that moment (on macOS and Windows the flag is `true` without asking, so this is the one case the flag
  can't foresee), the store refuses with `keychain_unavailable` instead of writing `device-secret.key`; only a
  passphrase network may use the plain file. A sealed secret the keychain won't open today is `db_encryption_locked`,
  never re-minted. A plain-file secret stays in its plain file even on a computer that has a keychain now
  (see the caveat above).
- **The keychain protects the key from other users and from a stolen disk, not from the logged-in user.**
  Any program running as the same user can ask the OS to unseal the item, subject to the OS's prompts.
- **What the database encryption does not cover.** As for the CLI, pictures, files and avatars are stored
  beside the database unencrypted. The host's own client window keeps **no copy of an encrypted network's
  content on the disk** (next section, "Storage partition"): its browser-side cache is switched off, and its
  HTTP cache too, so only its identity and preferences (localStorage) persist. On an unencrypted network the
  window caches as any browser would; that copy is erased by Emergency Reset (both the in-process reset and
  the fixed-key handoff), by "Start a new network" and by setup, never left behind for a later network, and
  `desktop.json` carries a `clientCopyStale` mark from the start of each of those until the erase succeeded,
  so a crash in between is finished at the next launch. Chromium's own on-disk logs are not securely erased.
- **SQLCipher is a Node-API addon** (`better-sqlite3-multiple-ciphers` ^13, NAPI_VERSION 10), which is ABI-stable
  across Node and Electron. Nothing is compiled: `scripts/native.mjs` copies the prebuild for the target
  platform and architecture into `dist/main/node_modules/`, where the server bundle's `createRequire` finds it.

## Emergency Reset on desktop

The node-wide wipe is the same as everywhere (docs/02), started from Settings with a hold-to-confirm. It needs
no admin session and ignores `killSwitch.enabled`: it is the host's own screen. How it ends depends on the key:

- **`off` and `ephemeral` (in-process).** The server deletes the data, answers complete, and keeps running on an
  empty database. For `ephemeral`, stopping alone already makes everything unreadable.
- **`persistent` and `passphrase` (fixed key).** The server journals the wipe in `node/.loam-wipe-phase`,
  deletes the database and media, proves them gone, calls the launcher's hook (`globalThis.__loamRequestWipeRestart`,
  installed once) and answers `complete: false`. The launcher then stops the node, **deletes the device
  secret** (the cryptographic wipe: nothing written under it can be read again, even with the passphrase),
  removes the journal and **proves it gone** (fsync of the folder), mints a fresh secret and boots again. The
  boot-time resume finishes the rest.
- **The two journal phases** are routed on, never on mere presence (ported from the Android launcher):
  `delete-pending` means the artifacts are not yet proven gone, so the old key stays and the server's resume
  retries the deletion; `key-clear-ready` means only the key clear is left, so the launcher does it before it
  resolves any key. An unreadable or unrecognised journal counts as `delete-pending`. The order (secret first,
  then journal) means a crash in between leaves `key-clear-ready`, and the next boot simply destroys the unused
  new secret again.
- **If it cannot finish.** A reset that did not complete but was journaled restarts the node to finish; one that
  could not even be journaled leaves the node locked (the server answers 503) and shows `reset_incomplete`,
  where Retry runs the reset again. The boot gives up after two key-clear rounds rather than looping. A reset
  **started elsewhere** (the web client's admin screen, `/api/panic`) is watched for up to 30 s: finished, the
  window's copy is erased and the window reloaded; still resetting after that, it ends the same two ways as
  the launcher's own, by whether the journal is on disk.
- **Start a new network** (Settings, or after a failure) does an Emergency Reset first when the node is running
  (so joined devices purge their copies), then stops it, destroys the secret, erases the host's client-window
  storage, empties the data folder (reporting any file it could not remove) and returns to Setup.
  **Setup** itself also starts from an empty folder and a new secret.
- Deleting files is not secure erasure on flash storage (docs/02); an encrypted network's real wipe is
  destroying its key.

## Application windows and security posture

Two windows, both created with `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`,
`webviewTag: false`:

- **Host window** (960 by 760, minimum 360 by 480): the launcher's own page, from `file://`, with the host
  preload. **Closing it hides it and the network keeps running**; the tray icon (and the dock on macOS) brings it
  back. Only **Quit** stops the node (`before-quit` waits for the node to close, capped at 10 s). A second
  launch focuses the existing window (single-instance lock, one launcher per computer user).
- **Client window** (1100 by 820): the web client at `http://127.0.0.1:<port>/`, loopback so it never depends on
  which network is up, with the client preload. On each new boot (a new token, maybe a new port or key) the page
  is reloaded so the preload injects what that boot accepts. The token reaches the page only through the preload;
  it is never in a URL, where anyone could craft one.

Rules for every page the app creates:

- **Navigation.** `will-navigate` and `will-redirect` are refused unless it is the client window staying on its
  own origin; a refused navigation to a web page opens in the computer's browser instead. `setWindowOpenHandler`
  denies every new window, opening http(s) links in the browser.
- **External links.** The host window may ask only for LOAM's pages: `https://loamnet.com/`, the GitHub project,
  its Ko-fi page, and pages of the running node (loopback, or this computer's addresses, on the node's port). The
  client window's links may be any http(s) page without credentials in the URL, as in a browser; other schemes
  (`file:`, custom protocols) are dropped.
- **Permissions.** Requests and checks are denied in every session the app uses, except
  `clipboard-sanitized-write` (the client's Copy buttons).
- **Storage partition for the client window.** A network kept only while LOAM runs (`ephemeral`) uses an
  in-memory partition, so everything the web client stored is gone on Quit; any other network uses a persistent
  one (`persist:loam-client`, so the host stays the same person across restarts), which sits in Electron's
  profile on disk **outside the database's encryption**. So on every encrypted network the preload also sets
  `window.__loamHostNoLocalCache`, and the web client (`lib/local-store.ts`) then keeps no IndexedDB at all:
  what it shows is held in memory and loaded from the node, on loopback, at every page load; its localStorage
  (identity token, preferences, no messages) is what persists. Both partitions are created without an HTTP
  cache, so pictures served in the clear (`optional` transport mode) never land on the disk either. Both are
  erased on every Emergency Reset and when a network is discarded. (The Android host's WebView could ask for
  the same with one injected line; docs/25 P30.)
- **CSP.** The built host shell carries `default-src 'self'`, `script-src 'self'`, `style-src 'self'`,
  `img-src 'self' data:`, `connect-src 'none'`, `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`:
  no network, no inline script. (Added at build time only; Vite's dev server injects `<style>` elements.) The web
  client keeps the strict CSP the server sets.
- **Menus.** macOS gets the application, Edit and Window menus (Edit is needed for copy and paste). Windows and
  Linux get no menu bar at all, so the shipped app has no developer-tools shortcut.
- **Electron fuses**, flipped in the packaged binary (`electron-builder.yml`): `runAsNode` off,
  `enableNodeOptionsEnvironmentVariable` off, `enableNodeCliInspectArguments` off, `onlyLoadAppFromAsar` on,
  `enableEmbeddedAsarIntegrityValidation` on. LOAM's binary must not double as a Node interpreter: on macOS the
  keychain trusts this binary with the network's key, so a program that could run its own code inside it could
  ask for that key. `resetAdHocDarwinSignature` re-signs an unsigned build ad hoc after the fuses are flipped,
  because on Apple Silicon a binary with a broken signature is killed at launch.
- **macOS entitlements** (`build/entitlements.mac.plist`, hardened runtime): only `allow-jit` and
  `allow-unsigned-executable-memory`, which Electron's JavaScript engine needs. Neither
  `disable-library-validation` nor `allow-dyld-environment-variables` is granted (why: "Signing" below). The
  app is not App-Sandboxed (that would stop it serving the LAN), so no network-server entitlement is needed.
- **No telemetry, no calls home.** The only outbound request is the tap-only **Check for updates**: one GET to
  GitHub's latest-release API (10 s timeout, no cookies, no LOAM data; only a strict `vX.Y.Z` tag is read). The
  result says whether a newer version exists and opens the releases page in the browser. Nothing checks on
  launch and nothing is downloaded. There is **no auto-updater, by design**: LOAM phones nowhere.

## Joining

The app is **Mode A**: the computer is a peer on a network the phones are also on (a café, an office, an event's
Wi-Fi, or the computer's own shared hotspot). The server binds `0.0.0.0` and the join URL is built exactly as
the TUI's Join screen builds it: `http://<joinHost>:<port>/#k=<transport key>`, plus `&i=<invite code>` on an
approval-only node. The address is the server's best pick of this computer's addresses (no loopback, no
link-local), re-read on every request, so a laptop that moves between networks follows. Settings can pin one
of the addresses the computer has now; a pinned address that has since vanished is ignored with a warning
in the log.

**Off-grid with no router:** the app has no programmatic hotspot, because macOS, Windows and Linux offer none
that works across them. The host turns on the OS's own hotspot first (macOS Internet Sharing, Windows Mobile
hotspot, NetworkManager's hotspot on Linux), and LOAM shows the address that gives the computer. The
step-by-step is on the website's [/desktop page](https://loamnet.com/desktop); the app itself shows only the
address, with a note that the phone must be on the same network.

**Firewall prompts** are the commonest desktop failure and the one thing the host must answer. On first listen
the macOS Application Firewall asks whether LOAM may accept incoming connections (choose Allow), and Windows
Defender Firewall asks which networks (tick Private, choose Allow access). Refused or ignored, phones cannot
reach the app. The prompt names the app from its signature, so an ad-hoc signed local build may show a path
instead of "LOAM". Guest Wi-Fi with client isolation
blocks joiners however the firewall is set, the same class of problem docs/04 notes for phones.

## Building and running

```bash
pnpm install
pnpm -r build                              # the workspace packages and the server
pnpm --filter client build                 # the web client the app embeds

pnpm --filter @loam/desktop build          # JS: server bundle, main, preloads, renderer, client copy → dist/
pnpm --filter @loam/desktop build:native   # the SQLCipher prebuild for this OS and arch → dist/main/node_modules/
pnpm --filter @loam/desktop dev            # build, then `electron .` (userData "LOAM (development)")
pnpm --filter @loam/desktop smoke          # headless boot check (below)
pnpm --filter @loam/desktop dist           # build + build:native + electron-builder for this machine → release/
pnpm --filter @loam/desktop typecheck      # main/preload/shared and the renderer (two tsc projects)
pnpm --filter @loam/desktop test           # Vitest: 29 files, 202 tests
```

- `build` stops with the command to run if a workspace package or `apps/client/dist` is not built.
  `build:native` accepts `--arch arm64|x64` and `--platform darwin|linux|win32` (after `--` through pnpm), and
  verifies the result by loading it under this machine's Electron and writing and rereading an encrypted
  database. **`--from-source`** compiles the driver for Electron with `@electron/rebuild` instead, in a
  **temporary copy** of the package, for a platform with no prebuild or to check a driver bump; it needs a C++
  toolchain.
- **Never rebuild the SQLCipher driver in place.** The pnpm store copy is shared with the `loamnet` CLI, which
  needs the host-Node build; `native.mjs` only ever reads it.
- **`ELECTRON_SKIP_BINARY_DOWNLOAD=1`** skips Electron's ~100 MB binary download at `pnpm install`. CI's main job
  sets it (it never launches Electron); the desktop workflow does not. `electron` is in
  `pnpm-workspace.yaml`'s `onlyBuiltDependencies` because its postinstall fetches the binary.
- Running the renderer alone in a browser (`vite` from `apps/desktop`) works against a fake bridge
  (`src/renderer/lib/fake-bridge.ts`), for working on screens.

### `--smoke`

`electron . --smoke` (or a packaged app with `--smoke`) sets up and boots a node as a first run would, with no
window and nothing kept: a fresh temporary folder (Electron's own profile moves there too), an in-memory
settings store and secret store, and `ephemeral` encryption when the SQLCipher driver loads, else `off`. It
waits for `GET /api/health` to answer 200 and for `/` to serve the web client, checks the node reports the
expected encryption, stops the node, deletes the folder, and prints **one JSON line**:
`{"ok":true,"port":3000,"driver":"better-sqlite3-multiple-ciphers","version":"0.6.4"}` (`driver` is
`node:sqlite` when it fell back; a failure prints `ok:false` with an `error`). Exit code 0, or 1 on any failure
or after 60 s. **`LOAM_SMOKE_REQUIRE_ENCRYPTION=1`** makes a missing SQLCipher driver a failure, so a build that
lost it cannot pass quietly. The keychain is never touched.

## Packaging and artifacts

`electron-builder.yml` packs `dist/**` (without source maps) and `package.json` only. `package.json` has
`"dependencies": {}` and every build tool in `devDependencies`, `npmRebuild`, `nodeGypRebuild` and
`buildDependenciesFromSource` are off, and `asar` is on with `dist/main/node_modules/**/*.node` in `asarUnpack`
(a native addon cannot load from inside the archive). So `dist/` is self-contained, and the packaged app does
not depend on `node_modules`. appId `com.loamnet.desktop`, product name `LOAM`, copyright Magic Zebra Ltd.

Names carry no version, so the website can link `releases/latest/download/<name>`:

| File | Target |
|---|---|
| `LOAM-mac-arm64.dmg`, `LOAM-mac-x64.dmg` | macOS, Apple Silicon and Intel |
| `LOAM-win-x64.exe` | Windows, NSIS (per-user by default, choice of folder, not one-click) |
| `LOAM-linux-x64.AppImage`, `LOAM-linux-x64.deb` | Linux. On Ubuntu 24.04 and newer, AppArmor stops an AppImage from using Chromium's user-namespace sandbox (the same reason CI's smoke passes `--no-sandbox`), so the `.deb`, whose post-install sets up the `chrome-sandbox` helper, is the one to recommend there; the site's /desktop page says so. Not yet run on a real Ubuntu desktop. |

There is **no Windows arm64 and no Linux arm64 artifact**; the driver prebuilds exist for them, but nothing
builds or tests them. Each release file also gets a `.sha256`.

## Signing

State today: **macOS builds are signed and notarized** (since 2026-10-22). Windows and Linux are not signed.

- **macOS.** The CI build signs both apps with the Developer ID Application certificate of Magic Zebra Limited
  (Team ID `D4AZ7F9PBW`) and notarizes each through the App Store Connect API, so a downloaded `.dmg` opens
  with no Gatekeeper step and the keychain's "Always Allow" survives updates (the code identity is stable). The
  five repository secrets behind it: `CSC_LINK` (the certificate as a base64-encoded `.p12`), `CSC_KEY_PASSWORD`
  (its password), `APPLE_API_KEY` (the contents of the App Store Connect `AuthKey_XXXX.p8`, Team key, Developer
  access), `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`. The packaging step is the only step that sees them; it
  writes the `.p8` to a 0600 file under `RUNNER_TEMP` for notarytool and removes it after. `CSC_LINK` without
  the API key signs but does not notarize, and the build warns. The certificate's private key lives in the
  owner's login keychain (created from Xcode, Settings, Accounts, Manage Certificates); the `.p8` is kept
  outside the repository. Apple's notary service took 57 minutes for the team's first submission, so the
  macOS job's timeout is 180 minutes (two architectures, two submissions).
  **Without the secrets** (a fork, or a local `dist` with no certificate) the build ad-hoc signs the bundle
  (`-c.mac.identity=- -c.mac.hardenedRuntime=false`; the hardened runtime has to be off for an ad-hoc
  signature, whose missing Team ID would otherwise make dyld refuse Electron's own framework): without that,
  Apple Silicon reports a downloaded copy as "damaged" instead of offering **Open Anyway** (System Settings,
  Privacy & Security).
  **Entitlements** (`build/entitlements.mac.plist`) grant only `allow-jit` and `allow-unsigned-executable-memory`,
  which V8 needs under the hardened runtime. `allow-dyld-environment-variables` and `disable-library-validation`
  are deliberately absent: with them, any local process could start LOAM with an injected library and ask the
  keychain for "LOAM Safe Storage", which is the device secret, and that is exactly what the fuses are there to
  stop. The unpacked SQLCipher `.node` is signed with the bundle, so library validation passes. Entitlements only
  take effect on a signed build; the first signed build (2026-10-22, both architectures) was checked with
  `codesign --verify --deep --strict`, `spctl -a -t install` (accepted, Notarized Developer ID), `stapler
  validate`, the entitlements read back, the encrypted `--smoke`, and a quarantined copy launched through
  Gatekeeper with no prompt.
- **Windows.** Free signing for open source from **SignPath Foundation**. Setup, when the owner has an
  account: a project with slug `loam`, a signing policy `release-signing` (with manual approval by the
  organization owners), and an artifact configuration `installer` whose root element is `<zip-file>` holding
  `LOAM-win-x64.exe`, signed with the Authenticode file-type signer; then two repository secrets,
  `SIGNPATH_API_TOKEN` (a submitter user's token) and `SIGNPATH_ORGANIZATION_ID`. The workflow uploads the
  unsigned installer as an artifact, SignPath pulls it from that run (which is how it knows it came from this
  repository's workflow), signs it, and the signed file replaces it before checksums are written. The published
  policy is `apps/site/code-signing.html` (loamnet.com/code-signing). Without the secrets the build is unsigned
  and SmartScreen warns ("More info", "Run anyway").
- **Linux** has no signature; the checksum and the build attestation are the check.

## CI

- **`ci.yml`** (every push and PR): sets `ELECTRON_SKIP_BINARY_DOWNLOAD=1`; the desktop's Vitest suites run
  inside `pnpm test`, and a `Desktop typecheck` step runs `pnpm --filter @loam/desktop typecheck`.
- **`build-desktop.yml`** (a `v*` tag, or manual with no Release): every action pinned to a commit SHA, read-only
  token. Jobs: `verify` (`check-versions`, on a tag against the tag) → `build-mac` (macos-15; builds the
  arm64 then x64 driver and packages each), `build-windows` (windows-2025; unsigned installer, then SignPath
  when configured), `build-linux` (ubuntu-24.04; AppImage and `.deb`, then the **smoke test of the packaged
  AppImage** under `xvfb-run` with `LOAM_SMOKE_REQUIRE_ENCRYPTION=1`, `--no-sandbox` because the runner
  restricts unprivileged user namespaces) → `attest` (tags only; the only job with `id-token` and
  `attestations: write`; records build provenance for all five files) → `release` (tags only; the only job
  with `contents: write`; runs no repo code; writes the `.sha256` files after any signing and attaches
  everything; a `-rc.N` or `-beta.N` tag is a GitHub pre-release). Each build job runs the desktop typecheck and
  tests first. Signing secrets reach only the one step that needs them, never a job. The workflow has to exist
  in the tagged commit to fire.
- A download is checked with `sha256sum -c LOAM-mac-arm64.dmg.sha256` and
  `gh attestation verify LOAM-mac-arm64.dmg --repo MagicZebraLtd/loam`.
- The macOS and Windows packaged apps are **not** smoke-tested in CI; only the Linux AppImage is.

## Tests

29 files, 202 tests, in `src/**/*.test.ts(x)` (excluded from the `tsc` builds; `vitest.config.ts` merges the
renderer's Vite config). Main-process suites start with `// @vitest-environment node`.

- Pure logic: settings parsing, key derivation and the key store (with a fake `safeStorage`), the wipe-phase
  reader, port stepping, the join URL, the update check, boot-error mapping, external-link rules, the log feed.
- `node-controller.test.ts`: every transition with a fake server, including the fixed-key reset handoff.
- `node-controller.real.test.ts`: the same state machine against the **real** server bundle and SQLCipher driver
  under plain Node, so the launcher/kill-switch/journal contract is checked end to end. It skips until `build`
  and `build:native` have run. It uses the in-memory secret store, not the keychain.
- Renderer screens mounted in jsdom against a fake `window.loamDesktop`, plus the form and error-copy logic.

## Not yet verified

Written and tested in code and CI, but not run where they matter (the checks are in
[docs/21](21-device-verification-checklist.md), "Desktop"):

- The **Windows and Linux builds** have not been run on a real machine. Only the Mac arm64 build has been
  produced locally; the Linux AppImage is smoke-tested in CI only.
- The **real keychain flow** (macOS Keychain, Windows DPAPI, a Linux secret service, and a Linux desktop without
  one) is tested with fakes and, for the reset handoff, against the real server with an in-memory secret store.
  No test has driven `safeStorage` itself.
- **Firewall prompts** and a **phone joining** from each OS; **Emergency Reset on each key mode** on a
  packaged build; a **browser-downloaded signed build** launching with no Gatekeeper step on an Intel Mac.
- The **Intel Mac build**: `native.mjs` skips its load check for a foreign architecture, and CI builds it on an
  Apple Silicon runner without running it.
- **Linux without a tray.** A GNOME desktop with no tray extension shows no icon; closing the window then leaves
  the network running with no way back except launching the app again (a second launch focuses the window).

## Deferred

No auto-updater (by design), no programmatic hotspot, no Windows or Linux arm64 builds, no Mac App Store,
Microsoft Store or Flatpak build, no translations of the host shell, and no encryption of pictures, files and
avatars (the same gap as the CLI and Android). These are listed in [docs/25](25-backlog.md).

## Why Electron

The original feasibility brief (October 2026) found the desktop app unusually cheap because the server was
already built for it: `startEmbeddedServer()` is a plain-Node, env-driven entry and the `cli/` package already
proved "boot the bundled server and serve the PWA on desktop Node", so Electron is that CLI wrapped in a window,
with no server changes. Tauri would be far smaller than Electron's 80 to 150 MB per platform but throws that
advantage away, since the server would need a bundled Node beside a Rust shell. The costs are the size and
Electron's native-module ABI, which the Node-API SQLCipher v13 driver removes for LOAM's one native module.

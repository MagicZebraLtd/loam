# 21 · On-device runtime verification checklist

> **Status: current, not yet run.** No results are recorded for this checklist. SQLCipher keying, rekey
> and wipe on a physical phone, the on-device model lifecycle and the host service are verified only in
> code and CI. Some host features have been tried on a Galaxy S25 Ultra along the way (hotspot address
> discovery and a second phone joining, 2026-09-28, docs/04), but not this list. Android changes made since
> it was written (the permission flow, the translated hosting notification, wired Wi-Fi mode, large-screen
> support) need the same run; docs/30 lists the large-screen checks. Open items are tracked in
> [docs/25](25-backlog.md).

The `feat/hardening-llm-sqlcipher` work (on-device LLM via llama.rn, at-rest SQLCipher encryption, the
kill-switch/wipe lifecycle) is code-complete and covered by the workspace test suite + CI, and it passed an
external review sign-off. Everything reachable in code and CI is verified there.

What CI and headless review CANNOT verify is behaviour that only exists on a physical arm64 Android device:
real native model loading, actual SQLCipher keying against the on-device driver, and the process-kill timing
of the wipe lifecycle. This checklist is that last mile. Run it on a real phone (the reference device is a
Galaxy S25 Ultra) against a clean release build.

If an item here exposes a native-runtime discrepancy, that is a genuine new finding. If they all pass, the
branch is done.

## Build and install

```bash
pnpm --filter app apk                 # → apps/app/loam-host.apk
adb install -r apps/app/loam-host.apk
```

- [ ] **Clean cold start.** Uninstall any prior copy first, then install and launch. The host boots, the join
  QR renders, and a second device can scan it and reach the server. This exercises the launcher module graph
  packaging (a clean install has no previously-extracted files to fall back on).

## 1. On-device LLM (llama.rn)

- [ ] **Download + activate + chat.** Start downloading the default model (Gemma 3 1B): a confirmation
  states its size and warns about mobile/metered data before anything downloads (a custom URL says its size
  is unknown). Confirm, activate it, DM the bot. Reply text streams in token by token.
- [ ] **Switch models while idle.** Activate a second model. The old context is released and the new one
  loads; the next DM uses the new model. Watch `adb shell dumpsys meminfo <pkg>` across the switch: resident
  memory must not stack (no two multi-GB contexts at once).
- [ ] **Switch models mid-inference.** Start a long reply, then switch the active model before it finishes.
  No crash; the old reply finishes or is dropped; the next DM runs the new model.
- [ ] **Delete the active model.** The file is removed and the bot deactivates cleanly.
- [ ] **Delete an inactive model.** The active model is unaffected and keeps working.
- [ ] **Deactivate.** The bot disappears as a DM contact and its RAM is reclaimed.
- [ ] **Bounded load / no freeze.** Load a large model on a busy device so the load is slow. A stuck or
  very slow load surfaces a "recovering" / timed-out message and NEVER freezes other DMs or the UI.
- [ ] **Completion timeout.** If a generation wedges, it is stopped and reported after the bound rather than
  hanging the assistant forever; a later DM recovers.
- [ ] **Acceleration is honest.** The reported acceleration (GPU / reason-no-GPU) matches what the device
  actually did (OpenCL / Hexagon vs CPU) — the app reads this back from llama.rn, it does not assume it.

## 2. SQLCipher at rest (`security.dbEncryption`)

- [ ] **The SQLCipher driver loads.** Select any encrypted mode and restart. The host boots (no
  `db_encryption_driver_missing` lock screen) and `adb logcat | grep LOAM-DB` shows no driver-load failure.
  This is the first on-device load of the self-built `better-sqlite3-multiple-ciphers` prebuild under the
  embedded Node 18.
- [ ] **Persistent mode.** Set `persistent`, restart. Pull `.loam/loam.db` off the device and confirm it is
  NOT readable as plaintext SQLite (the header is encrypted).
- [ ] **Passphrase mode.** Select it, restart, and confirm the host **refuses to start** until the
  passphrase is entered — on **every** start, not just the first (since 2026-09-04 the passphrase is never
  stored on the device; only the Keystore device secret it is mixed with is). Then: enter a **wrong**
  passphrase and confirm it is rejected **without** touching the existing database — the recovery screen
  offers "enter it again", and the correct one then opens it. Pull `.loam/loam.db` and confirm it is not
  plaintext. NOTE: **changing** a passphrase is *not* an in-place rekey today —
  `apps/app/src/lib/db-encryption.ts` only changes it via the delete-and-start-fresh path (an authenticated
  in-place passphrase rekey is a documented future enhancement, not built). So do not verify an in-place
  rekey; verify every-start prompt → correct unlocks / wrong rejected-and-retryable instead.
- [ ] **Host admin claim (`hostDevice`).** On a fresh install, join from a *second* device and open
  `/api/config` **before** the host screen finishes loading its WebView: that LAN session must NOT be admin.
  The host's own WebView must show the admin area without any claim form (the launcher's per-boot token is
  injected into it). Repeat after an Emergency Reset.
- [ ] **System-stopped hotspot.** With the share screen open, turn on the phone's own hotspot/tethering:
  the share screen must switch to the "system stopped the hotspot" message with the LAN addresses (not the
  dead SSID/QR); close and reopen it after turning tethering off and the hotspot restarts.
- [ ] **Ephemeral mode.** Trigger the kill switch / Emergency Reset: the key is rotated and the previous
  ciphertext is unreadable afterwards.
- [ ] **A reset from the host clears the WebView's storage.** On an unencrypted network (where the web
  client keeps IndexedDB), open a few conversations in the host's WebView, then run Emergency Reset from the
  host menu or Encryption settings. LOAM closes. Before launching it again, check that the WebView holds no
  cookies, localStorage or IndexedDB (on a debug build, `adb shell run-as <pkg> ls app_webview/Default/IndexedDB`
  and `app_webview/Default/Local Storage` show no entry for `http_127.0.0.1_3000`, and `app_webview/Default/Cookies`
  holds no `loam_session`). Launch: setup doesn't name the erased network or offer Continue.
  (`deleteAllWebData` compiles but has not run on a device.)
- [ ] **A live fixed-key reset closes LOAM with the setup record gone.** On a Community (persistent) or
  passphrase network, run Emergency Reset from the web admin page while LOAM is open. LOAM closes once the
  device key is cleared. Launch it again: setup opens with no Continue and doesn't name the erased network.
- [ ] **A resumed reset keeps the new setup and boots.** On a persistent network, start Emergency Reset and
  force-stop LOAM (`adb shell am force-stop <pkg>`) after the wipe journal reaches `key-clear-ready` and before
  the key is cleared. Launch LOAM and go through setup for a new network. The key is cleared, LOAM stays
  open, and the new network boots under the name and settings just chosen; setup doesn't ask again on the
  next launch.
- [ ] **A locked start-fresh shows no `boot_timeout`.** From the locked or unreadable-database screen, choose
  "Preserve old database & start fresh" on a passphrase network, so it ends on the passphrase prompt. Leave
  it for more than five minutes: the lock screen's details show no `boot_timeout`.
- [ ] **Wipe lifecycle under process kill.** On API 31+ / 34, start a wipe and force-kill the app mid-wipe
  (`adb shell am force-stop <pkg>`), then relaunch. The two-phase wipe resumes and completes: a fresh DB, the
  config (kill switch / panic token / profile / retention) survives, and there is no perpetual re-wipe loop.

## 3. Host service and manifest

- [ ] **Foreground service survives a background cold start.** Launch the app and switch away before the
  host finishes starting (~80 s cold). Return to the app: the "LOAM is hosting" notification appears (the
  service is re-asserted on returning to the foreground). Turn the screen off for several minutes; a joined
  second device keeps sending and receiving.
- [ ] **Notification permission (API 33+).** On a fresh install the `POST_NOTIFICATIONS` prompt appears
  once, while the app is in the foreground and never on top of the hotspot permission dialogs. Deny it:
  hosting still works, and the share screen notes that notifications are off.
- [ ] **A message notification goes when its message does.** With LOAM in the background, have a second
  device send the host's person a direct message: the notification shows its text. Delete that message
  from the second device: the notification disappears without opening LOAM. Repeat with an edit, and
  with a channel post in a private channel the host's person is then removed from. Then send two messages
  in one conversation and delete only the first: the notification stays, showing the second. (The native
  `clearMessageNotification` call has not been run on a device.)
- [ ] **Notifications go when LOAM is swiped away.** With a message notification showing, swipe LOAM away
  in the recent-apps screen: hosting stops and the message notification is gone. Start LOAM again with a
  notification left from an earlier run (force-stop with `adb shell am force-stop <pkg>` while one shows):
  it is gone once the host screen opens. (`LoamHostService.onTaskRemoved` calling
  `MessageNotifications.clearAll` compiles but has not run on a device.)
- [ ] **No watch bridging.** With a watch paired (Wear OS or a Galaxy Watch) and LOAM in the background,
  have a second device send the host's person a direct message: the notification shows on the phone and
  not on the watch. (`setLocalOnly(true)` in `MessageNotifications.show` compiles but has not run on a
  device.)
- [ ] **Notification taps and Back with fragment routes.** Tap a message notification from cold (LOAM not
  running, so the conversation waits for LOAM's own page to load) and while LOAM runs: the WebView opens that
  conversation (its address is `http://127.0.0.1:3000/#/dm/<id>` or
  `#/channel/<id>`). Press the hardware Back button in a conversation, a thread and the admin page: each
  goes where it did before the routes moved to the fragment, and Back on the start screen behaves as
  before. Open the assistant settings from the model manager: the admin page opens at its Assistant
  section.
- [ ] **A link tapped while a model file is verified comes back to LOAM.** Start verifying a downloaded
  model (the JS thread is busy hashing it), and meanwhile tap an outside link in a message in the host's
  WebView. Either the link opens outside LOAM, or the outside page is stopped and LOAM loads again in the
  WebView. The host stays admin, and the outside page never sees the host token: in a remote-debugged
  WebView (`chrome://inspect`), `window.__loamHostDeviceToken` is undefined on any page that isn't
  `http://127.0.0.1:3000`.
- [ ] **Links leave the WebView only for the browser.** In a message in the host's WebView, tap an
  `https://` link: it opens in the system browser and LOAM stays on its page. Tap an `intent:` link and a
  `tel:` link: nothing happens (no app opens, no dialer).
- [ ] **Leaving display mode** (still open, needs a decision). Turn on display mode, then press and hold to
  leave it, once with Android's "ask for PIN before unpinning" on and once with it off, and once with
  pinning refused: note whether the phone asks for its screen lock. Nothing in LOAM itself asks today.
- [ ] **Deep links are ignored.** `adb shell am start -a android.intent.action.VIEW -d 'loam://anything'`
  opens (or keeps) the host screen and navigates nowhere else.
- [ ] **Themed icon.** With themed icons on (Android 13+), the launcher shows the monochrome LOAM mark.
- [ ] **No device-to-device transfer** (optional, needs a second phone). Run the Android setup-time
  "copy data from old phone" flow: LOAM arrives with no database, avatars, attachments or config.

## 4. Recovery paths

- [ ] **Locked / unreadable DB.** Put the store into a state it cannot open under the current mode (e.g. wrong
  mode after a manual change). The app shows the locked / recovery screen rather than crashing, and the
  "preserve old DB and start fresh" option round-trips (old data set aside recoverably, fresh DB opens).

## 5. Desktop app (macOS / Windows / Linux)

The desktop app ([docs/24](24-electron-desktop.md)) is covered by 269 Vitest tests, a CI typecheck and, for
the Linux AppImage only, a packaged `--smoke` run. Everything below needs a real machine. Download the
installers from the tag build (or run `pnpm --filter @loam/desktop dist` on the machine), start from a clean
user account or delete the app's `LOAM` data folder first, and note the OS version, architecture and build with
each result. Machines to cover: a Mac on Apple Silicon and one on Intel, a Windows 10 or 11 PC, and a Linux
desktop with a secret service (GNOME Keyring or KWallet) and one without.

- [ ] **Packaged `--smoke` on each OS.** `LOAM.app/Contents/MacOS/LOAM --smoke`, `LOAM.exe --smoke` (from an
  installed copy), `./LOAM-linux-x64.AppImage --smoke`, each with `LOAM_SMOKE_REQUIRE_ENCRYPTION=1`. Prints one
  JSON line with `"ok":true` and `"driver":"better-sqlite3-multiple-ciphers"`, exits 0, leaves no `loam-smoke-*`
  folder and no keychain prompt.
- [ ] **Signed download (macOS).** Download the `.dmg` through a browser (so it is quarantined), drag LOAM to
  Applications, open it: it launches with no Gatekeeper refusal and no Open Anyway step. `spctl -a -vv -t install
  /Applications/LOAM.app` says accepted, source=Notarized Developer ID. Repeat on Intel.
- [ ] **Windows SmartScreen.** The unsigned installer shows "Windows protected your PC", More info, Run anyway
  installs; with SignPath configured, the publisher reads SignPath Foundation.
- [ ] **Linux install.** The AppImage runs after `chmod +x`; the `.deb` installs with `sudo apt install` and
  appears in the applications menu; the tray icon is visible (note the desktop environment).
- [ ] **Firewall prompts.** On first start the macOS Application Firewall asks about incoming connections
  (Allow), and Windows Defender Firewall asks which networks (Private, Allow access). With Allow, a phone on the
  same Wi-Fi reaches the join URL; refused, it cannot, and nothing in the app crashes.
- [ ] **A phone joins.** Scan the on-screen QR with a phone on the same network: it loads LOAM, encrypts
  (the `#k=` key), posts a message the host sees via **Open LOAM**, and "devices connected" counts it. Repeat on
  the computer's own hotspot (macOS Internet Sharing, Windows Mobile hotspot, a NetworkManager hotspot): the
  shown address is the hotspot's, and a phone on it can join.
- [ ] **Keychain prompt behaviour.** A **Private** network (ephemeral) and an unencrypted one raise no keychain
  prompt at any point. A **Community** network (persistent) raises it once at setup and once per start as the OS
  decides; on a signed macOS build "Always Allow" still holds after installing a newer build (only an ad-hoc
  signed local build asks again). Denying it ends in the Failed screen (`keychain_unavailable` or `db_encryption_locked`), never a
  silent plaintext start. Check `device-secret.enc` exists and `device-secret.key` does not.
- [ ] **No keychain (Linux without a secret service).** Setup does not offer the keychain mode, says why, and
  defaults Community to a passphrase; a passphrase network starts, restarts through the Unlock screen, and
  keeps its secret in `device-secret.key`. A wrong passphrase says so and leaves the data intact.
- [ ] **Emergency Reset on each key mode** (packaged build, with a phone joined and a few messages sent).
  *Off and ephemeral:* the node keeps running empty, the phone shows the neutral disconnected screen and purges.
  *Persistent and passphrase:* the node restarts under a fresh secret (`device-secret.enc` is new), the old
  database is gone, no `.loam-wipe-phase` is left, and the same passphrase opens the new empty network. Kill
  the app at a few points during the reset (after the journal appears, between deleting the secret and the
  journal) and start it again: it finishes the reset and never serves the old data. In every mode the host
  window's Activity screen keeps nothing from before the reset (one line says the log went with the network),
  with the Activity tab open during the reset and when opened afterwards.
- [ ] **Stop, Quit and reopen.** Closing the window keeps the phone connected; Quit stops the node within 10 s;
  reopening a persistent network restores its messages, an ephemeral one starts empty, and the host is still
  admin in **Open LOAM** (the client window keeps its identity on disk except for ephemeral networks). Press
  Stop while a phone is mid-upload: it stops within 10 s all the same. On an encrypted network, with messages
  shown in **Open LOAM**, quit and look in the profile folder (`Partitions/loam-client/IndexedDB` under
  `userData`): no `loam-poc` database exists; on an unencrypted network it does.
- [ ] **A reset from the web client that cannot finish.** Make the data folder read-only mid-run (or fill the
  disk), run Emergency Reset from the web admin screen: within 30 s the host window shows "Emergency Reset
  didn't finish" (or restarts to finish a journaled one), never a Running screen over a node answering 503.
- [ ] **Start a new network** from Settings erases the old network (devices purge), the keychain item or secret
  file, and the client window's stored copy, and returns to Setup.
- [ ] **Windows reserved ports.** On a PC with Hyper-V or WSL, `netsh interface ipv4 show excludedportrange
  protocol=tcp` lists blocks the system denies to everyone (EACCES, not "in use"); if one covers 3000, the app
  still starts, on the first port past the block, and the TUI (`loamnet`) does the same.
- [ ] **Windows durable writes.** The same crash and power-cut check as docs/25 O3, with the packaged app.
- [ ] **The client window closes with the node.** With **Open LOAM** showing a conversation, press Stop: the
  client window closes. Start the node again and reopen it from the host window or the tray: it loads LOAM
  and the host is still admin. Repeat with a Retry from the Failed screen and with an Emergency Reset on a
  persistent or passphrase network (the fixed-key handoff). An Off or ephemeral network's in-process reset
  reloads the open window instead of closing it.
- [ ] **The assistant page opens at its section.** Settings, Assistant card: the client window opens at
  `http://127.0.0.1:<port>/#/admin?section=llm` and scrolls to the Assistant section once the admin page has
  loaded.

## 6. Web client in a real browser and `loamnet`

- [ ] **A reload sends only `/`.** In a desktop browser on another machine, join a network by its QR or join
  link, open a direct message (the address ends `/#/dm/<id>`), open the browser's network panel with
  "Preserve log" on, and reload. The only page request is `GET /`; no request path carries the
  conversation id. Repeat on a phone browser (remote debugging) with a plain-HTTP LAN address, where the
  service worker doesn't register. Then type an old-style address (`http://<node>/dm/<id>`): it opens, and
  the address bar shows `/#/dm/<id>` afterwards.
- [ ] **`loamnet`'s admin link opens on `127.0.0.1`.** Run `npx loamnet`, press `o` (open as admin): the
  browser opens `http://127.0.0.1:<port>#k=…&a=…` (not `localhost`) and the session becomes admin. Separately, check that a code nobody used
  is retired: press `o`, then `p` for the phone's code, note its link without opening it, close the panel,
  and open that link in a private window: it no longer grants admin. In plain mode
  (`--plain`), "Open on this device" prints `http://127.0.0.1:<port>`. Start it again with `CLIENT_PORT` set
  to a port other than `PORT`: both links use the port LOAM listens on, not `CLIENT_PORT`.

## Reporting

Note the device model, Android version, and build SHA with each result. A failure on any
item is a native-runtime finding worth escalating; a clean pass closes the branch's remaining work.

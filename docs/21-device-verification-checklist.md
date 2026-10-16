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

The desktop app ([docs/24](24-electron-desktop.md)) is covered by 202 Vitest tests, a CI typecheck and, for
the Linux AppImage only, a packaged `--smoke` run. Everything below needs a real machine. Download the
installers from the tag build (or run `pnpm --filter @loam/desktop dist` on the machine), start from a clean
user account or delete the app's `LOAM` data folder first, and note the OS version, architecture and build with
each result. Machines to cover: a Mac on Apple Silicon and one on Intel, a Windows 10 or 11 PC, and a Linux
desktop with a secret service (GNOME Keyring or KWallet) and one without.

- [ ] **Packaged `--smoke` on each OS.** `LOAM.app/Contents/MacOS/LOAM --smoke`, `LOAM.exe --smoke` (from an
  installed copy), `./LOAM-linux-x64.AppImage --smoke`, each with `LOAM_SMOKE_REQUIRE_ENCRYPTION=1`. Prints one
  JSON line with `"ok":true` and `"driver":"better-sqlite3-multiple-ciphers"`, exits 0, leaves no `loam-smoke-*`
  folder and no keychain prompt.
- [ ] **Unsigned Gatekeeper path (macOS).** Download the `.dmg` through a browser (so it is quarantined), drag
  LOAM to Applications, open it: macOS refuses, System Settings, Privacy & Security, **Open Anyway** works once,
  and the app is not reported as "damaged" on Apple Silicon. Repeat on Intel.
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
  decides; on an unsigned macOS build it asks again after installing a newer build ("Always Allow" covered the old
  one only). Denying it ends in the Failed screen (`keychain_unavailable` or `db_encryption_locked`), never a
  silent plaintext start. Check `device-secret.enc` exists and `device-secret.key` does not.
- [ ] **No keychain (Linux without a secret service).** Setup does not offer the keychain mode, says why, and
  defaults Community to a passphrase; a passphrase network starts, restarts through the Unlock screen, and
  keeps its secret in `device-secret.key`. A wrong passphrase says so and leaves the data intact.
- [ ] **Emergency Reset on each key mode** (packaged build, with a phone joined and a few messages sent).
  *Off and ephemeral:* the node keeps running empty, the phone shows the neutral disconnected screen and purges.
  *Persistent and passphrase:* the node restarts under a fresh secret (`device-secret.enc` is new), the old
  database is gone, no `.loam-wipe-phase` is left, and the same passphrase opens the new empty network. Kill
  the app at a few points during the reset (after the journal appears, between deleting the secret and the
  journal) and start it again: it finishes the reset and never serves the old data.
- [ ] **Stop, Quit and reopen.** Closing the window keeps the phone connected; Quit stops the node within 10 s;
  reopening a persistent network restores its messages, an ephemeral one starts empty, and the host is still
  admin in **Open LOAM** (the client window keeps its storage on disk except for ephemeral networks).
- [ ] **Start a new network** from Settings erases the old network (devices purge), the keychain item or secret
  file, and the client window's stored copy, and returns to Setup.
- [ ] **Windows durable writes.** The same crash and power-cut check as docs/25 O3, with the packaged app.

## Reporting

Note the device model, Android version, and build SHA with each result. A failure on any
item is a native-runtime finding worth escalating; a clean pass closes the branch's remaining work.

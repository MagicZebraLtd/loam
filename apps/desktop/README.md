# LOAM desktop app

LOAM for Mac, Windows and Linux (Electron). The person who installs it runs a network: the app starts the
LOAM server inside itself, shows the join QR, and opens the web client in its own window with the host already
admin. Everyone else joins from their phone's browser. It is the desktop sibling of the Android host app and
the `loamnet` terminal app. Download page: [loamnet.com/desktop](https://loamnet.com/desktop). It ships with
LOAM 0.7.0. The Mac builds are signed and notarized; the Windows installer is unsigned for now (SignPath
Foundation signing is planned).

Everything about how it works, how it keeps its key, how Emergency Reset ends, how it is signed and what has
not yet been verified on real machines is in [docs/24](../../docs/24-electron-desktop.md).

## Develop

From the repo root, once:

```bash
pnpm install
pnpm -r build                  # workspace packages and the server
pnpm --filter client build     # the web client the app embeds
```

Then:

```bash
pnpm --filter @loam/desktop dev            # build the JS, then `electron .`
pnpm --filter @loam/desktop build:native   # the SQLCipher driver (needed for any encrypted network)
pnpm --filter @loam/desktop smoke          # headless boot check; prints one JSON line, exit 0 or 1
pnpm --filter @loam/desktop typecheck
pnpm --filter @loam/desktop test
```

`ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install` skips the ~100 MB Electron download where you will not run it.
`dev` keeps its data in a separate `LOAM (development)` folder, so it never touches a real network.

## Build an installer

```bash
pnpm --filter @loam/desktop dist           # build + build:native + electron-builder, for this machine → release/
```

Files are named without a version (`LOAM-mac-arm64.dmg`, `LOAM-mac-x64.dmg`, `LOAM-win-x64.exe`,
`LOAM-linux-x64.AppImage`, `LOAM-linux-x64.deb`). Release builds come from `.github/workflows/build-desktop.yml`.
The macOS builds are signed and notarized when the Apple secrets exist (docs/24 "Signing"); without them, and
for Windows until SignPath is set up, the builds are unsigned.

## Where the data lives

Electron's `userData` folder, named `LOAM`: `~/Library/Application Support/LOAM` (macOS), `%APPDATA%\LOAM`
(Windows), `~/.config/LOAM` (Linux). The node's data is in `node/` beside the launcher's `desktop.json`;
the network's key is never in `desktop.json`. Settings has an "Open data folder" button.

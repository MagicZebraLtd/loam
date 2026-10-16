#!/usr/bin/env node
// Builds the desktop app's JavaScript into a self-contained dist/ (electron-builder packs dist/** and
// package.json only, so nothing may be resolved from node_modules at runtime):
//   dist/main/loam-server.js  the LOAM server (shared recipe: scripts/lib/bundle-server.mjs)
//   dist/main/index.js        the main process (ESM; electron and the server bundle stay external)
//   dist/preload/*.cjs        the two preloads (CommonJS: a sandboxed preload can't be ESM)
//   dist/client/              the web client the node serves (copied from apps/client/dist)
//   dist/renderer/            the host shell (vite build of src/renderer, when its config exists)
//   dist/assets/icon.png      the LOAM mark, for the tray
// The SQLCipher driver is scripts/native.mjs's job (dist/main/node_modules/), and survives a rebuild here.
//
// Needs the workspace packages and the web client built first: `pnpm -r build` (or the packages one by one)
// and `pnpm --filter client build`.
//
// Usage: node scripts/build.mjs   (or: pnpm --filter @loam/desktop build)

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

import { assertServerInputsBuilt, bundleServer, repoRoot, SQLITE_DRIVERS } from "../../../scripts/lib/bundle-server.mjs";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(appDir, "dist");
const mainOut = join(dist, "main");

/** Electron 44's Node (24.x) runs the main process and the server; its Chromium runs the preloads. */
const NODE_TARGET = "node24";

assertServerInputsBuilt();

// Clear what this script makes; keep dist/main/node_modules (the native driver, from scripts/native.mjs).
mkdirSync(mainOut, { recursive: true });
for (const name of readdirSync(mainOut)) {
  if (name !== "node_modules") {
    rmSync(join(mainOut, name), { recursive: true, force: true });
  }
}
for (const name of ["preload", "client", "assets"]) {
  rmSync(join(dist, name), { recursive: true, force: true });
}

// 1. The server bundle. Its createRequire finds the SQLCipher driver in dist/main/node_modules.
const server = await bundleServer({
  entry: join(appDir, "src/server-entry.ts"),
  outFile: join(mainOut, "loam-server.js"),
  target: NODE_TARGET,
});

// 2. The main process. The server bundle is imported at runtime (a variable specifier in server-module.ts),
// never inlined; the SQLite drivers are listed too in case anything ever reaches for one directly.
await build({
  entryPoints: [join(appDir, "src/main/index.ts")],
  outfile: join(mainOut, "index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: NODE_TARGET,
  external: ["electron", "./loam-server.js", ...SQLITE_DRIVERS],
  sourcemap: "linked",
  logLevel: "info",
});

// 3. The preloads: CommonJS, `electron` external (the only module a sandboxed preload may require).
await build({
  entryPoints: {
    host: join(appDir, "src/preload/host.cts"),
    client: join(appDir, "src/preload/client.cts"),
  },
  outdir: join(dist, "preload"),
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: NODE_TARGET,
  external: ["electron"],
  logLevel: "info",
});

// 4. The web client the node serves to joiners and to the host's own window.
cpSync(join(repoRoot, "apps/client/dist"), join(dist, "client"), { recursive: true });

// 5. The tray icon.
mkdirSync(join(dist, "assets"), { recursive: true });
cpSync(join(appDir, "build/icon.png"), join(dist, "assets/icon.png"));

// 6. The host shell, built by its own Vite config.
const viteConfig = join(appDir, "vite.config.ts");
if (existsSync(viteConfig)) {
  const { build: viteBuild } = await import("vite");
  await viteBuild({ configFile: viteConfig, root: appDir, logLevel: "warn" });
  if (!existsSync(join(dist, "renderer/index.html"))) {
    throw new Error("The renderer build finished but dist/renderer/index.html is missing: check vite.config.ts's outDir.");
  }
} else {
  console.warn("! No vite.config.ts yet: skipping the renderer. The host window shows a placeholder page until it is built.");
}

const megabytes = (path) => (statSync(path).size / 1024 / 1024).toFixed(2);
console.log(
  `\n✓ Server bundle: ${Object.keys(server.metafile.inputs).length} modules → dist/main/loam-server.js (${megabytes(join(mainOut, "loam-server.js"))} MB)`,
);
console.log(`✓ Main process → dist/main/index.js (${megabytes(join(mainOut, "index.js"))} MB)`);
console.log("✓ Preloads → dist/preload/host.cjs, client.cjs");
console.log("✓ Web client → dist/client");
if (!existsSync(join(mainOut, "node_modules/better-sqlite3-multiple-ciphers"))) {
  console.log("! No SQLCipher driver in dist/main/node_modules yet: run `pnpm --filter @loam/desktop build:native` for encryption.");
}

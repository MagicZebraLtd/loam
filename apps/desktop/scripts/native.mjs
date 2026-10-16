#!/usr/bin/env node
// Puts the SQLCipher driver (better-sqlite3-multiple-ciphers) where the server bundle finds it at runtime:
// dist/main/node_modules/better-sqlite3-multiple-ciphers/. electron-builder packs dist/** only (no
// node_modules, npmRebuild off), so this copy is the only one the packaged app has; its .node file is
// asarUnpack'ed (electron-builder.yml) because a native addon can't be loaded from inside an asar archive.
//
// Since v13 the driver is a Node-API addon (NAPI_VERSION=10) and ships prebuilt binaries for darwin, linux
// and win32 on x64 and arm64. Node-API is ABI-stable across Node and Electron, so the prebuild for the target
// platform loads under Electron 44 as it is: nothing is compiled, and the pnpm store copy (shared with the
// `loamnet` CLI) is only ever read. Only that one prebuild is copied (the package carries all eight).
//
// `--from-source` instead compiles it for Electron with @electron/rebuild, in a TEMPORARY copy of the package
// (never in place), for a platform with no prebuild or to check a driver bump. It needs a C++ toolchain.
//
// Then the result is loaded under this machine's Electron (ELECTRON_RUN_AS_NODE) and made to write and reread
// an encrypted database, unless the target arch can't run here.
//
// Usage: node scripts/native.mjs [--arch arm64|x64] [--platform darwin|linux|win32] [--from-source]
//        (or: pnpm --filter @loam/desktop build:native -- --arch x64)

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const requireFromApp = createRequire(join(appDir, "package.json"));
const DRIVER = "better-sqlite3-multiple-ciphers";
const ARCHES = ["arm64", "x64"];
const PLATFORMS = ["darwin", "linux", "win32"];

/** The value after `--name` (or `--name=value`), else `fallback`. */
function option(name, fallback) {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === `--${name}`) {
      return args[i + 1];
    }
    if (args[i].startsWith(`--${name}=`)) {
      return args[i].slice(name.length + 3);
    }
  }
  return fallback;
}

const arch = option("arch", process.arch);
const platform = option("platform", process.platform);
const fromSource = process.argv.includes("--from-source");
if (!ARCHES.includes(arch) || !PLATFORMS.includes(platform)) {
  console.error(`Unsupported target ${platform}-${arch}: expected --platform ${PLATFORMS.join("|")} and --arch ${ARCHES.join("|")}.`);
  process.exit(1);
}

/** The Electron version, pinned exactly in package.json (a bump means a new native check). */
const electronVersion = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")).devDependencies.electron;
if (!/^\d+\.\d+\.\d+$/.test(electronVersion)) {
  console.error(`electron must be pinned to an exact version in package.json (found "${electronVersion}").`);
  process.exit(1);
}

// The real package directory (pnpm links it from the store; reading through the link is fine, writing never is).
const source = realpathSync(dirname(requireFromApp.resolve(`${DRIVER}/package.json`)));
const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
const outDir = join(appDir, "dist/main/node_modules", DRIVER);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
cpSync(join(source, "package.json"), join(outDir, "package.json"));
cpSync(join(source, "LICENSE"), join(outDir, "LICENSE"));
cpSync(join(source, "lib"), join(outDir, "lib"), { recursive: true });

if (fromSource) {
  await buildFromSource();
} else {
  // The glibc build on Linux: the AppImage and .deb target glibc desktops (musl prebuilds aren't shipped).
  const prebuild = join(source, "prebuilds", `${platform}-${arch}.node`);
  if (!existsSync(prebuild)) {
    console.error(`${DRIVER} ${manifest.version} has no prebuild for ${platform}-${arch}. Run with --from-source.`);
    process.exit(1);
  }
  mkdirSync(join(outDir, "prebuilds"), { recursive: true });
  cpSync(prebuild, join(outDir, "prebuilds", `${platform}-${arch}.node`));
  console.log(`✓ ${DRIVER} ${manifest.version}: Node-API prebuild for ${platform}-${arch} → dist/main/node_modules/${DRIVER}`);
}

/**
 * Compile the driver for Electron in a temporary copy laid out as <tmp>/node_modules/<driver> (with its
 * build-time dependency node-addon-api beside it and the prebuilds removed, so binding.gyp builds instead of
 * deferring to one), then copy only build/Release/better_sqlite3.node, where lib/binding.js looks when no
 * prebuild matches.
 */
async function buildFromSource() {
  if (platform !== process.platform) {
    console.error("--from-source builds for this machine's platform only (use --arch for the other architecture).");
    process.exit(1);
  }
  const { rebuild } = await import("@electron/rebuild");
  const temp = mkdtempSync(join(tmpdir(), "loam-native-"));
  try {
    const copy = join(temp, "node_modules", DRIVER);
    // Leave out the prebuilds (binding.gyp skips the build when one matches) and any earlier local build.
    const skipped = new Set([join(source, "prebuilds"), join(source, "build")]);
    cpSync(source, copy, { recursive: true, dereference: true, filter: (path) => !skipped.has(path) });
    const addonApi = realpathSync(dirname(createRequire(join(source, "package.json")).resolve("node-addon-api/package.json")));
    cpSync(addonApi, join(temp, "node_modules", "node-addon-api"), { recursive: true, dereference: true });
    writeFileSync(
      join(temp, "package.json"),
      JSON.stringify({ name: "loam-native-build", private: true, dependencies: { [DRIVER]: manifest.version } }),
    );
    console.log(`Compiling ${DRIVER} ${manifest.version} for Electron ${electronVersion} (${platform}-${arch})...`);
    await rebuild({ buildPath: temp, electronVersion, arch, onlyModules: [DRIVER], force: true, mode: "sequential" });
    const built = join(copy, "build", "Release", "better_sqlite3.node");
    if (!existsSync(built)) {
      throw new Error(`The build produced no ${built}`);
    }
    mkdirSync(join(outDir, "build", "Release"), { recursive: true });
    cpSync(built, join(outDir, "build", "Release", "better_sqlite3.node"));
    console.log(`✓ ${DRIVER} ${manifest.version}: built for Electron ${electronVersion} → dist/main/node_modules/${DRIVER}`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  verify();
}

/**
 * Load the copied driver under this machine's Electron, as the server bundle will (createRequire from
 * dist/main/), key a database file, write a row, reopen and read it, and check the file isn't plaintext SQLite.
 */
function verify() {
  if (platform !== process.platform || arch !== process.arch) {
    console.log(`(Not loading the ${platform}-${arch} driver under this ${process.platform}-${process.arch} Electron.)`);
    return;
  }
  const electron = requireFromApp("electron");
  const check = `
    const { createRequire } = require("node:module");
    const { mkdtempSync, readFileSync, rmSync } = require("node:fs");
    const { join } = require("node:path");
    const { tmpdir } = require("node:os");
    const Database = createRequire(process.argv[1])(${JSON.stringify(DRIVER)});
    const dir = mkdtempSync(join(tmpdir(), "loam-native-check-"));
    try {
      const file = join(dir, "check.db");
      let db = new Database(file);
      db.pragma("key = 'loam-native-check'");
      db.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('ok')");
      db.close();
      if (readFileSync(file).subarray(0, 15).toString("latin1") === "SQLite format 3") throw new Error("the file was written in plaintext");
      db = new Database(file);
      db.pragma("key = 'loam-native-check'");
      const row = db.prepare("SELECT v FROM t").get();
      db.close();
      if (!row || row.v !== "ok") throw new Error("the row didn't read back");
      process.stdout.write(JSON.stringify({ ok: true, node: process.versions.node, napi: process.versions.napi, electron: process.versions.electron }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  `;
  const output = execFileSync(electron, ["-e", check, join(appDir, "dist/main/loam-server.js")], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    encoding: "utf8",
  });
  const result = JSON.parse(output.trim());
  console.log(`✓ Loads under Electron ${result.electron ?? electronVersion} (Node ${result.node}, Node-API ${result.napi}): wrote and reread an encrypted database`);
}

if (!fromSource) {
  verify();
}

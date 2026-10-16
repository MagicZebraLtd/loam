// The esbuild recipe that bundles the LOAM server into one self-contained ESM file, shared by every launcher
// that boots it in plain Node: the `loamnet` npm package (scripts/build-cli.mjs) and the desktop app
// (apps/desktop/scripts/build.mjs). The Android host has its own CJS recipe (apps/app/scripts/
// bundle-server.mjs) because nodejs-mobile's Node can't load ESM bundles.
//
// The @loam/* workspace packages are inlined from their compiled dist/ (run `pnpm -r build` first). The
// three SQLite drivers stay external: node:sqlite is a Node >=22 builtin (the default, zero node-gyp);
// better-sqlite3(-multiple-ciphers) are optional native deps resolved at runtime, next to the bundle, only
// when an alternate or encrypted driver is requested.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

/** The repository root (this file lives in scripts/lib/). */
export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** The SQLite drivers no bundle may inline: a builtin and two native modules found at runtime. */
export const SQLITE_DRIVERS = ["node:sqlite", "better-sqlite3", "better-sqlite3-multiple-ciphers"];

/** The workspace packages the server bundle inlines from their dist/. */
const WORKSPACE_PACKAGES = ["schema", "display-name", "avatar", "qr", "crypto", "tui"];

/** Stop with the command to run when `path` is missing. */
export function assertBuilt(path, hint) {
  if (!existsSync(path)) {
    throw new Error(`Missing ${path}. Run \`${hint}\` first.`);
  }
}

/** Check that every package the bundle inlines, and the web client it serves, has been built. */
export function assertServerInputsBuilt() {
  for (const pkg of WORKSPACE_PACKAGES) {
    assertBuilt(join(repoRoot, `packages/${pkg}/dist/index.js`), "pnpm -r build");
  }
  assertBuilt(join(repoRoot, "apps/client/dist"), "pnpm --filter client build");
}

/**
 * Some bundled deps are CommonJS and call `require(...)` / read `__dirname` (e.g. @fastify/websocket, fastify
 * itself). ESM output has neither, so esbuild's `__require` shim throws on them. Recreate the CJS globals from
 * import.meta.url at the top of the bundle so those requires resolve normally (and db.ts's `createRequire`
 * finds the native driver next to the bundle).
 */
const CJS_GLOBALS_BANNER = [
  "import { createRequire as __loamCreateRequire } from 'node:module';",
  "import { fileURLToPath as __loamFileURLToPath } from 'node:url';",
  "import { dirname as __loamDirname } from 'node:path';",
  "const require = __loamCreateRequire(import.meta.url);",
  "const __filename = __loamFileURLToPath(import.meta.url);",
  "const __dirname = __loamDirname(__filename);",
].join("\n");

/**
 * Bundle `entry` (a module re-exporting what the launcher needs from the server) to `outFile`.
 * Resolves esbuild's result, with its metafile.
 *
 * @param {{ entry: string, outFile: string, target?: string, sourcemap?: boolean }} options
 *   `target` defaults to node22, the oldest Node the CLI supports; `sourcemap` defaults to off.
 */
export async function bundleServer({ entry, outFile, target = "node22", sourcemap = false }) {
  return build({
    entryPoints: [entry],
    outfile: outFile,
    bundle: true,
    platform: "node",
    format: "esm",
    target,
    sourcemap,
    external: SQLITE_DRIVERS,
    banner: { js: CJS_GLOBALS_BANNER },
    metafile: true,
    logLevel: "info",
  });
}

#!/usr/bin/env node
// Bundles the LOAM server into a single self-contained ESM file for the `loamnet` npm package, and
// copies the built web client alongside it. The published package boots a full node (server + PWA)
// from `bin/loam.js`, which imports `startEmbeddedServer` (and the QR helpers) from the bundle
// produced here.
//
// The esbuild recipe itself (ESM, node22, the CJS-globals banner, the SQLite drivers external, @loam/*
// inlined from dist/) is shared with the desktop app: scripts/lib/bundle-server.mjs. What is the CLI's own:
//   - the entry (cli/cli-entry.ts) re-exports startEmbeddedServer + the @loam/qr helpers + the terminal UI
//     as a library, so bin/loam.js controls env setup and the join-QR print before booting.
//   - output lands in cli/ (the publishable package), not nodejs-assets/.
//   - dist/THIRD_PARTY_NOTICES.txt lists the bundled open-source packages (scripts/third-party-notices.mjs).
//
// Usage: node scripts/build-cli.mjs   (or: pnpm build:cli)

import { cpSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { assertServerInputsBuilt, bundleServer, repoRoot } from "./lib/bundle-server.mjs";
import { writeNotices } from "./third-party-notices.mjs";

const entry = join(repoRoot, "cli/cli-entry.ts");
const clientDist = join(repoRoot, "apps/client/dist");
const pkgDir = join(repoRoot, "cli");
const outFile = join(pkgDir, "dist/loam-server.js");
const clientOut = join(pkgDir, "client");

assertServerInputsBuilt();

// Rebuild the generated artifacts (dist bundle + copied client); leave bin/ and package.json alone.
rmSync(join(pkgDir, "dist"), { recursive: true, force: true });
rmSync(clientOut, { recursive: true, force: true });
mkdirSync(dirname(outFile), { recursive: true });

const result = await bundleServer({ entry, outFile });

cpSync(clientDist, clientOut, { recursive: true });

// The licences of everything the bundle inlines travel with it (dist/ is in the package's `files`).
writeNotices("cli");

const bytes = statSync(outFile).size;
const inputs = Object.keys(result.metafile.inputs).length;
console.log(
  `\n✓ Bundled ${inputs} modules → ${outFile.replace(`${repoRoot}/`, "")} (${(bytes / 1024 / 1024).toFixed(2)} MB)`,
);
console.log(`✓ Copied web client → ${clientOut.replace(`${repoRoot}/`, "")}`);

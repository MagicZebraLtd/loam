#!/usr/bin/env node
// Writes THIRD_PARTY_NOTICES.txt: the open-source software a LOAM build bundles, with each package's licence.
// LOAM is AGPL-3.0-only, but its bundles inline MIT/ISC/BSD-licensed code (esbuild inlines fastify, pino, zod,
// @noble/* into the server bundle; Vite inlines preact, snarkdown, DOMPurify into the web client) whose
// licences ask for their notices to travel with every copy. So every distribution carries this file beside
// its code, generated at build time and never committed:
//
//   web      apps/client/public/third-party-notices.txt  → apps/client/dist, served at /third-party-notices.txt
//   cli      cli/dist/THIRD_PARTY_NOTICES.txt             (scripts/build-cli.mjs)
//   desktop  apps/desktop/dist/THIRD_PARTY_NOTICES.txt    (apps/desktop/scripts/build.mjs)
//   android  apps/app/nodejs-assets/nodejs-project/THIRD_PARTY_NOTICES.txt  (apps/app/scripts/bundle-server.mjs)
//
// The npm part walks the installed PRODUCTION dependency tree (dependencies + optionalDependencies) of each
// preset's workspace packages under node_modules, the way Node resolves them (so pnpm's .pnpm layout works):
// workspace packages are walked through but not listed (they are LOAM). The native part (Electron, Node.js
// for Android, llama.cpp, the SQLite drivers) comes from the hand-maintained scripts/third-party-native.json.
// Needs only node_modules, not built packages, and no dependencies. Output is deterministic (no dates).
//
// Usage: node scripts/third-party-notices.mjs <web|cli|desktop|android> [--out <file>]

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The repository root (this file lives in scripts/). */
export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const LICENSE_URL = "https://github.com/MagicZebraLtd/loam/blob/master/LICENSE";
const RULE = "-".repeat(78);

/**
 * What each distribution lists. `roots` are workspace package dirs: `{ dir }` walks that package's
 * production dependencies, `{ dir, only }` just the named dependencies of it (any dependency field, for a
 * package whose bundled deps are devDependencies). `exclude` drops a package reached as a transitive or
 * production dependency (one named in `only` is always kept); `scanDirs` lists every package installed
 * directly in a node_modules folder (no walk); `native` picks the third-party-native.json entries; `note`
 * is an extra header paragraph.
 */
export const PRESETS = {
  web: {
    title: "LOAM web client",
    covers:
      "the LOAM web client: the app people open in their browser, served by every LOAM host (the Android app, " +
      "the desktop app and loamnet) at /third-party-notices.txt. The host's own software has its own notices file.",
    roots: [{ dir: "apps/client" }],
    exclude: [],
    native: null,
    out: "apps/client/public/third-party-notices.txt",
  },
  cli: {
    title: "loamnet (the LOAM command-line host)",
    covers:
      "the loamnet npm package: its bundled server (dist/loam-server.js, which inlines the packages below) and " +
      "the web client it serves (client/, which also carries its own third-party-notices.txt).",
    roots: [{ dir: "apps/server" }, { dir: "packages/qr" }, { dir: "packages/tui" }, { dir: "apps/client" }, { dir: "cli" }],
    // External in the bundle; npm installs it separately, only for --encrypt (listed under native components).
    exclude: ["better-sqlite3-multiple-ciphers"],
    native: "cli",
    out: "cli/dist/THIRD_PARTY_NOTICES.txt",
  },
  desktop: {
    title: "LOAM for desktop (macOS, Windows, Linux)",
    covers:
      "the LOAM desktop app: its bundled server and main process (dist/main/), the host window (dist/renderer/), " +
      "the web client it serves (dist/client/) and the components listed under Native components.",
    roots: [
      { dir: "apps/server" },
      { dir: "apps/client" },
      { dir: "apps/desktop", only: ["@loam/qr", "@loam/schema", "@loam/tui", "preact", "zod"] },
    ],
    // The server's own copy is external; the desktop ships the newer one, listed under native components.
    exclude: ["better-sqlite3-multiple-ciphers"],
    native: "desktop",
    out: "apps/desktop/dist/THIRD_PARTY_NOTICES.txt",
  },
  android: {
    title: "LOAM for Android",
    covers:
      "the LOAM Android app: the host app (React Native and Expo), its embedded server (loam-server.js and the " +
      "SQLite drivers in node_modules/ beside it), the web client it serves (client/) and the native libraries " +
      "listed under Native components.",
    note:
      "The npm list is the host app's whole production dependency tree as installed, so it also names some " +
      "build tools (Expo's and React Native's) whose code doesn't end up in the app.",
    roots: [{ dir: "apps/server" }, { dir: "apps/client" }, { dir: "apps/app" }],
    // External in the bundle: the vendored copies in nodejs-project/node_modules are listed from there instead.
    exclude: ["better-sqlite3", "better-sqlite3-multiple-ciphers"],
    scanDirs: ["apps/app/nodejs-assets/nodejs-project/node_modules"],
    native: "android",
    out: "apps/app/nodejs-assets/nodejs-project/THIRD_PARTY_NOTICES.txt",
  },
};

/** Read and parse `dir/package.json`, or undefined when there is none. */
export function readManifest(dir) {
  const file = join(dir, "package.json");
  if (!existsSync(file)) {
    return undefined;
  }
  return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * Find the installed package `name` as Node would from `fromDir`: `<ancestor>/node_modules/<name>` for each
 * ancestor (an ancestor that is itself a node_modules folder is searched directly, which is how pnpm's
 * .pnpm/<pkg>/node_modules siblings resolve). Returns the real (symlink-resolved) directory, or undefined.
 */
export function resolvePackageDir(name, fromDir) {
  let current = fromDir;
  for (;;) {
    const base = basename(current) === "node_modules" ? current : join(current, "node_modules");
    const candidate = join(base, name);
    if (existsSync(join(candidate, "package.json"))) {
      return realpathSync(candidate);
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

/** The licence file names this recognises: LICENSE / LICENCE / COPYING, any case, any extension or suffix. */
const LICENSE_FILE = /^(licen[cs]e|copying)([.\-_].*)?$/i;

/**
 * The licence file in a package's own folder, or undefined. When there are several (LICENSE and
 * LICENSE-MIT…), all are kept, in name order, so a dual-licensed package keeps both texts.
 */
export function findLicenseTexts(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => LICENSE_FILE.test(name) && statSync(join(dir, name)).isFile())
    .sort()
    .map((name) => ({ file: name, text: normalizeText(readFileSync(join(dir, name), "utf8")) }));
}

/** LF line ends, no trailing spaces, no leading/trailing blank lines. */
function normalizeText(text) {
  return text
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
}

/** A manifest's licence as one SPDX-ish string (`license`, a legacy `{ type }` or `licenses` array), or UNKNOWN. */
export function licenseOf(manifest) {
  const { license, licenses } = manifest;
  if (typeof license === "string" && license.trim()) {
    return license.trim();
  }
  if (license && typeof license === "object" && typeof license.type === "string") {
    return license.type;
  }
  if (Array.isArray(licenses) && licenses.length > 0) {
    return licenses.map((entry) => (typeof entry === "string" ? entry : entry?.type)).filter(Boolean).join(" OR ");
  }
  return "UNKNOWN";
}

/** A manifest's source repository as a browsable URL, or undefined. */
export function repositoryOf(manifest) {
  const raw = typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url;
  if (typeof raw === "string" && raw) {
    let url = raw.replace(/^git\+/, "").replace(/\.git$/, "").replace(/^git:\/\//, "https://").replace(/^ssh:\/\/git@/, "https://");
    if (/^github:/.test(url) || /^[\w.-]+\/[\w.-]+$/.test(url)) {
      url = `https://github.com/${url.replace(/^github:/, "")}`;
    }
    return url.replace(/^git@github\.com:/, "https://github.com/");
  }
  return typeof manifest.homepage === "string" ? manifest.homepage : undefined;
}

/** A dependency spec that names a workspace package (LOAM's own code, never listed). */
function isWorkspaceSpec(spec) {
  return typeof spec === "string" && /^(workspace|link|file):/.test(spec);
}

/** True when `dir` isn't inside any node_modules folder (a workspace package reached through a symlink). */
function outsideNodeModules(dir) {
  return !dir.split(sep).includes("node_modules");
}

/**
 * Walk the production dependency trees under `roots` (absolute dirs; `only` limits a root to the named
 * dependencies) and the packages installed directly in `scanDirs`. Returns `{ packages, missing }`:
 * `packages` sorted by name then version, deduped by name@version; `missing` the required dependencies
 * that weren't installed (optional ones that aren't, like another platform's binary, are skipped quietly).
 */
export function collectPackages({ roots, exclude = [], scanDirs = [] }) {
  const excluded = new Set(exclude);
  const byKey = new Map();
  const missing = new Set();
  const visited = new Set();
  const queue = [];

  /** Queue the dependencies of the package at `dir` (whose manifest is `manifest`). */
  const enqueueDeps = (dir, manifest, only) => {
    const fields = only
      ? { ...manifest.devDependencies, ...manifest.optionalDependencies, ...manifest.dependencies }
      : { ...manifest.optionalDependencies, ...manifest.dependencies };
    const optional = new Set(Object.keys(manifest.optionalDependencies ?? {}));
    const names = only ?? Object.keys(fields);
    for (const name of names) {
      if (!only && excluded.has(name)) {
        continue;
      }
      queue.push({ name, spec: fields[name], from: dir, optional: optional.has(name) && !(name in (manifest.dependencies ?? {})) });
    }
  };

  /** Record the package at `dir` (unless it is a workspace package) and walk into its dependencies. */
  const visit = (dir, workspace) => {
    if (visited.has(dir)) {
      return;
    }
    visited.add(dir);
    const manifest = readManifest(dir);
    if (!manifest) {
      return;
    }
    if (!workspace) {
      const key = `${manifest.name}@${manifest.version}`;
      if (!byKey.has(key)) {
        byKey.set(key, {
          name: manifest.name,
          version: manifest.version,
          license: licenseOf(manifest),
          repository: repositoryOf(manifest),
          licenseTexts: findLicenseTexts(dir),
        });
      }
    }
    enqueueDeps(dir, manifest);
  };

  for (const root of roots) {
    const manifest = readManifest(root.dir);
    if (!manifest) {
      throw new Error(`No package.json in ${root.dir}`);
    }
    visited.add(realpathSync(root.dir));
    enqueueDeps(realpathSync(root.dir), manifest, root.only);
  }

  while (queue.length > 0) {
    const { name, spec, from, optional } = queue.shift();
    const dir = resolvePackageDir(name, from);
    if (!dir) {
      if (!optional) {
        missing.add(name);
      }
      continue;
    }
    visit(dir, isWorkspaceSpec(spec) || outsideNodeModules(dir));
  }

  for (const scanDir of scanDirs) {
    if (!existsSync(scanDir)) {
      continue;
    }
    const entries = readdirSync(scanDir).sort();
    for (const entry of entries) {
      if (entry.startsWith(".")) {
        continue;
      }
      const dirs = entry.startsWith("@") ? readdirSync(join(scanDir, entry)).sort().map((name) => join(scanDir, entry, name)) : [join(scanDir, entry)];
      for (const dir of dirs) {
        if (outsideNodeModules(realpathSync(dir))) {
          continue; // a linked workspace package: LOAM's own code
        }
        const manifest = readManifest(dir);
        const key = manifest && `${manifest.name}@${manifest.version}`;
        if (manifest && !byKey.has(key)) {
          byKey.set(key, {
            name: manifest.name,
            version: manifest.version,
            license: licenseOf(manifest),
            repository: repositoryOf(manifest),
            licenseTexts: findLicenseTexts(dir),
          });
        }
      }
    }
  }

  return { packages: sortPackages([...byKey.values()]), missing: [...missing].sort() };
}

/** Sort by name, then version (both plain code-point order, so the output never depends on the locale). */
export function sortPackages(packages) {
  const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return [...packages].sort((a, b) => compare(a.name, b.name) || compare(a.version, b.version));
}

/**
 * The native components for `build` from the hand-maintained list, with versions and licence texts read from
 * the installed packages they name (relative to `root`), falling back to the list's own text.
 */
export function nativeComponents(list, build, root = repoRoot) {
  if (!build) {
    return [];
  }
  return list.components
    .filter((component) => component.builds.includes(build))
    .map((component) => {
      let version = component.version;
      if (component.versionFrom) {
        const dir = resolvePackageDir(component.versionFrom.package, join(root, component.versionFrom.dir));
        const installed = dir && readManifest(dir)?.version;
        version = installed ? `${component.versionPrefix ?? ""}${installed}` : version;
      }
      let licenseText = component.licenseText;
      if (component.licenseFrom) {
        const dir = resolvePackageDir(component.licenseFrom.package, join(root, component.licenseFrom.dir));
        const file = dir && join(dir, component.licenseFrom.file);
        if (file && existsSync(file)) {
          licenseText = readFileSync(file, "utf8");
        }
      }
      return {
        name: component.name,
        version,
        license: component.license,
        url: component.url,
        note: component.note,
        licenseText: licenseText ? normalizeText(licenseText) : undefined,
      };
    });
}

/** Word-wrap a paragraph to `width` columns. */
function wrap(text, width = 78) {
  const lines = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) {
    lines.push(line);
  }
  return lines.join("\n");
}

/** The text for one npm package's entry. */
function renderPackage(pkg) {
  const head = [`${pkg.name}@${pkg.version}`, `License: ${pkg.license}`];
  if (pkg.repository) {
    head.push(`Source: ${pkg.repository}`);
  }
  let body;
  if (pkg.licenseTexts.length > 0) {
    body = pkg.licenseTexts.map((entry, index) => (index === 0 ? entry.text : `(${entry.file})\n\n${entry.text}`)).join("\n\n");
  } else {
    const spdx = /^[A-Za-z0-9.+-]+$/.test(pkg.license) && pkg.license !== "UNKNOWN" ? ` (https://spdx.org/licenses/${pkg.license}.html)` : "";
    body = wrap(`This package includes no licence file. Its package.json declares the licence ${pkg.license}${spdx}.`);
  }
  return `${head.join("\n")}\n\n${body}`;
}

/** The text for one native component's entry. */
function renderNative(component) {
  const head = [component.name];
  if (component.version) {
    head.push(`Version: ${component.version}`);
  }
  head.push(`License: ${component.license}`, `Source: ${component.url}`);
  const parts = [head.join("\n")];
  if (component.note) {
    parts.push(wrap(component.note));
  }
  parts.push(component.licenseText ?? wrap(`See the licence of the package named above (${component.license}).`));
  return parts.join("\n\n");
}

/** The whole notices file for a preset's title/covers, its npm packages and its native components. */
export function renderNotices({ title, covers, note, packages, native = [] }) {
  const header = [
    `THIRD-PARTY SOFTWARE NOTICES: ${title}`,
    "",
    wrap(
      "LOAM is free software by Magic Zebra Ltd, licensed under the GNU Affero General Public License, " +
        `version 3 only (AGPL-3.0-only): ${LICENSE_URL}`,
    ),
    "",
    wrap(
      `This file covers ${covers} It lists the open-source software bundled with this build, each under its own ` +
        "licence, whose text follows its entry (or, where a package ships no licence file, the licence its " +
        "package.json declares).",
    ),
    ...(note ? ["", wrap(note)] : []),
    "",
    `${packages.length} npm packages${native.length > 0 ? `, ${native.length} native components` : ""}.`,
  ].join("\n");
  const heading = (text) => `${"=".repeat(78)}\n${text}\n${"=".repeat(78)}`;
  const section = (entries) => entries.join(`\n\n${RULE}\n\n`);
  const parts = [header, heading("NPM PACKAGES"), section(packages.map(renderPackage))];
  if (native.length > 0) {
    parts.push(heading("NATIVE COMPONENTS"), section(native.map(renderNative)));
  }
  return `${parts.join("\n\n")}\n`;
}

/**
 * Generate and write the notices file for `presetName`. Returns `{ out, packages, native, missing }`.
 * `out` overrides the preset's path (absolute, or relative to the repo root).
 */
export function writeNotices(presetName, { out, root = repoRoot, log = console.log } = {}) {
  const preset = PRESETS[presetName];
  if (!preset) {
    throw new Error(`Unknown preset "${presetName}" (one of: ${Object.keys(PRESETS).join(", ")})`);
  }
  const { packages, missing } = collectPackages({
    roots: preset.roots.map((rootSpec) => ({ ...rootSpec, dir: join(root, rootSpec.dir) })),
    exclude: preset.exclude,
    scanDirs: (preset.scanDirs ?? []).map((dir) => join(root, dir)),
  });
  const list = JSON.parse(readFileSync(join(root, "scripts/third-party-native.json"), "utf8"));
  const native = nativeComponents(list, preset.native, root);
  const outFile = out ? (out.startsWith("/") ? out : join(root, out)) : join(root, preset.out);
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, renderNotices({ title: preset.title, covers: preset.covers, note: preset.note, packages, native }));
  if (missing.length > 0) {
    console.warn(`! Third-party notices: not installed, so not listed: ${missing.join(", ")}`);
  }
  log(`✓ Third-party notices: ${packages.length} npm packages, ${native.length} native components → ${relative(root, outFile)}`);
  return { out: outFile, packages, native, missing };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  const out = outIndex >= 0 ? args[outIndex + 1] : undefined;
  const preset = args.find((arg, index) => !arg.startsWith("--") && (outIndex < 0 || index !== outIndex + 1));
  if (!preset || (outIndex >= 0 && !out)) {
    console.error(`Usage: node scripts/third-party-notices.mjs <${Object.keys(PRESETS).join("|")}> [--out <file>]`);
    process.exit(2);
  }
  writeNotices(preset, { out: out && !out.startsWith("/") ? join(process.cwd(), out) : out });
}

// Tests for scripts/third-party-notices.mjs's pure parts, over a fake pnpm-style node_modules tree.
// Run: node --test scripts/third-party-notices.test.mjs (the root `pnpm test` runs it via test:scripts).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { after, before, describe, it } from "node:test";

import { collectPackages, licenseOf, nativeComponents, renderNotices, sortPackages } from "./third-party-notices.mjs";

let root;

/** Write a package.json (and any extra files) into `dir`. */
function pkg(dir, manifest, files = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(dir, name), text);
  }
}

/** Link `linkPath` to `target` the way pnpm does (a relative directory symlink). */
function link(target, linkPath) {
  mkdirSync(dirname(linkPath), { recursive: true });
  symlinkSync(relative(dirname(linkPath), target), linkPath, "dir");
}

/** The store copy of `name@version` under .pnpm. */
function store(name, version) {
  return join(root, "node_modules/.pnpm", `${name}@${version}`, "node_modules", name);
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "loam-notices-"));
  // a@1.0.0 depends on b and (optionally) on a binary for another platform that isn't installed.
  pkg(store("a", "1.0.0"), { name: "a", version: "1.0.0", license: "MIT", dependencies: { b: "^2" }, optionalDependencies: { "a-other-os": "1" } }, {
    LICENSE: "MIT License\r\n\r\nCopyright (c) A   \r\n",
  });
  pkg(store("b", "2.0.0"), { name: "b", version: "2.0.0", license: "ISC", repository: "git+https://github.com/example/b.git" });
  link(store("b", "2.0.0"), join(root, "node_modules/.pnpm/a@1.0.0/node_modules/b"));
  // Two versions of c, reached from different places, each listed.
  pkg(store("c", "1.0.0"), { name: "c", version: "1.0.0", license: { type: "BSD-3-Clause" } }, { "licence.md": "BSD c 1" });
  pkg(store("c", "10.0.0"), { name: "c", version: "10.0.0", license: "BSD-3-Clause" }, { "LICENSE.txt": "BSD c 10" });
  pkg(store("dropped", "1.0.0"), { name: "dropped", version: "1.0.0", license: "MIT" });

  // The workspace package `ws`: walked through (its deps listed), never listed itself.
  pkg(join(root, "packages/ws"), { name: "@loam/ws", version: "0.7.0", license: "AGPL-3.0-only", dependencies: { a: "^1", c: "^1" } });
  link(store("a", "1.0.0"), join(root, "packages/ws/node_modules/a"));
  link(store("c", "1.0.0"), join(root, "packages/ws/node_modules/c"));

  // The root app: a workspace dep, a dep it shares with ws (deduped), a second c, an excluded package, a
  // missing required dep, and a devDependency (not production, so not listed).
  pkg(join(root, "apps/app"), {
    name: "app",
    version: "0.7.0",
    dependencies: { "@loam/ws": "workspace:*", a: "^1", c: "^10", dropped: "1", ghost: "1" },
    devDependencies: { devonly: "1" },
  });
  link(join(root, "packages/ws"), join(root, "apps/app/node_modules/@loam/ws"));
  link(store("a", "1.0.0"), join(root, "apps/app/node_modules/a"));
  link(store("c", "10.0.0"), join(root, "apps/app/node_modules/c"));
  link(store("dropped", "1.0.0"), join(root, "apps/app/node_modules/dropped"));
  pkg(join(root, "apps/app/node_modules/devonly"), { name: "devonly", version: "1.0.0", license: "MIT" });
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("collectPackages", () => {
  it("walks workspace packages without listing them, dedupes by name@version and sorts by name then version", () => {
    const { packages } = collectPackages({ roots: [{ dir: join(root, "apps/app") }], exclude: ["dropped"] });
    assert.deepEqual(
      packages.map((entry) => `${entry.name}@${entry.version}`),
      ["a@1.0.0", "b@2.0.0", "c@1.0.0", "c@10.0.0"],
    );
  });

  it("reads LICENSE/LICENCE files of any case and extension, normalised", () => {
    const { packages } = collectPackages({ roots: [{ dir: join(root, "apps/app") }], exclude: ["dropped"] });
    const byKey = new Map(packages.map((entry) => [`${entry.name}@${entry.version}`, entry]));
    assert.equal(byKey.get("a@1.0.0").licenseTexts[0].text, "MIT License\n\nCopyright (c) A");
    assert.equal(byKey.get("c@1.0.0").licenseTexts[0].file, "licence.md");
    assert.equal(byKey.get("c@1.0.0").license, "BSD-3-Clause");
    assert.equal(byKey.get("c@10.0.0").licenseTexts[0].text, "BSD c 10");
    assert.deepEqual(byKey.get("b@2.0.0").licenseTexts, []);
    assert.equal(byKey.get("b@2.0.0").repository, "https://github.com/example/b");
  });

  it("reports a missing required dependency, skips a missing optional one, and honours exclude", () => {
    const { packages, missing } = collectPackages({ roots: [{ dir: join(root, "apps/app") }], exclude: ["dropped"] });
    assert.deepEqual(missing, ["ghost"]);
    assert.ok(!packages.some((entry) => entry.name === "dropped" || entry.name === "devonly"));
  });

  it("limits a root to the dependencies named in `only`, whichever field they are in", () => {
    const { packages } = collectPackages({ roots: [{ dir: join(root, "apps/app"), only: ["devonly"] }] });
    assert.deepEqual(packages.map((entry) => entry.name), ["devonly"]);
  });

  it("lists the packages installed directly in a scanned node_modules folder", () => {
    const { packages } = collectPackages({ roots: [], scanDirs: [join(root, "apps/app/node_modules")] });
    assert.deepEqual(packages.map((entry) => `${entry.name}@${entry.version}`), ["a@1.0.0", "c@10.0.0", "devonly@1.0.0", "dropped@1.0.0"]);
  });
});

describe("renderNotices", () => {
  const packages = sortPackages([
    { name: "zeta", version: "1.0.0", license: "MIT", licenseTexts: [{ file: "LICENSE", text: "zeta licence" }] },
    { name: "alpha", version: "2.0.0", license: "ISC", licenseTexts: [] },
    { name: "alpha", version: "10.0.0", license: "ISC", licenseTexts: [] },
  ]);

  it("puts the AGPL header first and is deterministic", () => {
    const once = renderNotices({ title: "Test build", covers: "a test build.", packages });
    assert.equal(once, renderNotices({ title: "Test build", covers: "a test build.", packages }));
    assert.match(once, /^THIRD-PARTY SOFTWARE NOTICES: Test build\n/);
    assert.match(once, /AGPL-3\.0-only/);
    assert.match(once, /https:\/\/github\.com\/MagicZebraLtd\/loam\/blob\/master\/LICENSE/);
    assert.ok(!/20\d\d-\d\d-\d\d/.test(once), "no dates");
  });

  it("falls back to the declared SPDX id when a package has no licence file", () => {
    const text = renderNotices({ title: "T", covers: "c.", packages });
    assert.match(text, /alpha@10\.0\.0\nLicense: ISC\n\nThis package includes no licence file\. Its package\.json declares the licence\nISC \(https:\/\/spdx\.org\/licenses\/ISC\.html\)\./);
    assert.ok(text.indexOf("alpha@10.0.0") < text.indexOf("alpha@2.0.0") && text.indexOf("alpha@2.0.0") < text.indexOf("zeta@1.0.0"));
  });

  it("appends the native components after the npm packages", () => {
    const list = {
      components: [
        { name: "Thing", builds: ["desktop"], version: "1", license: "MIT", url: "https://example.org", licenseText: "thing licence" },
        { name: "Other", builds: ["android"], license: "MIT", url: "https://example.org" },
      ],
    };
    const native = nativeComponents(list, "desktop", root);
    assert.deepEqual(native.map((entry) => entry.name), ["Thing"]);
    const text = renderNotices({ title: "T", covers: "c.", packages, native });
    assert.ok(text.indexOf("NATIVE COMPONENTS") > text.indexOf("zeta licence"));
    assert.match(text, /Thing\nVersion: 1\nLicense: MIT\nSource: https:\/\/example\.org\n\nthing licence/);
    assert.deepEqual(nativeComponents(list, null, root), []);
  });
});

describe("licenseOf", () => {
  it("reads the string, legacy object and legacy array forms", () => {
    assert.equal(licenseOf({ license: "MIT" }), "MIT");
    assert.equal(licenseOf({ license: { type: "BSD-2-Clause" } }), "BSD-2-Clause");
    assert.equal(licenseOf({ licenses: [{ type: "MIT" }, "Apache-2.0"] }), "MIT OR Apache-2.0");
    assert.equal(licenseOf({}), "UNKNOWN");
  });
});

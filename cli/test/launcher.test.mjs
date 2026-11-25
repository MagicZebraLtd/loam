// Tests for what bin/loam.js does around the server bundle, run against a stand-in bundle: the real launcher
// is copied into a temporary package whose dist/loam-server.js records what it saw and starts nothing. Run
// with `node --test` (root `pnpm test`).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const binDir = join(dirname(fileURLToPath(import.meta.url)), "..", "bin");

/** The stand-in bundle: just enough for plain mode, and a report of what the launcher left in the env. */
const FAKE_BUNDLE = `
const seen = { nodeEnvAtLoad: process.env.NODE_ENV ?? null };
process.on("exit", () => process.stdout.write("REPORT " + JSON.stringify(seen) + "\\n"));
export const readCliSettings = () => ({});
export const writeCliSettings = () => {};
export const createLogBook = () => ({ write() {}, note() {} });
export const createTui = () => { throw new Error("no terminal UI in this test"); };
export const processTerminal = () => ({});
export const processSystem = () => ({ lanAddresses: () => [] });
export const firstLanIPv4 = () => "192.168.1.2";
export const encodeQR = () => ({});
export const renderQRToTerminal = () => "QR";
export const localOrigin = (host, port) => {
  seen.localOrigin = { host, port };
  return "http://local.test:" + port;
};
export async function startEmbeddedServer() {
  seen.keyAtStart = process.env.LOAM_DB_KEY ?? null;
  return {
    host: {
      status() {
        seen.keyAfterStart = process.env.LOAM_DB_KEY ?? null;
        // The advertised port: CLIENT_PORT when set, as the server reports it.
        return { joinHost: "192.168.1.2", port: Number(process.env.CLIENT_PORT ?? process.env.PORT), people: { admins: 1 }, resets: 0 };
      },
      transportPublicKey: () => undefined,
    },
    close: async () => {},
  };
}
`;

/** A loamnet package with the real bin/ and the stand-in bundle (and a stand-in SQLCipher driver). */
function fakePackage() {
  const root = mkdtempSync(join(tmpdir(), "loam-launcher-"));
  cpSync(binDir, join(root, "bin"), { recursive: true });
  mkdirSync(join(root, "dist", "node_modules", "better-sqlite3-multiple-ciphers"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "loamnet", version: "0.0.0-test", type: "module" }));
  writeFileSync(join(root, "dist", "loam-server.js"), FAKE_BUNDLE);
  const driver = join(root, "dist", "node_modules", "better-sqlite3-multiple-ciphers");
  writeFileSync(join(driver, "package.json"), JSON.stringify({ name: "better-sqlite3-multiple-ciphers", main: "index.js" }));
  writeFileSync(join(driver, "index.js"), "module.exports = class Database { close() {} };\n");
  return root;
}

const roots = [];
after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Run the launcher in plain mode with `env` (and nothing else of this process's environment but PATH). */
function runLauncher(env) {
  const root = fakePackage();
  roots.push(root);
  const result = spawnSync(process.execPath, [join(root, "bin", "loam.js"), "--plain", "--data-dir", join(root, "data")], {
    env: { PATH: process.env.PATH, HOME: root, ...env },
    encoding: "utf8",
    timeout: 20_000,
  });
  const line = result.stdout.split("\n").find((entry) => entry.startsWith("REPORT "));
  assert.ok(line, `no report from the stand-in bundle:\n${result.stdout}\n${result.stderr}`);
  return { ...JSON.parse(line.slice("REPORT ".length)), stdout: result.stdout };
}

describe("bin/loam.js", () => {
  it("defaults NODE_ENV to production before the server bundle loads, so an inherited LOAM_DEV_MODE is refused", () => {
    assert.equal(runLauncher({ LOAM_DEV_MODE: "1" }).nodeEnvAtLoad, "production");
  });

  it("keeps a NODE_ENV the operator set", () => {
    assert.equal(runLauncher({ NODE_ENV: "development" }).nodeEnvAtLoad, "development");
  });

  it("hands the server the database key, then removes it from the environment", () => {
    const seen = runLauncher({ LOAM_DB_KEY: "correct horse battery staple" });
    assert.equal(seen.keyAtStart, "correct horse battery staple");
    assert.equal(seen.keyAfterStart, null);
  });

  it("builds local links from the address and port the server listens on, not the advertised port", () => {
    const port = 40_000 + Math.floor(Math.random() * 10_000);
    const seen = runLauncher({ HOST: "127.0.0.1", PORT: String(port), CLIENT_PORT: String(port + 1) });
    assert.deepEqual(seen.localOrigin, { host: "127.0.0.1", port });
    assert.match(seen.stdout, new RegExp(`Open on this device:  http://local\\.test:${port}\\n`));
    assert.match(seen.stdout, new RegExp(`Join from your phone: http://192\\.168\\.1\\.2:${port + 1}\\n`));
  });
});

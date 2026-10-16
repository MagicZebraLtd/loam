// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fileSettingsStore, parseSettings, SETTINGS_FILE, settingsView } from "./settings.js";

const network = { preset: "community", nodeName: "Field kitchen", encryption: "persistent", createdAt: 1_700_000_000_000 };

describe("parseSettings", () => {
  it("keeps every well-formed field", () => {
    expect(parseSettings({ network, port: 3005, joinHost: "192.168.1.4", logLevel: "debug", hostAck: 1, clientCopyStale: true })).toEqual({
      network,
      port: 3005,
      joinHost: "192.168.1.4",
      logLevel: "debug",
      hostAck: 1,
      clientCopyStale: true,
    });
  });

  it("drops bad fields one by one", () => {
    expect(parseSettings({ network, port: 70000, joinHost: "bad host!", logLevel: "trace", hostAck: 0, clientCopyStale: "yes" })).toEqual({
      network,
      logLevel: "info",
    });
  });

  it("drops a network record it can't trust, rather than guess its encryption", () => {
    expect(parseSettings({ network: { ...network, encryption: "rot13" }, port: 3000 })).toEqual({ port: 3000, logLevel: "info" });
  });

  it("starts from defaults for junk", () => {
    expect(parseSettings(null)).toEqual({ logLevel: "info" });
    expect(parseSettings([1, 2])).toEqual({ logLevel: "info" });
  });
});

describe("settingsView", () => {
  it("adds where the data lives and the version", () => {
    expect(settingsView({ logLevel: "info", port: 3001 }, "/data", "0.6.4")).toEqual({
      port: 3001,
      logLevel: "info",
      dataDir: "/data",
      version: "0.6.4",
    });
  });
});

describe("fileSettingsStore", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loam-settings-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips through desktop.json, private to this user", () => {
    const store = fileSettingsStore(dir);
    expect(store.read()).toEqual({ logLevel: "info" });
    store.write({ logLevel: "info", port: 3002, hostAck: 1 });
    expect(store.read()).toEqual({ logLevel: "info", port: 3002, hostAck: 1 });
    expect(JSON.parse(readFileSync(join(dir, SETTINGS_FILE), "utf8"))).toEqual({ logLevel: "info", port: 3002, hostAck: 1 });
    if (process.platform !== "win32") {
      expect(statSync(join(dir, SETTINGS_FILE)).mode & 0o777).toBe(0o600);
    }
  });

  it("reads an unparseable file as defaults", () => {
    writeFileSync(join(dir, SETTINGS_FILE), "{ nope");
    expect(fileSettingsStore(dir).read()).toEqual({ logLevel: "info" });
  });
});

// @vitest-environment node
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LoamConfigUpdate } from "@loam/schema";
import { afterEach, describe, expect, it } from "vitest";

import { CONFIG_FILE, writeInitialConfig } from "./data-dir.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function freshDataDir(): string {
  const root = mkdtempSync(join(tmpdir(), "loam-data-dir-"));
  roots.push(root);
  return join(root, "node");
}

describe("writeInitialConfig", () => {
  it("leaves one private config.json and no temporary copy", () => {
    const dataDir = freshDataDir();
    const config: LoamConfigUpdate = { node: { name: "Kitchen" } };
    writeInitialConfig(dataDir, config);
    expect(JSON.parse(readFileSync(join(dataDir, CONFIG_FILE), "utf8"))).toEqual(config);
    expect(readdirSync(dataDir)).toEqual([CONFIG_FILE]);
    if (process.platform !== "win32") {
      expect(statSync(join(dataDir, CONFIG_FILE)).mode & 0o777).toBe(0o600);
      expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    }
  });

  it("replaces an older config whole", () => {
    const dataDir = freshDataDir();
    writeInitialConfig(dataDir, { node: { name: "Before" } });
    writeInitialConfig(dataDir, { node: { name: "After" } });
    expect(JSON.parse(readFileSync(join(dataDir, CONFIG_FILE), "utf8"))).toEqual({ node: { name: "After" } });
    expect(readdirSync(dataDir)).toEqual([CONFIG_FILE]);
  });
});

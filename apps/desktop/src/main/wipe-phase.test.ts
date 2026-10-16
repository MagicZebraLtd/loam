// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clearWipePhase, LEGACY_WIPE_PENDING_FILE, readWipePhase, WIPE_PHASE_FILE } from "./wipe-phase.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "loam-wipe-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readWipePhase", () => {
  it("is undefined with no journal", () => {
    expect(readWipePhase(dir)).toBeUndefined();
  });

  it("reads the JSON journal the server writes", () => {
    writeFileSync(join(dir, WIPE_PHASE_FILE), JSON.stringify({ phase: "key-clear-ready", config: {} }));
    expect(readWipePhase(dir)).toBe("key-clear-ready");
    writeFileSync(join(dir, WIPE_PHASE_FILE), JSON.stringify({ phase: "delete-pending" }));
    expect(readWipePhase(dir)).toBe("delete-pending");
  });

  it("reads an older build's plain phase", () => {
    writeFileSync(join(dir, WIPE_PHASE_FILE), "key-clear-ready\n");
    expect(readWipePhase(dir)).toBe("key-clear-ready");
  });

  it("treats anything ambiguous as a pending deletion, never as safe to clear the key", () => {
    writeFileSync(join(dir, WIPE_PHASE_FILE), "{ truncated");
    expect(readWipePhase(dir)).toBe("delete-pending");
    rmSync(join(dir, WIPE_PHASE_FILE));
    mkdirSync(join(dir, WIPE_PHASE_FILE));
    expect(readWipePhase(dir)).toBe("delete-pending");
  });

  it("recognises the legacy marker as a pending deletion", () => {
    writeFileSync(join(dir, LEGACY_WIPE_PENDING_FILE), "");
    expect(readWipePhase(dir)).toBe("delete-pending");
  });
});

describe("clearWipePhase", () => {
  it("removes both names and proves them gone", () => {
    writeFileSync(join(dir, WIPE_PHASE_FILE), "key-clear-ready");
    writeFileSync(join(dir, LEGACY_WIPE_PENDING_FILE), "");
    expect(clearWipePhase(dir)).toBe(true);
    expect(existsSync(join(dir, WIPE_PHASE_FILE))).toBe(false);
    expect(existsSync(join(dir, LEGACY_WIPE_PENDING_FILE))).toBe(false);
    expect(readWipePhase(dir)).toBeUndefined();
  });

  it("succeeds when there is nothing to clear", () => {
    expect(clearWipePhase(dir)).toBe(true);
  });

  it("fails when the journal can't be removed", () => {
    mkdirSync(join(dir, WIPE_PHASE_FILE));
    writeFileSync(join(dir, WIPE_PHASE_FILE, "inside"), "");
    expect(clearWipePhase(dir)).toBe(false);
  });
});

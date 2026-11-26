// @vitest-environment node
import { describe, expect, it } from "vitest";

import { createCrashReloadBudget } from "./crash-reload.js";

describe("createCrashReloadBudget", () => {
  it("reloads a few crashes, then gives up while they keep coming", () => {
    let clock = 0;
    const mayReload = createCrashReloadBudget({ limit: 3, windowMs: 60_000, now: () => clock });
    expect([mayReload(), mayReload(), mayReload()]).toEqual([true, true, true]);
    clock = 30_000;
    expect(mayReload()).toBe(false);
  });

  it("forgets crashes older than the window", () => {
    let clock = 0;
    const mayReload = createCrashReloadBudget({ limit: 2, windowMs: 1_000, now: () => clock });
    mayReload();
    mayReload();
    expect(mayReload()).toBe(false);
    clock = 1_000;
    expect(mayReload()).toBe(true);
  });
});

import { describe, expect, it } from "vitest";

import { JoinHostSchema, SettingsUpdateSchema } from "../../shared/ipc";
import { JOIN_HOST_PATTERN, parsePort, settingsFormFrom, settingsUpdateFrom, validJoinHost } from "./settings-form";

describe("settings form", () => {
  it("accepts exactly the join addresses the contract does (blank aside, which means automatic)", () => {
    const samples = ["192.168.1.20", "loam.local", "my-host", "a", "-bad", "bad-", "has space", "x..y", "10.0.0.256", "a".repeat(254)];
    for (const sample of samples) {
      expect(validJoinHost(sample), sample).toBe(JoinHostSchema.safeParse(sample).success);
      expect(JOIN_HOST_PATTERN.test(sample) && sample.length <= 253, sample).toBe(JoinHostSchema.safeParse(sample).success);
    }
    expect(validJoinHost("")).toBe(true);
  });

  it("parses ports: blank is the default, junk and out-of-range are refused", () => {
    expect(parsePort("")).toBeNull();
    expect(parsePort(" 3001 ")).toBe(3001);
    expect(parsePort("0")).toBeUndefined();
    expect(parsePort("65536")).toBeUndefined();
    expect(parsePort("30.5")).toBeUndefined();
    expect(parsePort("abc")).toBeUndefined();
  });

  it("builds an update the contract accepts, clearing blank fields", () => {
    const result = settingsUpdateFrom({ port: "", joinHost: " ", logLevel: "debug" });
    expect(result).toEqual({ ok: true, update: { port: null, joinHost: null, logLevel: "debug" } });
    expect(result.ok && SettingsUpdateSchema.safeParse(result.update).success).toBe(true);
    const pinned = settingsUpdateFrom({ port: "3005", joinHost: "10.0.0.5", logLevel: "info" });
    expect(pinned.ok && SettingsUpdateSchema.safeParse(pinned.update).success).toBe(true);
  });

  it("reports both field errors at once", () => {
    const result = settingsUpdateFrom({ port: "99999", joinHost: "not valid!", logLevel: "info" });
    expect(result.ok).toBe(false);
    expect(!result.ok && Object.keys(result.errors).sort()).toEqual(["joinHost", "port"]);
  });

  it("starts from the saved settings", () => {
    expect(settingsFormFrom({ logLevel: "info", dataDir: "/d", version: "1", port: 3002, joinHost: "10.0.0.5" })).toEqual({
      port: "3002",
      joinHost: "10.0.0.5",
      logLevel: "info",
    });
    expect(settingsFormFrom({ logLevel: "debug", dataDir: "/d", version: "1" })).toEqual({ port: "", joinHost: "", logLevel: "debug" });
  });
});

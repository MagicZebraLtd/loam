import { describe, expect, it } from "vitest";

import { LoamConfigUpdateSchema, securityProfilePreset } from "./index.js";
import { cleanNodeName, DEFAULT_NODE_NAME, presetConfig, presetDbMode, SETUP_PRESETS } from "./setup-presets.js";

describe("presetConfig", () => {
  it("writes a valid config update for every preset", () => {
    for (const preset of SETUP_PRESETS) {
      const config = presetConfig(preset, " Riverside ", "fr");
      expect(LoamConfigUpdateSchema.safeParse(config).success, preset).toBe(true);
      expect(config.node).toEqual({ name: "Riverside", locale: "fr" });
    }
  });

  it("makes Private anonymous, short-lived, approval-only and encrypted in transit", () => {
    const config = presetConfig("private", "x", "en");
    expect(config.security).toEqual({ profile: "hardened" });
    expect(config.identity).toEqual({ allowUserDisplayNameEdit: false, allowUserAvatarEdit: false, allowUserAvatarUpload: false });
    expect(config.features).toEqual({ enablePresence: false });
    // The profile is what forces the rest (docs/09): check the axes it carries.
    const forced = securityProfilePreset("hardened");
    expect(forced?.joinPolicy).toBe("approval");
    expect(forced?.transportEncryption).toBe("required");
    expect(forced?.killSwitchEnabled).toBe(true);
  });

  it("makes Community open and visible", () => {
    const config = presetConfig("community", "x", "en");
    expect(config.security).toEqual({ profile: "standard" });
    expect(config.identity).toEqual({ allowUserDisplayNameEdit: true, allowUserAvatarEdit: true, allowUserAvatarUpload: true });
    expect(config.features).toEqual({ enablePresence: true });
  });

  it("writes only the name and language for Custom", () => {
    expect(presetConfig("custom", "x", "de")).toEqual({ node: { name: "x", locale: "de" } });
  });

  it("pins the peer and carries the link code when joining another network", () => {
    const config = presetConfig("custom", "x", "en", { url: "http://10.0.0.2:3000", transportKey: "k", linkCode: "c" });
    expect(config.sync).toEqual({ enabled: true, peers: [{ url: "http://10.0.0.2:3000", transportKey: "k", linkCode: "c" }] });
  });
});

describe("presetDbMode", () => {
  it("keeps Private only while running, Community on the device, and leaves Custom to the host", () => {
    expect(presetDbMode("private")).toBe("ephemeral");
    expect(presetDbMode("community")).toBe("persistent");
    expect(presetDbMode("custom")).toBeUndefined();
  });
});

describe("cleanNodeName", () => {
  it("trims, defaults when blank and caps at 80 characters", () => {
    expect(cleanNodeName("  ")).toBe(DEFAULT_NODE_NAME);
    expect(cleanNodeName(" Riverside ")).toBe("Riverside");
    expect(cleanNodeName("a".repeat(100))).toHaveLength(80);
    expect(cleanNodeName(`${"a".repeat(79)} b`)).toBe("a".repeat(79));
  });
});

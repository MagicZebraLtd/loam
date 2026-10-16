import { describe, expect, it } from "vitest";

import { SetupRequestSchema } from "../../shared/ipc";
import { availableEncryption, defaultEncryption, type SetupForm, validateSetup } from "./setup-form";

const keychain = { platform: "darwin" as const, keychain: true };
const noKeychain = { platform: "linux" as const, keychain: false };

function form(overrides: Partial<SetupForm> = {}): SetupForm {
  return { nodeName: "", preset: "community", encryption: "persistent", passphrase: "", confirm: "", acknowledged: true, ...overrides };
}

describe("setup form", () => {
  it("offers the keychain only when there is one, and defaults to a passphrase without it", () => {
    expect(availableEncryption(keychain)).toContain("persistent");
    expect(availableEncryption(noKeychain)).not.toContain("persistent");
    expect(defaultEncryption("community", keychain)).toBe("persistent");
    expect(defaultEncryption("community", noKeychain)).toBe("passphrase");
    expect(defaultEncryption("custom", keychain)).toBe("persistent");
    expect(defaultEncryption("private", noKeychain)).toBe("ephemeral");
  });

  it("builds a request the contract accepts, with the name trimmed and no passphrase unless asked for", () => {
    const result = validateSetup(form({ nodeName: "  Riverside  ", passphrase: "ignored" }), keychain);
    expect(result).toEqual({ ok: true, request: { nodeName: "Riverside", preset: "community", encryption: "persistent" } });
    expect(result.ok && SetupRequestSchema.safeParse(result.request).success).toBe(true);
  });

  it("sends the passphrase for the passphrase mode", () => {
    const result = validateSetup(form({ encryption: "passphrase", passphrase: "correct horse", confirm: "correct horse" }), keychain);
    expect(result.ok && result.request.passphrase).toBe("correct horse");
    expect(result.ok && SetupRequestSchema.safeParse(result.request).success).toBe(true);
  });

  it("refuses a missing, short or mismatched passphrase", () => {
    const missing = validateSetup(form({ encryption: "passphrase" }), keychain);
    expect(!missing.ok && missing.errors.passphrase).toBeTruthy();
    const short = validateSetup(form({ encryption: "passphrase", passphrase: "abc", confirm: "abc" }), keychain);
    expect(!short.ok && short.errors.passphrase).toMatch(/at least 8/);
    const mismatch = validateSetup(form({ encryption: "passphrase", passphrase: "correct horse", confirm: "correct house" }), keychain);
    expect(!mismatch.ok && mismatch.errors.confirm).toBeTruthy();
    const long = validateSetup(form({ encryption: "passphrase", passphrase: "x".repeat(1025), confirm: "x".repeat(1025) }), keychain);
    expect(!long.ok && long.errors.passphrase).toBeTruthy();
  });

  it("refuses the keychain where there is none, a long name, and no acknowledgement", () => {
    const result = validateSetup(form({ nodeName: "x".repeat(81), acknowledged: false }), noKeychain);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Object.keys(result.errors).sort()).toEqual(["acknowledged", "encryption", "nodeName"]);
    }
  });
});

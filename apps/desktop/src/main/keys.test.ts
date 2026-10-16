// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEVICE_SECRET_FILE,
  DEVICE_SECRET_PLAIN_FILE,
  fileDeviceSecretStore,
  KeyError,
  keychainProtects,
  memoryDeviceSecretStore,
  passphraseKey,
  resolveDbKey,
  type SecretBox,
} from "./keys.js";

/** A stand-in for safeStorage: "encrypts" by reversing and prefixing, so a test can see it was used. */
function fakeBox(available = true, backend?: string): SecretBox {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (text) => Buffer.from(`sealed:${[...text].reverse().join("")}`),
    decryptString: (data) => {
      // Electron's safeStorage throws here when encryption isn't available.
      if (!available) {
        throw new Error("encryption unavailable");
      }
      const text = data.toString();
      if (!text.startsWith("sealed:")) {
        throw new Error("not ours");
      }
      return [...text.slice(7)].reverse().join("");
    },
    ...(backend ? { getSelectedStorageBackend: () => backend } : {}),
  };
}

describe("keychainProtects", () => {
  it("trusts the macOS and Windows keychains when encryption works", () => {
    expect(keychainProtects(fakeBox(), "darwin")).toBe(true);
    expect(keychainProtects(fakeBox(), "win32")).toBe(true);
  });

  it("refuses Linux's basic_text fallback", () => {
    expect(keychainProtects(fakeBox(true, "basic_text"), "linux")).toBe(false);
    expect(keychainProtects(fakeBox(true, "unknown"), "linux")).toBe(false);
    expect(keychainProtects(fakeBox(true, "gnome_libsecret"), "linux")).toBe(true);
    expect(keychainProtects(fakeBox(true), "linux")).toBe(false);
  });

  it("never touches the keychain just to ask", () => {
    const box = fakeBox(true, "kwallet5");
    box.isEncryptionAvailable = () => {
      throw new Error("asked the keychain");
    };
    box.encryptString = () => {
      throw new Error("asked the keychain");
    };
    expect(keychainProtects(box, "darwin")).toBe(true);
    expect(keychainProtects(box, "win32")).toBe(true);
    expect(keychainProtects(box, "linux")).toBe(true);
    // Creating the store reads nothing either; only get() does.
    const dir = mkdtempSync(join(tmpdir(), "loam-keys-lazy-"));
    try {
      const store = fileDeviceSecretStore(dir, box);
      store.destroy();
      expect(() => store.get("persistent")).toThrow(expect.objectContaining({ code: "keychain_unavailable" }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("passphraseKey", () => {
  it("is SHA256(passphrase:secret) as hex, as the Android host derives it", () => {
    // echo -n 'pass:secret' | shasum -a 256
    expect(passphraseKey("pass", "secret")).toBe("3583e43a7b177b37e50337a2f69fdc4fae6ec7235e44b7fbf2eb893d30150152");
    expect(passphraseKey("pass", "a")).not.toBe(passphraseKey("pass", "b"));
  });
});

describe("resolveDbKey", () => {
  it("maps each mode to the LOAM_DB_KEY contract", () => {
    const secrets = memoryDeviceSecretStore();
    expect(resolveDbKey("off", secrets, { keychain: true })).toBeUndefined();
    expect(resolveDbKey("ephemeral", secrets, { keychain: false })).toBe("ephemeral");
    const persistent = resolveDbKey("persistent", secrets, { keychain: true });
    expect(persistent).toBe(secrets.current());
    expect(resolveDbKey("passphrase", secrets, { keychain: true, passphrase: "pw" })).toBe(passphraseKey("pw", persistent!));
  });

  it("refuses a persistent key without a keychain", () => {
    expect(() => resolveDbKey("persistent", memoryDeviceSecretStore(), { keychain: false })).toThrow(KeyError);
    try {
      resolveDbKey("persistent", memoryDeviceSecretStore(), { keychain: false });
    } catch (error) {
      expect((error as KeyError).code).toBe("keychain_unavailable");
    }
  });

  it("needs the passphrase for a passphrase network", () => {
    expect(() => resolveDbKey("passphrase", memoryDeviceSecretStore(), { keychain: true })).toThrow(KeyError);
  });

  it("gives a different key once the secret is destroyed", () => {
    const secrets = memoryDeviceSecretStore();
    const before = resolveDbKey("passphrase", secrets, { keychain: true, passphrase: "pw" });
    secrets.destroy();
    expect(resolveDbKey("passphrase", secrets, { keychain: true, passphrase: "pw" })).not.toBe(before);
  });
});

describe("fileDeviceSecretStore", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loam-keys-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the secret sealed by the keychain and reads it back", () => {
    const secret = fileDeviceSecretStore(dir, fakeBox()).get("persistent");
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(join(dir, DEVICE_SECRET_FILE), "utf8").startsWith("sealed:")).toBe(true);
    expect(readFileSync(join(dir, DEVICE_SECRET_FILE), "utf8")).not.toContain(secret);
    expect(fileDeviceSecretStore(dir, fakeBox()).get("persistent")).toBe(secret);
  });

  it("mints a new secret after destroy", () => {
    const store = fileDeviceSecretStore(dir, fakeBox());
    const first = store.get("persistent");
    store.destroy();
    expect(existsSync(join(dir, DEVICE_SECRET_FILE))).toBe(false);
    expect(store.get("persistent")).not.toBe(first);
  });

  it("never mints over a secret the keychain won't open", () => {
    writeFileSync(join(dir, DEVICE_SECRET_FILE), "someone else's");
    expect(() => fileDeviceSecretStore(dir, fakeBox()).get("persistent")).toThrow(KeyError);
    expect(readFileSync(join(dir, DEVICE_SECRET_FILE), "utf8")).toBe("someone else's");
  });

  it("keeps a sealed secret locked, not re-minted, when the keychain is away", () => {
    const secret = fileDeviceSecretStore(dir, fakeBox()).get("passphrase");
    expect(() => fileDeviceSecretStore(dir, fakeBox(false)).get("passphrase")).toThrow(
      expect.objectContaining({ code: "db_encryption_locked" }),
    );
    expect(fileDeviceSecretStore(dir, fakeBox()).get("passphrase")).toBe(secret);
  });

  it("keeps a passphrase network's secret in a private plain file with no keychain", () => {
    const secret = fileDeviceSecretStore(dir, fakeBox(false)).get("passphrase");
    expect(readFileSync(join(dir, DEVICE_SECRET_PLAIN_FILE), "utf8").trim()).toBe(secret);
    expect(fileDeviceSecretStore(dir, fakeBox(false)).get("passphrase")).toBe(secret);
  });

  it("never keeps a persistent key in the clear", () => {
    expect(() => fileDeviceSecretStore(dir, fakeBox(false)).get("persistent")).toThrow(
      expect.objectContaining({ code: "keychain_unavailable" }),
    );
    expect(existsSync(join(dir, DEVICE_SECRET_PLAIN_FILE))).toBe(false);
    expect(existsSync(join(dir, DEVICE_SECRET_FILE))).toBe(false);
  });

  it("seals a plain secret once this computer has a keychain", () => {
    const secret = fileDeviceSecretStore(dir, fakeBox(false)).get("passphrase");
    expect(fileDeviceSecretStore(dir, fakeBox()).get("passphrase")).toBe(secret);
    expect(existsSync(join(dir, DEVICE_SECRET_PLAIN_FILE))).toBe(false);
    expect(readFileSync(join(dir, DEVICE_SECRET_FILE), "utf8")).not.toContain(secret);
    expect(fileDeviceSecretStore(dir, fakeBox()).get("passphrase")).toBe(secret);
  });
});

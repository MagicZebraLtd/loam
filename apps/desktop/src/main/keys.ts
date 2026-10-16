/**
 * The network's at-rest key, mirroring the Android launcher (apps/app/src/lib/db-encryption.ts). A random
 * 32-byte device secret is kept in `device-secret.enc`, encrypted by the OS keychain through Electron's
 * `safeStorage`; from it:
 *   - `persistent` → LOAM_DB_KEY is the device secret itself (the keychain is the only thing protecting it);
 *   - `passphrase` → SHA256(passphrase + ":" + deviceSecret), so the passphrase alone opens nothing and
 *     deleting the secret makes the old database unreadable even to someone who knows the passphrase;
 *   - `ephemeral` → the literal "ephemeral": the server makes a random key that lives only in memory;
 *   - `off` → no key.
 * Deleting the secret file is the cryptographic wipe a fixed-key Emergency Reset ends with (wipe-phase.ts).
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { DbEncryptionMode } from "@loam/schema";

/** Where the secret lives when the keychain protects it. */
export const DEVICE_SECRET_FILE = "device-secret.enc";
/**
 * Where it lives when this computer has no keychain at all (a Linux desktop with no secret service, where
 * Electron can't encrypt). Only a passphrase network uses it then: the passphrase is the protection, and the
 * secret still gives the reset its "rotate the key" property. A `persistent` network is refused instead.
 */
export const DEVICE_SECRET_PLAIN_FILE = "device-secret.key";

/** The part of Electron's `safeStorage` used here, so tests can supply a fake. */
export type SecretBox = {
  isEncryptionAvailable(): boolean;
  encryptString(text: string): Buffer;
  decryptString(data: Buffer): string;
  /** Linux only in Electron; absent elsewhere. */
  getSelectedStorageBackend?: () => string;
};

/**
 * Whether the OS keychain really protects what `safeStorage` encrypts, decided WITHOUT touching the keychain:
 * this runs at launch (the Setup screen offers "Kept in this computer's keychain" only when it is true), and on
 * macOS even `safeStorage.isEncryptionAvailable()` reads the keychain item, which can raise a "LOAM wants to use
 * your confidential information" prompt for a network that never needs a stored key. So:
 *   - macOS always has the Keychain and Windows always has DPAPI: true, without asking;
 *   - Linux depends on the desktop: the backend Electron picked at startup says, and `basic_text` (a fixed,
 *     public key: the secret would be as good as written in the clear) or `unknown` means no.
 * The keychain itself is touched only by {@link fileDeviceSecretStore}, when a persistent or passphrase network
 * needs its secret. An unsigned build has a new code identity with every release, so macOS asks again after
 * each update ("Always Allow" covers that build only) until the app is signed with a stable identity.
 */
export function keychainProtects(box: SecretBox, platform: NodeJS.Platform): boolean {
  if (platform === "darwin" || platform === "win32") {
    return true;
  }
  if (typeof box.getSelectedStorageBackend !== "function") {
    return false;
  }
  const backend = box.getSelectedStorageBackend();
  return backend !== "basic_text" && backend !== "unknown";
}

/** A device secret: 32 random bytes, as hex (the format the Android launcher uses). */
export function mintDeviceSecret(): string {
  return randomBytes(32).toString("hex");
}

/** The passphrase-mode key. Pure. */
export function passphraseKey(passphrase: string, deviceSecret: string): string {
  return createHash("sha256").update(`${passphrase}:${deviceSecret}`, "utf8").digest("hex");
}

/** Why a key couldn't be produced: the keychain can't hold one, or the stored secret can't be read back. */
export class KeyError extends Error {
  constructor(
    readonly code: "keychain_unavailable" | "db_encryption_locked",
    message: string,
  ) {
    super(message);
    this.name = "KeyError";
  }
}

/** The device secret's storage, behind an interface so the controller's tests never touch the keychain. */
export type DeviceSecretStore = {
  /** The secret, minted (and stored) on first use. Throws {@link KeyError}. */
  get(): string;
  /** Delete the secret, proven gone. The next `get` mints a new one. */
  destroy(): void;
};

/** Write `bytes` beside `path` and rename over it, private to this user. */
function writePrivate(path: string, bytes: Buffer | string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  rmSync(temporary, { force: true });
  writeFileSync(temporary, bytes, { mode: 0o600 });
  renameSync(temporary, path);
}

/** The error code Node uses for "no such file". */
function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

/**
 * The device secret in `userData`, through the keychain when there is one. Nothing here runs until `get()`:
 * the keychain is read only when a persistent or passphrase network is set up or started.
 */
export function fileDeviceSecretStore(userData: string, box: SecretBox): DeviceSecretStore {
  const sealedPath = join(userData, DEVICE_SECRET_FILE);
  const plainPath = join(userData, DEVICE_SECRET_PLAIN_FILE);
  let cached: string | undefined;

  function read(): string | undefined {
    let raw: string;
    try {
      raw = box.isEncryptionAvailable() ? box.decryptString(readFileSync(sealedPath)) : readFileSync(plainPath, "utf8").trim();
    } catch (error) {
      if (isMissing(error)) {
        return undefined;
      }
      // The file is there but the keychain won't open it (another user, a reset keychain): the database it
      // protects is as good as locked. Never mint over it, which would lose it for good.
      throw new KeyError("db_encryption_locked", `The stored device secret couldn't be read: ${String(error)}`);
    }
    if (!/^[0-9a-f]{64}$/.test(raw)) {
      throw new KeyError("db_encryption_locked", "The stored device secret is damaged.");
    }
    return raw;
  }

  return {
    get() {
      if (cached !== undefined) {
        return cached;
      }
      const stored = read();
      if (stored !== undefined) {
        cached = stored;
        return stored;
      }
      const secret = mintDeviceSecret();
      let sealed: Buffer | undefined;
      try {
        sealed = box.isEncryptionAvailable() ? box.encryptString(secret) : undefined;
      } catch (error) {
        throw new KeyError("keychain_unavailable", `The keychain refused to keep the network's key: ${String(error)}`);
      }
      if (sealed) {
        writePrivate(sealedPath, sealed);
      } else {
        writePrivate(plainPath, `${secret}\n`);
      }
      cached = secret;
      return secret;
    },
    destroy() {
      cached = undefined;
      for (const path of [sealedPath, plainPath]) {
        rmSync(path, { force: true });
      }
    },
  };
}

/** An in-memory secret store, for tests and the smoke run (which never touches the keychain). */
export function memoryDeviceSecretStore(): DeviceSecretStore & { current(): string | undefined } {
  let secret: string | undefined;
  return {
    get() {
      secret ??= mintDeviceSecret();
      return secret;
    },
    destroy() {
      secret = undefined;
    },
    current: () => secret,
  };
}

/**
 * The LOAM_DB_KEY value for `mode` (undefined: no encryption). `keychain` says whether a persistent key can be
 * kept safely; `passphrase` is what the host typed this start (never stored). Throws {@link KeyError}.
 */
export function resolveDbKey(
  mode: DbEncryptionMode,
  secrets: DeviceSecretStore,
  options: { keychain: boolean; passphrase?: string },
): string | undefined {
  switch (mode) {
    case "off":
      return undefined;
    case "ephemeral":
      return "ephemeral";
    case "persistent":
      if (!options.keychain) {
        throw new KeyError(
          "keychain_unavailable",
          "This computer has no keychain to keep the network's key in, so it can't be kept between starts.",
        );
      }
      return secrets.get();
    case "passphrase":
      if (!options.passphrase) {
        throw new KeyError("db_encryption_locked", "The passphrase is needed to open this network.");
      }
      return passphraseKey(options.passphrase, secrets.get());
  }
}

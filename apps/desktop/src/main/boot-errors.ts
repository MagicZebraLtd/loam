/**
 * What a failed boot means for the host's screen. The server throws typed errors with a `.code`
 * (apps/server/src/errors.ts; store-lifecycle.ts throws them), and `listen` fails with Node's EADDRINUSE; this
 * maps each to the desktop's catalog (DesktopErrorCode in src/shared/ipc.ts), mirroring what the Android
 * launcher shows for the same failure. Pure, so it is unit-tested.
 */
import type { DbEncryptionMode } from "@loam/schema";

import type { DesktopError } from "../shared/ipc.js";

/** The `.code` of the server's "this database didn't open under that key" error. */
export const DB_UNREADABLE_CODE = "db_encryption_unreadable";
/** The `.code` of the boot-time wipe resume that stopped to hand the device-key clear to the launcher. */
export const WIPE_RESUME_CODE = "db_encryption_wipe_resume";

/** What a boot failure leads to: the Unlock screen again (a wrong passphrase), or the Failed screen. */
export type BootFailure = { kind: "wrong_passphrase" } | { kind: "failed"; error: DesktopError };

/** The error's string `.code`, when it has one. Never assumes `error` is even an object. */
export function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/** A short English detail for the Activity screen and bug reports. Never carries a key: none is in a message. */
export function errorDetail(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}

/**
 * Map a boot error to what the host sees. `mode` is the network's at-rest encryption: an unreadable database
 * under a passphrase means the passphrase was wrong (the Unlock screen asks again); under a device-held key it
 * means the key no longer opens it (the secret was lost or the database belongs to another key).
 */
export function mapBootError(error: unknown, mode: DbEncryptionMode): BootFailure {
  const code = errorCode(error);
  const detail = errorDetail(error);
  switch (code) {
    case "EADDRINUSE":
      return { kind: "failed", error: { code: "port_in_use", detail } };
    case "db_encryption_driver_missing":
      return { kind: "failed", error: { code: "db_encryption_driver_missing", detail } };
    case DB_UNREADABLE_CODE:
      return mode === "passphrase"
        ? { kind: "wrong_passphrase" }
        : { kind: "failed", error: { code: "db_encryption_locked", detail } };
    // A plaintext database under an encrypted mode is never served (that would be a silent downgrade): the
    // way out is the same as for a lost key, starting a new network.
    case "db_encryption_plaintext_unconverted":
      return { kind: "failed", error: { code: "db_encryption_locked", detail } };
    // The data folder doesn't fit the key mode (a database an ephemeral key can never open, or a marker that
    // can't be written or removed). Each message names the file and the fix.
    case "db_ephemeral_existing_database":
    case "db_ephemeral_marker_unwritable":
    case "db_ephemeral_marker_unremovable":
      return { kind: "failed", error: { code: "db_unreadable", detail } };
    // An interrupted Emergency Reset the boot couldn't finish (the controller handles the case it can).
    case WIPE_RESUME_CODE:
      return { kind: "failed", error: { code: "reset_incomplete", detail } };
    default:
      // The SQLCipher module missing at require time (a broken install) names itself in the message.
      if (mode !== "off" && detail.includes("better-sqlite3-multiple-ciphers")) {
        return { kind: "failed", error: { code: "db_encryption_driver_missing", detail } };
      }
      return { kind: "failed", error: { code: "unknown", detail } };
  }
}

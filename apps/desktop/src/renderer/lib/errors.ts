/**
 * What the Failed screen says for each reason the node couldn't start or run: a plain title, what to do,
 * and which way out it offers besides "Try again". Typed as a full record, so a new code in ipc.ts fails to
 * compile until it has words here.
 */
import type { DesktopErrorCode } from "../../shared/ipc";
import type { StringKey } from "./strings";

export type ErrorCopy = {
  title: StringKey;
  body: StringKey;
  /**
   * Offer "Start a new network" (erase and go back to setup): for failures where the data can't be opened as
   * it is, so starting over is the only other way forward.
   */
  newNetwork: boolean;
  /** Offer the download page (a broken install). */
  download: boolean;
};

export const ERROR_COPY: Record<DesktopErrorCode, ErrorCopy> = {
  port_in_use: { title: "error.port_in_use.title", body: "error.port_in_use.body", newNetwork: false, download: false },
  port_unavailable: { title: "error.port_unavailable.title", body: "error.port_unavailable.body", newNetwork: false, download: false },
  db_encryption_driver_missing: {
    title: "error.db_encryption_driver_missing.title",
    body: "error.db_encryption_driver_missing.body",
    newNetwork: true,
    download: false,
  },
  db_encryption_locked: { title: "error.db_encryption_locked.title", body: "error.db_encryption_locked.body", newNetwork: true, download: false },
  db_unreadable: { title: "error.db_unreadable.title", body: "error.db_unreadable.body", newNetwork: true, download: false },
  // The key lives in the keychain: if the keychain stays out of reach, the data can't be opened either.
  keychain_unavailable: { title: "error.keychain_unavailable.title", body: "error.keychain_unavailable.body", newNetwork: true, download: false },
  client_missing: { title: "error.client_missing.title", body: "error.client_missing.body", newNetwork: false, download: true },
  // Starting over is the sure way to finish an erase that couldn't be recorded.
  reset_incomplete: { title: "error.reset_incomplete.title", body: "error.reset_incomplete.body", newNetwork: true, download: false },
  stop_timeout: { title: "error.stop_timeout.title", body: "error.stop_timeout.body", newNetwork: false, download: false },
  unknown: { title: "error.unknown.title", body: "error.unknown.body", newNetwork: false, download: false },
};

/** The copy for `code`, falling back to "unknown" for a code this build doesn't know (a newer main process). */
export function errorCopy(code: string): ErrorCopy {
  return Object.prototype.hasOwnProperty.call(ERROR_COPY, code) ? ERROR_COPY[code as DesktopErrorCode] : ERROR_COPY.unknown;
}

// What the host reads on the recovery screens when the launcher (nodejs-project-template/main.js) or the
// embedded server reports a boot error or notice (F-054). Both report in English for the log, with a code;
// this maps the code to the host catalog, so the screen speaks the host's language, and the screen keeps
// the English text behind a Details disclosure. Pure, so it is unit-tested.
import type { AppCatalogKey } from './i18n';

/** Why a `db_encryption_locked` report locked (main.js forwards boot-config.js's `reason`). Only `no_key`
 * (a secret-based mode with no key yet, the usual passphrase prompt) has its own text: the code also covers
 * an unreadable mode, an unfinished setup and a wipe still finishing. */
export type LockedReason = 'no_key' | 'mode_unknown' | undefined;

const BOOT_ERROR_KEYS: Readonly<Record<string, AppCatalogKey>> = {
  db_encryption_plaintext_unconverted: 'boot.plaintextBody',
  db_encryption_driver_missing: 'boot.driverMissingBody',
  port_in_use: 'boot.portInUseBody',
  kill_switch_wipe_incomplete: 'boot.wipeUnfinishedBody',
  kill_switch_wipe_resumed: 'boot.wipeUnfinishedBody',
  kill_switch_wipe_no_marker: 'boot.wipeUnfinishedBody',
  boot_timeout: 'boot.notReady',
  boot_failed: 'boot.notReady',
  boot_unhandled_rejection: 'boot.notReady',
};

/** Every boot error code mapped here, for the test that checks they all name catalog keys. */
export const BOOT_ERROR_CODES: readonly string[] = Object.keys(BOOT_ERROR_KEYS);

/**
 * The catalog text for a boot error `code`. `db_encryption_unreadable` has none: its screen's title and
 * body already say it in the host's language. Unknown and missing codes get the generic "did not become
 * ready".
 */
export function bootErrorKey(code: string | undefined, lockedReason?: LockedReason): AppCatalogKey | undefined {
  if (code === 'db_encryption_locked') {
    return lockedReason === 'no_key' ? 'boot.lockedBody' : 'boot.lockedOtherBody';
  }
  if (code === 'db_encryption_unreadable') {
    return undefined;
  }
  return (code !== undefined ? BOOT_ERROR_KEYS[code] : undefined) ?? 'boot.notReady';
}

/** The catalog text for a boot notice (main.js's `DB_ENCRYPTION_NOTICE_CODES`). */
export function bootNoticeKey(code: string | undefined): AppCatalogKey {
  return code === 'db_encryption_recovered_fresh' ? 'boot.noticeRecoveredFresh' : 'boot.noticeDowngraded';
}

/** Read the launcher's `reason` beside a locked report, accepting only the values it sends. */
export function parseLockedReason(value: unknown): LockedReason {
  return value === 'no_key' || value === 'mode_unknown' ? value : undefined;
}

// When the host must type a database passphrase twice (F-055).
//
// A passphrase entry is only a one-time candidate: on an EXISTING database a typo just fails to open it and
// the host is asked again. On a database that doesn't exist yet the first entry becomes the key, so a typo
// in the masked field keys the new network under a passphrase nobody knows, and it only shows at the next
// start, when nothing can open it. The desktop host and loamnet ask twice there; so does this app.
// Pure, so it is unit-tested without React Native.

/** `hasStoredPassphrase()`'s answer (db-encryption.ts). */
export type PassphrasePresenceForConfirm = 'present' | 'absent' | 'error';

/**
 * Whether the locked screen must ask for the passphrase twice. `newDatabase` is the launcher's word
 * (main.js: no database file yet, or a start-fresh marker waiting, so this key creates one). The
 * "a passphrase governs this database" record being absent or unreadable counts too: after a Forget that
 * asks once more than needed, which costs nothing.
 */
export function passphraseNeedsConfirmation(options: {
  newDatabase: boolean;
  presence: PassphrasePresenceForConfirm | undefined;
}): boolean {
  return options.newDatabase || options.presence !== 'present';
}

/** Why `entry` can't be used yet: `'empty'`, `'mismatch'` (confirmation required and not equal), or undefined. */
export function passphraseEntryProblem(
  entry: string,
  confirmation: string,
  needsConfirmation: boolean,
): 'empty' | 'mismatch' | undefined {
  if (!entry) {
    return 'empty';
  }
  if (needsConfirmation && entry !== confirmation) {
    return 'mismatch';
  }
  return undefined;
}

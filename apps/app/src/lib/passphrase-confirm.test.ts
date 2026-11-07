import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { passphraseEntryProblem, passphraseNeedsConfirmation } from './passphrase-confirm';

describe("the launcher's newDatabase signal", () => {
  const mainJs = readFileSync(join(__dirname, '..', '..', 'nodejs-project-template/main.js'), 'utf8');

  it('counts a missing database or a waiting start-fresh marker as a new database', () => {
    const fn = mainJs.slice(mainJs.indexOf('function keyCreatesDatabase() {'));
    expect(fn.slice(0, 400)).toMatch(
      /!fs\.existsSync\(path\.join\(dataDir, 'loam\.db'\)\) \|\| fs\.existsSync\(START_FRESH_MARKER_PATH\)/,
    );
  });

  it('is sent with the locked report the key resolution makes, and forwarded to the host screen', () => {
    expect(mainJs).toMatch(/cfg\.bootError\.code === 'db_encryption_locked' \? \{ newDatabase: keyCreatesDatabase\(\) \}/);
    expect(mainJs).toMatch(/payload\.newDatabase = details\.newDatabase;/);
  });
});

describe('passphraseNeedsConfirmation', () => {
  it('asks twice when the entry will create a new database, whatever the stored record says', () => {
    // After an Emergency Reset or a new network the record can still read "present" with no database.
    expect(passphraseNeedsConfirmation({ newDatabase: true, presence: 'present' })).toBe(true);
    expect(passphraseNeedsConfirmation({ newDatabase: true, presence: 'absent' })).toBe(true);
  });

  it('asks twice when no passphrase has ever opened this database, or the record is unreadable', () => {
    expect(passphraseNeedsConfirmation({ newDatabase: false, presence: 'absent' })).toBe(true);
    expect(passphraseNeedsConfirmation({ newDatabase: false, presence: 'error' })).toBe(true);
    expect(passphraseNeedsConfirmation({ newDatabase: false, presence: undefined })).toBe(true);
  });

  it('asks once at the usual start of an existing passphrase network (a typo just fails to open it)', () => {
    expect(passphraseNeedsConfirmation({ newDatabase: false, presence: 'present' })).toBe(false);
  });
});

describe('passphraseEntryProblem', () => {
  it('refuses an empty entry', () => {
    expect(passphraseEntryProblem('', '', false)).toBe('empty');
    expect(passphraseEntryProblem('', '', true)).toBe('empty');
  });

  it('refuses a mismatch only when confirmation is required', () => {
    expect(passphraseEntryProblem('correct horse', 'correct hrose', true)).toBe('mismatch');
    expect(passphraseEntryProblem('correct horse', '', true)).toBe('mismatch');
    expect(passphraseEntryProblem('correct horse', '', false)).toBeUndefined();
  });

  it('compares exactly, with no trimming (the key is derived from the exact entry)', () => {
    expect(passphraseEntryProblem('pass ', 'pass', true)).toBe('mismatch');
    expect(passphraseEntryProblem('pass', 'pass', true)).toBeUndefined();
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BOOT_ERROR_CODES, bootErrorKey, bootNoticeKey, parseLockedReason } from './boot-messages';
import { en } from './i18n/en';

const APP_ROOT = join(__dirname, '..', '..');
const SERVER_SRC = join(APP_ROOT, '..', 'server', 'src');

describe('bootErrorKey', () => {
  it('names a real catalog key for every mapped code', () => {
    for (const code of BOOT_ERROR_CODES) {
      expect(en, code).toHaveProperty(bootErrorKey(code) as string);
    }
  });

  it('gives the usual passphrase prompt its own text and every other locked case the general one', () => {
    expect(bootErrorKey('db_encryption_locked', 'no_key')).toBe('boot.lockedBody');
    expect(bootErrorKey('db_encryption_locked', 'mode_unknown')).toBe('boot.lockedOtherBody');
    expect(bootErrorKey('db_encryption_locked', undefined)).toBe('boot.lockedOtherBody');
  });

  it('has no body for the unreadable screen (its title and body say it) and a generic one for the unknown', () => {
    expect(bootErrorKey('db_encryption_unreadable')).toBeUndefined();
    expect(bootErrorKey('something_new')).toBe('boot.notReady');
    expect(bootErrorKey(undefined)).toBe('boot.notReady');
  });

  it('covers every boot error and notice code the server and the launcher report', () => {
    const sources = [
      readFileSync(join(SERVER_SRC, 'store-lifecycle.ts'), 'utf8'),
      readFileSync(join(SERVER_SRC, 'kill-switch.ts'), 'utf8'),
      readFileSync(join(SERVER_SRC, 'embedded-main.ts'), 'utf8'),
    ].join('\n');
    const reported = new Set(
      [...sources.matchAll(/report(?:BootNotice|BootError)\([^,]+,\s*"([a-z_]+)"\)/g)].map((match) => match[1]),
    );
    expect(reported.size).toBeGreaterThan(5);
    const handled = new Set([
      ...BOOT_ERROR_CODES,
      'db_encryption_locked',
      'db_encryption_unreadable',
      'db_encryption_recovered_fresh', // a notice: bootNoticeKey
      // A persistent database an ephemeral key can never open, or the ephemeral marker can't be handled:
      // the generic "did not become ready" plus Details, and Encryption settings on the same screen.
      'db_ephemeral_existing_database',
      'db_ephemeral_marker_unremovable',
      'db_ephemeral_marker_unwritable',
    ]);
    for (const code of reported) {
      expect(handled, code).toContain(code);
    }
  });
});

describe('bootNoticeKey', () => {
  it('names the fresh-start notice and falls back to the general one', () => {
    expect(bootNoticeKey('db_encryption_recovered_fresh')).toBe('boot.noticeRecoveredFresh');
    expect(bootNoticeKey(undefined)).toBe('boot.noticeDowngraded');
  });
});

describe('parseLockedReason', () => {
  it('accepts only the reasons boot-config.js sends', () => {
    expect(parseLockedReason('no_key')).toBe('no_key');
    expect(parseLockedReason('mode_unknown')).toBe('mode_unknown');
    expect(parseLockedReason('anything')).toBeUndefined();
    expect(parseLockedReason(3)).toBeUndefined();
  });

  it('matches the reasons boot-config.js actually attaches', () => {
    const bootConfig = readFileSync(join(APP_ROOT, 'nodejs-project-template/boot-config.js'), 'utf8');
    const reasons = [...bootConfig.matchAll(/reason: '([a-z_]+)'/g)].map((match) => match[1]);
    expect(reasons.sort()).toEqual(['mode_unknown', 'no_key']);
  });
});

describe('the recovery screens show catalog text, not the launcher English (F-054)', () => {
  const index = readFileSync(join(APP_ROOT, 'src/app/index.tsx'), 'utf8');

  it('never renders the reported message or a notice message as the body', () => {
    expect(index).not.toMatch(/\{errorMessage \?\? t\(/);
    expect(index).not.toMatch(/notice\.message \?\?/);
    expect(index).toMatch(/setErrorDetail\(payload\.message\)/);
  });

  it('puts the reported text behind Details', () => {
    expect([...index.matchAll(/<BootDetails text=\{errorDetail\} \/>/g)].length).toBeGreaterThanOrEqual(5);
    expect([...index.matchAll(/<BootDetails text=\{notice\.message\} \/>/g)].length).toBe(2);
  });
});

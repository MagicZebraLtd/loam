// The database passphrase is never offered to a password manager: Android's autofill service would keep a
// copy outside LOAM, beyond the reach of "Forget" and an Emergency Reset. There is no renderer in this
// harness, so this pins the props in the source of every secure text field.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const APP_ROOT = join(__dirname, '..', '..');
const FILES = ['src/app/index.tsx', 'src/components/db-encryption-settings.tsx'];

/** Every `<TextInput ... />` element in `source` that has `secureTextEntry`. */
function secureInputs(source: string): string[] {
  return [...source.matchAll(/<TextInput\b[\s\S]*?\/>/g)].map((match) => match[0]).filter((element) => /\bsecureTextEntry\b/.test(element));
}

describe('passphrase fields', () => {
  it.each(FILES)('in %s are kept out of autofill', (file) => {
    const inputs = secureInputs(readFileSync(join(APP_ROOT, file), 'utf8'));
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) {
      expect(input).toMatch(/\bimportantForAutofill="no"/);
      expect(input).toMatch(/\bautoComplete="off"/);
    }
  });

  it('covers all seven passphrase fields', () => {
    const count = FILES.reduce((total, file) => total + secureInputs(readFileSync(join(APP_ROOT, file), 'utf8')).length, 0);
    expect(count).toBe(7);
  });
});

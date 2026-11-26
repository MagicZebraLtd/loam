// Checks on the launcher script (nodejs-project-template/main.js) that the host screen depends on. main.js
// can't be required here (it pulls in rn-bridge and starts booting at import), so the device-key handoff hook
// is run on its own against a stand-in bridge, and the rest is read from the source.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const MAIN_JS = readFileSync(join(__dirname, '..', '..', 'nodejs-project-template/main.js'), 'utf8');

/** The source of one `function name(...) { ... }` (or listener) from main.js, up to the next top-level line. */
function section(start: string): string {
  const from = MAIN_JS.indexOf(start);
  expect(from, start).toBeGreaterThanOrEqual(0);
  const rest = MAIN_JS.slice(from);
  // Every top-level block in main.js closes with a `}` or `});` at column 0.
  const end = /\n\}\)?;?\n/.exec(rest);
  expect(end, start).not.toBeNull();
  return rest.slice(0, end!.index + end![0].length);
}

describe('the device-key clear request', () => {
  it('carries no payload when a running server asks for it after a reset', () => {
    const hook = section('global.__loamRequestWipeRestart = function () {');
    const posts: unknown[][] = [];
    const global: { __loamRequestWipeRestart?: () => void } = {};
    new Function('global', 'rnBridge', hook)(global, {
      channel: { post: (...args: unknown[]) => posts.push(args) },
    });
    global.__loamRequestWipeRestart?.();
    expect(posts).toEqual([['loam-wipe-restart']]);
  });

  it('says `resume: true` when the launcher finishes an earlier launch reset at its own boot', () => {
    const boot = section('function bootWithWipeResume() {');
    const posts = [...boot.matchAll(/rnBridge\.channel\.post\('loam-wipe-restart'([^)]*)\)/g)];
    expect(posts).toHaveLength(1);
    expect(posts[0]![1]).toBe(', { resume: true }');
    // Every other request for the clear is the live one.
    const all = [...MAIN_JS.matchAll(/rnBridge\.channel\.post\('loam-wipe-restart'([^)]*)\)/g)].map((match) => match[1]);
    expect(all.sort()).toEqual(['', ', { resume: true }']);
  });
});

describe('the boot watchdog', () => {
  it('is armed by every attempt that loads the server, and never by a locked one', () => {
    const boot = section('function resolveDbEncryptionAndBoot() {');
    const last = boot.slice(boot.lastIndexOf('.then(function (outcome) {'));
    const locked = last.slice(0, last.indexOf("require('./loam-server.js')"));
    expect(locked).toMatch(/if \(outcome === 'locked'\) \{/);
    expect(locked.replace(/\/\/.*$/gm, '')).not.toMatch(/startReadinessProbe\(\)/);
    const loaded = last.slice(last.indexOf("require('./loam-server.js')"));
    expect(loaded.replace(/\/\/.*$/gm, '')).toMatch(/^require\('\.\/loam-server\.js'\);\s*startReadinessProbe\(\);/);
  });

  it('is not armed again by a start-fresh, so a locked start-fresh keeps its lock screen', () => {
    // A start-fresh boots through `bootWithWipeResume`, which arms the watchdog only once the server loads.
    // A second one armed after a locked outcome would report `boot_timeout` five minutes later over the
    // lock screen's details.
    const listener = section("rnBridge.channel.on('loam-db-start-fresh', function (payload) {");
    expect(listener).toMatch(/bootWithWipeResume\(\)\.then\(/);
    expect(listener.replace(/\/\/.*$/gm, '')).not.toMatch(/startReadinessProbe\(\)/);
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  closeAfterReset,
  finishWipeKeyClear,
  mayRebootstrapAfterWipe,
  requestEmergencyReset,
  resetOutcome,
  wipeKeyClearStateAfter,
  wipeRestartKind,
  type WipeKeyClearSteps,
} from './emergency-reset';

// What `closeLoamAfterReset` (reset-close.ts) wires in: the native close and web-storage delete, the share
// cache and the setup record. Each records its step, so the tests can check what happened before the close.
const steps = vi.hoisted(() => ({ order: [] as string[], webData: undefined as undefined | (() => Promise<void>) }));
vi.mock('../../modules/loam-hotspot', () => ({
  closeApp: vi.fn(() => {
    steps.order.push('close');
  }),
  deleteAllWebData: vi.fn(async () => {
    steps.order.push('web-data');
    await steps.webData?.();
  }),
  deleteWebOriginData: vi.fn(async (origin: string) => {
    steps.order.push(`web-data ${origin}`);
  }),
}));
vi.mock('./save-file', () => ({
  clearSharedFiles: vi.fn(async () => {
    steps.order.push('shared-files');
  }),
}));
vi.mock('./new-network', () => ({
  clearSetupRecord: vi.fn(async () => {
    steps.order.push('setup-record');
  }),
}));

const { HOST_WEB_DATA_TIMEOUT_MS, clearWipeKeyAfterReset, closeLoamAfterReset } = await import('./reset-close');

beforeEach(() => {
  steps.order.length = 0;
  steps.webData = undefined;
});

/** A bridge double: records posts, lets the test answer like main.js would. */
function fakeChannel() {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const posts: Array<{ name: string; payload: { requestId: string } }> = [];
  return {
    posts,
    channel: {
      addListener(name: string, handler: (payload: unknown) => void) {
        const set = listeners.get(name) ?? new Set();
        set.add(handler);
        listeners.set(name, set);
        return { remove: () => set.delete(handler) };
      },
      removeAllListeners(name: string) {
        listeners.delete(name);
      },
      post(name: string, payload: unknown) {
        posts.push({ name, payload: payload as { requestId: string } });
      },
    },
    answer(payload: unknown) {
      for (const handler of listeners.get('loam-emergency-reset-result') ?? []) {
        handler(payload);
      }
    },
  };
}

describe('requestEmergencyReset', () => {
  it('posts the request and resolves with the matching answer', async () => {
    const bridge = fakeChannel();
    const pending = requestEmergencyReset(bridge.channel);
    const { requestId } = bridge.posts[0]!.payload;
    expect(bridge.posts[0]!.name).toBe('loam-emergency-reset');
    bridge.answer({ requestId: 'someone-else', ok: false, error: 'not mine' });
    bridge.answer({ requestId, ok: true, complete: true, keyClear: true, journaled: true });
    await expect(pending).resolves.toEqual({ ok: true, complete: true, keyClear: true, journaled: true });
  });

  it('reports an incomplete wipe and a failure as such', async () => {
    const bridge = fakeChannel();
    const incomplete = requestEmergencyReset(bridge.channel);
    bridge.answer({ requestId: bridge.posts[0]!.payload.requestId, ok: true, complete: false, journaled: true });
    await expect(incomplete).resolves.toEqual({ ok: true, complete: false, keyClear: false, journaled: true });

    const failed = requestEmergencyReset(bridge.channel);
    bridge.answer({ requestId: bridge.posts[1]!.payload.requestId, ok: false, error: 'not running' });
    await expect(failed).resolves.toEqual({ ok: false, error: 'not running' });
  });

  it('carries an unjournaled incomplete wipe through, and reads a missing flag as journaled', async () => {
    const bridge = fakeChannel();
    const unrecorded = requestEmergencyReset(bridge.channel);
    bridge.answer({ requestId: bridge.posts[0]!.payload.requestId, ok: true, complete: false, journaled: false });
    await expect(unrecorded).resolves.toEqual({ ok: true, complete: false, keyClear: false, journaled: false });

    // A launcher answer without the field keeps today's reopen-to-finish screen.
    const older = requestEmergencyReset(bridge.channel);
    bridge.answer({ requestId: bridge.posts[1]!.payload.requestId, ok: true, complete: false });
    await expect(older).resolves.toEqual({ ok: true, complete: false, keyClear: false, journaled: true });
  });

  it('gives up after the timeout instead of hanging', async () => {
    vi.useFakeTimers();
    const bridge = fakeChannel();
    const pending = requestEmergencyReset(bridge.channel, 1000);
    vi.advanceTimersByTime(1000);
    await expect(pending).resolves.toEqual({ ok: false, error: "The host app didn't answer. It may still be starting." });
    vi.useRealTimers();
  });

  it('closes LOAM only once everything is erased, and never on an incomplete erase', () => {
    // Review 2026-10-03 #3: the screen used to close the app on any `ok`, including `complete: false`.
    expect(resetOutcome({ ok: true, complete: true, keyClear: false, journaled: true })).toBe('close');
    expect(resetOutcome({ ok: true, complete: true, keyClear: true, journaled: true })).toBe('key-clear');
    expect(resetOutcome({ ok: true, complete: false, keyClear: false, journaled: true })).toBe('incomplete');
    expect(resetOutcome({ ok: true, complete: false, keyClear: true, journaled: true })).toBe('incomplete');
    expect(resetOutcome({ ok: false, error: 'not running' })).toBe('failed');
  });

  it('asks for the reset again, rather than promising a reopen finishes it, when the wipe was not journaled', () => {
    expect(resetOutcome({ ok: true, complete: false, keyClear: false, journaled: false })).toBe('unrecorded');
    expect(resetOutcome({ ok: true, complete: false, keyClear: true, journaled: false })).toBe('unrecorded');
    // A finished wipe needs no journal: whether one was written doesn't change closing.
    expect(resetOutcome({ ok: true, complete: true, keyClear: false, journaled: false })).toBe('close');
    expect(resetOutcome({ ok: true, complete: true, keyClear: true, journaled: false })).toBe('key-clear');
  });
});

describe('closeAfterReset', () => {
  it('closes LOAM only once the shared-file cache is cleared', async () => {
    // Review 2026-10-09 (Android P3): the host-menu reset used to close straight away, leaving the last
    // shared file in the cache until the next launch.
    const order: string[] = [];
    let release!: () => void;
    const clear = () =>
      new Promise<void>((resolve) => {
        release = () => {
          order.push('clear');
          resolve();
        };
      });
    const pending = closeAfterReset(
      {
        clearSharedFiles: clear,
        clearSetupRecord: async () => undefined,
        deleteHostWebData: async () => undefined,
        closeApp: () => order.push('close'),
      },
      1000,
    );
    await Promise.resolve();
    expect(order).toEqual([]);
    release();
    await pending;
    expect(order).toEqual(['clear', 'close']);
  });

  it('clears the setup record before closing, after the shared files', async () => {
    const order: string[] = [];
    await closeAfterReset(
      {
        clearSharedFiles: async () => void order.push('files'),
        clearSetupRecord: async () => void order.push('setup-record'),
        deleteHostWebData: async () => void order.push('web-data'),
        closeApp: () => order.push('close'),
      },
      1000,
    );
    expect(order).toEqual(['files', 'setup-record', 'web-data', 'close']);
  });

  it('still closes LOAM when every step fails', async () => {
    const close = vi.fn();
    const fail = () => Promise.reject(new Error('gone'));
    await closeAfterReset(
      {
        clearSharedFiles: fail,
        clearSetupRecord: fail,
        deleteHostWebData: () => {
          throw new Error('no module');
        },
        closeApp: close,
      },
      1000,
    );
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('closeLoamAfterReset (both reset paths)', () => {
  it("forgets the network's name and deletes all of the host WebView's storage before LOAM closes", async () => {
    // A reset used to leave `loam.setup` behind (setup then offered "Continue <name>") and relied on the page
    // hearing the `wipe` frame to purge its own storage. The WebView only ever shows LOAM, so all of it goes,
    // not one origin's share that the WebView may not clear for an IP-literal site.
    await closeLoamAfterReset();
    expect(steps.order.at(-1)).toBe('close');
    expect(steps.order).toEqual(['shared-files', 'setup-record', 'web-data', 'close']);
  });

  it('waits for the WebView storage delete before closing', async () => {
    let release!: () => void;
    steps.webData = () => new Promise<void>((resolve) => (release = resolve));
    const pending = closeLoamAfterReset();
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
    expect(steps.order).toContain('web-data');
    expect(steps.order).not.toContain('close');
    release();
    await pending;
    expect(steps.order.at(-1)).toBe('close');
  });

  it('still closes LOAM when the WebView storage delete never answers', async () => {
    vi.useFakeTimers();
    try {
      steps.webData = () => new Promise<void>(() => undefined);
      const pending = closeLoamAfterReset();
      await vi.advanceTimersByTimeAsync(HOST_WEB_DATA_TIMEOUT_MS - 1);
      expect(steps.order).not.toContain('close');
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(steps.order.at(-1)).toBe('close');
    } finally {
      vi.useRealTimers();
    }
  });

  it('is how the host-menu reset and the device-key clear both close LOAM', () => {
    const screen = readFileSync(join(__dirname, '../app/index.tsx'), 'utf8');
    const overlay = readFileSync(join(__dirname, '../components/emergency-reset.tsx'), 'utf8');
    const wiring = readFileSync(join(__dirname, 'reset-close.ts'), 'utf8');
    // `attemptWipeKeyClear` (index.tsx) goes through the kind-aware sequence, which closes through
    // `closeLoamAfterReset` on a live reset; the reset screen closes through it directly.
    expect(screen).toMatch(/const attemptWipeKeyClear = async \(\) => \{\s*const kind = wipeKeyClearKindRef\.current;[\s\S]*?await clearWipeKeyAfterReset\(\s*kind,/);
    expect(screen).not.toMatch(/closeLoamAfterReset\(|import \{[^}]*closeLoamAfterReset/);
    expect(wiring).toMatch(/closeLoam: closeLoamAfterReset/);
    expect(overlay.match(/closeLoamAfterReset\(\)/g)).toHaveLength(2);
    for (const source of [screen, overlay]) {
      expect(source).not.toMatch(/closeAfterReset\(/);
      expect(source).not.toMatch(/finishWipeKeyClear\(/);
    }
  });
});

describe('which device-key clear main.js asks for', () => {
  it('reads a resume only from an explicit `resume: true`', () => {
    expect(wipeRestartKind({ resume: true })).toBe('resume');
    for (const payload of [undefined, null, {}, { resume: false }, { resume: 'true' }, { resume: 1 }, 'resume', true]) {
      expect(wipeRestartKind(payload), JSON.stringify(payload)).toBe('live');
    }
  });
});

/** Steps that record their order, with a key clear that answers `result`. */
function keyClearSteps(result: { ok: boolean; error?: string } | (() => Promise<{ ok: boolean; error?: string }>)) {
  const order: string[] = [];
  const record = (name: string) => async () => void order.push(name);
  const stepsUnderTest: WipeKeyClearSteps = {
    clearSetupRecord: record('setup-record'),
    clearSharedFiles: record('shared-files'),
    deleteHostWebData: record('web-data'),
    clearKeyAndAck: async () => {
      order.push('key-clear');
      return typeof result === 'function' ? result() : result;
    },
    closeLoam: record('close'),
  };
  return { order, steps: stepsUnderTest };
}

describe('finishWipeKeyClear', () => {
  it('on a live reset, forgets the setup record first, then clears the key, then closes LOAM', async () => {
    const { order, steps: s } = keyClearSteps({ ok: true });
    await expect(finishWipeKeyClear('live', s, 1000)).resolves.toEqual({ ok: true });
    expect(order).toEqual(['setup-record', 'key-clear', 'close']);
  });

  it('on a live reset whose key clear fails, neither closes nor claims success, and the record stays gone', async () => {
    const { order, steps: s } = keyClearSteps({ ok: false, error: 'key still there' });
    await expect(finishWipeKeyClear('live', s, 1000)).resolves.toEqual({ ok: false, error: 'key still there' });
    expect(order).toEqual(['setup-record', 'key-clear']);
  });

  it('on a live reset, still clears the key when forgetting the setup record fails', async () => {
    const { order, steps: s } = keyClearSteps({ ok: true });
    s.clearSetupRecord = () => Promise.reject(new Error('store gone'));
    await expect(finishWipeKeyClear('live', s, 1000)).resolves.toEqual({ ok: true });
    expect(order).toEqual(['key-clear', 'close']);
  });

  it('on a resume, clears the shared file and the WebView storage, then the key, and keeps the new setup', async () => {
    // The setup screens already ran in this launch: the record now names the network just set up, and the
    // boot carries on in this process, so nothing may close.
    const { order, steps: s } = keyClearSteps({ ok: true });
    await expect(finishWipeKeyClear('resume', s, 1000)).resolves.toEqual({ ok: true });
    expect(order).toEqual(['shared-files', 'web-data', 'key-clear']);
    expect(order).not.toContain('setup-record');
    expect(order).not.toContain('close');
  });

  it('on a resume whose key clear fails, reports the failure and touches nothing else', async () => {
    const { order, steps: s } = keyClearSteps({ ok: false, error: 'keystore busy' });
    await expect(finishWipeKeyClear('resume', s, 1000)).resolves.toEqual({ ok: false, error: 'keystore busy' });
    expect(order).toEqual(['shared-files', 'web-data', 'key-clear']);
  });

  it('on a resume, clears the key once the WebView storage delete has had its time, even if it never answers', async () => {
    vi.useFakeTimers();
    try {
      const { order, steps: s } = keyClearSteps({ ok: true });
      s.deleteHostWebData = () => new Promise<void>(() => undefined);
      const pending = finishWipeKeyClear('resume', s, 1500);
      await vi.advanceTimersByTimeAsync(1499);
      expect(order).toEqual(['shared-files']);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toEqual({ ok: true });
      expect(order).toEqual(['shared-files', 'key-clear']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts a key clear that throws as a failure, in either kind', async () => {
    for (const kind of ['live', 'resume'] as const) {
      const { order, steps: s } = keyClearSteps(() => Promise.reject(new Error('bridge gone')));
      await expect(finishWipeKeyClear(kind, s, 1000)).resolves.toEqual({ ok: false, error: 'bridge gone' });
      expect(order).not.toContain('close');
    }
  });
});

describe('the re-bootstrap after a reset the web client reports', () => {
  it('runs only while no device-key clear is under way or failed', () => {
    expect(mayRebootstrapAfterWipe('idle')).toBe(true);
    expect(mayRebootstrapAfterWipe('clearing')).toBe(false);
    expect(mayRebootstrapAfterWipe('failed')).toBe(false);
  });

  it('is allowed again after a resumed clear, but not after a live one, which closes LOAM', () => {
    expect(wipeKeyClearStateAfter('resume', { ok: true })).toBe('idle');
    expect(wipeKeyClearStateAfter('live', { ok: true })).toBe('clearing');
    expect(wipeKeyClearStateAfter('resume', { ok: false })).toBe('failed');
    expect(wipeKeyClearStateAfter('live', { ok: false })).toBe('failed');
  });
});

describe('clearWipeKeyAfterReset (the wiring index.tsx calls)', () => {
  it('on a resume, deletes all WebView storage and keeps the setup record and the app', async () => {
    const clear = vi.fn(async () => {
      steps.order.push('key-clear');
      return { ok: true };
    });
    await expect(clearWipeKeyAfterReset('resume', clear)).resolves.toEqual({ ok: true });
    expect(steps.order).toEqual(['shared-files', 'web-data', 'key-clear']);
  });

  it('on a live reset, forgets the setup record before the key clear and closes LOAM after it', async () => {
    const clear = vi.fn(async () => {
      steps.order.push('key-clear');
      return { ok: true };
    });
    await expect(clearWipeKeyAfterReset('live', clear)).resolves.toEqual({ ok: true });
    expect(steps.order[0]).toBe('setup-record');
    expect(steps.order.indexOf('key-clear')).toBe(1);
    expect(steps.order.at(-1)).toBe('close');
  });
});

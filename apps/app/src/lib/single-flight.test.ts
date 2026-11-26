import { describe, expect, it, vi } from 'vitest';

import { createSingleFlight } from './single-flight';

/** A promise the test settles by hand, standing in for a device-key clear. */
function pending<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createSingleFlight', () => {
  it('joins a call made while the first is running: the work runs once and both get its result', async () => {
    const flight = createSingleFlight<string>();
    const first = pending<string>();
    const work = vi.fn(() => first.promise);
    const a = flight.run(work);
    const b = flight.run(work);
    expect(work).toHaveBeenCalledTimes(1);
    first.resolve('cleared');
    await expect(a).resolves.toBe('cleared');
    await expect(b).resolves.toBe('cleared');
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('runs the work again once the earlier run has settled', async () => {
    const flight = createSingleFlight<number>();
    let calls = 0;
    const work = () => Promise.resolve(++calls);
    await expect(flight.run(work)).resolves.toBe(1);
    await expect(flight.run(work)).resolves.toBe(2);
  });

  it('shares a rejection with every joined caller, and a later call runs afresh', async () => {
    const flight = createSingleFlight<string>();
    const first = pending<string>();
    const failing = vi.fn(() => first.promise);
    const a = flight.run(failing);
    const b = flight.run(failing);
    first.reject(new Error('keystore busy'));
    await expect(a).rejects.toThrow('keystore busy');
    await expect(b).rejects.toThrow('keystore busy');
    expect(failing).toHaveBeenCalledTimes(1);
    await expect(flight.run(() => Promise.resolve('cleared'))).resolves.toBe('cleared');
  });

  it('turns a synchronous throw into a rejection that does not stick', async () => {
    const flight = createSingleFlight<string>();
    await expect(
      flight.run(() => {
        throw new Error('no bridge');
      }),
    ).rejects.toThrow('no bridge');
    await expect(flight.run(() => Promise.resolve('cleared'))).resolves.toBe('cleared');
  });

  it('settled() waits for the run in flight, and answers at once when nothing runs', async () => {
    const flight = createSingleFlight<string>();
    await expect(flight.settled()).resolves.toBeUndefined();

    const first = pending<string>();
    void flight.run(() => first.promise).catch(() => undefined);
    let waited = false;
    const wait = flight.settled().then(() => {
      waited = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(waited).toBe(false);
    first.reject(new Error('failed'));
    await wait;
    expect(waited).toBe(true);
  });

  it('settled() also waits out a run that starts while it is waiting', async () => {
    const flight = createSingleFlight<string>();
    const first = pending<string>();
    const second = pending<string>();
    void flight.run(() => first.promise);
    let waited = false;
    const wait = flight.settled().then(() => {
      waited = true;
    });
    first.resolve('one');
    // The next run is asked for in the same turn the first one settles.
    await first.promise;
    void flight.run(() => second.promise);
    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
    }
    expect(waited).toBe(false);
    second.resolve('two');
    await wait;
    expect(waited).toBe(true);
  });
});

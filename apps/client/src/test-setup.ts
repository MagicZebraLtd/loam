import { afterAll, vi } from "vitest";

/**
 * Preact 11 runs `useEffect` cleanups of unmounted components after the next paint (requestAnimationFrame
 * raced against a 35 ms timeout), not during the unmount. A test file that unmounts in its last test would
 * otherwise have those cleanups fire after Vitest has torn the jsdom environment down, where `window` no
 * longer exists, and Vitest reports the ReferenceError as an unhandled error that fails the run even though
 * every test passed. Waiting past that window at the end of each file lets them run while the page still
 * exists. Real timers first: a file that left fake timers on would never see this timeout fire.
 */
afterAll(async () => {
  vi.useRealTimers();
  await new Promise((resolve) => setTimeout(resolve, 80));
  // One more turn of the timer queue. Preact's 35 ms timer only schedules the cleanups; a second, zero-delay
  // timer runs them. When the machine stalls, that timer and the wait above come due together, and the wait
  // would end with the cleanups still queued. A timer set now runs after theirs.
  await new Promise((resolve) => setTimeout(resolve, 0));
});

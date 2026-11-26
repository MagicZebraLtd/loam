/**
 * One run of some async work at a time, joined rather than repeated. Built for the device-key clear after an
 * Emergency Reset (`attemptWipeKeyClear` in src/app/index.tsx): main.js asks for the clear again when its own
 * wait times out, and a second clear running beside the first could delete the device secret minted once the
 * first one acknowledged. Pure: no timers, nothing native.
 */
export type SingleFlight<T> = {
  /**
   * Start `work`, or join the run already in flight (its `work` is not called) and get that run's result or
   * rejection. Once the run has settled, the next call starts `work` again, so a failure never sticks.
   */
  run: (work: () => Promise<T>) => Promise<T>;
  /** Resolves (never rejects) once no run is in flight, including one started while this waits. */
  settled: () => Promise<void>;
};

/** Create an empty {@link SingleFlight}. */
export function createSingleFlight<T>(): SingleFlight<T> {
  let inFlight: Promise<T> | undefined;

  const run = (work: () => Promise<T>): Promise<T> => {
    if (inFlight) {
      return inFlight;
    }
    let current: Promise<T>;
    try {
      current = Promise.resolve(work());
    } catch (error) {
      current = Promise.reject(error);
    }
    inFlight = current;
    // Registered before the caller can await `current`, so the slot is free by the time it resumes.
    const release = () => {
      if (inFlight === current) {
        inFlight = undefined;
      }
    };
    current.then(release, release);
    return current;
  };

  const settled = async (): Promise<void> => {
    while (inFlight) {
      await inFlight.then(
        () => undefined,
        () => undefined,
      );
    }
  };

  return { run, settled };
}

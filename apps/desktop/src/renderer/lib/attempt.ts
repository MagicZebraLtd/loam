import type { HostResult } from "@loam/schema";

/**
 * Run a bridge call that answers with a `HostResult`, turning a thrown error (the IPC channel failed, the
 * main process refused the request outright) into `{ ok: false, error }`, so a screen has one shape to
 * handle and never leaves a rejected promise unhandled.
 */
export async function attempt<T>(call: () => Promise<HostResult<T>>): Promise<HostResult<T>> {
  try {
    return await call();
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

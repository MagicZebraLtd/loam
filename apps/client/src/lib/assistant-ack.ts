// A member's acknowledgement that the assistant answers from an online service (docs/06): shown once per
// service on this device, then remembered in localStorage. It is a per-device convenience, like the theme:
// blocked or cleared storage only means the notice asks again.

/** The localStorage key prefix; the service's hostname follows it. */
export const ASSISTANT_ACK_PREFIX = "loam.assistantAck.";

/** The storage key for `host`'s acknowledgement. Hostnames are case-insensitive, so it is lower-cased. */
function ackKey(host: string): string {
  return `${ASSISTANT_ACK_PREFIX}${host.toLowerCase()}`;
}

/**
 * Whether this device already acknowledged that the assistant's answers come from `host`.
 *
 * @param host - The online service's hostname (`AssistantDestination` of kind `online`).
 * @returns False when nothing is stored or storage can't be read.
 */
export function hasAcknowledgedAssistantHost(host: string): boolean {
  try {
    return localStorage.getItem(ackKey(host)) === "1";
  } catch {
    return false;
  }
}

/**
 * Remember that this device acknowledged `host`. Best-effort: if storage is blocked, the acknowledgement
 * lasts only as long as the caller keeps it in memory.
 *
 * @param host - The online service's hostname.
 */
export function acknowledgeAssistantHost(host: string): void {
  try {
    localStorage.setItem(ackKey(host), "1");
  } catch {
    // Not remembered: the notice asks again next time.
  }
}

/**
 * Forget every acknowledgement (wipe, identity change): which online services the assistant used here is a
 * trace of using it, so it goes with the rest of the cached content. Best-effort.
 */
export function clearAssistantAcks(): void {
  try {
    const keys: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(ASSISTANT_ACK_PREFIX)) {
        keys.push(key);
      }
    }
    for (const key of keys) {
      localStorage.removeItem(key);
    }
  } catch {
    // Nothing durable to clear.
  }
}

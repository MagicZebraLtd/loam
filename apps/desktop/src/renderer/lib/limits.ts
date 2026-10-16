/**
 * The limits and fixed values the renderer checks against. They mirror `src/shared/ipc.ts` and @loam/tui,
 * which the renderer imports for types only (their runtime pulls in zod and Node built-ins): `limits.test.ts`
 * keeps the copies equal.
 */

/** `MAX_NODE_NAME` in ipc.ts (the server's limit). */
export const MAX_NODE_NAME = 80;
/** `MAX_PASSPHRASE` in ipc.ts. */
export const MAX_PASSPHRASE = 1024;
/**
 * The shortest passphrase setup accepts. The contract allows one character, but the key is only as strong
 * as the passphrase, so a new network asks for a little more. Unlocking accepts whatever was set.
 */
export const MIN_NEW_PASSPHRASE = 8;
/** `HOST_ACK_VERSION` in packages/tui/src/app.ts: the version of the "You run this network" note. */
export const HOST_ACK_VERSION = 1;
/** Where a person downloads LOAM again (the GitHub releases page, as in apps/app/src/lib/app-updates.ts). */
export const RELEASES_PAGE = "https://github.com/MagicZebraLtd/loam/releases/latest";
/** The port the node prefers when none is set (DesktopSettingsView.port). */
export const DEFAULT_PORT = 3000;
/** `CopyRequestSchema`'s cap on copied text in ipc.ts. */
export const MAX_COPY_LENGTH = 4096;

/** Whether this host still has to see the "You run this network" note. */
export function needsHostAck(hostAck: number | undefined): boolean {
  return (hostAck ?? 0) < HOST_ACK_VERSION;
}

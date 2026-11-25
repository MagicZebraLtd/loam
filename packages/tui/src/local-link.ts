/**
 * The host part of a link that opens LOAM on this computer (the terminal UI's "Open as admin", plain mode's
 * admin link and "Open on this device"), from the address the node listens on (`HOST`). Such a link can carry
 * a one-time admin code, so it must reach an address LOAM itself holds: never `localhost`, which can resolve
 * to `[::1]` while LOAM listens on IPv4 only, where another account on this computer could listen and read it.
 */
import { isIP } from "node:net";

/**
 * `127.0.0.1` when the node listens on every interface (`0.0.0.0`, `::`, nothing set) or on `127.0.0.1`,
 * `[::1]` when it listens on IPv6 loopback only, and otherwise the one address it listens on (bracketed when
 * IPv6), since then it doesn't listen on `127.0.0.1` at all: another loopback address such as `127.0.0.2` is
 * used as it is, because `127.0.0.1` on that port is free for another program. `localhost` counts as
 * `127.0.0.1`. Pure.
 */
export function localLinkHost(listenHost: string): string {
  const bare = listenHost.trim().replace(/^\[(.*)\]$/, "$1");
  if (bare === "" || bare === "0.0.0.0" || bare === "::" || bare === "127.0.0.1" || bare.toLowerCase() === "localhost") {
    return "127.0.0.1";
  }
  if (bare === "::1") {
    return "[::1]";
  }
  return isIP(bare) === 6 ? `[${bare}]` : bare;
}

/** `http://<local link host>:<port>`, for the address and port the node listens on. Pure. */
export function localOrigin(listenHost: string, listenPort: number): string {
  return `http://${localLinkHost(listenHost)}:${listenPort}`;
}

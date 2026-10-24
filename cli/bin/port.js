// Port selection for the `loam` launcher (bin/loam.js). Kept separate so it's testable
// (cli/test/port.test.mjs). The server binds a wildcard address, but on macOS (and anywhere Node's
// SO_REUSEADDR lets a wildcard bind coexist with a specific one) a wildcard bind can succeed while another
// program holds the same port on loopback — `http://localhost:<port>` would then open that program, not
// LOAM. So a port counts as free only when the listen host AND the loopback addresses are all bindable.
import { createServer } from "node:net";

/** Errors meaning "this address family/interface doesn't exist here", not "the port is taken". */
const UNAVAILABLE_ADDRESS_CODES = new Set(["EADDRNOTAVAIL", "EAFNOSUPPORT"]);

/**
 * Try to bind `host:port` and release it at once. Resolves true when the bind succeeds (or the address
 * isn't usable on this machine at all, e.g. no IPv6 loopback), false when the port is in use, and rejects
 * on any other error (such as EACCES for a privileged port) so the caller can report it. EACCES on an
 * unprivileged port counts as in use: Windows reserves blocks of ports for Hyper-V and WSL (netsh's "excluded
 * port range", often covering 3000) and denies a bind inside one, so the search steps past the block.
 */
function canBind(port, host) {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", (error) => {
      if (error.code === "EADDRINUSE" || (error.code === "EACCES" && port >= 1024)) {
        resolve(false);
      } else if (UNAVAILABLE_ADDRESS_CODES.has(error.code)) {
        resolve(true);
      } else {
        reject(error);
      }
    });
    probe.listen({ port, host, exclusive: true }, () => {
      probe.close(() => resolve(true));
    });
  });
}

/** The addresses to probe for a server listening on `host`: that host, plus loopback for a wildcard. */
export function probeHosts(host) {
  const wildcard = host === "0.0.0.0" || host === "::";
  return wildcard ? [host, "127.0.0.1", "::1"] : [host];
}

/** Whether nothing else is listening on `port` for a server that will bind `host`. */
export async function isPortFree(port, host) {
  for (const address of probeHosts(host)) {
    if (!(await canBind(port, address))) {
      return false;
    }
  }
  return true;
}

/** How many ports `findFreePort` tries by default: enough to cross a Windows reserved port block (about a hundred wide). */
export const PORT_ATTEMPTS = 120;

/**
 * The first free port in `start … start + attempts - 1` (never past 65535) for a server on `host`, or
 * undefined when every one is taken.
 */
export async function findFreePort(start, host, attempts = PORT_ATTEMPTS) {
  const last = Math.min(start + attempts - 1, 65535);
  for (let port = start; port <= last; port += 1) {
    if (await isPortFree(port, host)) {
      return port;
    }
  }
  return undefined;
}

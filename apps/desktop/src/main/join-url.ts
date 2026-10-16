/**
 * The join URL, built exactly as the terminal UI's Join screen builds it (packages/tui/src/app.ts `joinLink`):
 * `http://<joinHost>:<port>/#k=<transport key>` plus `&i=<invite code>` on an approval-only node. The key rides
 * in the fragment so a scanner learns it out of band (docs/08); there is no `#k=` in Developer Mode, which the
 * shipped app never runs.
 */
import { networkInterfaces } from "node:os";

/** An IPv6 address in brackets, as a URL needs it. */
export function formatHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/** What the join URL is made of. */
export type JoinUrlParts = {
  joinHost: string;
  port: number;
  transportKey?: string;
  inviteCode?: string;
};

/** The URL joiners open (and the join QR encodes). Pure. */
export function buildJoinUrl({ joinHost, port, transportKey, inviteCode }: JoinUrlParts): string {
  const parts = [transportKey ? `k=${transportKey}` : "", inviteCode ? `i=${inviteCode}` : ""].filter(Boolean);
  return `http://${formatHost(joinHost)}:${port}/${parts.length ? `#${parts.join("&")}` : ""}`;
}

/** The URL this computer's own window opens: loopback, so it never depends on which network is up. */
export function localOrigin(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/** One interface's entry, as `os.networkInterfaces()` reports it (the part read here). */
export type InterfaceEntry = { family: string | number; address: string; internal: boolean };

/**
 * The IPv4 addresses other devices could reach this computer on (no loopback, no link-local 169.254.x.x),
 * as the terminal UI lists them for pinning a join address. Pure over the interface table.
 */
export function lanAddressesFrom(table: Record<string, InterfaceEntry[] | undefined>): string[] {
  const found: string[] = [];
  for (const entries of Object.values(table)) {
    for (const entry of entries ?? []) {
      const ipv4 = entry.family === "IPv4" || entry.family === 4;
      if (ipv4 && !entry.internal && !entry.address.startsWith("169.254.") && !found.includes(entry.address)) {
        found.push(entry.address);
      }
    }
  }
  return found;
}

/** This computer's LAN addresses right now. */
export function lanAddresses(): string[] {
  return lanAddressesFrom(networkInterfaces());
}

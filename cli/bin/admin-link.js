// Plain mode's one-time admin link: while nobody is admin (a new network, or again after an Emergency Reset),
// keep one on hand (each lasts 10 minutes). In a terminal it is printed. Without one (a service), it goes to a
// file only this user can read, never to the log: a journal or log shipper is read by more people than this. A
// code that is replaced, or no longer needed because someone is admin, is retired on the server too: deleting
// the file alone would leave it usable until it expired.
import { rmSync, writeFileSync } from "node:fs";

/**
 * The offer, run at start and then on a timer while loam runs; it never throws, since a throw would escape the
 * timer and stop the node. `localOrigin` is the origin of the address and port the node listens on (never the
 * advertised port), `joinUrl` what joiners are told. `log` and `error` print a line.
 */
export function createAdminLinkOffer({ host, linkFile, joinUrl, localOrigin, interactive, log, error }) {
  let current;
  let started = false;

  /** Remove the link file; false (and said why) when it couldn't be. */
  const removeLinkFile = () => {
    try {
      rmSync(linkFile, { force: true });
      return true;
    } catch (failure) {
      error(`Couldn't remove the old admin link ${linkFile} (${failure?.code ?? failure}). Delete it by hand.`);
      return false;
    }
  };
  const retireCurrent = () => {
    if (current) {
      const { code } = current;
      current = undefined;
      try {
        host.revokeAdminClaimCode(code);
      } catch {
        // Mid-reset the node can refuse; a reset retires every code anyway.
      }
    }
  };

  const offer = () => {
    // A file an earlier run left holds a code that died with that process: remove it once, whatever happens next.
    if (!started) {
      started = true;
      removeLinkFile();
    }
    let status;
    try {
      status = host.status();
    } catch {
      return;
    }
    if (status.people.admins > 0) {
      if (current) {
        removeLinkFile();
        retireCurrent();
      }
      return;
    }
    // A link minted now would carry the key that is being replaced: wait for the reset to finish.
    if (status.resetting) {
      return;
    }
    if (current && current.expiresAt - Date.now() > 60_000 && current.resets === status.resets) {
      return;
    }
    retireCurrent();
    const minted = host.adminClaimCode();
    if (!minted) {
      return;
    }
    const key = host.transportPublicKey();
    const fragment = `#${key ? `k=${key}&` : ""}a=${minted.code}`;
    const link = `${joinUrl}${fragment}`;
    current = { code: minted.code, expiresAt: minted.expiresAt, resets: status.resets };
    if (interactive) {
      // Two links to one code. A browser on this computer should use loopback: only a loopback caller is told
      // to keep no copy of an encrypted network's messages on this disk (`hostNoLocalCache`, docs/02).
      log("Nobody is admin yet. Open one of these links to become admin (it works once, for 10 minutes):");
      log(`  On this computer:    ${localOrigin}/${fragment}`);
      log(`  From another device: ${link}`);
      log("");
      return;
    }
    // Remove first: `mode` only applies to a new file, so an existing one (left with looser permissions, or a
    // symlink pointing elsewhere) would otherwise keep its permissions or send the code somewhere else.
    try {
      rmSync(linkFile, { force: true });
      writeFileSync(linkFile, `${link}\n`, { mode: 0o600, flag: "wx" });
    } catch (failure) {
      // Something put a file back in between (or the folder isn't writable): don't write through it.
      retireCurrent();
      error(`Couldn't write the one-time admin link to ${linkFile} (${failure?.code ?? failure}). Trying again shortly.`);
      return;
    }
    log(`Nobody is admin yet. A one-time admin link (renewed every 10 minutes) is in ${linkFile}`);
  };

  return () => {
    try {
      offer();
    } catch (failure) {
      // The host API refusing mid-reset, say: the next tick tries again.
      error(`Couldn't offer an admin link (${failure?.message ?? failure}). Trying again shortly.`);
    }
  };
}

// Tests for plain mode's one-time admin link (cli/bin/admin-link.js). Run with `node --test` (root `pnpm test`).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { createAdminLinkOffer } from "../bin/admin-link.js";

const dirs = [];
after(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A fresh folder for the link file. */
function folder() {
  const dir = mkdtempSync(join(tmpdir(), "loam-admin-link-"));
  dirs.push(dir);
  return dir;
}

/** A host API with only what the offer calls, whose status a test can change. */
function fakeHost(status) {
  const calls = [];
  let minted = 0;
  const fake = {
    calls,
    status: { people: { admins: 0 }, resets: 0, resetting: false, ...status },
    host: {
      status: () => fake.status,
      adminClaimCode: () => {
        minted += 1;
        calls.push(`mint:${minted}`);
        return { code: `code${minted}`, expiresAt: Date.now() + 600_000 };
      },
      revokeAdminClaimCode: (code) => calls.push(`revoke:${code}`),
      transportPublicKey: () => "KEY",
    },
  };
  return fake;
}

/** The offer over `fake`, printing into `lines`. */
function offerFor(fake, options) {
  const lines = [];
  const offer = createAdminLinkOffer({
    host: fake.host,
    linkFile: options.linkFile,
    joinUrl: "http://192.168.1.2:3000",
    localOrigin: options.localOrigin ?? "http://127.0.0.1:3000",
    interactive: options.interactive ?? false,
    log: (line) => lines.push(line),
    error: (line) => lines.push(`ERROR ${line}`),
  });
  return { offer, lines };
}

describe("createAdminLinkOffer", () => {
  it("removes a link file an earlier run left when someone is already admin", () => {
    const linkFile = join(folder(), "admin-link.txt");
    writeFileSync(linkFile, "http://192.168.1.2:3000/#k=KEY&a=deadcode\n");
    const fake = fakeHost({ people: { admins: 1 } });
    offerFor(fake, { linkFile }).offer();
    assert.equal(existsSync(linkFile), false);
    assert.deepEqual(fake.calls, []);
  });

  it("writes the link file while nobody is admin", () => {
    const linkFile = join(folder(), "admin-link.txt");
    const fake = fakeHost();
    offerFor(fake, { linkFile }).offer();
    assert.equal(readFileSync(linkFile, "utf8"), "http://192.168.1.2:3000#k=KEY&a=code1\n");
  });

  it("mints nothing while the node is resetting", () => {
    const linkFile = join(folder(), "admin-link.txt");
    const fake = fakeHost({ resetting: true });
    const { offer } = offerFor(fake, { linkFile });
    offer();
    assert.deepEqual(fake.calls, []);
    assert.equal(existsSync(linkFile), false);
    fake.status = { ...fake.status, resetting: false, resets: 1 };
    offer();
    assert.deepEqual(fake.calls, ["mint:1"]);
  });

  it("never throws out of a tick when the link file can't be removed", () => {
    const linkFile = join(folder(), "admin-link.txt");
    const fake = fakeHost();
    const { offer, lines } = offerFor(fake, { linkFile });
    offer();
    assert.ok(existsSync(linkFile));
    // Someone became admin, and a folder now sits where the file was: removing it fails.
    rmSync(linkFile);
    mkdirSync(join(linkFile, "inside"), { recursive: true });
    fake.status = { ...fake.status, people: { admins: 1 } };
    assert.doesNotThrow(() => offer());
    assert.deepEqual(fake.calls, ["mint:1", "revoke:code1"]);
    assert.ok(lines.some((line) => line.startsWith("ERROR ")), lines.join("\n"));
  });

  it("prints the local link on the origin it is given", () => {
    const linkFile = join(folder(), "admin-link.txt");
    const fake = fakeHost();
    const { offer, lines } = offerFor(fake, { linkFile, interactive: true, localOrigin: "http://127.0.0.1:3001" });
    offer();
    assert.ok(lines.some((line) => line.includes("http://127.0.0.1:3001/#k=KEY&a=code1")), lines.join("\n"));
    assert.equal(existsSync(linkFile), false);
  });
});

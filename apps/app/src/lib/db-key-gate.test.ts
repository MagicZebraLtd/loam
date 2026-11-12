// Tests the pure "may a DB key be resolved this boot?" decision extracted from
// nodejs-project-template/main.js into db-key-gate.js (P1-2, Sol round 5). main.js itself can't be
// safely `require()`d from this harness — it pulls in `rn-bridge` (unavailable outside the embedded
// nodejs-mobile runtime) at import time and runs `bootWithWipeResume()` as a boot-time side effect the
// instant it's required — so this dependency-free helper is the unit-testable seam for that gate. See
// the module's own doc comment for the full security rationale (a wipe-pending marker on disk means an
// earlier kill-switch wipe's Keystore key-clear was never confirmed, so no key may be resolved — and no
// boot may proceed — until that's cleared).
//
// COVERAGE NOTE: this only tests the pure decision function. The actual WIRING in main.js — that EVERY
// boot/unlock entry point (the initial boot, and the `loam-db-unlock` retry listener) routes through
// `bootWithWipeResume()` (which calls this gate) rather than `resolveDbEncryptionAndBoot()` directly —
// is NOT covered by an automated test, since main.js can't be loaded in this harness (see above). That
// wiring was verified by inspection (`git diff` on nodejs-project-template/main.js) and `node --check`
// (syntax only). A real-device/emulator smoke test of a Retry tap during a resumed wipe is the only way
// to exercise the full path end-to-end.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { mayResolveDbKeyThisBoot, mayRunBootPipeline } from "../../nodejs-project-template/db-key-gate.js";

const MAIN_JS = readFileSync(join(__dirname, "..", "..", "nodejs-project-template/main.js"), "utf8");

describe("mayRunBootPipeline (F-053: a mode change on a running network waits for the next start)", () => {
  it("refuses once the server is running, so an ephemeral pick can't delete the live database", () => {
    expect(mayRunBootPipeline(true)).toBe(false);
  });

  it("allows a boot while no server is running (first boot, locked, recovery screens)", () => {
    expect(mayRunBootPipeline(false)).toBe(true);
  });

  it("is consulted by bootWithWipeResume and by the start-fresh listener before any reboot", () => {
    const boot = MAIN_JS.slice(MAIN_JS.indexOf("function bootWithWipeResume() {"));
    expect(boot.slice(0, boot.indexOf("if (wipeResumeWait)"))).toMatch(/if \(!mayRunBootPipeline\(serverReadyAnnounced\)\) \{\s*return Promise\.resolve\(\);/);
    const listener = MAIN_JS.slice(MAIN_JS.indexOf("rnBridge.channel.on('loam-db-start-fresh'"));
    const beforeReboot = listener.slice(0, listener.indexOf("bootWithWipeResume()"));
    expect(beforeReboot).toMatch(/if \(!mayRunBootPipeline\(serverReadyAnnounced\)\) \{[\s\S]{0,200}return;/);
    // The marker is still installed (and acked) first, so the change applies at the next start.
    expect(beforeReboot.indexOf("installStartFreshMarker(")).toBeLessThan(beforeReboot.indexOf("mayRunBootPipeline("));
  });
});

describe("mayResolveDbKeyThisBoot", () => {
  it("refuses to resolve a key when a wipe-pending marker exists", () => {
    expect(mayResolveDbKeyThisBoot(true)).toBe(false);
  });

  it("allows resolving a key when no wipe-pending marker exists", () => {
    expect(mayResolveDbKeyThisBoot(false)).toBe(true);
  });
});

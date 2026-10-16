// @vitest-environment node
// The state machine against the REAL server bundle (dist/main/loam-server.js) and SQLCipher driver
// (dist/main/node_modules), under plain Node: the fixed-key Emergency Reset handoff is a contract between this
// launcher and the server's kill switch and wipe journal, so it is checked end to end here. Skipped until
// `pnpm --filter @loam/desktop build && build:native` has produced both.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { clean, createLogBook } from "@loam/tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DbEncryptionMode } from "@loam/schema";

import { encryptedDriverLoads } from "./driver.js";
import { memoryDeviceSecretStore } from "./keys.js";
import { createLogFeed } from "./log-feed.js";
import { NodeController } from "./node-controller.js";
import { findFreePort } from "./port.js";
import type { ServerModule } from "./server-module.js";
import { memorySettingsStore } from "./settings.js";
import { WIPE_PHASE_FILE } from "./wipe-phase.js";

const distMain = join(import.meta.dirname, "../../dist/main");
const bundlePath = join(distMain, "loam-server.js");
const clientDist = join(import.meta.dirname, "../../dist/client");
const ready = existsSync(bundlePath) && existsSync(join(clientDist, "index.html")) && encryptedDriverLoads(bundlePath);

type Hooked = { __loamRequestWipeRestart?: () => void };

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "loam-real-"));
});

afterEach(() => {
  delete (globalThis as Hooked).__loamRequestWipeRestart;
  rmSync(root, { recursive: true, force: true });
});

/** A controller over the real server, with an in-memory keychain and settings. */
async function realController(encryption: DbEncryptionMode, secrets = memoryDeviceSecretStore()) {
  const server = (await import(pathToFileURL(bundlePath).href)) as ServerModule;
  const dataDir = join(root, "node");
  const controller = new NodeController({
    capabilities: { platform: "darwin", keychain: true },
    version: "0.6.4",
    dataDir,
    clientDist,
    settings: memorySettingsStore({ logLevel: "info", network: { preset: "custom", nodeName: "Real", encryption, createdAt: 1 } }),
    secrets,
    loadServer: async () => server.startEmbeddedServer,
    driverLoads: () => true,
    log: createLogFeed(createLogBook(), clean),
    clean,
    findFreePort: (preferred, host) => findFreePort(preferred + Math.floor(Math.random() * 2000), host),
    lanAddresses: () => [],
    env: process.env,
    installHostResetHook: () => undefined,
    installWipeRestartHook: (hook) => {
      (globalThis as Hooked).__loamRequestWipeRestart = hook;
    },
    onState: () => undefined,
    onNodeChanged: () => undefined,
    onNetworkDiscarded: async () => undefined,
    clearClientData: async () => undefined,
  });
  return { controller, secrets, dataDir };
}

/** Become a person on the node (GET /api/config mints an identity). */
async function join_(origin: string): Promise<void> {
  const response = await fetch(`${origin}/api/config`);
  expect(response.status).toBe(200);
}

describe.skipIf(!ready)("with the real server", () => {
  it("a fixed-key reset destroys the device secret and the node comes back empty under a new key", async () => {
    const { controller, secrets, dataDir } = await realController("persistent");
    await controller.initialize();
    expect(controller.phaseName()).toBe("running");
    await join_(controller.localOrigin()!);
    expect(controller.hostUsers()).toMatchObject({ ok: true, value: [expect.anything()] });
    const oldSecret = secrets.current();
    const oldDb = readFileSync(join(dataDir, "loam.db"));

    expect(await controller.emergencyReset()).toEqual({ ok: true, value: { complete: true, journaled: true } });
    expect(controller.phaseName()).toBe("running");
    expect(secrets.current()).toBeDefined();
    expect(secrets.current()).not.toBe(oldSecret);
    expect(existsSync(join(dataDir, WIPE_PHASE_FILE))).toBe(false);
    expect(controller.hostUsers()).toEqual({ ok: true, value: [] });
    expect(readFileSync(join(dataDir, "loam.db")).equals(oldDb)).toBe(false);
    await controller.shutdown();
  });

  it("a plaintext reset finishes in-process", async () => {
    const { controller } = await realController("off");
    await controller.initialize();
    await join_(controller.localOrigin()!);
    expect(await controller.emergencyReset()).toMatchObject({ ok: true, value: { complete: true } });
    expect(controller.hostUsers()).toEqual({ ok: true, value: [] });
    await controller.shutdown();
  });

  it("finishes a fixed-key reset a crash interrupted before the data was proven gone", async () => {
    const first = await realController("persistent");
    await first.controller.initialize();
    await join_(first.controller.localOrigin()!);
    await first.controller.shutdown();
    // The journal the kill switch writes before it deletes anything; the crash came right after.
    writeFileSync(join(first.dataDir, WIPE_PHASE_FILE), JSON.stringify({ phase: "delete-pending" }));
    const oldSecret = first.secrets.current();

    // Same data folder and secret, as the next launch would have them.
    const { controller: second } = await realController("persistent", first.secrets);
    await second.initialize();
    expect(second.phaseName()).toBe("running");
    expect(first.secrets.current()).not.toBe(oldSecret);
    expect(existsSync(join(first.dataDir, WIPE_PHASE_FILE))).toBe(false);
    expect(second.hostUsers()).toEqual({ ok: true, value: [] });
    await second.shutdown();
  });
});

/**
 * `--smoke` (`pnpm --filter @loam/desktop smoke`, and CI against the packaged app): set up and boot a node in a
 * fresh temporary folder, exactly as a first run would but with no window and nothing kept, wait for
 * `GET /api/health` and the web client on loopback, then print one JSON line and exit: 0 when it all worked,
 * 1 on any failure or after 60 s. Encryption is `ephemeral` when the SQLCipher driver loads (the line says which
 * driver ran); set LOAM_SMOKE_REQUIRE_ENCRYPTION=1 to fail when it doesn't, so a build that lost the driver
 * can't pass quietly. The keychain is never touched.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clean, createLogBook } from "@loam/tui";
import { app } from "electron";

import { encryptedDriverLoads } from "./driver.js";
import { lanAddresses } from "./join-url.js";
import { memoryDeviceSecretStore } from "./keys.js";
import { createLogFeed } from "./log-feed.js";
import { NodeController } from "./node-controller.js";
import { appPaths } from "./paths.js";
import { findFreePort } from "./port.js";
import { loadServerModule } from "./server-module.js";
import { memorySettingsStore } from "./settings.js";

/** The whole run must finish within this. */
const SMOKE_TIMEOUT_MS = 60_000;

type SmokeReport = { ok: boolean; port?: number; driver?: string; version: string; error?: string };

/** Print the one line CI reads and exit with its verdict. */
function finish(report: SmokeReport): never {
  process.stdout.write(`${JSON.stringify(report)}\n`);
  app.exit(report.ok ? 0 : 1);
  process.exit(report.ok ? 0 : 1);
}

/** GET `url` and resolve its status and body. */
async function get(url: string): Promise<{ status: number; body: string }> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  return { status: response.status, body: await response.text() };
}

/** Run the smoke test. Must be called before `app` is ready (it moves userData to the temporary folder). */
export async function runSmoke(): Promise<void> {
  const version = app.getVersion();
  const root = mkdtempSync(join(tmpdir(), "loam-smoke-"));
  // Electron's own profile (cookies, caches) goes in the temporary folder too, never the real one.
  app.setPath("userData", join(root, "electron"));
  app.disableHardwareAcceleration();
  const timer = setTimeout(() => finish({ ok: false, version, error: "timeout" }), SMOKE_TIMEOUT_MS);

  let controller: NodeController | undefined;
  try {
    await app.whenReady();
    app.dock?.hide();
    const driverLoads = encryptedDriverLoads(appPaths.serverBundle);
    const driver = driverLoads ? "better-sqlite3-multiple-ciphers" : "node:sqlite";
    if (!driverLoads && process.env.LOAM_SMOKE_REQUIRE_ENCRYPTION === "1") {
      throw new Error("The SQLCipher driver didn't load.");
    }
    const log = createLogFeed(createLogBook(), clean);
    log.setListener((entry) => {
      if (entry.kind === "message" && (entry.level === "error" || entry.level === "warn")) {
        process.stderr.write(`[${entry.level}] ${entry.text}\n`);
      }
    });
    controller = new NodeController({
      capabilities: { platform: process.platform as "darwin" | "win32" | "linux", keychain: false },
      version,
      dataDir: join(root, "node"),
      clientDist: appPaths.clientDist,
      settings: memorySettingsStore(),
      secrets: memoryDeviceSecretStore(),
      loadServer: async () => (await loadServerModule()).startEmbeddedServer,
      driverLoads: () => driverLoads,
      log,
      clean,
      findFreePort,
      lanAddresses,
      env: process.env,
      installHostResetHook: () => undefined,
      installWipeRestartHook: () => undefined,
      onState: () => undefined,
      onNodeChanged: () => undefined,
      onNetworkDiscarded: async () => undefined,
      clearClientData: async () => undefined,
    });
    await controller.initialize();
    await controller.setup({ nodeName: "LOAM smoke", preset: "private", encryption: driverLoads ? "ephemeral" : "off" });
    const state = controller.getState();
    const origin = controller.localOrigin();
    if (state.phase !== "running" || !origin) {
      throw new Error(state.phase === "failed" ? `${state.error.code}: ${state.error.detail ?? ""}` : `phase ${state.phase}`);
    }
    const health = await get(`${origin}/api/health`);
    if (health.status !== 200) {
      throw new Error(`/api/health answered ${health.status}`);
    }
    const page = await get(`${origin}/`);
    if (page.status !== 200 || !page.body.includes("<html")) {
      throw new Error(`the web client answered ${page.status}`);
    }
    if (state.node.dbEncryption !== (driverLoads ? "ephemeral" : "off")) {
      throw new Error(`the node reports encryption ${state.node.dbEncryption}`);
    }
    await controller.shutdown();
    clearTimeout(timer);
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    finish({ ok: true, port: state.node.port, driver, version });
  } catch (error) {
    await controller?.shutdown();
    clearTimeout(timer);
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    finish({ ok: false, version, error: error instanceof Error ? error.message : String(error) });
  }
}

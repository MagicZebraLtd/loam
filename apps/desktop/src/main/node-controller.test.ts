// @vitest-environment node
// The node's state machine (node-controller.ts), driven with a fake server: no Electron, no real node.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HostApi, HostStatus } from "@loam/schema";
import { clean, createLogBook } from "@loam/tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DesktopState } from "../shared/ipc.js";
import { passphraseKey, memoryDeviceSecretStore } from "./keys.js";
import { createLogFeed } from "./log-feed.js";
import { NodeController, type ControllerDeps } from "./node-controller.js";
import type { EmbeddedNode, EmbeddedServerOptions } from "./server-module.js";
import { memorySettingsStore, type DesktopSettings } from "./settings.js";
import { WIPE_PHASE_FILE } from "./wipe-phase.js";

/** An Error with a `.code`, as the server's typed boot errors carry. */
function coded(code: string): Error {
  return Object.assign(new Error(`boot failed: ${code}`), { code });
}

type ResetBehaviour = "in-process" | "fixed-key" | "incomplete-journaled" | "incomplete-unjournaled";

/** One booted fake node: what it was started with, and a host API whose answers a test can change. */
type FakeNode = EmbeddedNode & {
  env: NodeJS.ProcessEnv;
  options: EmbeddedServerOptions;
  closed: boolean;
  status: HostStatus;
  calls: string[];
};

/** A fake server factory. `failures` makes the next starts throw, in order; `reset` picks what a reset does. */
function fakeServer(context: { env: NodeJS.ProcessEnv; dataDir: string; hook: () => (() => void) | undefined }) {
  const nodes: FakeNode[] = [];
  const failures: (Error | (() => Error))[] = [];
  let reset: ResetBehaviour = "in-process";

  async function start(options: EmbeddedServerOptions): Promise<EmbeddedNode> {
    const failure = failures.shift();
    if (failure) {
      throw typeof failure === "function" ? failure() : failure;
    }
    const env = { ...context.env };
    const calls: string[] = [];
    const node: FakeNode = {
      env,
      options,
      closed: false,
      calls,
      status: {
        nodeName: "Kitchen\u001b[2J",
        version: env.LOAM_VERSION ?? "dev",
        joinHost: "192.168.1.20",
        port: Number(env.PORT),
        transportEncryption: "optional",
        dbEncryption: (env.LOAM_DB_ENCRYPTION_MODE as HostStatus["dbEncryption"]) ?? "off",
        securityProfile: "standard",
        joinPolicy: "open",
        devMode: false,
        clients: [],
        people: { total: 0, online: 0, pending: 0, admins: 0 },
        quarantined: 0,
        logLevel: "info",
        resets: 0,
        resetting: false,
      },
      host: {} as HostApi,
      async close() {
        node.closed = true;
      },
    };
    node.host = {
      status: () => structuredClone(node.status),
      config: () => ({}) as ReturnType<HostApi["config"]>,
      updateConfig: () => ({ ok: true, value: {} as ReturnType<HostApi["config"]> }),
      users: () => [{ id: "user.1", displayName: "Bob‮", isAdmin: false, online: true, pending: false, banned: false, createdAt: 1 }],
      makeAdmin: (userId) => {
        calls.push(`makeAdmin:${userId}`);
        return { ok: true, value: { id: userId, displayName: "Bob", isAdmin: true, online: true, pending: false, banned: false, createdAt: 1 } };
      },
      adminClaimCode: () => ({ code: "CLAIM", expiresAt: 10 }),
      revokeAdminClaimCode: (code) => void calls.push(`revoke:${code}`),
      linkCode: () => ({ code: "LINK", expiresAt: 10 }),
      invite: () => null,
      setJoinHost: (host) => void calls.push(`joinHost:${host ?? "auto"}`),
      setLogLevel: (level) => void calls.push(`logLevel:${level}`),
      transportPublicKey: () => `key-of-boot-${nodes.length}`,
      emergencyReset: async () => {
        calls.push("reset");
        node.status = { ...node.status, resets: node.status.resets + 1 };
        if (reset === "fixed-key") {
          // As kill-switch.ts's hooked branch: journal key-clear-ready, then ask the launcher for the key clear.
          writeFileSync(join(context.dataDir, WIPE_PHASE_FILE), JSON.stringify({ phase: "key-clear-ready" }));
          context.hook()?.();
          return { complete: true, journaled: true };
        }
        if (reset === "incomplete-journaled") {
          return { complete: false, journaled: true };
        }
        if (reset === "incomplete-unjournaled") {
          return { complete: false, journaled: false };
        }
        return { complete: true, journaled: false };
      },
    };
    nodes.push(node);
    return node;
  }

  return {
    start,
    nodes,
    fail(...errors: (Error | (() => Error))[]) {
      failures.push(...errors);
    },
    onReset(behaviour: ResetBehaviour) {
      reset = behaviour;
    },
  };
}

let root: string;
let dataDir: string;
let clientDist: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "loam-controller-"));
  dataDir = join(root, "node");
  clientDist = join(root, "client");
  mkdirSync(clientDist, { recursive: true });
  writeFileSync(join(clientDist, "index.html"), "<!doctype html>");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A controller over fakes. Returns it with every fake, for the assertions. */
function makeController(options: { settings?: DesktopSettings; keychain?: boolean; driver?: boolean; freePort?: number | null } = {}) {
  const env: NodeJS.ProcessEnv = { LOAM_DEV_MODE: "1", LOAM_CONFIG_FILE: "/elsewhere.json" };
  let hook: (() => void) | undefined;
  const server = fakeServer({ env, dataDir, hook: () => hook });
  const settings = memorySettingsStore(options.settings);
  const secrets = memoryDeviceSecretStore();
  const states: DesktopState[] = [];
  const nodeChanges: (string | undefined)[] = [];
  let discarded = 0;
  const log = createLogFeed(createLogBook(), clean);
  const findFreePort = vi.fn(async (preferred: number) => (options.freePort === null ? undefined : (options.freePort ?? preferred)));
  const deps: ControllerDeps = {
    capabilities: { platform: "darwin", keychain: options.keychain ?? true },
    version: "0.6.4",
    dataDir,
    clientDist,
    settings,
    secrets,
    loadServer: async () => server.start,
    driverLoads: () => options.driver ?? true,
    log,
    clean,
    findFreePort,
    lanAddresses: () => ["192.168.1.20", "10.0.0.5"],
    env,
    installWipeRestartHook: (installed) => {
      hook = installed;
    },
    onState: (state) => states.push(state),
    onNodeChanged: (origin) => nodeChanges.push(origin),
    onNetworkDiscarded: async () => {
      discarded += 1;
    },
    now: () => 1_000,
    closeTimeoutMs: 50,
  };
  const controller = new NodeController(deps);
  return { controller, server, settings, secrets, states, nodeChanges, env, log, findFreePort, discarded: () => discarded };
}

const community = { preset: "community", nodeName: "Kitchen", encryption: "persistent", createdAt: 5 } as const;
const passphraseNetwork = { preset: "custom", nodeName: "Kitchen", encryption: "passphrase", createdAt: 5 } as const;

describe("first run", () => {
  it("asks for setup when no network exists", async () => {
    const { controller, states } = makeController();
    await controller.initialize();
    expect(states.at(-1)).toMatchObject({ phase: "setup", capabilities: { keychain: true }, settings: { dataDir, version: "0.6.4" } });
  });

  it("sets up a network and starts it with exactly the launcher's env", async () => {
    const { controller, server, settings, states, env, nodeChanges } = makeController();
    await controller.initialize();
    expect(await controller.setup({ nodeName: "  Field kitchen  ", preset: "private", encryption: "ephemeral" })).toEqual({
      ok: true,
      value: undefined,
    });

    const node = server.nodes[0]!;
    expect(node.env).toMatchObject({
      NODE_ENV: "production",
      LOAM_DATA_DIR: dataDir,
      LOAM_CLIENT_DIST: clientDist,
      PORT: "3000",
      HOST: "0.0.0.0",
      LOAM_VERSION: "0.6.4",
      LOAM_DB_KEY: "ephemeral",
      LOAM_DB_ENCRYPTION_MODE: "ephemeral",
    });
    // Nothing from the host's shell reaches the server, and the key doesn't outlive the boot.
    expect(node.env.LOAM_DEV_MODE).toBeUndefined();
    expect(node.env.LOAM_CONFIG_FILE).toBeUndefined();
    expect(env.LOAM_DB_KEY).toBeUndefined();
    expect(node.options.handleSignals).toBe(false);
    expect(node.options.hostToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    expect(JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8"))).toMatchObject({
      node: { name: "Field kitchen", locale: "en" },
      security: { profile: "hardened" },
    });
    expect(settings.read().network).toEqual({ preset: "private", nodeName: "Field kitchen", encryption: "ephemeral", createdAt: 1_000 });

    const running = states.at(-1)!;
    expect(running.phase).toBe("running");
    if (running.phase === "running") {
      expect(running.node.joinUrl).toBe("http://192.168.1.20:3000/#k=key-of-boot-1");
      expect(running.node.transportPublicKey).toBe("key-of-boot-1");
      expect(running.node.nodeName).toBe("Kitchen[2J");
      expect(running.node.addresses).toEqual(["192.168.1.20", "10.0.0.5"]);
      expect(running.node.startedAt).toBe(1_000);
    }
    expect(nodeChanges).toEqual(["http://127.0.0.1:3000"]);
  });

  it("empties a data folder an earlier network left", async () => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "loam.db"), "old messages");
    const { controller } = makeController();
    await controller.initialize();
    await controller.setup({ nodeName: "", preset: "custom", encryption: "off" });
    expect(existsSync(join(dataDir, "loam.db"))).toBe(false);
  });

  it("keeps the host's client storage in memory for a network kept only while LOAM runs", async () => {
    const { controller } = makeController();
    await controller.initialize();
    await controller.setup({ nodeName: "A", preset: "private", encryption: "ephemeral" });
    expect(controller.clientStorageInMemory()).toBe(true);
    const kept = makeController({ settings: { logLevel: "info", network: community } });
    expect(kept.controller.clientStorageInMemory()).toBe(false);
  });

  it("refuses a kept key without a keychain, and encryption without the driver", async () => {
    const noKeychain = makeController({ keychain: false });
    await noKeychain.controller.initialize();
    expect(await noKeychain.controller.setup({ nodeName: "A", preset: "community", encryption: "persistent" })).toMatchObject({ ok: false });
    expect(noKeychain.server.nodes).toHaveLength(0);
    expect(noKeychain.settings.read().network).toBeUndefined();

    const noDriver = makeController({ driver: false });
    await noDriver.controller.initialize();
    expect(await noDriver.controller.setup({ nodeName: "A", preset: "private", encryption: "ephemeral" })).toMatchObject({ ok: false });
    expect(noDriver.server.nodes).toHaveLength(0);
  });

  it("won't set up over an existing network", async () => {
    const { controller } = makeController({ settings: { logLevel: "info", network: community } });
    await controller.initialize();
    expect(await controller.setup({ nodeName: "B", preset: "custom", encryption: "off" })).toMatchObject({ ok: false });
  });
});

describe("keys", () => {
  it("starts a kept-key network with the device secret", async () => {
    const { controller, server, secrets } = makeController({ settings: { logLevel: "info", network: community } });
    await controller.initialize();
    expect(server.nodes[0]!.env.LOAM_DB_KEY).toBe(secrets.current());
    expect(server.nodes[0]!.env.LOAM_DB_ENCRYPTION_MODE).toBe("persistent");
  });

  it("asks for the passphrase, says when it was wrong, and opens with the right one", async () => {
    const { controller, server, secrets, states } = makeController({ settings: { logLevel: "info", network: passphraseNetwork } });
    await controller.initialize();
    expect(states.at(-1)).toMatchObject({ phase: "locked", wrongPassphrase: false });

    server.fail(coded("db_encryption_unreadable"));
    expect(await controller.unlock({ passphrase: "wrong" })).toMatchObject({ ok: false });
    expect(states.at(-1)).toMatchObject({ phase: "locked", wrongPassphrase: true });

    expect(await controller.unlock({ passphrase: "right" })).toEqual({ ok: true, value: undefined });
    expect(server.nodes[0]!.env.LOAM_DB_KEY).toBe(passphraseKey("right", secrets.current()!));
    expect(controller.phaseName()).toBe("running");
  });

  it("asks for the passphrase again after a stop", async () => {
    const { controller, states } = makeController({ settings: { logLevel: "info", network: passphraseNetwork } });
    await controller.initialize();
    await controller.unlock({ passphrase: "pw" });
    await controller.stop();
    expect(states.at(-1)).toMatchObject({ phase: "stopped" });
    await controller.start();
    expect(states.at(-1)).toMatchObject({ phase: "locked", wrongPassphrase: false });
  });

  it("refuses a kept-key network when the keychain went away", async () => {
    const { controller, states, server } = makeController({ keychain: false, settings: { logLevel: "info", network: community } });
    await controller.initialize();
    expect(states.at(-1)).toMatchObject({ phase: "failed", error: { code: "keychain_unavailable" } });
    expect(server.nodes).toHaveLength(0);
  });
});

describe("boot failures", () => {
  it.each([
    ["EADDRINUSE", "port_in_use"],
    ["db_encryption_driver_missing", "db_encryption_driver_missing"],
    ["db_encryption_unreadable", "db_encryption_locked"],
    ["db_encryption_plaintext_unconverted", "db_encryption_locked"],
  ])("shows %s as %s, and Retry starts again", async (code, expected) => {
    const { controller, server, states } = makeController({ settings: { logLevel: "info", network: community } });
    server.fail(coded(code));
    await controller.initialize();
    expect(states.at(-1)).toMatchObject({ phase: "failed", error: { code: expected } });
    await controller.start();
    expect(controller.phaseName()).toBe("running");
  });

  it("refuses a node with no transport key rather than hand out a keyless join code", async () => {
    const { controller, server, states } = makeController({ settings: { logLevel: "info", network: community } });
    const realStart = server.start;
    // `loadServer` reads `server.start` when it runs, so this keyless node is what the boot gets.
    server.start = async (options: EmbeddedServerOptions) => {
      const node = (await realStart(options)) as FakeNode;
      node.host.transportPublicKey = () => undefined;
      return node;
    };
    await controller.initialize();
    expect(states.at(-1)).toMatchObject({ phase: "failed", error: { code: "unknown" } });
    expect(server.nodes[0]!.closed).toBe(true);
    expect(controller.hostInjection()).toBeUndefined();
  });

  it("stops before booting when the encrypted driver doesn't load", async () => {
    const { controller, server, states } = makeController({ driver: false, settings: { logLevel: "info", network: community } });
    await controller.initialize();
    expect(states.at(-1)).toMatchObject({ phase: "failed", error: { code: "db_encryption_driver_missing" } });
    expect(server.nodes).toHaveLength(0);
  });

  it("reports a broken install with no web client", async () => {
    rmSync(join(clientDist, "index.html"));
    const { controller, states } = makeController({ settings: { logLevel: "info", network: community } });
    await controller.initialize();
    expect(states.at(-1)).toMatchObject({ phase: "failed", error: { code: "client_missing" } });
  });

  it("steps past a taken port, and reports when none is free", async () => {
    const stepped = makeController({ freePort: 3004, settings: { logLevel: "info", network: community, port: 3000 } });
    await stepped.controller.initialize();
    expect(stepped.server.nodes[0]!.env.PORT).toBe("3004");

    const full = makeController({ freePort: null, settings: { logLevel: "info", network: community } });
    await full.controller.initialize();
    expect(full.states.at(-1)).toMatchObject({ phase: "failed", error: { code: "port_unavailable" } });
  });

  it("falls back to 3000 when the saved port can't be used at all", async () => {
    const { controller, server, findFreePort } = makeController({ settings: { logLevel: "info", network: community, port: 80 } });
    findFreePort.mockImplementationOnce(async () => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });
    await controller.initialize();
    expect(server.nodes[0]!.env.PORT).toBe("3000");
  });

  it("pins a saved join address only while this computer has it", async () => {
    const pinned = makeController({ settings: { logLevel: "info", network: community, joinHost: "10.0.0.5" } });
    await pinned.controller.initialize();
    expect(pinned.server.nodes[0]!.env.LOAM_JOIN_HOST).toBe("10.0.0.5");

    const gone = makeController({ settings: { logLevel: "info", network: community, joinHost: "172.16.0.9" } });
    await gone.controller.initialize();
    expect(gone.server.nodes[0]!.env.LOAM_JOIN_HOST).toBeUndefined();
  });
});

describe("running", () => {
  it("pushes the status only when it moved", async () => {
    const { controller, server, states } = makeController({ settings: { logLevel: "info", network: community } });
    await controller.initialize();
    const pushes = states.length;
    controller.refresh();
    expect(states).toHaveLength(pushes);
    server.nodes[0]!.status = { ...server.nodes[0]!.status, clients: ["192.168.1.30"] };
    controller.refresh();
    expect(states).toHaveLength(pushes + 1);
    expect(states.at(-1)).toMatchObject({ phase: "running", node: { clients: ["192.168.1.30"] } });
  });

  it("hands the client window the host token and transport key, only while running", async () => {
    const { controller, server } = makeController({ settings: { logLevel: "info", network: community } });
    expect(controller.hostInjection()).toBeUndefined();
    await controller.initialize();
    expect(controller.hostInjection()).toEqual({ hostToken: server.nodes[0]!.options.hostToken, transportKey: "key-of-boot-1" });
    await controller.stop();
    expect(controller.hostInjection()).toBeUndefined();
    expect(server.nodes[0]!.closed).toBe(true);
  });

  it("applies the join address and log level at once, the port at the next start", async () => {
    const { controller, server, settings } = makeController({ settings: { logLevel: "info", network: community } });
    await controller.initialize();
    expect(controller.updateSettings({ joinHost: "10.0.0.5", logLevel: "debug", port: 4000 })).toMatchObject({
      ok: true,
      value: { joinHost: "10.0.0.5", logLevel: "debug", port: 4000 },
    });
    expect(server.nodes[0]!.calls).toEqual(expect.arrayContaining(["joinHost:10.0.0.5", "logLevel:debug"]));
    controller.updateSettings({ joinHost: null, port: null });
    expect(server.nodes[0]!.calls).toContain("joinHost:auto");
    expect(settings.read()).toMatchObject({ logLevel: "debug" });
    expect(settings.read().port).toBeUndefined();
  });

  it("cleans what others typed before it reaches the window", async () => {
    const { controller } = makeController({ settings: { logLevel: "info", network: community } });
    await controller.initialize();
    expect(controller.hostUsers()).toMatchObject({ ok: true, value: [{ displayName: "Bob" }] });
    expect(controller.hostMakeAdmin("user.1")).toMatchObject({ ok: true, value: { isAdmin: true } });
  });

  it("answers host calls with an error when nothing runs", () => {
    const { controller } = makeController();
    expect(controller.hostUsers()).toMatchObject({ ok: false });
    expect(controller.hostLinkCode()).toMatchObject({ ok: false });
  });

  it("records the host note acknowledgement", async () => {
    const { controller, settings } = makeController();
    controller.acknowledgeHost();
    expect(settings.read().hostAck).toBe(1);
  });
});

describe("Emergency Reset", () => {
  it("keeps running when the server wiped in-process", async () => {
    const { controller, server, nodeChanges } = makeController({ settings: { logLevel: "info", network: community } });
    await controller.initialize();
    expect(await controller.emergencyReset()).toEqual({ ok: true, value: { complete: true, journaled: false } });
    expect(server.nodes).toHaveLength(1);
    expect(controller.phaseName()).toBe("running");
    expect(nodeChanges.at(-1)).toBe("http://127.0.0.1:3000");
  });

  it("on a fixed key: stops, destroys the device secret, clears the journal and boots under a new key", async () => {
    const { controller, server, secrets, states } = makeController({ settings: { logLevel: "info", network: community } });
    await controller.initialize();
    const oldKey = server.nodes[0]!.env.LOAM_DB_KEY;
    server.onReset("fixed-key");

    expect(await controller.emergencyReset()).toEqual({ ok: true, value: { complete: true, journaled: true } });
    expect(states.some((state) => state.phase === "resetting")).toBe(true);
    expect(server.nodes[0]!.closed).toBe(true);
    expect(server.nodes).toHaveLength(2);
    expect(server.nodes[1]!.env.LOAM_DB_KEY).toBe(secrets.current());
    expect(server.nodes[1]!.env.LOAM_DB_KEY).not.toBe(oldKey);
    expect(existsSync(join(dataDir, WIPE_PHASE_FILE))).toBe(false);
    expect(controller.phaseName()).toBe("running");
    // A new boot, a new host token: an open client window reloads and presents it.
    expect(server.nodes[1]!.options.hostToken).not.toBe(server.nodes[0]!.options.hostToken);
  });

  it("on a passphrase network, boots again with the same passphrase and a new secret", async () => {
    const { controller, server, secrets } = makeController({ settings: { logLevel: "info", network: passphraseNetwork } });
    await controller.initialize();
    await controller.unlock({ passphrase: "pw" });
    server.onReset("fixed-key");
    await controller.emergencyReset();
    expect(server.nodes[1]!.env.LOAM_DB_KEY).toBe(passphraseKey("pw", secrets.current()!));
    expect(server.nodes[1]!.env.LOAM_DB_KEY).not.toBe(server.nodes[0]!.env.LOAM_DB_KEY);
  });

  it("restarts to finish a journaled reset", async () => {
    const { controller, server } = makeController({ settings: { logLevel: "info", network: community } });
    await controller.initialize();
    server.onReset("incomplete-journaled");
    expect(await controller.emergencyReset()).toEqual({ ok: true, value: { complete: true, journaled: true } });
    expect(server.nodes).toHaveLength(2);
    expect(server.nodes[0]!.closed).toBe(true);
  });

  it("stays locked when the reset couldn't be journaled, and Retry runs it again", async () => {
    const { controller, server, states } = makeController({ settings: { logLevel: "info", network: community } });
    await controller.initialize();
    server.onReset("incomplete-unjournaled");
    await controller.emergencyReset();
    expect(states.at(-1)).toMatchObject({ phase: "failed", error: { code: "reset_incomplete" } });
    expect(server.nodes[0]!.closed).toBe(false);

    server.onReset("in-process");
    await controller.start();
    expect(server.nodes[0]!.calls.filter((call) => call === "reset")).toHaveLength(2);
    expect(controller.phaseName()).toBe("running");
  });

  it("finishes an interrupted fixed-key reset before resolving any key", async () => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, WIPE_PHASE_FILE), JSON.stringify({ phase: "key-clear-ready" }));
    const { controller, server, secrets } = makeController({ settings: { logLevel: "info", network: community } });
    const before = secrets.get();
    await controller.initialize();
    expect(server.nodes[0]!.env.LOAM_DB_KEY).not.toBe(before);
    expect(existsSync(join(dataDir, WIPE_PHASE_FILE))).toBe(false);
  });

  it("treats a resume that stopped without asking for the key clear as a reset that can't finish", async () => {
    const { controller, server, secrets } = makeController({ settings: { logLevel: "info", network: community } });
    const oldSecret = secrets.get();
    server.fail(coded("db_encryption_wipe_resume"));
    await controller.initialize();
    expect(controller.getState()).toMatchObject({ phase: "failed", error: { code: "reset_incomplete" } });
    // No hook call, so the deletion isn't proven: the key must survive for the server's next retry.
    expect(secrets.current()).toBe(oldSecret);
  });

  it("destroys the key and boots fresh when the resume's hook fired", async () => {
    let hook: (() => void) | undefined;
    const env: NodeJS.ProcessEnv = {};
    const server = fakeServer({ env, dataDir, hook: () => hook });
    server.fail(() => {
      writeFileSync(join(dataDir, WIPE_PHASE_FILE), JSON.stringify({ phase: "key-clear-ready" }));
      hook?.();
      return coded("db_encryption_wipe_resume");
    });
    const secrets = memoryDeviceSecretStore();
    const oldSecret = secrets.get();
    const controller = new NodeController({
      capabilities: { platform: "linux", keychain: true },
      version: "0.6.4",
      dataDir,
      clientDist,
      settings: memorySettingsStore({ logLevel: "info", network: community }),
      secrets,
      loadServer: async () => server.start,
      driverLoads: () => true,
      log: createLogFeed(createLogBook(), clean),
      clean,
      findFreePort: async (preferred) => preferred,
      lanAddresses: () => [],
      env,
      installWipeRestartHook: (installed) => {
        hook = installed;
      },
      onState: () => undefined,
      onNodeChanged: () => undefined,
      onNetworkDiscarded: async () => undefined,
    });
    await controller.initialize();
    expect(controller.phaseName()).toBe("running");
    expect(secrets.current()).not.toBe(oldSecret);
    expect(server.nodes[0]!.env.LOAM_DB_KEY).toBe(secrets.current());
    expect(existsSync(join(dataDir, WIPE_PHASE_FILE))).toBe(false);
  });
});

describe("a new network", () => {
  it("resets the running node, empties the folder, forgets the network and goes back to setup", async () => {
    const { controller, server, settings, secrets, states, discarded } = makeController({
      settings: { logLevel: "info", network: community, port: 3001 },
    });
    await controller.initialize();
    const oldSecret = secrets.current();
    writeFileSync(join(dataDir, "loam.db"), "messages");
    expect(await controller.newNetwork()).toEqual({ ok: true, value: undefined });
    expect(server.nodes[0]!.calls).toContain("reset");
    expect(server.nodes[0]!.closed).toBe(true);
    expect(existsSync(join(dataDir, "loam.db"))).toBe(false);
    expect(secrets.current()).toBeUndefined();
    expect(secrets.get()).not.toBe(oldSecret);
    expect(settings.read()).toEqual({ logLevel: "info", port: 3001 });
    expect(states.at(-1)).toMatchObject({ phase: "setup" });
    // The host's own client window kept a copy of the network: erased too.
    expect(discarded()).toBe(1);
  });

  it("discards a stopped network's data too", async () => {
    const { controller, settings } = makeController({ settings: { logLevel: "info", network: community } });
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "loam.db"), "messages");
    expect(await controller.newNetwork()).toEqual({ ok: true, value: undefined });
    expect(existsSync(join(dataDir, "loam.db"))).toBe(false);
    expect(settings.read().network).toBeUndefined();
  });
});

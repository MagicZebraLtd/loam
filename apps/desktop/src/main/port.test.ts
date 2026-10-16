// @vitest-environment node
// The port picker (port.ts), ported with cli/test/port.test.mjs. Each test holds real sockets, so it only uses
// ports the OS hands out as free.
import { createServer, type Server } from "node:net";

import { afterAll, describe, expect, it } from "vitest";

import { findFreePort, isPortFree, probeHosts } from "./port.js";

const held: Server[] = [];

/** Listen on `host:port` (port 0 = any) and keep it open until the suite ends; resolves the port. */
function hold(host: string, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ host, port }, () => {
      held.push(server);
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}

afterAll(async () => {
  await Promise.all(held.map((server) => new Promise((resolve) => server.close(resolve))));
});

describe("probeHosts", () => {
  it("adds loopback for a wildcard host", () => {
    expect(probeHosts("0.0.0.0")).toEqual(["0.0.0.0", "127.0.0.1", "::1"]);
    expect(probeHosts("::")).toEqual(["::", "127.0.0.1", "::1"]);
  });

  it("probes only a specific host", () => {
    expect(probeHosts("192.168.1.5")).toEqual(["192.168.1.5"]);
  });
});

describe("isPortFree", () => {
  it("reports a port another server holds on the wildcard address", async () => {
    const port = await hold("0.0.0.0");
    expect(await isPortFree(port, "0.0.0.0")).toBe(false);
  });

  it("reports a port another server holds only on loopback", async () => {
    const port = await hold("127.0.0.1");
    expect(await isPortFree(port, "0.0.0.0")).toBe(false);
  });

  it("reports a released port as free", async () => {
    const port = await hold("0.0.0.0");
    await new Promise((resolve) => held.pop()?.close(resolve));
    expect(await isPortFree(port, "0.0.0.0")).toBe(true);
  });
});

describe("findFreePort", () => {
  it("steps past a taken port", async () => {
    const taken = await hold("0.0.0.0");
    const port = await findFreePort(taken, "0.0.0.0", 20);
    expect(port).toBeDefined();
    expect(port! > taken && port! < taken + 20).toBe(true);
    expect(await isPortFree(port!, "0.0.0.0")).toBe(true);
  });

  it("returns undefined when every port in the range is taken", async () => {
    const taken = await hold("0.0.0.0");
    expect(await findFreePort(taken, "0.0.0.0", 1)).toBeUndefined();
  });

  it("never looks past 65535", async () => {
    const port = await findFreePort(65535, "0.0.0.0", 20);
    expect(port === undefined || port === 65535).toBe(true);
  });
});

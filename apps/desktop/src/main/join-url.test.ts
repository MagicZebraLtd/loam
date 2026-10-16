// @vitest-environment node
import { describe, expect, it } from "vitest";

import { buildJoinUrl, formatHost, lanAddressesFrom, localOrigin } from "./join-url.js";

describe("buildJoinUrl", () => {
  it("carries the transport key in the fragment", () => {
    expect(buildJoinUrl({ joinHost: "192.168.1.20", port: 3000, transportKey: "KEY" })).toBe(
      "http://192.168.1.20:3000/#k=KEY",
    );
  });

  it("adds the invite code on an approval-only node", () => {
    expect(buildJoinUrl({ joinHost: "10.0.0.5", port: 3001, transportKey: "KEY", inviteCode: "INV" })).toBe(
      "http://10.0.0.5:3001/#k=KEY&i=INV",
    );
  });

  it("has no fragment without a key or an invite", () => {
    expect(buildJoinUrl({ joinHost: "loam.local", port: 3000 })).toBe("http://loam.local:3000/");
  });

  it("brackets an IPv6 host", () => {
    expect(formatHost("fe80::1")).toBe("[fe80::1]");
    expect(formatHost("[fe80::1]")).toBe("[fe80::1]");
    expect(buildJoinUrl({ joinHost: "fe80::1", port: 3000, transportKey: "K" })).toBe("http://[fe80::1]:3000/#k=K");
  });
});

describe("localOrigin", () => {
  it("is loopback on the node's port", () => {
    expect(localOrigin(3002)).toBe("http://127.0.0.1:3002");
  });
});

describe("lanAddressesFrom", () => {
  it("keeps reachable IPv4 addresses once each", () => {
    expect(
      lanAddressesFrom({
        lo0: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
        en0: [
          { family: "IPv4", address: "192.168.1.20", internal: false },
          { family: "IPv6", address: "fe80::1", internal: false },
        ],
        en1: [
          { family: 4, address: "10.0.0.5", internal: false },
          { family: "IPv4", address: "169.254.3.4", internal: false },
        ],
        bridge: [{ family: "IPv4", address: "192.168.1.20", internal: false }],
        none: undefined,
      }),
    ).toEqual(["192.168.1.20", "10.0.0.5"]);
  });
});

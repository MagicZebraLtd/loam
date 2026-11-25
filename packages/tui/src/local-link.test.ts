import { describe, expect, it } from "vitest";

import { localLinkHost, localOrigin } from "./local-link.js";

describe("localLinkHost", () => {
  it("uses IPv4 loopback for every interface and for 127.0.0.1", () => {
    for (const listen of ["0.0.0.0", "::", "", "127.0.0.1", "[::]"]) {
      expect(localLinkHost(listen)).toBe("127.0.0.1");
    }
  });

  it("keeps another loopback address, since 127.0.0.1 on that port isn't LOAM's", () => {
    expect(localLinkHost("127.0.0.2")).toBe("127.0.0.2");
  });

  it("uses IPv6 loopback when that is the only address LOAM listens on", () => {
    expect(localLinkHost("::1")).toBe("[::1]");
  });

  it("uses the one address LOAM listens on otherwise, bracketed when it is IPv6", () => {
    expect(localLinkHost("192.168.1.20")).toBe("192.168.1.20");
    expect(localLinkHost("fd00::5")).toBe("[fd00::5]");
    expect(localLinkHost("[fd00::5]")).toBe("[fd00::5]");
  });

  it("never answers localhost, which can resolve to an address LOAM doesn't hold", () => {
    expect(localLinkHost("localhost")).toBe("127.0.0.1");
  });
});

describe("localOrigin", () => {
  it("puts the listen port on the local host", () => {
    expect(localOrigin("0.0.0.0", 3001)).toBe("http://127.0.0.1:3001");
    expect(localOrigin("::1", 3000)).toBe("http://[::1]:3000");
  });
});

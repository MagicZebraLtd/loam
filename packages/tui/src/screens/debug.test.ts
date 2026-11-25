import { describe, expect, it } from "vitest";

import { redact } from "./debug.js";

describe("redact", () => {
  it("redacts an IPv4 address that carries a port", () => {
    expect(redact("connect ECONNREFUSED 192.168.1.20:11434")).toBe("connect ECONNREFUSED <address>");
  });

  it("redacts a bracketed IPv6 address that carries a port", () => {
    expect(redact("connect ECONNREFUSED [fd00::5]:3000")).toBe("connect ECONNREFUSED <address>");
    expect(redact("listening on [fe80::1%en0]:3000")).toBe("listening on <address>");
  });

  it("drops a URL's query and fragment along with its host", () => {
    expect(redact("GET http://192.168.1.9:3000/api/x?token=SECRET#k=KEY&a=CODE failed")).toBe("GET http://<host>/api/x failed");
    expect(redact("open http://pi.local:3000#k=KEY&a=CODE now")).toBe("open http://<host> now");
    expect(redact("ws://[fd00::5]:3000/ws?enc=SID&cn=NONCE")).toBe("ws://<host>/ws");
  });

  it("leaves times and version numbers alone", () => {
    expect(redact("at 12:34:56 on v24.15.0")).toBe("at 12:34:56 on v24.15.0");
  });
});

// @vitest-environment node
import { describe, expect, it } from "vitest";

import { isKnownExternalUrl, isSameOrigin, isWebUrl } from "./external-links.js";

const node = { port: 3000, hosts: ["192.168.1.20"] };

describe("isKnownExternalUrl", () => {
  it("opens LOAM's own pages", () => {
    expect(isKnownExternalUrl("https://github.com/MagicZebraLtd/loam/releases/latest", node)).toBe(true);
    expect(isKnownExternalUrl("https://github.com/MagicZebraLtd/loam", node)).toBe(true);
    expect(isKnownExternalUrl("https://loamnet.com/child-safety", node)).toBe(true);
  });

  it("refuses look-alikes", () => {
    expect(isKnownExternalUrl("https://github.com/MagicZebraLtd/loamevil", node)).toBe(false);
    expect(isKnownExternalUrl("https://loamnet.com.evil.example/", node)).toBe(false);
    expect(isKnownExternalUrl("http://loamnet.com/", node)).toBe(false);
    expect(isKnownExternalUrl("https://user:pw@loamnet.com/", node)).toBe(false);
    expect(isKnownExternalUrl("https://example.com/", node)).toBe(false);
  });

  it("opens the running node's pages on this computer's addresses only", () => {
    expect(isKnownExternalUrl("http://192.168.1.20:3000/#k=abc", node)).toBe(true);
    expect(isKnownExternalUrl("http://127.0.0.1:3000/", node)).toBe(true);
    expect(isKnownExternalUrl("http://192.168.1.20:3001/", node)).toBe(false);
    expect(isKnownExternalUrl("http://10.9.9.9:3000/", node)).toBe(false);
    expect(isKnownExternalUrl("http://127.0.0.1:3000/", undefined)).toBe(false);
  });

  it("never opens another scheme", () => {
    expect(isKnownExternalUrl("file:///etc/passwd", node)).toBe(false);
    expect(isKnownExternalUrl("javascript:alert(1)", node)).toBe(false);
    expect(isKnownExternalUrl("not a url", node)).toBe(false);
  });
});

describe("isWebUrl", () => {
  it("is http(s) only", () => {
    expect(isWebUrl("https://example.com/a")).toBe(true);
    expect(isWebUrl("http://example.com/a")).toBe(true);
    expect(isWebUrl("smb://server/share")).toBe(false);
    expect(isWebUrl("file:///C:/Windows")).toBe(false);
  });
});

describe("isSameOrigin", () => {
  it("compares the whole origin", () => {
    expect(isSameOrigin("http://127.0.0.1:3000/channel/x", "http://127.0.0.1:3000")).toBe(true);
    expect(isSameOrigin("http://127.0.0.1:3001/", "http://127.0.0.1:3000")).toBe(false);
    expect(isSameOrigin("http://127.0.0.1:3000/", undefined)).toBe(false);
  });
});

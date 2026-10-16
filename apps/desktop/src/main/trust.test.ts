// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  CLIENT_PARTITIONS,
  clientPartition,
  hostShellUrl,
  isHostShellSender,
  mayInjectHostToken,
  navigationDecision,
} from "./trust.js";

const shell = hostShellUrl("/Applications/LOAM.app/Contents/Resources/app.asar/dist/renderer/index.html");
const node = "http://127.0.0.1:3000";

describe("isHostShellSender", () => {
  it("trusts the host window's top frame on the shell page", () => {
    expect(isHostShellSender({ isWindow: true, isMainFrame: true, frameUrl: shell }, shell)).toBe(true);
    expect(isHostShellSender({ isWindow: true, isMainFrame: true, frameUrl: `${shell}#/settings` }, shell)).toBe(true);
  });

  it("refuses the client window, an iframe, and any other page", () => {
    expect(isHostShellSender({ isWindow: false, isMainFrame: true, frameUrl: shell }, shell)).toBe(false);
    expect(isHostShellSender({ isWindow: true, isMainFrame: false, frameUrl: shell }, shell)).toBe(false);
    expect(isHostShellSender({ isWindow: true, isMainFrame: true, frameUrl: "file:///tmp/evil.html" }, shell)).toBe(false);
    expect(isHostShellSender({ isWindow: true, isMainFrame: true, frameUrl: `${node}/` }, shell)).toBe(false);
    expect(isHostShellSender({ isWindow: true, isMainFrame: true, frameUrl: "" }, shell)).toBe(false);
    expect(isHostShellSender({ isWindow: true, isMainFrame: true, frameUrl: "data:text/html,hi" }, shell)).toBe(false);
  });
});

describe("mayInjectHostToken", () => {
  it("hands the token to the client window's top frame on the node's loopback origin", () => {
    expect(mayInjectHostToken({ isWindow: true, isMainFrame: true, frameUrl: `${node}/channels` }, node)).toBe(true);
  });

  it("refuses any other window, frame, origin, or a stopped node", () => {
    expect(mayInjectHostToken({ isWindow: false, isMainFrame: true, frameUrl: `${node}/` }, node)).toBe(false);
    expect(mayInjectHostToken({ isWindow: true, isMainFrame: false, frameUrl: `${node}/` }, node)).toBe(false);
    expect(mayInjectHostToken({ isWindow: true, isMainFrame: true, frameUrl: "http://127.0.0.1:3001/" }, node)).toBe(false);
    expect(mayInjectHostToken({ isWindow: true, isMainFrame: true, frameUrl: "http://localhost:3000/" }, node)).toBe(false);
    expect(mayInjectHostToken({ isWindow: true, isMainFrame: true, frameUrl: "http://192.168.1.20:3000/" }, node)).toBe(false);
    expect(mayInjectHostToken({ isWindow: true, isMainFrame: true, frameUrl: `${node}/` }, undefined)).toBe(false);
  });
});

describe("navigationDecision", () => {
  const client = { isClientWindow: true, clientOrigin: node };
  const host = { isClientWindow: false, clientOrigin: node };

  it("lets the client window move around its own node", () => {
    expect(navigationDecision(`${node}/channel/x`, client)).toBe("allow");
  });

  it("sends web pages anywhere else to the browser", () => {
    expect(navigationDecision("https://example.com/", client)).toBe("open-in-browser");
    expect(navigationDecision("http://127.0.0.1:3001/", client)).toBe("open-in-browser");
    expect(navigationDecision(`${node}/`, host)).toBe("open-in-browser");
  });

  it("blocks everything else outright", () => {
    expect(navigationDecision("file:///etc/hosts", client)).toBe("block");
    expect(navigationDecision("file:///etc/hosts", host)).toBe("block");
    expect(navigationDecision("smb://server/share", client)).toBe("block");
    expect(navigationDecision(`${node}/`, { isClientWindow: true, clientOrigin: undefined })).toBe("open-in-browser");
  });
});

describe("clientPartition", () => {
  it("keeps an ephemeral network's client copy in memory", () => {
    expect(clientPartition(true)).toBe(CLIENT_PARTITIONS.memory);
    expect(clientPartition(true).startsWith("persist:")).toBe(false);
    expect(clientPartition(false)).toBe(CLIENT_PARTITIONS.kept);
  });
});

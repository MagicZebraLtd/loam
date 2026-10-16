import { act } from "preact/test-utils";
import { afterEach, describe, expect, it } from "vitest";

import type { DesktopState, NodeInfo } from "../../shared/ipc";
import { createFakeBridge, FAKE_TRANSPORT_KEY, sampleNode, sampleSettings, sampleState } from "../lib/fake-bridge";
import { buttonWith, click, mount, settle, unmountAll } from "../test-support/mount";
import { RunningScreen } from "./RunningScreen";

afterEach(unmountAll);

function running(node: Partial<NodeInfo> = {}, options: { hostAck?: number } = {}) {
  // A note already acknowledged, unless the test says otherwise (`hostAck: undefined` = never seen).
  const hostAck = "hostAck" in options ? options.hostAck : 1;
  const state = sampleState({ phase: "running", node: sampleNode(node) }, { settings: sampleSettings({ hostAck }) }) as Extract<
    DesktopState,
    { phase: "running" }
  >;
  const bridge = createFakeBridge({ state });
  const root = mount(<RunningScreen bridge={bridge} state={state} />);
  return { bridge, root };
}

describe("RunningScreen", () => {
  it("shows the name, the join QR, the address and who is connected", () => {
    const { root } = running();
    expect(root.querySelector("h1")?.textContent).toBe("Riverside");
    expect(root.querySelector(".running-qr svg")).toBeTruthy();
    expect(root.querySelector(".join-url code")?.textContent).toBe("http://192.168.1.20:3000");
    expect(root.textContent).toContain("2 phones connected");
    expect(root.textContent).toContain("3 people, 2 online");
    expect(root.textContent).toContain("Closing this window keeps the network running");
    for (const label of ["Open LOAM", "Display mode", "Link another LOAM node", "Stop network"]) {
      expect(buttonWith(root, label), label).toBeTruthy();
    }
  });

  it("says when no one has joined yet, and when nobody is admin", () => {
    const { root } = running({ clients: [], people: { total: 0, online: 0, pending: 0, admins: 0 } });
    expect(root.textContent).toContain("No one has joined yet");
    expect(root.textContent).toContain("Nobody is admin yet");
  });

  it("copies the whole join link, key included, and opens LOAM", async () => {
    const { bridge, root } = running();
    click(buttonWith(root, "Copy"));
    await settle();
    expect(bridge.copied).toBe(`http://192.168.1.20:3000/#k=${FAKE_TRANSPORT_KEY}`);
    expect(root.textContent).toContain("Copied");
    click(buttonWith(root, "Open LOAM"));
    expect(bridge.calls).toContain("openClient");
  });

  it("fills the window with the code in display mode until Esc", () => {
    const { root } = running();
    click(buttonWith(root, "Display mode"));
    expect(root.querySelector(".display-mode")).toBeTruthy();
    expect(root.querySelector(".display-heading")?.textContent).toBe("Join Riverside");
    expect(root.querySelector(".display-qr svg")).toBeTruthy();
    expect(document.activeElement?.textContent).toBe("Leave display mode");
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(root.querySelector(".display-mode")).toBeNull();
    expect(document.activeElement?.textContent).toBe("Display mode");
  });

  it("shows a link code as a keyed QR", async () => {
    const { bridge, root } = running();
    click(buttonWith(root, "Link another LOAM node"));
    await settle();
    expect(bridge.calls).toContain("host.linkCode");
    expect(root.querySelector(".link-qr svg")).toBeTruthy();
    expect(root.textContent).toMatch(/Works once, until \d\d:\d\d/);
    click(buttonWith(root, "Back"));
    expect(root.querySelector(".running-qr")).toBeTruthy();
  });

  it("stops in one press, but asks for a hold when stopping erases everything", async () => {
    const kept = running();
    click(buttonWith(kept.root, "Stop network"));
    await settle();
    expect(kept.bridge.calls).toContain("stop");
    unmountAll();

    const ephemeral = running({ dbEncryption: "ephemeral" });
    expect(buttonWith(ephemeral.root, "Stop network")).toBeUndefined();
    expect(ephemeral.root.textContent).toContain("stopping it erases them for good");
    expect(buttonWith(ephemeral.root, "Hold to stop and erase")).toBeTruthy();
  });

  it("asks a host who hasn't seen the host note to acknowledge it", async () => {
    const { bridge, root } = running({}, { hostAck: undefined });
    expect(root.textContent).toContain("You run this network");
    click(buttonWith(root, "I understand"));
    await settle();
    expect(bridge.calls).toContain("acknowledgeHost");
  });
});

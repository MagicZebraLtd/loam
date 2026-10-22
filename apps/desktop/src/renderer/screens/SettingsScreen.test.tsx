import { afterEach, describe, expect, it, vi } from "vitest";

import type { UpdateCheckResult } from "../../shared/ipc";
import { createFakeBridge, sampleNode, sampleSettings, sampleState } from "../lib/fake-bridge";
import { buttonWith, click, mount, settle, typeInto, unmountAll } from "../test-support/mount";
import { SettingsScreen } from "./SettingsScreen";

afterEach(unmountAll);

function settings(phase: "running" | "stopped", update?: UpdateCheckResult) {
  const state =
    phase === "running"
      ? sampleState({ phase: "running", node: sampleNode() }, { settings: sampleSettings({ joinHost: "172.16.0.9" }) })
      : sampleState({ phase: "stopped" });
  const bridge = createFakeBridge({ state, ...(update ? { update } : {}) });
  const root = mount(<SettingsScreen bridge={bridge} state={state} />);
  return { bridge, root };
}

describe("SettingsScreen", () => {
  it("offers Automatic and this computer's addresses while running, keeping a pinned one", () => {
    const { root } = settings("running");
    const options = Array.from(root.querySelectorAll('select[name="joinHost"] option')).map((option) => option.textContent);
    expect(options).toEqual(["Automatic", "172.16.0.9", "192.168.1.20", "10.0.0.5"]);
    expect(root.querySelector<HTMLSelectElement>('select[name="joinHost"]')?.value).toBe("172.16.0.9");
    expect(root.textContent).toContain("Kept in this computer's keychain");
    expect(root.textContent).toContain("Encrypted for everyone who joins by the code");
    expect(buttonWith(root, "Hold to erase everything")).toBeTruthy();
    expect(buttonWith(root, "Hold to erase and start over")).toBeTruthy();
  });

  it("opens the web admin page's assistant section while running, and says to start the network otherwise", () => {
    const running = settings("running");
    click(buttonWith(running.root, "Set up the assistant"));
    expect(running.bridge.calls).toContain("openClient:assistant");

    const stopped = settings("stopped");
    expect(buttonWith(stopped.root, "Set up the assistant")).toBeUndefined();
    expect(stopped.root.textContent).toContain("Start the network to set up the assistant.");
  });

  it("takes a typed join address when stopped, and has no Emergency Reset", () => {
    const { root } = settings("stopped");
    expect(root.querySelector('input[name="joinHost"]')).toBeTruthy();
    expect(root.textContent).toContain("Start the network to run Emergency Reset.");
    expect(buttonWith(root, "Hold to erase everything")).toBeUndefined();
  });

  it("checks the fields before saving, then saves", async () => {
    const { bridge, root } = settings("stopped");
    typeInto(root.querySelector('input[name="port"]'), "70000");
    typeInto(root.querySelector('input[name="joinHost"]'), "no spaces please");
    click(buttonWith(root, "Save"));
    await settle();
    expect(root.textContent).toContain("Use a whole number from 1 to 65535.");
    expect(root.textContent).toContain("Use an IP address");
    expect(bridge.calls).not.toContain("updateSettings");

    typeInto(root.querySelector('input[name="port"]'), "3005");
    typeInto(root.querySelector('input[name="joinHost"]'), "loam.local");
    typeInto(root.querySelector('select[name="logLevel"]'), "debug");
    click(buttonWith(root, "Save"));
    await settle();
    expect(bridge.current().settings).toMatchObject({ port: 3005, joinHost: "loam.local", logLevel: "debug" });
    expect(root.textContent).toContain("Saved");
  });

  it("shows a refused save", async () => {
    const { bridge, root } = settings("stopped");
    bridge.updateSettings = vi.fn(async () => ({ ok: false as const, error: "desktop.json couldn't be written" }));
    click(buttonWith(root, "Save"));
    await settle();
    expect(root.textContent).toContain("Not saved: desktop.json couldn't be written");
  });

  it("checks for updates only when asked, and offers the download", async () => {
    const { bridge, root } = settings("stopped");
    expect(bridge.calls).not.toContain("checkForUpdates");
    click(buttonWith(root, "Check for updates"));
    await settle();
    expect(root.textContent).toContain("LOAM 0.7.0 is available. This computer has 0.6.4.");
    click(buttonWith(root, "Download"));
    expect(bridge.opened).toEqual(["https://github.com/MagicZebraLtd/loam/releases/latest"]);
  });

  it("says when GitHub couldn't be reached", async () => {
    const { root } = settings("stopped", { ok: false, error: "offline" });
    click(buttonWith(root, "Check for updates"));
    await settle();
    expect(root.textContent).toContain("Couldn't reach GitHub");
  });

  it("opens the data folder", () => {
    const { bridge, root } = settings("stopped");
    expect(root.textContent).toContain("/Users/someone/Library/Application Support/LOAM/node");
    click(buttonWith(root, "Open data folder"));
    expect(bridge.calls).toContain("openDataFolder");
  });
});

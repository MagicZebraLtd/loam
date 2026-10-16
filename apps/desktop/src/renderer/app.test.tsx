import { act } from "preact/test-utils";
import { afterEach, describe, expect, it } from "vitest";

import type { DesktopState } from "../shared/ipc";
import { App, showsTabs } from "./app";
import { createFakeBridge, sampleNetwork, sampleNode, sampleSettings, sampleState } from "./lib/fake-bridge";
import { buttonWith, click, mount, settle, unmountAll } from "./test-support/mount";

afterEach(unmountAll);

const PHASES: { state: DesktopState; heading: string | RegExp; tabs: boolean }[] = [
  { state: sampleState({ phase: "setup" }), heading: "Welcome to LOAM", tabs: false },
  {
    state: sampleState({ phase: "locked", wrongPassphrase: false }, { network: sampleNetwork({ encryption: "passphrase" }) }),
    heading: "Unlock Riverside",
    tabs: false,
  },
  { state: sampleState({ phase: "starting" }), heading: "Starting the network…", tabs: true },
  { state: sampleState({ phase: "running", node: sampleNode() }), heading: "Riverside", tabs: true },
  { state: sampleState({ phase: "stopped" }), heading: "Riverside is stopped", tabs: true },
  { state: sampleState({ phase: "failed", error: { code: "db_unreadable" } }), heading: "The messages can't be read", tabs: true },
  { state: sampleState({ phase: "resetting" }), heading: "Erasing everything…", tabs: false },
];

describe("App", () => {
  it.each(PHASES)("shows the right screen for $state.phase", async ({ state, heading, tabs }) => {
    const root = mount(<App bridge={createFakeBridge({ state })} />);
    await settle();
    expect(root.querySelector("main h1")?.textContent).toMatch(heading);
    expect(Boolean(root.querySelector("nav.tabs")), "tabs").toBe(tabs);
    expect(showsTabs(state)).toBe(tabs);
  });

  it("shows no tabs before a network exists", () => {
    expect(showsTabs(sampleState({ phase: "stopped" }, { network: undefined }))).toBe(false);
  });

  it("switches between the four screens", async () => {
    const root = mount(<App bridge={createFakeBridge({ state: sampleState({ phase: "running", node: sampleNode() }) })} />);
    await settle();
    const tab = (label: string) => root.querySelector("nav.tabs") && buttonWith(root.querySelector("nav.tabs")!, label);
    click(tab("People"));
    await settle();
    expect(root.querySelector("main h1")?.textContent).toBe("People");
    expect(tab("People")?.getAttribute("aria-current")).toBe("page");
    click(tab("Activity"));
    await settle();
    expect(root.querySelector("main h1")?.textContent).toBe("Activity");
    click(tab("Settings"));
    expect(root.querySelector("main h1")?.textContent).toBe("Settings");
    click(tab("Network"));
    expect(root.querySelector("main h1")?.textContent).toBe("Riverside");
  });

  it("follows state pushes: setup, starting, running", async () => {
    const bridge = createFakeBridge({ state: sampleState({ phase: "setup" }, { settings: sampleSettings({ hostAck: 1 }) }) });
    const root = mount(<App bridge={bridge} />);
    await settle();
    click(buttonWith(root, "Start the network"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(bridge.calls).toContain("setup");
    await settle();
    expect(bridge.current().phase).toBe("running");
    expect(root.querySelector("main h1")?.textContent).toBe("LOAM");
    expect(root.querySelector(".running-qr svg")).toBeTruthy();
  });

  it("goes back to the Network tab when the tabs go away, and after a new network", async () => {
    const bridge = createFakeBridge({ state: sampleState({ phase: "running", node: sampleNode() }) });
    const root = mount(<App bridge={bridge} />);
    await settle();
    click(buttonWith(root.querySelector("nav.tabs")!, "Settings"));
    act(() => {
      bridge.push(sampleState({ phase: "resetting" }));
    });
    expect(root.querySelector("main h1")?.textContent).toBe("Erasing everything…");
    act(() => {
      bridge.push(sampleState({ phase: "running", node: sampleNode() }));
    });
    expect(root.querySelector("main h1")?.textContent).toBe("Riverside");
  });
});

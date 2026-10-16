import { afterEach, describe, expect, it } from "vitest";

import { createFakeBridge, sampleSettings, sampleState } from "../lib/fake-bridge";
import { buttonWith, click, mount, settle, typeInto, unmountAll } from "../test-support/mount";
import { SetupScreen } from "./SetupScreen";

afterEach(unmountAll);

function setup(options: { keychain?: boolean; hostAck?: number } = {}) {
  const state = sampleState({ phase: "setup" }, {
    capabilities: { platform: "linux", keychain: options.keychain ?? true },
    settings: sampleSettings({ hostAck: options.hostAck }),
  });
  const bridge = createFakeBridge({ state });
  const root = mount(<SetupScreen bridge={bridge} state={state} />);
  return { bridge, root };
}

function radio(root: HTMLElement, name: string, value: string): HTMLInputElement {
  return root.querySelector(`input[name="${name}"][value="${value}"]`) as HTMLInputElement;
}

describe("SetupScreen", () => {
  it("shows the name field, the three kinds of network, the storage choices and the host note", () => {
    const { root } = setup();
    expect(root.querySelector<HTMLInputElement>('input[name="nodeName"]')?.placeholder).toBe("LOAM");
    expect(root.querySelector<HTMLInputElement>('input[name="nodeName"]')?.maxLength).toBe(80);
    expect(root.textContent).toContain("Private and short-lived");
    expect(root.textContent).toContain("Community");
    expect(root.textContent).toContain("Choose every setting myself");
    expect(root.textContent).toContain("If LOAM closes or the computer restarts");
    for (const mode of ["off", "ephemeral", "passphrase", "persistent"]) {
      expect(radio(root, "encryption", mode), mode).toBeTruthy();
    }
    expect(root.textContent).toContain("You run this network");
    expect(root.textContent).toContain("report it to the police");
  });

  it("hides the keychain without one, explains why, and defaults to a passphrase", () => {
    const { root } = setup({ keychain: false });
    expect(radio(root, "encryption", "persistent")).toBeNull();
    expect(radio(root, "encryption", "passphrase").checked).toBe(true);
    expect(root.textContent).toContain("no keychain LOAM can use");
    expect(root.querySelector('input[name="passphrase"]')).toBeTruthy();
  });

  it("moves the storage to match the kind of network", () => {
    const { root } = setup();
    expect(radio(root, "encryption", "persistent").checked).toBe(true);
    click(radio(root, "preset", "private"));
    expect(radio(root, "encryption", "ephemeral").checked).toBe(true);
  });

  it("shows what's wrong beside each field and sends nothing", async () => {
    const { bridge, root } = setup();
    click(radio(root, "encryption", "passphrase"));
    typeInto(root.querySelector('input[name="passphrase"]'), "short");
    click(buttonWith(root, "Start the network"));
    await settle();
    expect(root.textContent).toContain("Use at least 8 characters.");
    expect(root.textContent).toContain("Tick \"I understand\"");
    expect(bridge.calls).not.toContain("setup");

    typeInto(root.querySelector('input[name="passphrase"]'), "long enough");
    typeInto(root.querySelector('input[name="confirm"]'), "long enougj");
    click(buttonWith(root, "Start the network"));
    await settle();
    expect(root.textContent).toContain("don't match");
  });

  it("acknowledges the note, then sends the setup request", async () => {
    const { bridge, root } = setup();
    typeInto(root.querySelector('input[name="nodeName"]'), "  Riverside ");
    click(root.querySelector('input[name="acknowledged"]'));
    click(buttonWith(root, "Start the network"));
    await settle();
    expect(bridge.calls).toEqual(["acknowledgeHost", "setup"]);
    expect(bridge.current().network).toMatchObject({ nodeName: "Riverside", preset: "community", encryption: "persistent" });
  });

  it("doesn't ask again for a note already acknowledged", async () => {
    const { bridge, root } = setup({ hostAck: 1 });
    expect(root.textContent).not.toContain("You run this network");
    click(buttonWith(root, "Start the network"));
    await settle();
    expect(bridge.calls).toEqual(["setup"]);
  });
});

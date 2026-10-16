import { afterEach, describe, expect, it } from "vitest";

import type { DesktopState } from "../../shared/ipc";
import { createFakeBridge, sampleNetwork, sampleState } from "../lib/fake-bridge";
import { buttonWith, click, mount, settle, typeInto, unmountAll } from "../test-support/mount";
import { UnlockScreen } from "./UnlockScreen";

afterEach(unmountAll);

function locked(wrongPassphrase: boolean): Extract<DesktopState, { phase: "locked" }> {
  return sampleState({ phase: "locked", wrongPassphrase }, { network: sampleNetwork({ encryption: "passphrase" }) }) as Extract<
    DesktopState,
    { phase: "locked" }
  >;
}

describe("UnlockScreen", () => {
  it("asks for the passphrase and sends it", async () => {
    const state = locked(false);
    const bridge = createFakeBridge({ state });
    const root = mount(<UnlockScreen bridge={bridge} state={state} />);
    expect(root.querySelector("h1")?.textContent).toBe("Unlock Riverside");
    click(buttonWith(root, "Unlock and start"));
    await settle();
    expect(root.textContent).toContain("Type the passphrase.");
    expect(bridge.calls).not.toContain("unlock");
    typeInto(root.querySelector('input[name="passphrase"]'), "correct horse");
    click(buttonWith(root, "Unlock and start"));
    await settle();
    expect(bridge.calls).toContain("unlock");
    expect(root.querySelector<HTMLInputElement>('input[name="passphrase"]')?.value).toBe("");
  });

  it("says when the passphrase was wrong, and offers a new network", () => {
    const state = locked(true);
    const root = mount(<UnlockScreen bridge={createFakeBridge({ state })} state={state} />);
    expect(root.textContent).toContain("didn't open the network");
    expect(root.textContent).toContain("Forgot the passphrase?");
    expect(buttonWith(root, "Hold to erase and start over")).toBeTruthy();
  });
});

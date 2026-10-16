import { afterEach, describe, expect, it } from "vitest";

import type { DesktopState } from "../../shared/ipc";
import { createFakeBridge, sampleNetwork, sampleState } from "../lib/fake-bridge";
import { buttonWith, click, mount, settle, typeInto, unmountAll } from "../test-support/mount";
import { UnlockScreen } from "./UnlockScreen";

afterEach(unmountAll);

function locked(wrongPassphrase: boolean, fresh = false): Extract<DesktopState, { phase: "locked" }> {
  return sampleState({ phase: "locked", wrongPassphrase, fresh }, { network: sampleNetwork({ encryption: "passphrase" }) }) as Extract<
    DesktopState,
    { phase: "locked" }
  >;
}

function render(state: Extract<DesktopState, { phase: "locked" }>) {
  const bridge = createFakeBridge({ state });
  const root = mount(<UnlockScreen bridge={bridge} state={state} />);
  return { bridge, root };
}

describe("UnlockScreen", () => {
  it("asks for the passphrase once and sends it", async () => {
    const { bridge, root } = render(locked(false));
    expect(root.querySelector("h1")?.textContent).toBe("Unlock Riverside");
    expect(root.querySelector('input[name="confirm"]')).toBeNull();
    click(buttonWith(root, "Unlock and start"));
    await settle();
    expect(root.textContent).toContain("Type the passphrase.");
    expect(bridge.calls).not.toContain("unlock");
    typeInto(root.querySelector('input[name="passphrase"]'), "abc");
    click(buttonWith(root, "Unlock and start"));
    await settle();
    expect(bridge.calls).toContain("unlock");
    expect(root.querySelector<HTMLInputElement>('input[name="passphrase"]')?.value).toBe("");
  });

  it("says when the passphrase was wrong, and offers a new network", () => {
    const { root } = render(locked(true));
    expect(root.textContent).toContain("didn't open the network");
    expect(root.textContent).toContain("Forgot the passphrase?");
    expect(buttonWith(root, "Hold to erase and start over")).toBeTruthy();
  });

  describe("fresh (erased by an Emergency Reset)", () => {
    it("explains the erase and asks for the new passphrase twice", () => {
      const { root } = render(locked(false, true));
      expect(root.querySelector("h1")?.textContent).toBe("Choose a new passphrase");
      expect(root.textContent).toContain("Emergency Reset erased this network");
      expect(root.textContent).toContain("It is never stored");
      expect(root.querySelector('input[name="confirm"]')).toBeTruthy();
      expect(root.textContent).not.toContain("Forgot the passphrase?");
    });

    it("refuses a short or mismatched passphrase", async () => {
      const { bridge, root } = render(locked(false, true));
      typeInto(root.querySelector('input[name="passphrase"]'), "short");
      typeInto(root.querySelector('input[name="confirm"]'), "short");
      click(buttonWith(root, "Start the new network"));
      await settle();
      expect(root.textContent).toContain("Use at least 8 characters.");
      typeInto(root.querySelector('input[name="passphrase"]'), "correct horse");
      typeInto(root.querySelector('input[name="confirm"]'), "correct house");
      click(buttonWith(root, "Start the new network"));
      await settle();
      expect(root.textContent).toContain("The two passphrases don't match.");
      expect(bridge.calls).not.toContain("unlock");
    });

    it("sends a matching passphrase through unlock", async () => {
      const { bridge, root } = render(locked(false, true));
      typeInto(root.querySelector('input[name="passphrase"]'), "correct horse");
      typeInto(root.querySelector('input[name="confirm"]'), "correct horse");
      click(buttonWith(root, "Start the new network"));
      await settle();
      expect(bridge.calls).toEqual(["unlock"]);
      expect(bridge.current().phase).not.toBe("locked");
    });
  });
});

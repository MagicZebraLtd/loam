import { act } from "preact/test-utils";
import { afterEach, describe, expect, it } from "vitest";

import { createFakeBridge } from "../lib/fake-bridge";
import { buttonWith, click, mount, settle, unmountAll } from "../test-support/mount";
import { SupportDialog } from "./SupportDialog";

afterEach(unmountAll);

describe("SupportDialog", () => {
  it("is just a button until pressed", () => {
    const root = mount(<SupportDialog bridge={createFakeBridge()} />);
    expect(buttonWith(root, "Support LOAM")).toBeTruthy();
    expect(root.querySelector("[role=dialog]")).toBeNull();
  });

  it("opens with the text and opens Ko-fi with the exact URL", async () => {
    const bridge = createFakeBridge();
    const root = mount(<SupportDialog bridge={bridge} />);
    click(buttonWith(root, "Support LOAM"));
    expect(root.querySelector("[role=dialog]")?.textContent).toContain("LOAM is free and open source, and always will be.");
    click(buttonWith(root, "Open Ko-fi"));
    await settle();
    expect(bridge.opened).toEqual(["https://ko-fi.com/magiczebra"]);
  });

  it("closes on Close and on Esc, returning focus to the button", () => {
    const root = mount(<SupportDialog bridge={createFakeBridge()} />);
    const opener = buttonWith(root, "Support LOAM");
    click(opener);
    click(buttonWith(root, "Close"));
    expect(root.querySelector("[role=dialog]")).toBeNull();
    expect(document.activeElement).toBe(opener);

    click(opener);
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(root.querySelector("[role=dialog]")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

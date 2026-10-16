import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buttonWith, click, mount, unmountAll } from "../test-support/mount";
import { HOLD_MS, HoldToConfirm } from "./HoldToConfirm";

function pointer(target: Element, type: string): void {
  act(() => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, detail: 1 }));
  });
}

function key(target: Element, type: "keydown" | "keyup", value: string): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, key: value }));
  });
}

describe("HoldToConfirm", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    unmountAll();
    vi.useRealTimers();
  });

  it("acts only after the button is held for the whole time", () => {
    const onConfirm = vi.fn();
    const root = mount(<HoldToConfirm label="Hold to erase" onConfirm={onConfirm} />);
    const button = buttonWith(root, "Hold to erase")!;
    pointer(button, "pointerdown");
    expect(button.textContent).toContain("Keep holding");
    act(() => {
      vi.advanceTimersByTime(HOLD_MS - 1);
    });
    expect(onConfirm).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("cancels when let go early", () => {
    const onConfirm = vi.fn();
    const root = mount(<HoldToConfirm label="Hold to erase" onConfirm={onConfirm} />);
    const button = buttonWith(root, "Hold to erase")!;
    pointer(button, "pointerdown");
    act(() => {
      vi.advanceTimersByTime(HOLD_MS / 2);
    });
    pointer(button, "pointerup");
    act(() => {
      vi.advanceTimersByTime(HOLD_MS);
    });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(button.textContent).toContain("Hold to erase");
  });

  it("can be held from the keyboard with Space or Enter", () => {
    const onConfirm = vi.fn();
    const root = mount(<HoldToConfirm label="Hold to erase" onConfirm={onConfirm} />);
    const button = buttonWith(root, "Hold to erase")!;
    key(button, "keydown", " ");
    act(() => {
      vi.advanceTimersByTime(HOLD_MS);
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    key(button, "keyup", " ");
    key(button, "keydown", "Enter");
    key(button, "keyup", "Enter");
    act(() => {
      vi.advanceTimersByTime(HOLD_MS);
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("gives assistive technology, which can only click, a separate Confirm step", () => {
    const onConfirm = vi.fn();
    const root = mount(<HoldToConfirm label="Hold to erase" onConfirm={onConfirm} />);
    // jsdom's click() carries detail 0, as an assistive technology's activation does.
    click(buttonWith(root, "Hold to erase"));
    expect(onConfirm).not.toHaveBeenCalled();
    click(buttonWith(root, "Confirm"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(buttonWith(root, "Confirm")).toBeUndefined();
  });

  it("does nothing while disabled", () => {
    const onConfirm = vi.fn();
    const root = mount(<HoldToConfirm disabled label="Hold to erase" onConfirm={onConfirm} />);
    const button = buttonWith(root, "Hold to erase")!;
    pointer(button, "pointerdown");
    act(() => {
      vi.advanceTimersByTime(HOLD_MS * 2);
    });
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

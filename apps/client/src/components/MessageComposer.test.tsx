import type { VNode } from "preact";
import { render } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MessageAttachment } from "@loam/schema";

import { MessageComposer } from "./MessageComposer";

// Rendered-component tests: mount real Preact components into jsdom and drive the composer's DOM.

const mounted: HTMLDivElement[] = [];

function mount(element: VNode): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  render(element, container);
  mounted.push(container);
  return container;
}

/** Let Preact flush its batched state update (it re-renders on a microtask, not synchronously). */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Set a textarea/input value the way Preact's controlled inputs expect, then fire an input event. */
function typeInto(field: HTMLTextAreaElement | HTMLInputElement, text: string): void {
  field.value = text;
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

afterEach(() => {
  for (const container of mounted) {
    render(null, container);
    container.remove();
  }
  mounted.length = 0;
});

describe("MessageComposer", () => {
  it("keeps the send button disabled while the composer is empty", () => {
    const host = mount(<MessageComposer label="Message" onSend={async () => {}} placeholder="Say something" />);

    const send = host.querySelector("button[type='submit']") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
  });

  it("submits the trimmed body via onSend and clears the textarea", async () => {
    const onSend = vi.fn(async () => {});
    const host = mount(<MessageComposer label="Message" onSend={onSend} placeholder="Say something" />);

    const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
    typeInto(textarea, "  hello world  ");
    await tick();

    const send = host.querySelector("button[type='submit']") as HTMLButtonElement;
    expect(send.disabled).toBe(false);

    const form = host.querySelector("form") as HTMLFormElement;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await tick();

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith("hello world", undefined, undefined);
  });

  it("keeps what was typed while a send was still in flight (the next message, not the sent one)", async () => {
    let finish: () => void = () => {};
    const onSend = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const host = mount(<MessageComposer label="Message" onSend={onSend} placeholder="Say something" />);
    const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
    typeInto(textarea, "first");
    await tick();
    (host.querySelector("form") as HTMLFormElement).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await tick();
    expect(onSend).toHaveBeenCalledWith("first", undefined, undefined);

    // A fast typist starts the next message before the server has answered.
    typeInto(textarea, "firstsecond");
    await tick();
    finish();
    await tick();
    expect(textarea.value).toBe("second");
  });

  it("shows the location toggle only when location sharing is allowed", async () => {
    const withoutLocation = mount(<MessageComposer label="Message" onSend={async () => {}} placeholder="Say something" />);
    expect(withoutLocation.querySelector(".composer-location-toggle")).toBeNull();

    const withLocation = mount(
      <MessageComposer allowLocationSharing label="Message" onSend={async () => {}} placeholder="Say something" />,
    );
    const toggle = withLocation.querySelector(".composer-location-toggle") as HTMLButtonElement;
    expect(toggle).not.toBeNull();

    // Toggling opens the coordinate/label form.
    expect(withLocation.querySelector(".composer-location-form")).toBeNull();
    toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    expect(withLocation.querySelector(".composer-location-form")).not.toBeNull();
  });

  it("sends a location-only message when the toggle form has a label", async () => {
    const onSend = vi.fn(async () => {});
    const host = mount(
      <MessageComposer allowLocationSharing label="Message" onSend={onSend} placeholder="Say something" />,
    );

    (host.querySelector(".composer-location-toggle") as HTMLButtonElement).dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    await tick();

    const labelInput = host.querySelector(".composer-location-label") as HTMLInputElement;
    typeInto(labelInput, "north gate");
    await tick();

    const send = host.querySelector("button[type='submit']") as HTMLButtonElement;
    expect(send.disabled).toBe(false);

    (host.querySelector("form") as HTMLFormElement).dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    await tick();

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith("", undefined, { label: "north gate" });
  });

  it("keeps the text and a ready attachment through a refused send and a spell disabled, then sends both", async () => {
    // A DM to the assistant refused because its destination changed: the composer is then held until the
    // member acknowledges an online service (docs/06), and what they wrote must still be there afterwards.
    const attachment = { id: "att_0123456789abcdef", mimeType: "image/png", width: 1, height: 1 } as MessageAttachment;
    const onSend = vi.fn<(body: string, attachments?: MessageAttachment[]) => Promise<void>>(async () => {
      throw new Error("refused");
    });
    const composer = (disabledReason?: string) => (
      <MessageComposer
        disabledReason={disabledReason}
        label="Message"
        onSend={onSend}
        onUploadAttachment={async () => attachment}
        placeholder="Say something"
      />
    );
    const host = mount(composer());
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { value: [new File(["x"], "photo.png", { type: "image/png" })], configurable: true });
    input.dispatchEvent(new Event("input", { bubbles: true }));
    typeInto(host.querySelector("textarea") as HTMLTextAreaElement, "my question");
    await tick();
    await tick();
    (host.querySelector("form") as HTMLFormElement).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await tick();
    expect(onSend).toHaveBeenCalledWith("my question", [attachment], undefined);

    render(composer("Read the notice above"), host);
    await tick();
    expect(host.querySelector("textarea")).toBeNull();
    render(composer(), host);
    await tick();

    expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("my question");
    expect(host.querySelector(".attachment-chip")?.textContent).toContain("photo.png");
    onSend.mockImplementation(async () => {});
    (host.querySelector("form") as HTMLFormElement).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await tick();
    expect(onSend).toHaveBeenLastCalledWith("my question", [attachment], undefined);
  });

  it("keeps a picture added while a send was in flight, and frees only the sent one's preview", async () => {
    let previews = 0;
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: vi.fn(() => `blob:preview-${(previews += 1)}`), revokeObjectURL: revoke });
    try {
      const first = { id: "att_0123456789abcdef", mimeType: "image/png", width: 1, height: 1 } as MessageAttachment;
      const second = { id: "att_fedcba9876543210", mimeType: "image/png", width: 1, height: 1 } as MessageAttachment;
      const uploads = [first, second];
      let finish: () => void = () => {};
      const onSend = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
      const host = mount(
        <MessageComposer label="Message" onSend={onSend} onUploadAttachment={async () => uploads.shift()!} placeholder="Say something" />,
      );
      const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
      /** Pick one picture through the file field. */
      function pickPicture(name: string): void {
        Object.defineProperty(input, "files", { value: [new File(["x"], name, { type: "image/png" })], configurable: true });
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }

      pickPicture("first.png");
      await tick();
      await tick();
      (host.querySelector("form") as HTMLFormElement).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await tick();
      expect(onSend).toHaveBeenCalledWith("", [first], undefined);

      // A picture pasted or picked while the server has not answered yet belongs to the next message.
      pickPicture("second.png");
      await tick();
      await tick();
      finish();
      await tick();
      await tick();

      const chips = Array.from(host.querySelectorAll(".attachment-chip"));
      expect(chips.map((chip) => chip.querySelector(".attachment-chip-name")?.textContent)).toEqual(["second.png"]);
      expect(revoke.mock.calls).toEqual([["blob:preview-1"]]);
    } finally {
      Reflect.deleteProperty(URL, "createObjectURL");
      Reflect.deleteProperty(URL, "revokeObjectURL");
    }
  });

  it("gives a draft brought back after a spell disabled its full height again", async () => {
    Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", { configurable: true, get: () => 80 });
    try {
      const composer = (disabledReason?: string) => (
        <MessageComposer disabledReason={disabledReason} label="Message" onSend={async () => {}} placeholder="Say something" />
      );
      const host = mount(composer());
      typeInto(host.querySelector("textarea") as HTMLTextAreaElement, "line one\nline two\nline three");
      await tick();
      expect((host.querySelector("textarea") as HTMLTextAreaElement).style.height).toBe("80px");

      render(composer("You are timed out"), host);
      await tick();
      render(composer(), host);
      // Effects run after paint.
      await new Promise((resolve) => setTimeout(resolve, 50));

      const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
      expect(textarea.value).toBe("line one\nline two\nline three");
      expect(textarea.style.height).toBe("80px");
    } finally {
      delete (HTMLTextAreaElement.prototype as { scrollHeight?: number }).scrollHeight;
    }
  });
});

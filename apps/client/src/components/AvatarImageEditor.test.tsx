import type { VNode } from "preact";
import { render } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AvatarImageEditor } from "./AvatarImageEditor";

// Rendered-component tests: mount real Preact components into jsdom and assert on the resulting DOM.
// A full canvas exercise is impractical in jsdom, so this covers the shell: controls render, and the
// crop actions stay disabled until an image is chosen.

const mounted: HTMLDivElement[] = [];

function mount(element: VNode): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  render(element, container);
  mounted.push(container);
  return container;
}

afterEach(() => {
  for (const container of mounted) {
    render(null, container);
    container.remove();
  }
  mounted.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(URL, "createObjectURL");
  Reflect.deleteProperty(URL, "revokeObjectURL");
});

/**
 * Stand-ins for what jsdom lacks: a picture that loads, object URLs, a 2D context and `toBlob`. `webp` false
 * is Safari, which hands back a PNG when asked for WebP. Lossy types come out at `quality * 0.4` bytes a pixel.
 */
function fakeCanvas({ webp, pngBytesPerPixel }: { webp: boolean; pngBytesPerPixel: number }): void {
  const context = {
    fillStyle: "",
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    scale: vi.fn(),
    drawImage: vi.fn(),
  };
  class FakeImage {
    naturalWidth = 800;
    naturalHeight = 600;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(value: string) {
      if (value) {
        queueMicrotask(() => this.onload?.());
      }
    }
  }
  vi.stubGlobal("Image", FakeImage);
  Object.assign(URL, { createObjectURL: vi.fn(() => "blob:picked"), revokeObjectURL: vi.fn() });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function toBlob(
    this: HTMLCanvasElement,
    callback: BlobCallback,
    type = "image/png",
    quality = 0.92,
  ) {
    const produced = type === "image/webp" && !webp ? "image/png" : type;
    const pixels = this.width * this.height;
    const size = Math.round(produced === "image/png" ? pixels * pngBytesPerPixel : pixels * quality * 0.4);
    queueMicrotask(() => callback(new Blob([new Uint8Array(size)], { type: produced })));
  });
}

/** Let the fake picture load, the encoder's callbacks run and Preact re-render. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * Choose a picture in the file field the way a browser does: it holds the file's name as its value until
 * something clears it.
 */
function pick(host: HTMLElement): HTMLInputElement {
  const input = host.querySelector<HTMLInputElement>("input[type='file']")!;
  let value = "C:\\fakepath\\photo.jpg";
  Object.defineProperty(input, "files", { configurable: true, value: [new File(["x"], "photo.jpg", { type: "image/jpeg" })] });
  Object.defineProperty(input, "value", {
    configurable: true,
    get: () => value,
    set: (next: string) => {
      value = next;
    },
  });
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return input;
}

/** Choose a picture, press "Use cropped image" and return what the editor hands over. */
async function chooseAndUpload(): Promise<Blob> {
  const onUpload = vi.fn(async (_blob: Blob) => {});
  const host = mount(<AvatarImageEditor disabled={false} onUpload={onUpload} />);
  pick(host);
  await settle();
  host.querySelectorAll("button")[1]!.click();
  await settle();
  expect(host.querySelector(".form-error")).toBeNull();
  expect(onUpload).toHaveBeenCalledTimes(1);
  return onUpload.mock.calls[0]![0];
}

describe("AvatarImageEditor", () => {
  it("renders the crop canvas and the choose/zoom/rotate controls", () => {
    const host = mount(<AvatarImageEditor disabled={false} onUpload={async () => {}} />);

    expect(host.querySelector("canvas.avatar-crop-canvas")).not.toBeNull();
    expect(host.querySelector("input[type='file']")).not.toBeNull();

    const rangeInputs = host.querySelectorAll("input[type='range']");
    expect(rangeInputs.length).toBe(2);

    const buttons = host.querySelectorAll("button");
    expect(buttons.length).toBe(2);
  });

  it("keeps the crop actions disabled until an image is chosen", () => {
    const host = mount(<AvatarImageEditor disabled={false} onUpload={async () => {}} />);

    const buttons = Array.from(host.querySelectorAll("button"));
    // The first button chooses an image (enabled); the second uses the crop and stays disabled with no image.
    expect(buttons[0]?.disabled).toBe(false);
    expect(buttons[1]?.disabled).toBe(true);

    for (const range of Array.from(host.querySelectorAll("input[type='range']"))) {
      expect((range as HTMLInputElement).disabled).toBe(true);
    }
  });

  it("uploads a JPEG under the cap from a browser that hands back PNG for WebP", async () => {
    fakeCanvas({ webp: false, pngBytesPerPixel: 3 });
    const uploaded = await chooseAndUpload();
    expect(uploaded.type).toBe("image/jpeg");
    expect(uploaded.size).toBeLessThanOrEqual(128 * 1024);
  });

  it("keeps PNG there when it fits, as for a small flat picture", async () => {
    fakeCanvas({ webp: false, pngBytesPerPixel: 0.5 });
    expect((await chooseAndUpload()).type).toBe("image/png");
  });

  it("still uploads WebP where the browser writes it", async () => {
    fakeCanvas({ webp: true, pngBytesPerPixel: 3 });
    expect((await chooseAndUpload()).type).toBe("image/webp");
  });

  it("clears the file field once its file is read, so picking the same file again is seen", async () => {
    fakeCanvas({ webp: true, pngBytesPerPixel: 3 });
    const host = mount(<AvatarImageEditor disabled={false} onUpload={async () => {}} />);
    const input = pick(host);
    await settle();
    expect(input.value).toBe("");
  });

  it("disables every control when the editor is disabled", () => {
    const host = mount(<AvatarImageEditor disabled onUpload={async () => {}} />);

    for (const button of Array.from(host.querySelectorAll("button"))) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
    for (const range of Array.from(host.querySelectorAll("input[type='range']"))) {
      expect((range as HTMLInputElement).disabled).toBe(true);
    }
  });
});

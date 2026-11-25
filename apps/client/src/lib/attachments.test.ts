import { afterEach, describe, expect, it, vi } from "vitest";

import { loadLocale, setActiveLocale } from "../i18n";
import {
  ATTACHMENT_FILE_MAX_BYTES,
  ATTACHMENT_IMAGE_SOURCE_MAX_BYTES,
  ATTACHMENT_MAX_BYTES,
  attachmentExtension,
  attachmentPath,
  bytesToBase64,
  exceededAttachmentLimit,
  fitWithin,
  formatByteLimit,
  prepareImageAttachment,
} from "./attachments";

/** What a fake encoder hands back, in bytes a pixel: PNG 3, WebP `quality * 0.2`, JPEG `quality * 0.4`. */
function fakeEncodedSize(type: string, pixels: number, quality = 0.92): number {
  if (type === "image/png") {
    return pixels * 3;
  }
  return Math.round(pixels * quality * (type === "image/webp" ? 0.2 : 0.4));
}

/**
 * Stand-ins for what jsdom lacks: a picture that loads at `width` x `height`, object URLs, a 2D context
 * that records its fills, and `toBlob`. `webp` false is Safari, which hands back a PNG when asked for WebP.
 */
function fakeImagePipeline({ width, height, webp, detail = 1 }: { width: number; height: number; webp: boolean; detail?: number }) {
  const fills: string[] = [];
  const context = {
    fillStyle: "",
    clearRect: vi.fn(),
    drawImage: vi.fn(),
    fillRect: vi.fn(function fillRect(this: { fillStyle: string }) {
      fills.push(this.fillStyle);
    }),
  };
  const requested: string[] = [];
  class FakeImage {
    naturalWidth = width;
    naturalHeight = height;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_value: string) {
      queueMicrotask(() => this.onload?.());
    }
  }
  vi.stubGlobal("Image", FakeImage);
  Object.assign(URL, { createObjectURL: vi.fn(() => "blob:picked"), revokeObjectURL: vi.fn() });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function toBlob(
    this: HTMLCanvasElement,
    callback: BlobCallback,
    type = "image/png",
    quality?: number,
  ) {
    requested.push(type);
    const produced = type === "image/webp" && !webp ? "image/png" : type;
    // `detail` stands for a busier picture: the same pixels encode to that many times the bytes.
    const size = fakeEncodedSize(produced, this.width * this.height, quality) * detail;
    queueMicrotask(() => callback(new Blob([new Uint8Array(size)], { type: produced })));
  });
  return { fills, requested };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(URL, "createObjectURL");
  Reflect.deleteProperty(URL, "revokeObjectURL");
  setActiveLocale("en");
});

describe("prepareImageAttachment", () => {
  it("keeps WebP where the browser can write it", async () => {
    fakeImagePipeline({ width: 4000, height: 3000, webp: true });
    const prepared = await prepareImageAttachment(new File(["x"], "photo.jpg", { type: "image/jpeg" }));
    expect(prepared.blob.type).toBe("image/webp");
    expect(prepared.blob.size).toBeLessThanOrEqual(ATTACHMENT_MAX_BYTES);
    expect({ width: prepared.width, height: prepared.height }).toEqual({ width: 1280, height: 960 });
  });

  it("shrinks a WebP that no quality gets under the limit at full size", async () => {
    fakeImagePipeline({ width: 4000, height: 3000, webp: true, detail: 2 });
    const prepared = await prepareImageAttachment(new File(["x"], "forest.jpg", { type: "image/jpeg" }));
    expect(prepared.blob.type).toBe("image/webp");
    expect(prepared.blob.size).toBeLessThanOrEqual(ATTACHMENT_MAX_BYTES);
    expect({ width: prepared.width, height: prepared.height }).toEqual({ width: 960, height: 720 });
  });

  it("sends a JPEG under the limit, over white, from a browser that hands back PNG for WebP", async () => {
    const { fills, requested } = fakeImagePipeline({ width: 4000, height: 3000, webp: false });
    const prepared = await prepareImageAttachment(new File(["x"], "photo.jpg", { type: "image/jpeg" }));
    expect(prepared.blob.type).toBe("image/jpeg");
    expect(prepared.blob.size).toBeLessThanOrEqual(ATTACHMENT_MAX_BYTES);
    // No quality fits 1280 x 960 here, so it came from a smaller size, which the upload reports.
    expect(prepared.width).toBeLessThan(1280);
    expect(prepared.width / prepared.height).toBeCloseTo(4 / 3, 1);
    // WebP was asked for once: the PNG answer showed the browser can't write it.
    expect(requested.filter((type) => type === "image/webp")).toHaveLength(1);
    expect(fills).toContain("#ffffff");
  });

  it("says in the reader's language that an image can't be sent", async () => {
    await loadLocale("fr");
    setActiveLocale("fr");
    await expect(prepareImageAttachment(new File(["x"], "drawing.svg", { type: "image/svg+xml" }))).rejects.toThrow(
      "Choisissez une image PNG, JPEG ou WebP.",
    );
  });
});

describe("fitWithin", () => {
  it("never upscales", () => {
    expect(fitWithin(640, 480, 1280)).toEqual({ width: 640, height: 480 });
  });

  it("caps the longest edge preserving aspect ratio", () => {
    expect(fitWithin(4000, 3000, 1280)).toEqual({ width: 1280, height: 960 });
    expect(fitWithin(3000, 4000, 1280)).toEqual({ width: 960, height: 1280 });
  });

  it("never collapses a dimension to zero", () => {
    expect(fitWithin(10_000, 1, 1280).height).toBe(1);
    expect(fitWithin(0, 0, 1280)).toEqual({ width: 1, height: 1 });
  });
});

describe("attachment paths", () => {
  it("maps MIME types to the server's canonical extensions", () => {
    expect(attachmentExtension("image/png")).toBe("png");
    expect(attachmentExtension("image/jpeg")).toBe("jpg");
    expect(attachmentExtension("image/webp")).toBe("webp");
  });

  it("builds the served path from id and MIME type", () => {
    expect(attachmentPath({ id: "att_0123456789abcdef", mimeType: "image/webp" })).toBe(
      "/api/attachments/att_0123456789abcdef.webp",
    );
  });
});

describe("attachment size limits (review 2026-09-25)", () => {
  it("refuses a non-image file over the server's 1 MiB cap before it's read", () => {
    expect(exceededAttachmentLimit({ type: "application/pdf", size: ATTACHMENT_FILE_MAX_BYTES })).toBeUndefined();
    expect(exceededAttachmentLimit({ type: "application/pdf", size: ATTACHMENT_FILE_MAX_BYTES + 1 })).toBe(ATTACHMENT_FILE_MAX_BYTES);
    expect(exceededAttachmentLimit({ type: "", size: 100 * 1024 * 1024 })).toBe(ATTACHMENT_FILE_MAX_BYTES);
  });

  it("lets a normal photo through to the downscaler but refuses an absurd source image", () => {
    expect(exceededAttachmentLimit({ type: "image/jpeg", size: 8 * 1024 * 1024 })).toBeUndefined();
    expect(exceededAttachmentLimit({ type: "image/jpeg", size: ATTACHMENT_IMAGE_SOURCE_MAX_BYTES + 1 })).toBe(
      ATTACHMENT_IMAGE_SOURCE_MAX_BYTES,
    );
  });

  it("formats limits for the error text", () => {
    expect(formatByteLimit(1024 * 1024)).toBe("1 MB");
    expect(formatByteLimit(256 * 1024)).toBe("256 KB");
  });

  it("bytesToBase64 matches btoa for small and multi-chunk inputs", () => {
    const small = new Uint8Array([0, 1, 2, 250, 255]);
    expect(bytesToBase64(small)).toBe(btoa(String.fromCharCode(...small)));
    const big = new Uint8Array(100_000).map((_, index) => index % 256);
    let reference = "";
    for (const byte of big) {
      reference += String.fromCharCode(byte);
    }
    expect(bytesToBase64(big)).toBe(btoa(reference));
    expect(bytesToBase64(new Uint8Array())).toBe("");
  });
});

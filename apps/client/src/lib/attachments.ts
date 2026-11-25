import type { AvatarImageMimeType, MessageAttachment } from "@loam/schema";

import { t } from "../i18n";
import { encodeCanvasUnderLimit, type EncodingAttempt } from "./image-encoding";

/** Longest edge an attachment is downscaled to before upload (like the avatar editor's 256px). */
export const ATTACHMENT_MAX_DIMENSION = 1280;
/** The server rejects attachment binaries larger than this. */
export const ATTACHMENT_MAX_BYTES = 256 * 1024;
/** Most images a message may carry (mirrors the schema cap). */
export const ATTACHMENT_MAX_COUNT = 4;
/** The server's cap for a non-image file attachment (mirrors `attachmentFileMaxBytes` in the server's
 * media.ts) — sent as-is, so the picked file itself must fit. */
export const ATTACHMENT_FILE_MAX_BYTES = 1024 * 1024;
/** Largest source image the on-device downscaler will even try to decode. The upload is re-encoded under
 * {@link ATTACHMENT_MAX_BYTES} anyway; this only stops a huge pick from stalling the tab while it decodes. */
export const ATTACHMENT_IMAGE_SOURCE_MAX_BYTES = 50 * 1024 * 1024;

/**
 * The size limit a picked file breaks, or `undefined` when it may be read and uploaded. Checked BEFORE
 * reading the file: reading a huge pick whole and base64-encoding it would hang the tab, only for the
 * server to refuse it.
 */
export function exceededAttachmentLimit(file: Pick<File, "size" | "type">): number | undefined {
  const limit = file.type.startsWith("image/") ? ATTACHMENT_IMAGE_SOURCE_MAX_BYTES : ATTACHMENT_FILE_MAX_BYTES;
  return file.size > limit ? limit : undefined;
}

/** A byte limit as short human text (`256 KB`, `1 MB`) for an error message. */
export function formatByteLimit(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MB` : `${Math.round(bytes / 1024)} KB`;
}

/** Base64-encode bytes in fixed-size chunks — `String.fromCharCode` per byte (the old loop) is quadratic
 * string building; a chunked `apply` is linear and stays under the engine's argument-count limit. */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    parts.push(String.fromCharCode.apply(null, Array.from(bytes.subarray(offset, offset + CHUNK))));
  }
  return btoa(parts.join(""));
}

/**
 * Scale a width/height pair to fit within `max` on its longest edge, preserving aspect ratio and
 * never upscaling.
 */
export function fitWithin(width: number, height: number, max: number): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height, 1));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** The canonical file extension an attachment is served under (mirrors the server's mapping). */
export function attachmentExtension(mimeType: AvatarImageMimeType): string {
  if (mimeType === "image/png") {
    return "png";
  }

  if (mimeType === "image/jpeg") {
    return "jpg";
  }

  return "webp";
}

/** Whether an attachment is an inline-renderable image (vs a download-only file). */
export function isImageAttachment(attachment: Pick<MessageAttachment, "mimeType">): boolean {
  return (
    attachment.mimeType === "image/png" ||
    attachment.mimeType === "image/jpeg" ||
    attachment.mimeType === "image/webp"
  );
}

/** Server path an attachment is served from (images keep their extension; files use the generic `.bin`). */
export function attachmentPath(attachment: MessageAttachment): string {
  const extension = isImageAttachment(attachment)
    ? attachmentExtension(attachment.mimeType as AvatarImageMimeType)
    : "bin";
  return `/api/attachments/${attachment.id}.${extension}`;
}

export type PreparedAttachment = {
  blob: Blob;
  width: number;
  height: number;
};

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(t("composer.imageUnreadable")));
    image.src = url;
  });
}

/** WebP at descending qualities, then PNG, then WebP at smaller sizes (a very detailed photo), while the
 *  browser writes WebP. */
const WEBP_ATTEMPTS: EncodingAttempt[] = [
  { type: "image/webp", quality: 0.82 },
  { type: "image/webp", quality: 0.72 },
  { type: "image/webp", quality: 0.6 },
  { type: "image/png" },
  { type: "image/webp", quality: 0.6, scale: 0.75 },
  { type: "image/webp", quality: 0.6, scale: 0.5 },
];

/** JPEG at descending qualities, then at smaller sizes, where it can't (Safari, every iOS browser). */
const JPEG_ATTEMPTS: EncodingAttempt[] = [
  { type: "image/jpeg", quality: 0.82 },
  { type: "image/jpeg", quality: 0.72 },
  { type: "image/jpeg", quality: 0.6 },
  { type: "image/jpeg", quality: 0.6, scale: 0.75 },
  { type: "image/jpeg", quality: 0.6, scale: 0.5 },
];

/**
 * Downscale an image file on-device — like the avatar editor, the original never leaves the
 * browser. Longest edge capped at {@link ATTACHMENT_MAX_DIMENSION}, re-encoded to webp (png
 * fallback), or to JPEG where the browser can't write WebP, under the server's {@link ATTACHMENT_MAX_BYTES}
 * cap. The upload sends the blob's own type, and `width`/`height` are the size it was encoded at.
 */
export async function prepareImageAttachment(file: File): Promise<PreparedAttachment> {
  if (!file.type.startsWith("image/") || file.type === "image/svg+xml") {
    throw new Error(t("composer.imageType"));
  }

  const url = URL.createObjectURL(file);

  try {
    const image = await loadImage(url);
    const { width, height } = fitWithin(image.naturalWidth, image.naturalHeight, ATTACHMENT_MAX_DIMENSION);
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");

    if (!context) {
      throw new Error(t("composer.imageProcessFailed"));
    }

    const encoded = await encodeCanvasUnderLimit(canvas, context, {
      width,
      height,
      maxBytes: ATTACHMENT_MAX_BYTES,
      paint: (_canvas, drawWidth, drawHeight) => context.drawImage(image, 0, 0, drawWidth, drawHeight),
      attempts: WEBP_ATTEMPTS,
      withoutWebp: JPEG_ATTEMPTS,
    });

    if (!encoded) {
      throw new Error(t("composer.imageTooLarge"));
    }

    return encoded;
  } finally {
    URL.revokeObjectURL(url);
  }
}

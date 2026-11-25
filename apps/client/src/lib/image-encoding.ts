/**
 * Re-encoding a picture on a canvas until it fits an upload cap. WebP is the first choice, but Safari (and so
 * every browser on iOS) can't write it: asked for `image/webp`, `toBlob` hands back a PNG, which for a camera
 * photo is far over any cap. So a result only counts when it is the type asked for, and once the browser
 * answers WebP with something else the call stops asking for WebP and runs its fallback list instead.
 */

/** The picture types the node accepts for attachments and avatars. */
export type EncodedImageType = "image/webp" | "image/jpeg" | "image/png";

/** One encoding to try. */
export interface EncodingAttempt {
  type: EncodedImageType;
  /** Quality for the lossy types (0 to 1); PNG ignores it. */
  quality?: number;
  /** Fraction of the full size to draw at, 1 when absent. */
  scale?: number;
}

/** A picture that fits, with the size it was drawn at. */
export interface EncodedImage {
  blob: Blob;
  width: number;
  height: number;
}

export interface EncodeOptions {
  /** Full size of the picture. */
  width: number;
  height: number;
  maxBytes: number;
  /** Draws the picture onto the canvas, already sized to `width` x `height` and cleared. */
  paint: (canvas: HTMLCanvasElement, width: number, height: number) => void;
  /** Tried in order while the browser writes WebP. */
  attempts: EncodingAttempt[];
  /** Tried in order instead, once the browser shows it can't write WebP. */
  withoutWebp: EncodingAttempt[];
}

/** JPEG has no transparency: painted under the picture so see-through parts come out white, not black. */
const JPEG_BACKGROUND = "#ffffff";

/** `canvas.toBlob` as a promise. */
function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * The first attempt whose result is the type asked for and fits `maxBytes`, or `undefined` when none does.
 * Each attempt repaints `canvas` at its own size.
 */
export async function encodeCanvasUnderLimit(
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  options: EncodeOptions,
): Promise<EncodedImage | undefined> {
  let list = options.attempts;
  for (let index = 0; index < list.length; index += 1) {
    const attempt = list[index]!;
    const scale = attempt.scale ?? 1;
    const width = Math.max(1, Math.round(options.width * scale));
    const height = Math.max(1, Math.round(options.height * scale));
    // Setting the size clears the canvas.
    canvas.width = width;
    canvas.height = height;
    if (attempt.type === "image/jpeg") {
      context.fillStyle = JPEG_BACKGROUND;
      context.fillRect(0, 0, width, height);
    }
    options.paint(canvas, width, height);

    const blob = await canvasBlob(canvas, attempt.type, attempt.quality);
    // No blob at all for WebP counts as "can't write it" too.
    if ((!blob || blob.type !== attempt.type) && attempt.type === "image/webp" && list !== options.withoutWebp) {
      list = options.withoutWebp;
      index = -1;
      continue;
    }
    if (blob && blob.type === attempt.type && blob.size <= options.maxBytes) {
      return { blob, width, height };
    }
  }
  return undefined;
}

import { useMemo } from "preact/hooks";

import type { QRErrorCorrectionLevel } from "@loam/qr";

import { qrSvg } from "../lib/qr";

/**
 * A QR code, black on white in both themes. Hidden from assistive technology: the screens always show the
 * text it carries beside it, which is what a screen reader should read. When the text is too long to
 * encode, `fallback` shows instead.
 */
export function QrCode({
  className = "",
  ecLevel,
  fallback,
  value,
}: {
  className?: string;
  ecLevel?: QRErrorCorrectionLevel;
  fallback?: string;
  value: string;
}) {
  // The SVG is our own encoder's output (fixed markup, the text only shapes the modules), never user HTML.
  const svg = useMemo(() => qrSvg(value, ecLevel), [value, ecLevel]);
  if (!svg) {
    return fallback ? <p className="notice qr-fallback">{fallback}</p> : null;
  }
  return <div aria-hidden="true" className={`qr ${className}`} dangerouslySetInnerHTML={{ __html: svg }} />;
}

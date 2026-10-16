import { encodeQR, renderQRToSvg } from "@loam/qr";
import type { QRErrorCorrectionLevel } from "@loam/qr";

/**
 * A QR code as an SVG string, or "" when the encoder can't fit the text (it caps at version 6). Always black
 * on white whatever the theme (DESIGN.md: QR tiles use fixed colours), because some phone scanners can't
 * read a light-on-dark code. The screens show the text beside every code, so "" degrades to that.
 */
export function qrSvg(value: string | undefined, ecLevel?: QRErrorCorrectionLevel): string {
  if (!value) {
    return "";
  }
  try {
    return renderQRToSvg(encodeQR(value, ecLevel ? { ecLevel } : undefined), { dark: "#000000", light: "#ffffff" });
  } catch {
    return "";
  }
}

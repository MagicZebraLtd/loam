import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import preact from "@preact/preset-vite";
import { defineConfig, type Plugin } from "vite";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const clientStyles = resolve(__dirname, "../client/src/styles");
const clientAssets = resolve(__dirname, "../client/src/assets");

/**
 * The built page's Content-Security-Policy. The host shell loads from file:// and talks only to the main
 * process through its preload bridge: no network, no inline script, no other origin. Added at build time
 * only, because Vite's dev server injects styles as <style> elements, which `style-src 'self'` refuses.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/** Puts {@link CONTENT_SECURITY_POLICY} in the built index.html's head. */
function contentSecurityPolicy(): Plugin {
  return {
    name: "loam:desktop-csp",
    apply: "build",
    transformIndexHtml: () => [
      { tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: CONTENT_SECURITY_POLICY }, injectTo: "head-prepend" },
    ],
  };
}

/**
 * The host shell's renderer (the window with setup, the join QR, People, Settings and Activity). Built to
 * `dist/renderer` and loaded by the main process from file://, so every asset path is relative (`base: './'`).
 * The workspace packages resolve to their sources, as in apps/client, and the client's design tokens and
 * component styles (and the LOAM mark) come straight from apps/client (`@client-styles`, `@client-assets`), so the two never drift.
 */
export default defineConfig({
  root: __dirname,
  base: "./",
  plugins: [preact(), contentSecurityPolicy()],
  build: {
    outDir: resolve(__dirname, "dist/renderer"),
    emptyOutDir: true,
    // Electron 44 ships a current Chromium: no old-WebView floor here (unlike apps/client).
    target: "chrome120",
    cssTarget: "chrome120",
  },
  resolve: {
    alias: {
      "@client-assets": clientAssets,
      "@client-styles": clientStyles,
      "@loam/crypto": resolve(__dirname, "../../packages/crypto/src/index.ts"),
      "@loam/qr": resolve(__dirname, "../../packages/qr/src/index.ts"),
      "@loam/schema": resolve(__dirname, "../../packages/schema/src/index.ts"),
    },
  },
  server: {
    // Plain `vite` for working on the screens in a browser (with the fake bridge): local only.
    host: "127.0.0.1",
    fs: { allow: [__dirname, clientStyles, clientAssets, resolve(__dirname, "../../packages")] },
  },
});

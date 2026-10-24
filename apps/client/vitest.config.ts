import preact from "@preact/preset-vite";
import { defineConfig } from "vitest/config";

// Uses @preact/preset-vite so rendered-component tests (*.test.tsx) transform JSX with Preact's
// runtime and mount real components into jsdom. The plain-TS lib tests (src/lib/*) have no JSX and
// are unaffected. jsdom supplies document/window; fake-indexeddb is imported per-test.
export default defineConfig({
  plugins: [preact()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // Lets Preact 11's after-paint effect cleanups finish before each file's environment is torn down.
    setupFiles: ["src/test-setup.ts"],
  },
});

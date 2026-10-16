import { defineConfig, mergeConfig } from "vitest/config";

import viteConfig from "./vite.config.ts";

/**
 * One runner for the whole app, over the renderer's Vite config (Preact's JSX, the package and
 * `@client-*` aliases). jsdom by default, for the renderer's mounted screens (*.test.tsx) and its pure
 * helpers; the main process's tests (src/main/**) start with a `// @vitest-environment node` header, which
 * overrides this per file.
 */
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: "jsdom",
      include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    },
  }),
);

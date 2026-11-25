import { describe, expect, it } from "vitest";

import manifestText from "../../public/manifest.webmanifest?raw";

// Routes live in the URL fragment, so the installed app opens at the shell itself: a start address with a
// path would send that path in its first request for nothing.
describe("web app manifest", () => {
  it("starts the installed app at the shell, inside its own scope", () => {
    const manifest = JSON.parse(manifestText) as { start_url: string; scope: string };
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
  });
});

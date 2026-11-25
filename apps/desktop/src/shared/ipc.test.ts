// @vitest-environment node
import { describe, expect, it } from "vitest";

import { CLIENT_PAGE_PATHS } from "./ipc.js";

describe("CLIENT_PAGE_PATHS", () => {
  it("opens a web client page by its fragment route, so the path the window loads is always /", () => {
    for (const path of Object.values(CLIENT_PAGE_PATHS)) {
      expect(new URL(path, "http://127.0.0.1:3000").pathname).toBe("/");
    }
    expect(CLIENT_PAGE_PATHS.assistant).toBe("/#/admin?section=llm");
  });
});

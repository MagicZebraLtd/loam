// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { en, t } from "./strings";

/** Every renderer source file but this table and the tests, as one string. */
function rendererSources(): string {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter(
    (file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file) && !file.endsWith("strings.ts"),
  );
  return files.map((file) => readFileSync(join(root, file), "utf8")).join("\n");
}

describe("strings", () => {
  it("has no string the screens never use", () => {
    const sources = rendererSources();
    expect(Object.keys(en).filter((key) => !sources.includes(`"${key}"`))).toEqual([]);
  });

  it("has no em-dashes anywhere (house style)", () => {
    for (const [key, value] of Object.entries(en)) {
      expect(value, key).not.toContain("—");
    }
  });

  it("fills placeholders and leaves unknown ones visible", () => {
    expect(t("running.connectedMany", { n: 3 })).toBe("3 phones connected");
    expect(t("display.heading", {})).toBe("Join {name}");
    expect(t("tabs.network")).toBe("Network");
  });

  it("uses British spelling for the words the client spells that way", () => {
    const all = Object.values(en).join(" ");
    expect(all).not.toMatch(/\bcolor\b|\brecognized\b|\borganization\b/i);
  });
});

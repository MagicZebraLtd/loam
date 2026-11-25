import { describe, expect, it } from "vitest";

import {
  DISPLAY_NAME_CACHE_LIMIT,
  displayNameCacheSize,
  englishWordPack,
  generateDisplayName,
  getDisplayNameParts,
  hashString,
} from "./display-name.js";

describe("hashString", () => {
  it("is deterministic and unsigned", () => {
    expect(hashString("jhiFKh88dhiu")).toBe(hashString("jhiFKh88dhiu"));
    expect(hashString("jhiFKh88dhiu") >>> 0).toBe(hashString("jhiFKh88dhiu"));
  });
});

describe("generateDisplayName", () => {
  it("returns a stable dotted three-word display name", () => {
    expect(generateDisplayName("jhiFKh88dhiu")).toBe(generateDisplayName("jhiFKh88dhiu"));
    expect(generateDisplayName("jhiFKh88dhiu")).toMatch(/^[a-z]+\.[a-z]+\.[a-z]+$/);
  });

  it("produces different names for different ids", () => {
    expect(generateDisplayName("jhiFKh88dhiu")).not.toBe(generateDisplayName("Qz1mV0f8eL2k"));
  });

  it("returns words from the configured pack", () => {
    const parts = getDisplayNameParts("abc123+/==", englishWordPack);

    expect(englishWordPack.adjectives).toContain(parts.adjective);
    expect(englishWordPack.materials).toContain(parts.material);
    expect(englishWordPack.creatures).toContain(parts.creature);
  });

  it("supports custom packs for future language sets", () => {
    const customPack = {
      adjectives: ["uno", "dos"],
      materials: ["tres", "cuatro"],
      creatures: ["cinco", "seis"],
    } as const;

    expect(generateDisplayName("seed", customPack)).toMatch(/^(uno|dos)\.(tres|cuatro)\.(cinco|seis)$/);
  });
});

describe("the name cache", () => {
  it("stays bounded however many ids are named, and the same id keeps its name across an emptying", () => {
    const pack = { adjectives: ["red", "blue"], materials: ["clay", "slate"], creatures: ["fox", "owl"] } as const;
    const before = generateDisplayName("user.0000000000000000", pack);

    for (let index = 1; index <= DISPLAY_NAME_CACHE_LIMIT * 2 + 10; index += 1) {
      generateDisplayName(`user.${index.toString(16).padStart(16, "0")}`, pack);
      expect(displayNameCacheSize(pack)).toBeLessThanOrEqual(DISPLAY_NAME_CACHE_LIMIT);
    }

    expect(generateDisplayName("user.0000000000000000", pack)).toBe(before);
  });
});

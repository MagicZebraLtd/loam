import { describe, expect, it } from "vitest";

import { hasInvite, hasKey, linkCodeUrl } from "./link-code";

describe("link code URL", () => {
  it("appends the code to the keyed join URL, dropping an invite", () => {
    expect(linkCodeUrl("http://10.0.0.5:3000/#k=abc_DEF-1&i=inv123", "code0123456789ab")).toBe("http://10.0.0.5:3000/#k=abc_DEF-1&l=code0123456789ab");
  });

  it("refuses a join URL with no key", () => {
    expect(linkCodeUrl("http://10.0.0.5:3000/", "code")).toBeUndefined();
  });

  it("tells whether a join URL carries a key or an invite", () => {
    expect(hasKey("http://h:1/#k=abc")).toBe(true);
    expect(hasKey("http://h:1/")).toBe(false);
    expect(hasInvite("http://h:1/#k=abc&i=xyz")).toBe(true);
    expect(hasInvite("http://h:1/#k=abc")).toBe(false);
  });
});

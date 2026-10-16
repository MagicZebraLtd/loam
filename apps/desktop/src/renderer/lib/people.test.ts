import type { HostUser } from "@loam/schema";
import { describe, expect, it } from "vitest";

import { canMakeAdmin, nameKey, sharedNames, shortId } from "./people";

function user(overrides: Partial<HostUser>): HostUser {
  return { id: "user.0000000000000000", displayName: "x", isAdmin: false, online: false, pending: false, banned: false, createdAt: 0, ...overrides };
}

describe("people helpers", () => {
  it("treats names that look alike as the same", () => {
    expect(nameKey("  Sam  ")).toBe(nameKey("sam"));
    expect(nameKey("Sa​m")).toBe(nameKey("Sam"));
    expect(nameKey("Ｓam")).toBe(nameKey("Sam"));
    expect(sharedNames([user({ displayName: "Sam" }), user({ displayName: "sam " }), user({ displayName: "Alex" })])).toEqual(new Set(["sam"]));
  });

  it("shows the end of an id", () => {
    expect(shortId("user.0123456789abcdef")).toBe("abcdef");
  });

  it("offers Make admin to everyone but admins and banned people", () => {
    expect(canMakeAdmin(user({}))).toBe(true);
    expect(canMakeAdmin(user({ pending: true }))).toBe(true);
    expect(canMakeAdmin(user({ isAdmin: true }))).toBe(false);
    expect(canMakeAdmin(user({ banned: true }))).toBe(false);
  });
});

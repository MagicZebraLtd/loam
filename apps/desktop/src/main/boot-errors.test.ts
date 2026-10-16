// @vitest-environment node
import { describe, expect, it } from "vitest";

import { errorCode, errorDetail, mapBootError } from "./boot-errors.js";

/** An Error with a `.code`, as the server's typed boot errors carry. */
function coded(code: string, message = `failed: ${code}`): Error {
  return Object.assign(new Error(message), { code });
}

describe("mapBootError", () => {
  it("asks for the passphrase again when it didn't open the database", () => {
    expect(mapBootError(coded("db_encryption_unreadable"), "passphrase")).toEqual({ kind: "wrong_passphrase" });
  });

  it("reports a device key that no longer opens the database as locked", () => {
    expect(mapBootError(coded("db_encryption_unreadable"), "persistent")).toMatchObject({
      kind: "failed",
      error: { code: "db_encryption_locked" },
    });
  });

  it.each([
    ["EADDRINUSE", "port_in_use"],
    ["db_encryption_driver_missing", "db_encryption_driver_missing"],
    ["db_encryption_plaintext_unconverted", "db_encryption_locked"],
    ["db_ephemeral_existing_database", "db_unreadable"],
    ["db_ephemeral_marker_unwritable", "db_unreadable"],
    ["db_ephemeral_marker_unremovable", "db_unreadable"],
    ["db_encryption_wipe_resume", "reset_incomplete"],
    ["ENOSPC", "unknown"],
  ])("maps %s to %s", (code, expected) => {
    expect(mapBootError(coded(code), "ephemeral")).toMatchObject({ kind: "failed", error: { code: expected } });
  });

  it("recognises the SQLCipher module missing at require time", () => {
    const missing = new Error("Cannot find module 'better-sqlite3-multiple-ciphers'");
    expect(mapBootError(missing, "persistent")).toMatchObject({ error: { code: "db_encryption_driver_missing" } });
    expect(mapBootError(missing, "off")).toMatchObject({ error: { code: "unknown" } });
  });

  it("keeps the detail short", () => {
    const failure = mapBootError(new Error("x".repeat(2000)), "off");
    expect(failure.kind === "failed" && failure.error.detail!.length).toBe(500);
  });
});

describe("errorCode", () => {
  it("reads only a string code", () => {
    expect(errorCode(coded("X"))).toBe("X");
    expect(errorCode({ code: 5 })).toBeUndefined();
    expect(errorCode("text")).toBeUndefined();
    expect(errorCode(null)).toBeUndefined();
  });

  it("describes anything thrown", () => {
    expect(errorDetail("plain")).toBe("plain");
  });
});

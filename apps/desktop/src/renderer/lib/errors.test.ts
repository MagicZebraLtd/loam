import { describe, expect, it } from "vitest";

import { DESKTOP_ERROR_CODES } from "../../shared/ipc";
import { ERROR_COPY, errorCopy } from "./errors";
import { en } from "./strings";

describe("error copy", () => {
  it("has a title and what-to-do for every DesktopErrorCode, and nothing else", () => {
    expect(Object.keys(ERROR_COPY).sort()).toEqual([...DESKTOP_ERROR_CODES].sort());
    for (const code of DESKTOP_ERROR_CODES) {
      const copy = ERROR_COPY[code];
      expect(en[copy.title], code).toBeTruthy();
      expect(en[copy.body], code).toBeTruthy();
    }
  });

  it("offers a new network where the data can't be opened as it is", () => {
    for (const code of ["db_encryption_driver_missing", "db_encryption_locked", "db_unreadable"] as const) {
      expect(ERROR_COPY[code].newNetwork, code).toBe(true);
    }
    expect(ERROR_COPY.port_in_use.newNetwork).toBe(false);
    expect(ERROR_COPY.client_missing.download).toBe(true);
  });

  it("falls back to unknown for a code it doesn't know", () => {
    expect(errorCopy("something_new")).toBe(ERROR_COPY.unknown);
    expect(errorCopy("toString")).toBe(ERROR_COPY.unknown);
    expect(errorCopy("port_in_use")).toBe(ERROR_COPY.port_in_use);
  });
});

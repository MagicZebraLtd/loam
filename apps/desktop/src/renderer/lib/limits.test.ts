// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { MAX_NODE_NAME as IPC_MAX_NODE_NAME, MAX_PASSPHRASE as IPC_MAX_PASSPHRASE, CopyRequestSchema } from "../../shared/ipc";
import { HOST_ACK_VERSION, MAX_COPY_LENGTH, MAX_NODE_NAME, MAX_PASSPHRASE, needsHostAck } from "./limits";
import { en } from "./strings";

const tuiApp = readFileSync(fileURLToPath(new URL("../../../../../packages/tui/src/app.ts", import.meta.url)), "utf8");

describe("limits", () => {
  it("match the contract's", () => {
    expect(MAX_NODE_NAME).toBe(IPC_MAX_NODE_NAME);
    expect(MAX_PASSPHRASE).toBe(IPC_MAX_PASSPHRASE);
    expect(CopyRequestSchema.safeParse({ text: "x".repeat(MAX_COPY_LENGTH) }).success).toBe(true);
    expect(CopyRequestSchema.safeParse({ text: "x".repeat(MAX_COPY_LENGTH + 1) }).success).toBe(false);
  });

  it("keeps the host note's version and words in step with the TUI's", () => {
    expect(tuiApp).toContain(`export const HOST_ACK_VERSION = ${HOST_ACK_VERSION};`);
    for (const key of ["hostNote.title", "hostNote.stored", "hostNote.reports", "hostNote.child", "hostNote.more"] as const) {
      expect(tuiApp, key).toContain(`"${en[key]}"`);
    }
  });

  it("asks for the note until the current version is acknowledged", () => {
    expect(needsHostAck(undefined)).toBe(true);
    expect(needsHostAck(HOST_ACK_VERSION - 1)).toBe(true);
    expect(needsHostAck(HOST_ACK_VERSION)).toBe(false);
  });
});

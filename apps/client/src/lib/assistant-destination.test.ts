import { type NetworkConfig, type User } from "@loam/schema";
import { describe, expect, it } from "vitest";

import { ApiError } from "./api";
import { isAssistantDestinationChanged, withAssistantDestination } from "./assistant-destination";

const bot: User = { id: "llm.ollama.gemma4", displayName: "Assistant", type: "bot", isAdmin: false, createdAt: 1, ephemeral: false };
const person: User = { id: "user.ada", displayName: "Ada", type: "human", isAdmin: false, createdAt: 1, ephemeral: true };
const config = { assistantDestination: { kind: "host" }, assistantDestinationRevision: "f".repeat(32) } as NetworkConfig;

describe("withAssistantDestination", () => {
  it("adds the revision this screen holds to a DM to the assistant", () => {
    expect(withAssistantDestination({ type: "dm", recipientUserId: bot.id, body: "hi" }, bot, config)).toEqual({
      type: "dm",
      recipientUserId: bot.id,
      body: "hi",
      assistantDestinationRevision: "f".repeat(32),
    });
  });

  it("leaves a DM to a person, to an unknown recipient, or with no revision known as it is", () => {
    const toPerson = { type: "dm" as const, recipientUserId: person.id, body: "hi" };
    expect(withAssistantDestination(toPerson, person, config)).toEqual(toPerson);
    expect(withAssistantDestination(toPerson, undefined, config)).toEqual(toPerson);
    const toBot = { type: "dm" as const, recipientUserId: bot.id, body: "hi" };
    expect(withAssistantDestination(toBot, bot, { ...config, assistantDestinationRevision: undefined })).toEqual(toBot);
    expect(withAssistantDestination(toBot, bot, undefined)).toEqual(toBot);
  });
});

describe("isAssistantDestinationChanged", () => {
  it("recognises only the node's 409 with that code", () => {
    expect(isAssistantDestinationChanged(new ApiError(409, { code: "assistant_destination_changed" }, "x"))).toBe(true);
    expect(isAssistantDestinationChanged(new ApiError(429, { code: "assistant_destination_changed" }, "x"))).toBe(false);
    expect(isAssistantDestinationChanged(new ApiError(409, { code: "message_streaming" }, "x"))).toBe(false);
    expect(isAssistantDestinationChanged(new Error("assistant_destination_changed"))).toBe(false);
  });
});

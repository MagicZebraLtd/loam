import { afterEach, describe, expect, it, vi } from "vitest";

import { acknowledgeAssistantHost, clearAssistantAcks, hasAcknowledgedAssistantHost } from "./assistant-ack";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("the assistant's online-service acknowledgement", () => {
  it("is remembered per service, whatever the hostname's case", () => {
    expect(hasAcknowledgedAssistantHost("openrouter.ai")).toBe(false);
    acknowledgeAssistantHost("OpenRouter.ai");
    expect(localStorage.getItem("loam.assistantAck.openrouter.ai")).toBe("1");
    expect(hasAcknowledgedAssistantHost("openrouter.ai")).toBe(true);
    expect(hasAcknowledgedAssistantHost("api.openai.com")).toBe(false);
  });

  it("is cleared with the cached content, leaving other keys alone", () => {
    acknowledgeAssistantHost("openrouter.ai");
    acknowledgeAssistantHost("api.groq.com");
    localStorage.setItem("loam.theme", "dark");
    clearAssistantAcks();
    expect(hasAcknowledgedAssistantHost("openrouter.ai")).toBe(false);
    expect(hasAcknowledgedAssistantHost("api.groq.com")).toBe(false);
    expect(localStorage.getItem("loam.theme")).toBe("dark");
  });

  it("treats storage that throws as not acknowledged, and never throws itself", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "key").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => acknowledgeAssistantHost("openrouter.ai")).not.toThrow();
    expect(hasAcknowledgedAssistantHost("openrouter.ai")).toBe(false);
    expect(() => clearAssistantAcks()).not.toThrow();
  });
});

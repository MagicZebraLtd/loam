import { ChannelSchema, MessageSchema, UserSchema, type Channel, type Message, type User } from "@loam/schema";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseDmInboxEntries, parseListEntries } from "./list-payloads";

const channel: Channel = {
  id: "general",
  name: "general",
  visibility: "public",
  allowPosting: "everyone",
  allowReplies: true,
  discoverable: true,
  createdAt: 1,
};
const user: User = { id: "user.a", displayName: "A", type: "human", isAdmin: false, createdAt: 1, ephemeral: true };
const message = { id: "m1", type: "channelPost", channelId: "general", authorId: "user.a", body: "hello", createdAt: 1 } as Message;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseListEntries", () => {
  it.each([
    ["channel", ChannelSchema, channel, { ...channel, id: "bad", name: "" }],
    ["user", UserSchema, user, { ...user, id: "user.bad", type: "robot" }],
    ["message", MessageSchema, message, { ...message, id: "m.bad", type: "nonsense" }],
  ] as const)("keeps the good %s rows and nothing of a bad one", (listName, schema, good, bad) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const parsed = parseListEntries([good, bad], schema, listName);
    expect(parsed).toEqual([good]);
    expect(JSON.stringify(parsed)).not.toContain(bad.id);
    // One warning, with the count only: never the row itself.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("1 of 2");
    expect(String(warn.mock.calls[0]![0])).not.toContain(bad.id);
  });

  it("says nothing when every row is good", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(parseListEntries([channel], ChannelSchema, "channel")).toEqual([channel]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("treats an answer that is not a list as a failed request", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(() => parseListEntries({ channels: [channel] }, ChannelSchema, "channel")).toThrow();
  });
});

describe("parseDmInboxEntries", () => {
  it("keeps the good conversations and nothing of a bad one", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const good = { userId: "user.a", lastMessageAt: 5, lastAuthorId: "user.a" };
    const parsed = parseDmInboxEntries({ conversations: [good, { userId: "user.bad", lastMessageAt: "soon" }] });
    expect(parsed).toEqual([good]);
  });

  it("throws on an answer with no conversations list", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(() => parseDmInboxEntries(null)).toThrow();
    expect(() => parseDmInboxEntries({})).toThrow();
  });
});

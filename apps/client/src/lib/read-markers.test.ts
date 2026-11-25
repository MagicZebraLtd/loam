import type { Message } from "@loam/schema";
import { describe, expect, it } from "vitest";

import { heldDmPeers, isConversationGone, readMarkersWithout } from "./read-markers";

function dm(id: string, authorId: string, recipientUserId: string): Message {
  return { id, type: "dm", authorId, recipientUserId, body: "hi", createdAt: 1 } as Message;
}

describe("isConversationGone", () => {
  it("judges a channel against the channel list and a DM against the partners, each only when given", () => {
    const live = { channelIds: new Set(["general"]), dmPeerIds: new Set(["user.kept"]) };
    expect(isConversationGone("channel:general", live)).toBe(false);
    expect(isConversationGone("channel:deleted", live)).toBe(true);
    expect(isConversationGone("dm:user.kept", live)).toBe(false);
    expect(isConversationGone("dm:user.gone", live)).toBe(true);
    expect(isConversationGone("dm:user.gone", { channelIds: new Set() })).toBe(false);
    expect(isConversationGone("channel:deleted", { dmPeerIds: new Set() })).toBe(false);
    expect(isConversationGone("other:x", live)).toBe(false);
  });
});

describe("readMarkersWithout", () => {
  it("drops the markers picked and keeps the rest", () => {
    const reads = { "channel:general": 5, "dm:user.gone": 7, "dm:user.kept": 9 };
    expect(readMarkersWithout(reads, (key) => key === "dm:user.gone")).toEqual({ "channel:general": 5, "dm:user.kept": 9 });
  });

  it("returns the same object when nothing goes", () => {
    const reads = { "channel:general": 5 };
    expect(readMarkersWithout(reads, () => false)).toBe(reads);
  });
});

describe("heldDmPeers", () => {
  it("is the inbox plus partners of DMs that arrived after the request began", () => {
    const messages = [dm("old", "user.stale", "user.me"), dm("live", "user.me", "user.new")];
    const peers = heldDmPeers(
      [{ userId: "user.inbox", lastMessageAt: 1, lastAuthorId: "user.inbox" }],
      messages,
      new Set(["old"]),
      "user.me",
    );
    expect([...peers].sort()).toEqual(["user.inbox", "user.new"]);
  });
});

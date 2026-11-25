import type { Channel, Message } from "@loam/schema";
import { describe, expect, it, vi } from "vitest";

import {
  applySearchChange,
  matchesSearchTerm,
  pruneExpiredResults,
  publishSearchChange,
  type SearchChange,
  subscribeSearchChanges,
} from "./search-results";

// The Search screen's copy of its results follows the app: a delete, a moderator's removal, an edit or a lost
// channel reaches it, and retention prunes it by the rule conversations use.

const HOUR = 3_600_000;
const NOW = 10 * HOUR;

const general = { id: "general", name: "general", createdAt: 0 } as Channel;
const quick = { id: "quick", name: "quick", createdAt: 0, messageTtlMs: 10 * 60_000 } as Channel;

function post(id: string, body: string, channelId = "general", ageMs = 0): Message {
  return { id, type: "channelPost", channelId, authorId: "user.a", body, createdAt: NOW - ageMs } as Message;
}

function reply(id: string, parentMessageId: string, body: string, ageMs = 0): Message {
  return { id, type: "channelReply", channelId: "general", parentMessageId, authorId: "user.a", body, createdAt: NOW - ageMs } as Message;
}

function dm(id: string, body: string, ageMs = 0): Message {
  return { id, type: "dm", recipientUserId: "user.b", authorId: "user.a", body, createdAt: NOW - ageMs } as Message;
}

const ids = (messages: Message[]): string[] => messages.map((message) => message.id);

describe("matchesSearchTerm", () => {
  it("matches as the server does: a case-insensitive substring of the body, the term trimmed", () => {
    expect(matchesSearchTerm(post("a", "Meet at the BRIDGE"), "bridge")).toBe(true);
    expect(matchesSearchTerm(post("a", "Meet at the bridge"), "  Bridge ")).toBe(true);
    expect(matchesSearchTerm(post("a", "Meet at the bridge"), "river")).toBe(false);
    const reaction = { id: "r", type: "reaction", targetMessageId: "a", authorId: "user.a", reaction: "👍", createdAt: 1 } as Message;
    expect(matchesSearchTerm(reaction, "")).toBe(false);
  });
});

describe("applySearchChange", () => {
  const results = [post("a", "bridge one"), dm("b", "bridge two"), post("c", "bridge three")];

  it("drops a deleted message's row", () => {
    expect(ids(applySearchChange(results, { kind: "deleted", messageId: "b" }, "bridge"))).toEqual(["a", "c"]);
  });

  it("returns the same array for a delete of a message it doesn't hold", () => {
    expect(applySearchChange(results, { kind: "deleted", messageId: "zzz" }, "bridge")).toBe(results);
  });

  it("replaces an edited row in place while it still matches", () => {
    const edited = { ...results[1], body: "the BRIDGE at noon" } as Message;
    const next = applySearchChange(results, { kind: "updated", message: edited }, "bridge");
    expect(ids(next)).toEqual(["a", "b", "c"]);
    expect(next[1]).toBe(edited);
    // The input is left as it was.
    expect((results[1] as { body: string }).body).toBe("bridge two");
  });

  it("drops an edited row that no longer matches", () => {
    const edited = { ...results[0], body: "meet at the river" } as Message;
    expect(ids(applySearchChange(results, { kind: "updated", message: edited }, "bridge"))).toEqual(["b", "c"]);
  });

  it("drops a row a moderator removed (the body is blanked)", () => {
    const removed = { ...results[2], body: "", meta: { removedByModerator: true } } as Message;
    expect(ids(applySearchChange(results, { kind: "updated", message: removed }, "bridge"))).toEqual(["a", "b"]);
  });

  it("ignores an update for a message not in the results, even one that matches", () => {
    const fresh = post("new", "bridge four");
    expect(applySearchChange(results, { kind: "updated", message: fresh }, "bridge")).toBe(results);
  });

  it("drops every row in a removed channel and keeps DMs and other channels", () => {
    const mixed = [
      post("a", "x", "general"),
      dm("b", "x"),
      post("c", "x", "secret"),
      { ...reply("d", "c", "x"), channelId: "secret" } as Message,
      post("e", "x", "general"),
    ];
    expect(ids(applySearchChange(mixed, { kind: "channelRemoved", channelId: "secret" }, "x"))).toEqual(["a", "b", "e"]);
    expect(applySearchChange(mixed, { kind: "channelRemoved", channelId: "elsewhere" }, "x")).toBe(mixed);
  });
});

describe("pruneExpiredResults", () => {
  const results = [post("old", "x", "general", 2 * HOUR), post("recent", "x", "general", 30 * 60_000), dm("oldDm", "x", 2 * HOUR)];

  it("drops results past the node TTL, DMs included", () => {
    expect(ids(pruneExpiredResults(results, [general], HOUR, NOW))).toEqual(["recent"]);
  });

  it("applies a channel's TTL when it is shorter than the node's", () => {
    const inQuick = [post("q1", "x", "quick", 20 * 60_000), post("q2", "x", "quick", 5 * 60_000), post("g", "x", "general", 20 * 60_000)];
    expect(ids(pruneExpiredResults(inQuick, [general, quick], HOUR, NOW))).toEqual(["q2", "g"]);
  });

  it("keeps everything when there is no retention", () => {
    expect(pruneExpiredResults(results, [general], undefined, NOW)).toBe(results);
  });

  it("takes `now` from the newest message held as well as the clock, as conversations do", () => {
    // The device clock runs two hours slow; the app holds a message the node stamped at the real time.
    const slowClock = NOW - 2 * HOUR;
    const aging = [post("aging", "x", "general", 90 * 60_000)];
    expect(ids(pruneExpiredResults(aging, [general], HOUR, slowClock))).toEqual(["aging"]);
    expect(pruneExpiredResults(aging, [general], HOUR, slowClock, [post("seen", "y")])).toEqual([]);
  });

  it("drops a reply whose expired post the app holds, as the node's cascade does", () => {
    const parent = post("parent", "y", "general", 2 * HOUR);
    const child = reply("child", "parent", "x", 10 * 60_000);
    expect(ids(pruneExpiredResults([child], [general], HOUR, NOW))).toEqual(["child"]);
    expect(pruneExpiredResults([child], [general], HOUR, NOW, [parent])).toEqual([]);
  });
});

describe("publishSearchChange / subscribeSearchChanges", () => {
  const change: SearchChange = { kind: "deleted", messageId: "a" };

  it("delivers to every listener until it unsubscribes", () => {
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = subscribeSearchChanges(first);
    const stopSecond = subscribeSearchChanges(second);

    publishSearchChange(change);
    stopFirst();
    publishSearchChange(change);
    stopSecond();
    publishSearchChange(change);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledWith(change);
  });

  it("carries on past a listener that throws", () => {
    const after = vi.fn();
    const stopThrower = subscribeSearchChanges(() => {
      throw new Error("boom");
    });
    const stopAfter = subscribeSearchChanges(after);

    expect(() => publishSearchChange(change)).not.toThrow();
    expect(after).toHaveBeenCalledWith(change);
    stopThrower();
    stopAfter();
  });
});

import type { Channel, Message } from "@loam/schema";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { destroyDatabase, getAllRecords, resetLocalStoreForTests } from "./local-store";
import { cachedRetentionTtl, expiredMessageIds, persistRetentionTtl, retentionTtlFor } from "./retention";

// Client-side retention (review 2026-11-07 F-030): a device that was away when the node's reaper ran must
// still drop what has expired, by the node TTL and each channel's own shorter one.

const HOUR = 3_600_000;
const NOW = 10 * HOUR;

const general: Channel = { id: "general", name: "general", createdAt: 0 } as Channel;
const quick: Channel = { id: "quick", name: "quick", createdAt: 0, messageTtlMs: 10 * 60_000 } as Channel;
const slow: Channel = { id: "slow", name: "slow", createdAt: 0, messageTtlMs: 5 * HOUR } as Channel;

function post(id: string, channelId: string, ageMs: number): Message {
  return { id, type: "channelPost", channelId, authorId: "user.a", body: id, createdAt: NOW - ageMs } as Message;
}

function reply(id: string, parentMessageId: string, ageMs: number): Message {
  return { id, type: "channelReply", channelId: "general", parentMessageId, authorId: "user.a", body: id, createdAt: NOW - ageMs } as Message;
}

function dm(id: string, ageMs: number): Message {
  return { id, type: "dm", recipientId: "user.b", authorId: "user.a", body: id, createdAt: NOW - ageMs } as Message;
}

function reaction(id: string, targetMessageId: string, ageMs: number): Message {
  return { id, type: "reaction", targetMessageId, emoji: "👍", authorId: "user.a", createdAt: NOW - ageMs } as Message;
}

describe("retentionTtlFor", () => {
  it("lets a channel TTL only shorten the node's, stand alone without one, and leaves DMs on the node's", () => {
    const channels = new Map([general, quick, slow].map((channel) => [channel.id, channel]));
    expect(retentionTtlFor(post("a", "general", 0), channels, HOUR)).toBe(HOUR);
    expect(retentionTtlFor(post("a", "quick", 0), channels, HOUR)).toBe(10 * 60_000);
    expect(retentionTtlFor(post("a", "slow", 0), channels, HOUR)).toBe(HOUR);
    expect(retentionTtlFor(post("a", "slow", 0), channels, undefined)).toBe(5 * HOUR);
    expect(retentionTtlFor(post("a", "general", 0), channels, undefined)).toBeUndefined();
    expect(retentionTtlFor(dm("d", 0), channels, HOUR)).toBe(HOUR);
    expect(retentionTtlFor(dm("d", 0), channels, 0)).toBeUndefined();
  });
});

describe("expiredMessageIds", () => {
  it("finds what is past its TTL, with the replies under an expired post and the reactions on it", () => {
    const messages = [
      post("old", "general", 2 * HOUR),
      reply("old.reply", "old", 10 * 60_000),
      reaction("old.like", "old", 60_000),
      post("fresh", "general", 30 * 60_000),
      post("quick.old", "quick", 20 * 60_000),
      dm("dm.old", 3 * HOUR),
      dm("dm.fresh", 60_000),
    ];
    expect(expiredMessageIds(messages, [general, quick], HOUR, NOW)).toEqual(
      new Set(["old", "old.reply", "old.like", "quick.old", "dm.old"]),
    );
  });

  it("keeps everything when the node keeps messages and no channel has a TTL", () => {
    expect(expiredMessageIds([post("old", "general", 100 * HOUR), dm("d", 100 * HOUR)], [general], undefined, NOW).size).toBe(0);
  });

  it("spares a reply still streaming", () => {
    const streaming = { ...dm("bot", 2 * HOUR), meta: { streaming: true } } as Message;
    expect(expiredMessageIds([streaming], [], HOUR, NOW).size).toBe(0);
  });

  it("goes by the newest server stamp it holds when this device's clock is behind", () => {
    const messages = [post("old", "general", 2 * HOUR), post("latest", "general", 0)];
    // The device thinks it is three hours earlier than the node: the node's own stamp still dates "old".
    expect(expiredMessageIds(messages, [general], HOUR, NOW - 3 * HOUR)).toEqual(new Set(["old"]));
  });
});

describe("the remembered node TTL", () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    resetLocalStoreForTests();
  });

  afterEach(async () => {
    await destroyDatabase().catch(() => undefined);
    resetLocalStoreForTests();
  });

  it("round-trips through the local store, and a cleared TTL reads as none", async () => {
    await persistRetentionTtl(HOUR);
    expect(cachedRetentionTtl(await getAllRecords<{ id: string }>("sync"))).toBe(HOUR);
    await persistRetentionTtl(undefined);
    expect(cachedRetentionTtl(await getAllRecords<{ id: string }>("sync"))).toBeUndefined();
  });
});

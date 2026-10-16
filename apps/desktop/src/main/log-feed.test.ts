// @vitest-environment node
import { clean, createLogBook, type LogEntry } from "@loam/tui";
import { describe, expect, it } from "vitest";

import { createLogFeed } from "./log-feed.js";

describe("createLogFeed", () => {
  it("pushes each new entry once, cleaned", () => {
    const feed = createLogFeed(createLogBook(() => 1000), clean);
    const pushed: LogEntry[] = [];
    feed.setListener((entry) => pushed.push(entry));
    feed.write(`${JSON.stringify({ level: 40, time: 1, msg: "name\u001b[31m Bob‮" })}\n`);
    feed.note("info", "launcher line");
    expect(pushed).toEqual([
      expect.objectContaining({ kind: "message", level: "warn", text: "name[31m Bob" }),
      expect.objectContaining({ kind: "message", level: "info", text: "launcher line" }),
    ]);
    expect(feed.entries()).toHaveLength(2);
  });

  it("joins a request pair into one push", () => {
    const feed = createLogFeed(createLogBook(() => 1000), clean);
    const pushed: LogEntry[] = [];
    feed.setListener((entry) => pushed.push(entry));
    feed.write(`${JSON.stringify({ level: 30, reqId: "r1", req: { method: "GET", url: "/api/health" }, msg: "incoming request" })}\n`);
    expect(pushed).toHaveLength(0);
    feed.write(`${JSON.stringify({ level: 30, reqId: "r1", res: { statusCode: 200 }, responseTime: 2, msg: "request completed" })}\n`);
    expect(pushed).toEqual([expect.objectContaining({ kind: "request", method: "GET", url: "/api/health", status: 200 })]);
  });

  it("forgets everything on clear, says so, and keeps what comes after", () => {
    const feed = createLogFeed(createLogBook(() => 1000), clean);
    const pushed: string[] = [];
    let clears = 0;
    feed.setListener((entry) => pushed.push(entry.kind === "message" ? entry.text : ""));
    feed.setClearListener(() => {
      clears += 1;
    });
    feed.note("info", "before");
    feed.clear();
    expect(clears).toBe(1);
    expect(feed.entries()).toEqual([]);
    feed.note("info", "after");
    expect(pushed).toEqual(["before", "after"]);
    expect(feed.entries().map((entry) => (entry.kind === "message" ? entry.text : ""))).toEqual(["after"]);
  });

  it("keeps pushing once the book is full", () => {
    const feed = createLogFeed(createLogBook(() => 1000, 2), clean);
    const pushed: string[] = [];
    feed.setListener((entry) => pushed.push(entry.kind === "message" ? entry.text : ""));
    for (const text of ["a", "b", "c", "d"]) {
      feed.note("info", text);
    }
    expect(pushed).toEqual(["a", "b", "c", "d"]);
  });
});

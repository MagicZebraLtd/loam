import type { LogEntry } from "@loam/tui";
import { describe, expect, it } from "vitest";

import { appendEntry, copyableLog, entryLevel, entryText, isProblem, LOG_KEEP } from "./log-format";

const request: LogEntry = { kind: "request", time: 0, method: "GET", url: "/api/health", status: 200, ms: 3.25 };
const slow: LogEntry = { kind: "request", time: 0, method: "POST", url: "/api/x", status: 503, ms: 120.4 };
const warning: LogEntry = { kind: "message", time: 0, level: "warn", text: "careful" };

describe("log format", () => {
  it("writes requests as METHOD url → status ms and messages as their text", () => {
    expect(entryText(request)).toBe("GET /api/health → 200 3.3 ms");
    expect(entryText(slow)).toBe("POST /api/x → 503 120 ms");
    expect(entryText(warning)).toBe("careful");
  });

  it("levels requests by status and flags problems", () => {
    expect(entryLevel(request)).toBe("info");
    expect(entryLevel(slow)).toBe("error");
    expect(isProblem(request)).toBe(false);
    expect(isProblem(slow)).toBe(true);
    expect(isProblem(warning)).toBe(true);
  });

  it("copies the newest lines that fit", () => {
    const entries = Array.from({ length: 300 }, (_, index): LogEntry => ({ kind: "message", time: 0, level: "info", text: `line ${index}` }));
    const { text, count } = copyableLog(entries, 200);
    expect(text.length).toBeLessThanOrEqual(200);
    expect(count).toBeGreaterThan(0);
    expect(text.endsWith("line 299")).toBe(true);
    expect(copyableLog([{ kind: "message", time: 0, level: "info", text: "x".repeat(500) }], 100).text).toHaveLength(100);
  });

  it("keeps at most LOG_KEEP entries", () => {
    let entries: LogEntry[] = [];
    for (let index = 0; index < LOG_KEEP + 5; index += 1) {
      entries = appendEntry(entries, { ...warning, text: String(index) });
    }
    expect(entries).toHaveLength(LOG_KEEP);
    expect(entries[0]).toMatchObject({ text: "5" });
  });
});

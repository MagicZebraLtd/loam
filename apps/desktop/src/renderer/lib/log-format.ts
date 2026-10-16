/** The Activity screen's lines, as text (for the list and for Copy). */
import type { LogEntry } from "@loam/tui";

import { clock } from "./format";
import { MAX_COPY_LENGTH } from "./limits";

/** Entries the screen keeps (the main process caps its own book at the same size). */
export const LOG_KEEP = 1_000;

/** A request that failed, or a warning or error (the TUI's "problems only"). */
export function isProblem(entry: LogEntry): boolean {
  return entry.kind === "request" ? entry.status >= 400 : entry.level === "warn" || entry.level === "error";
}

/** A request's duration: one decimal under 10 ms, else whole milliseconds. */
function duration(ms: number): string {
  return ms < 10 ? `${ms.toFixed(1)} ms` : `${Math.round(ms)} ms`;
}

/** What an entry says, without its time: "METHOD url → status ms" for a request, the text for a message. */
export function entryText(entry: LogEntry): string {
  if (entry.kind === "request") {
    return `${entry.method} ${entry.url} → ${entry.status} ${duration(entry.ms)}`;
  }
  return entry.text;
}

/** An entry's level label: a message's own level, a request's from its status. */
export function entryLevel(entry: LogEntry): "error" | "warn" | "info" | "debug" {
  if (entry.kind === "message") {
    return entry.level;
  }
  return entry.status >= 500 ? "error" : entry.status >= 400 ? "warn" : "info";
}

/** One entry as a line of plain text: time, level, then what it says. */
export function entryLine(entry: LogEntry): string {
  return `${clock(entry.time)}  ${entryLevel(entry).toUpperCase().padEnd(5)}  ${entryText(entry)}`;
}

/**
 * The newest lines that fit in one copy (the bridge refuses more than {@link MAX_COPY_LENGTH} characters),
 * oldest first, and how many of them there are.
 */
export function copyableLog(entries: readonly LogEntry[], limit = MAX_COPY_LENGTH): { text: string; count: number } {
  const lines: string[] = [];
  let length = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const line = entryLine(entries[index]!);
    const added = line.length + (lines.length ? 1 : 0);
    if (length + added > limit) {
      // A single line longer than the whole allowance is cut rather than leaving nothing to copy.
      if (!lines.length) {
        lines.push(line.slice(0, limit));
      }
      break;
    }
    lines.push(line);
    length += added;
  }
  lines.reverse();
  return { text: lines.join("\n"), count: lines.length };
}

/** Add an entry, keeping at most {@link LOG_KEEP}. */
export function appendEntry(entries: readonly LogEntry[], entry: LogEntry): LogEntry[] {
  const next = [...entries, entry];
  return next.length > LOG_KEEP ? next.slice(next.length - LOG_KEEP) : next;
}

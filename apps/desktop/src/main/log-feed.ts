/**
 * The node's log for the Activity screen: the terminal UI's in-memory log book (`createLogBook` from @loam/tui,
 * capped, never written to disk) plus a push of every new entry to the host window. Every text field in an
 * entry can carry what someone else typed (a display name in a warning, a request path), so each one goes
 * through `clean()` before it leaves the main process.
 */
import type { LogBook, LogEntry } from "@loam/tui";

/** A log line's level (@loam/tui doesn't export its own name for it). */
export type LogLevel = Extract<LogEntry, { kind: "message" }>["level"];

export type LogFeed = {
  /** The server's raw log output (its `logStream`). */
  write(chunk: string): void;
  /** A line from the launcher itself. */
  note(level: LogLevel, text: string): void;
  /** Everything kept so far, oldest first, cleaned. */
  entries(): LogEntry[];
  /** Hear about every new entry (cleaned). One listener: the host window. */
  setListener(listener: ((entry: LogEntry) => void) | undefined): void;
  /**
   * Forget everything kept, and say so to the clear listener. An Emergency Reset that finished, or a network
   * being discarded: its log of who connected and what they asked for belongs to it, as in the terminal UI.
   * Entries written afterwards are kept and pushed as before.
   */
  clear(): void;
  /** Hear about every clear. One listener: the host window. */
  setClearListener(listener: (() => void) | undefined): void;
};

/** `entry` with every text field passed through `clean`. Pure. */
export function cleanEntry(entry: LogEntry, clean: (text: string) => string): LogEntry {
  if (entry.kind === "message") {
    return { ...entry, text: clean(entry.text) };
  }
  return {
    ...entry,
    method: clean(entry.method),
    url: clean(entry.url),
    ...(entry.remote !== undefined ? { remote: clean(entry.remote) } : {}),
  };
}

export function createLogFeed(book: LogBook, clean: (text: string) => string): LogFeed {
  let listener: ((entry: LogEntry) => void) | undefined;
  let clearListener: (() => void) | undefined;
  let lastSeen: LogEntry | undefined;

  /** Hand the listener whatever the book gained since the last look (a request pair lands as one entry). */
  function flush(): void {
    const all = book.entries();
    const from = lastSeen === undefined ? 0 : all.lastIndexOf(lastSeen) + 1;
    const fresh = all.slice(from);
    if (fresh.length === 0) {
      return;
    }
    lastSeen = fresh[fresh.length - 1];
    for (const entry of fresh) {
      listener?.(cleanEntry(entry, clean));
    }
  }

  return {
    write(chunk) {
      book.write(chunk);
      flush();
    },
    note(level, text) {
      book.note(level, text);
      flush();
    },
    entries: () => book.entries().map((entry) => cleanEntry(entry, clean)),
    setListener(next) {
      listener = next;
    },
    clear() {
      book.clear();
      lastSeen = undefined;
      clearListener?.();
    },
    setClearListener(next) {
      clearListener = next;
    },
  };
}

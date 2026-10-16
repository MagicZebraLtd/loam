import type { LogEntry } from "@loam/tui";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";

import type { DesktopBridge } from "../../shared/ipc";
import { clock } from "../lib/format";
import { appendEntry, copyableLog, entryLevel, entryText, isProblem, LOG_KEEP } from "../lib/log-format";
import { t } from "../lib/strings";

/**
 * Activity (the TUI's Activity screen): the node's requests and messages as they happen, newest at the
 * bottom, with a problems-only switch and Copy. The log lives in the main process's memory only (never on
 * disk); this screen asks for it on opening and then follows `onLog`. Text from others arrives already
 * cleaned by the main process and is shown as text, never as markup.
 */
export function ActivityScreen({ bridge }: { bridge: DesktopBridge }) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [copied, setCopied] = useState<string>();
  const list = useRef<HTMLOListElement>(null);
  // Follow new lines only while the list is scrolled to the bottom, so reading an older line isn't disturbed.
  const pinned = useRef(true);

  useEffect(() => {
    let cancelled = false;
    // Lines that arrive while the first answer is on its way are kept and added after it.
    const early: LogEntry[] = [];
    let loaded = false;
    const unsubscribe = bridge.onLog((entry) => {
      if (!loaded) {
        early.push(entry);
        return;
      }
      setEntries((current) => appendEntry(current, entry));
    });
    void bridge
      .log()
      .catch(() => [] as LogEntry[])
      .then((initial) => {
        if (cancelled) return;
        loaded = true;
        // Entries cross IPC as copies, so a line in both lists is recognised by its content.
        const seen = new Set(initial.map((entry) => JSON.stringify(entry)));
        setEntries([...initial, ...early.filter((entry) => !seen.has(JSON.stringify(entry)))].slice(-LOG_KEEP));
      });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [bridge]);

  const shown = errorsOnly ? entries.filter(isProblem) : entries;

  useLayoutEffect(() => {
    const element = list.current;
    if (element && pinned.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [shown.length, errorsOnly]);

  function onScroll(): void {
    const element = list.current;
    if (element) {
      pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
    }
  }

  async function copyAll(): Promise<void> {
    const { text, count } = copyableLog(shown);
    try {
      await bridge.copy(text);
    } catch {
      return;
    }
    setCopied(count === shown.length ? t("activity.copiedAll", { n: count }) : t("activity.copiedSome", { n: count }));
  }

  return (
    <main className="screen screen-fill">
      <div className="screen-column activity">
        <div className="activity-head">
          <h1>{t("activity.title")}</h1>
          <label className="check-row">
            <input checked={errorsOnly} onChange={(event) => setErrorsOnly(event.currentTarget.checked)} type="checkbox" />
            <span>{t("activity.errorsOnly")}</span>
          </label>
          <button className="btn btn-secondary btn-sm" disabled={!shown.length} onClick={() => void copyAll()} type="button">
            {t("activity.copy")}
          </button>
          <span aria-live="polite" className="muted">
            {copied}
          </span>
        </div>
        <p className="field-hint">
          {t("activity.tunnelNote")} {t("activity.memoryNote")}
        </p>
        {shown.length ? (
          <ol aria-label={t("activity.logLabel")} className="log" onScroll={onScroll} ref={list} tabIndex={0}>
            {shown.map((entry, index) => {
              const level = entryLevel(entry);
              return (
                <li className={`log-line log-${level}`} key={`${entry.time}-${index}`}>
                  <time className="log-time">{clock(entry.time)}</time>
                  <span className="log-level">{level.toUpperCase()}</span>
                  <span className="log-text">{entryText(entry)}</span>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="muted log-empty">{errorsOnly ? t("activity.emptyProblems") : t("activity.empty")}</p>
        )}
      </div>
    </main>
  );
}

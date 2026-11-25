import type { Channel, Message, User } from "@loam/schema";
import { MessageSchema } from "@loam/schema";
import { generateDisplayName } from "@loam/display-name";
import { useLocation } from "../lib/location";
import { useEffect, useId, useRef, useState } from "preact/hooks";

import { IconSearch } from "../components/icons";
import { ScreenHeader } from "../components/ScreenHeader";
import { SearchResult } from "../components/SearchResult";
import { t } from "../i18n";
import { fetchJson } from "../lib/api";
import { markdownToPlainText } from "../lib/markdown";
import { bodyFor, displayTime } from "../lib/message-format";
import { RETENTION_PRUNE_INTERVAL_MS } from "../lib/retention";
import {
  applySearchChange,
  pruneExpiredResults,
  type SearchChange,
  subscribeSearchChanges,
} from "../lib/search-results";

/**
 * The last term searched in this tab, and who searched it, so coming back from a result (or reopening
 * the screen) shows the same search. It lives here and nowhere else: a term in the address would reach
 * the wire on every reload and sit in the browser's history and caches, so the address stays `/search`.
 * Keyed by user so a term never follows an identity change in the same tab.
 */
let rememberedSearch: { userId: string; term: string } | undefined;

/**
 * A `#/search?q=` term taken off the address and not yet searched, because the app had no session to search
 * with yet. Module memory, since the screen is keyed by the confirmed user id: on a first visit it remounts
 * under that id, after the address has already lost the term. Cleared when the search runs.
 */
let pendingDeepLinkTerm: string | undefined;

/** Forget the remembered search and any deep-link term still waiting (a device wipe, or the start of a different
 * identity). */
export function forgetRememberedSearch(): void {
  rememberedSearch = undefined;
  pendingDeepLinkTerm = undefined;
}

/** The results on screen and the term they were found by (what to highlight, and what an edit must still match). */
type ShownResults = { term: string; rows: Message[] };

/** A search request in flight, with the live changes that arrived while it was out (folded over its answer). */
type SearchRequest = { refresh: boolean; changes: SearchChange[] };

/**
 * Full-text message search over `GET /api/search`. The server scopes results strictly to what this
 * user may read (public channels, their private channels, their own DMs), so the client just
 * renders whatever comes back. Tapping a result jumps to its conversation (or thread).
 *
 * The results stay in step with the app while the screen is open: deletes, edits and lost channels the app
 * publishes (`lib/search-results.ts`) are folded in, retention prunes them by the rule conversations use, and
 * the search on screen runs again after the app resyncs with the node (`resyncCount`), which brings in what was
 * missed while the socket was down.
 */
export function SearchView({
  blockedUserIds,
  channels,
  currentUser,
  heldMessages,
  nodeTtlMs,
  ready,
  resyncCount,
  usersById,
}: {
  blockedUserIds: ReadonlySet<string>;
  channels: Channel[];
  currentUser: User;
  /** The messages the app holds, judged alongside the results for retention (see `pruneExpiredResults`). */
  heldMessages: readonly Message[];
  /** The node's retention, as the app applies it to conversations. */
  nodeTtlMs: number | undefined;
  /** Whether the app has its config from the node, so a search has a session to go out on. The search a
   * person arrives with waits for it; the screen can show before it, after the identity splash gives up. */
  ready: boolean;
  /** The app's count of finished resyncs with the node; a change re-runs the search on screen. */
  resyncCount: number;
  usersById: Map<string, User>;
}) {
  const location = useLocation();
  // A `/#/search?q=…` link (a deep link from elsewhere; an older `/search?q=…` is moved into the fragment by
  // lib/location.tsx) runs that search once; its term comes off the address before the request goes out.
  // Otherwise the search this person last ran here, if any. The route's query is in the fragment, which the
  // start-up readers split on `&`: a search route never takes a parameter named `k`, `a`, `i` or `l`.
  const deepLinkQuery = typeof location.query.q === "string" ? location.query.q.trim() : "";
  const initialQuery =
    deepLinkQuery || pendingDeepLinkTerm || (rememberedSearch?.userId === currentUser.id ? rememberedSearch.term : "");
  const [query, setQuery] = useState(initialQuery);
  const [shown, setShown] = useState<ShownResults>();
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string>();
  const searchInputId = useId();
  const inFlightRef = useRef<SearchRequest | undefined>(undefined);
  // What retention needs, read when a prune runs rather than captured by the closure that runs it.
  const retentionRef = useRef({ channels, heldMessages, nodeTtlMs });
  retentionRef.current = { channels, heldMessages, nodeTtlMs };
  const seenResyncRef = useRef(resyncCount);
  // Whether this mount has run the search it arrived with (or found none to run).
  const arrivalDoneRef = useRef(false);

  /** `rows` less what has passed its retention now. */
  function pruned(rows: Message[]): Message[] {
    const retention = retentionRef.current;
    return pruneExpiredResults(rows, retention.channels, retention.nodeTtlMs, Date.now(), retention.heldMessages);
  }

  /**
   * Search for `text`. A refresh (the search on screen, again after a resync) runs quietly and only when no other
   * request is out; a search the person runs replaces a refresh still in flight. A failed refresh leaves nothing
   * on screen, since what was there may be out of date.
   */
  async function run(text = query, refresh = false): Promise<void> {
    const trimmed = text.trim();

    if (!trimmed || (refresh ? inFlightRef.current : searching)) {
      return;
    }

    const request: SearchRequest = { refresh, changes: [] };
    inFlightRef.current = request;

    if (!refresh) {
      setSearching(true);
      setError(undefined);
      rememberedSearch = { userId: currentUser.id, term: trimmed };
    }

    try {
      const payload = await fetchJson<unknown>(`/api/search?q=${encodeURIComponent(trimmed)}`);

      if (inFlightRef.current !== request) {
        return;
      }

      const rawResults =
        payload && typeof payload === "object" && "results" in payload && Array.isArray(payload.results)
          ? (payload.results as unknown[])
          : [];
      const rows = rawResults.flatMap((item) => {
        const parsed = MessageSchema.safeParse(item);
        return parsed.success ? [parsed.data] : [];
      });
      // A change that arrived while the request was out may postdate its answer: apply them, in order, on top.
      const live = request.changes.reduce((current, change) => applySearchChange(current, change, trimmed), rows);
      setShown({ term: trimmed, rows: pruned(live) });
    } catch (searchError) {
      if (inFlightRef.current !== request) {
        return;
      }

      if (refresh) {
        setShown(undefined);
      }
      setError(searchError instanceof Error ? searchError.message : t("search.error"));
    } finally {
      if (inFlightRef.current === request) {
        inFlightRef.current = undefined;
      }
      // A later search the person started that replaced this one clears the flag when it lands.
      if (!refresh && !inFlightRef.current) {
        setSearching(false);
      }
    }
  }

  // A deep link's term comes off the address at once, so the one request is the only place it goes, and waits
  // in `pendingDeepLinkTerm` until there is a session to search with.
  useEffect(() => {
    if (deepLinkQuery) {
      pendingDeepLinkTerm = deepLinkQuery;
      location.route(location.path, true);
    }
    // Only on arrival; later searches go through the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Opened with a term (a deep link, or a search to come back to): run it once, as soon as the app has its config.
  // Before that a pinned client has no session (the search would fail and never be retried) and any other would
  // send it ahead of its session.
  useEffect(() => {
    if (!ready || arrivalDoneRef.current) {
      return;
    }
    arrivalDoneRef.current = true;
    const term = pendingDeepLinkTerm ?? initialQuery;
    pendingDeepLinkTerm = undefined;
    if (term) {
      void run(term);
    }
    // Only on arrival; later searches go through the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  // The app's deletes, edits and channel removals, folded into the results on screen and kept for the answer
  // of a request still in flight.
  useEffect(
    () =>
      subscribeSearchChanges((change) => {
        inFlightRef.current?.changes.push(change);
        setShown((previous) => {
          if (!previous) {
            return previous;
          }
          const rows = applySearchChange(previous.rows, change, previous.term);
          return rows === previous.rows ? previous : { ...previous, rows };
        });
      }),
    [],
  );

  // Retention, as for conversations: whenever the TTLs may have changed, and on the app's interval.
  useEffect(() => {
    const prune = (): void =>
      setShown((previous) => {
        if (!previous) {
          return previous;
        }
        const rows = pruned(previous.rows);
        return rows === previous.rows ? previous : { ...previous, rows };
      });
    prune();
    const timer = window.setInterval(prune, RETENTION_PRUNE_INTERVAL_MS);
    return () => window.clearInterval(timer);
    // `pruned` reads the latest inputs through `retentionRef`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channels, nodeTtlMs]);

  // The app finished a resync: run the search on screen again, once, so what changed while the socket was down
  // (deletes, edits, lost access) shows. Nothing on screen, or a request already out, needs no second one.
  useEffect(() => {
    if (resyncCount === seenResyncRef.current) {
      return;
    }
    seenResyncRef.current = resyncCount;
    if (shown?.rows.length && !inFlightRef.current) {
      void run(shown.term, true);
    }
    // Only on a new resync; `shown` is read as it is now.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resyncCount]);

  function contextLabel(message: Message): string {
    if (message.type === "channelPost" || message.type === "channelReply") {
      const channel = channels.find((entry) => entry.id === message.channelId);
      return `${channel?.visibility === "private" ? "🔒" : "#"}${channel?.name ?? message.channelId}`;
    }

    if (message.type === "dm") {
      const peerId = message.authorId === currentUser.id ? message.recipientUserId : message.authorId;
      return t("search.dmWith", { name: usersById.get(peerId)?.displayName ?? generateDisplayName(peerId) });
    }

    return "";
  }

  function routeFor(message: Message): string | undefined {
    if (message.type === "channelPost") {
      return `/channel/${encodeURIComponent(message.channelId)}`;
    }

    if (message.type === "channelReply") {
      return `/channel/${encodeURIComponent(message.channelId)}/thread/${encodeURIComponent(message.parentMessageId)}`;
    }

    if (message.type === "dm") {
      const peerId = message.authorId === currentUser.id ? message.recipientUserId : message.authorId;
      return `/dm/${encodeURIComponent(peerId)}`;
    }

    return undefined;
  }

  return (
    <section className="settings-view">
      <ScreenHeader title={t("search.title")} />
      <div className="screen-body">
        <div className="screen-column">
          <form
            className="search-form"
            onSubmit={(event) => {
              event.preventDefault();
              void run();
            }}
            role="search"
          >
            <label className="sr-only" for={searchInputId}>
              {t("sidebar.searchMessages")}
            </label>
            <span className="search-field">
              <IconSearch className="search-field-icon" size={18} />
              <input
                className="input search-input"
                dir="auto"
                disabled={searching}
                enterKeyHint="search"
                id={searchInputId}
                maxLength={200}
                onInput={(event) => setQuery(event.currentTarget.value)}
                placeholder={t("search.placeholder")}
                type="search"
                value={query}
              />
            </span>
            <button className="btn btn-primary" disabled={searching || !query.trim()} type="submit">
              {searching ? t("search.searching") : t("search.button")}
            </button>
          </form>
          {error ? <p className="notice notice-danger">{error}</p> : null}
          {!shown && !error && !searching ? <p className="empty-note">{t("search.hint")}</p> : null}
          {shown && !shown.rows.length ? <p className="empty-note">{t("search.noResults")}</p> : null}
          {shown?.rows.length ? (
            <ul className="search-results">
              {shown.rows.map((message) => {
                const route = routeFor(message);
                const author = usersById.get(message.authorId);
                return (
                  <SearchResult
                    authorName={author?.displayName ?? generateDisplayName(message.authorId)}
                    body={markdownToPlainText(bodyFor(message))}
                    contextLabel={contextLabel(message)}
                    hiddenAsBlocked={message.authorId !== currentUser.id && blockedUserIds.has(message.authorId)}
                    key={message.id}
                    onOpen={() => {
                      if (route) {
                        location.route(route);
                      }
                    }}
                    query={shown.term}
                    time={displayTime(message.createdAt)}
                  />
                );
              })}
            </ul>
          ) : null}
        </div>
      </div>
    </section>
  );
}

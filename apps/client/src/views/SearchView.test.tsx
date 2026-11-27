import type { Channel, Message, User } from "@loam/schema";
import { render } from "preact";
import { LocationProvider } from "../lib/location";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RETENTION_PRUNE_INTERVAL_MS } from "../lib/retention";
import { publishSearchChange } from "../lib/search-results";
import { forgetRememberedSearch, SearchView } from "./SearchView";

// Counts the screen's live subscriptions, so a test can see it let go when it unmounts.
const subscriptions = vi.hoisted(() => ({ active: 0 }));
vi.mock("../lib/search-results", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/search-results")>();
  return {
    ...actual,
    subscribeSearchChanges: (listener: Parameters<typeof actual.subscribeSearchChanges>[0]) => {
      subscriptions.active += 1;
      const stop = actual.subscribeSearchChanges(listener);
      return () => {
        subscriptions.active -= 1;
        stop();
      };
    },
  };
});

// The search term stays out of the address: a deep link's term is replaced before its request goes out,
// a submitted search never touches the address, and the screen remembers the term in memory instead.

const me: User = { id: "user.me", displayName: "Me", type: "human", isAdmin: false, createdAt: 1, ephemeral: true };
const someoneElse: User = { ...me, id: "user.else" };

const mounted: HTMLDivElement[] = [];
/** Each search request the stubbed fetch saw, with what the address bar showed at that moment. */
let requests: { path: string; address: string }[] = [];
/** What the stubbed node answers each search with; a test swaps it to hold a request or change the answer. */
let answer: () => Promise<Response>;

/** The props a test may vary; the rest are fixed. */
type Props = { channels?: Channel[]; nodeTtlMs?: number; ready?: boolean; resyncCount?: number };

function view(user: User, props: Props) {
  return (
    <LocationProvider>
      <SearchView
        blockedUserIds={new Set()}
        channels={props.channels ?? []}
        currentUser={user}
        heldMessages={[]}
        nodeTtlMs={props.nodeTtlMs}
        ready={props.ready ?? true}
        resyncCount={props.resyncCount ?? 0}
        usersById={new Map()}
      />
    </LocationProvider>
  );
}

function mount(user = me, props: Props = {}): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  render(view(user, props), container);
  mounted.push(container);
  return container;
}

/** Render the mounted view again with new props, as the app does when its state changes. */
function rerender(container: HTMLDivElement, props: Props, user = me): void {
  render(view(user, props), container);
}

function searchAnswer(results: Message[]): () => Promise<Response> {
  return async () => new Response(JSON.stringify({ results }), { status: 200 });
}

function unmountAll(): void {
  for (const container of mounted) {
    render(null, container);
    container.remove();
  }
  mounted.length = 0;
}

/** Let effects run, the stubbed fetch resolve, and Preact re-render. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function address(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

/** Type `term` and submit the form, letting Preact render the typed value in between as it would for a person. */
async function submit(host: ParentNode, term: string): Promise<void> {
  const input = host.querySelector<HTMLInputElement>("input[type=search]")!;
  input.value = term;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await flush();
  host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await flush();
}

beforeEach(() => {
  requests = [];
  answer = searchAnswer([]);
  forgetRememberedSearch();
  window.history.replaceState(null, "", "/search");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push({ path: url.slice(url.indexOf("/api/")), address: address() });
      return answer();
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  unmountAll();
  window.history.replaceState(null, "", "/");
});

describe("SearchView", () => {
  it("runs a deep-linked search once, with the term off the address before the request", async () => {
    window.history.replaceState(null, "", "/search?q=secret%20plans");
    const host = mount();
    await flush();

    expect(requests).toEqual([{ path: "/api/search?q=secret%20plans", address: "/#/search" }]);
    expect(address()).toBe("/#/search");
    expect(host.querySelector<HTMLInputElement>("input[type=search]")?.value).toBe("secret plans");
    expect(host.querySelector(".empty-note")?.textContent).toBe("No messages matched.");
  });

  it("runs a deep link in the fragment form (/#/search?q=) once, with the term off the address before the request", async () => {
    window.history.replaceState(null, "", "/#/search?q=secret%20plans");
    const host = mount();
    await flush();

    expect(requests).toEqual([{ path: "/api/search?q=secret%20plans", address: "/#/search" }]);
    expect(address()).toBe("/#/search");
    expect(host.querySelector<HTMLInputElement>("input[type=search]")?.value).toBe("secret plans");
  });

  it("holds a deep link's search until the app has its session, across a remount as the confirmed person", async () => {
    window.history.replaceState(null, "", "/#/search?q=secret%20plans");
    const placeholder = { ...me, id: "user.placeholder" };
    const host = mount(placeholder, { ready: false });
    await flush();
    expect(requests).toEqual([]);
    expect(address()).toBe("/#/search");

    // The node confirms another id: the app remounts the screen under it, now with its config.
    unmountAll();
    const confirmed = mount(me, { ready: false });
    await flush();
    expect(requests).toEqual([]);
    rerender(confirmed, { ready: true });
    await flush();
    expect(requests).toEqual([{ path: "/api/search?q=secret%20plans", address: "/#/search" }]);
    expect(confirmed.querySelector<HTMLInputElement>("input[type=search]")?.value).toBe("secret plans");
    expect(host.isConnected).toBe(false);

    rerender(confirmed, { ready: true, resyncCount: 0 });
    await flush();
    expect(requests).toHaveLength(1);
  });

  it("never puts a submitted search in the address", async () => {
    const host = mount();
    await flush();
    expect(requests).toEqual([]);

    await submit(host, "meeting point");

    expect(requests).toEqual([{ path: "/api/search?q=meeting%20point", address: "/#/search" }]);
    expect(address()).toBe("/#/search");
  });

  it("shows the same search again when the same person comes back to the screen, and no one else's", async () => {
    await submit(mount(), "meeting point");
    unmountAll();

    const again = mount();
    await flush();
    expect(again.querySelector<HTMLInputElement>("input[type=search]")?.value).toBe("meeting point");
    expect(requests.map((request) => request.path)).toEqual(["/api/search?q=meeting%20point", "/api/search?q=meeting%20point"]);
    unmountAll();

    const other = mount(someoneElse);
    await flush();
    expect(other.querySelector<HTMLInputElement>("input[type=search]")?.value).toBe("");
    expect(requests).toHaveLength(2);
  });
});

describe("SearchView keeps its results in step with the app", () => {
  const MINUTE = 60_000;
  const general = { id: "general", name: "general", visibility: "public", createdAt: 1 } as Channel;
  const secret = { id: "secret", name: "secret", visibility: "private", createdAt: 1 } as Channel;

  function post(id: string, body: string, channelId = "general", createdAt = Date.now()): Message {
    return { id, type: "channelPost", channelId, authorId: someoneElse.id, body, createdAt } as Message;
  }

  function dm(id: string, body: string): Message {
    return { id, type: "dm", recipientUserId: me.id, authorId: someoneElse.id, body, createdAt: Date.now() } as Message;
  }

  /** The text of the results on screen ("" when there are none). */
  function shownText(host: ParentNode): string {
    return host.querySelector(".search-results")?.textContent ?? "";
  }

  async function searchFor(term: string, results: Message[], props: Props = {}): Promise<HTMLDivElement> {
    answer = searchAnswer(results);
    const host = mount(me, props);
    await flush();
    await submit(host, term);
    return host;
  }

  it("drops a row when the message is deleted", async () => {
    const host = await searchFor("bridge", [post("m1", "meet at the bridge"), post("m2", "the bridge is closed")]);
    expect(shownText(host)).toContain("meet at the bridge");

    publishSearchChange({ kind: "deleted", messageId: "m1" });
    await flush();

    expect(shownText(host)).not.toContain("meet at the bridge");
    expect(shownText(host)).toContain("the bridge is closed");
  });

  it("shows an edit's new text", async () => {
    const host = await searchFor("bridge", [post("m1", "meet at the bridge")]);

    publishSearchChange({ kind: "updated", message: post("m1", "meet at the bridge at noon") });
    await flush();

    expect(shownText(host)).toContain("meet at the bridge at noon");
  });

  it("drops a row an edit no longer matches, down to the no-results note", async () => {
    const host = await searchFor("bridge", [post("m1", "meet at the bridge")]);

    publishSearchChange({ kind: "updated", message: post("m1", "meet at the river") });
    await flush();

    expect(host.querySelector(".search-results")).toBeNull();
    expect(host.textContent).not.toContain("meet at the");
    expect(host.querySelector(".empty-note")?.textContent).toBe("No messages matched.");
  });

  it("drops the rows of a channel this person lost", async () => {
    const results = [post("m1", "public plan"), post("m2", "secret plan", "secret"), dm("m3", "dm plan")];
    const host = await searchFor("plan", results, { channels: [general, secret] });
    expect(shownText(host)).toContain("secret plan");

    publishSearchChange({ kind: "channelRemoved", channelId: "secret" });
    await flush();

    expect(shownText(host)).not.toContain("secret plan");
    expect(shownText(host)).toContain("public plan");
    expect(shownText(host)).toContain("dm plan");
  });

  it("never shows a message deleted while the search was in flight", async () => {
    let land: (response: Response) => void = () => undefined;
    answer = () => new Promise<Response>((resolve) => (land = resolve));
    const host = mount();
    await flush();
    await submit(host, "bridge");

    publishSearchChange({ kind: "deleted", messageId: "m1" });
    publishSearchChange({ kind: "updated", message: post("m2", "the bridge reopened") });
    land(new Response(JSON.stringify({ results: [post("m1", "meet at the bridge"), post("m2", "the bridge is closed")] })));
    await flush();

    expect(shownText(host)).not.toContain("meet at the bridge");
    expect(shownText(host)).not.toContain("the bridge is closed");
    expect(shownText(host)).toContain("the bridge reopened");
  });

  it("drops a row once retention expires it, on the app's interval", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    try {
      const aging = post("m1", "meet at the bridge", "general", Date.now() - 55 * MINUTE);
      const host = await searchFor("bridge", [aging], { nodeTtlMs: 60 * MINUTE });
      expect(shownText(host)).toContain("meet at the bridge");

      vi.advanceTimersByTime(RETENTION_PRUNE_INTERVAL_MS * 6);
      await flush();

      expect(shownText(host)).not.toContain("meet at the bridge");
    } finally {
      vi.useRealTimers();
    }
  });

  it("prunes when the retention it is given gets shorter", async () => {
    const host = await searchFor("bridge", [post("m1", "meet at the bridge", "general", Date.now() - 30 * MINUTE)], {
      nodeTtlMs: 60 * MINUTE,
    });
    expect(shownText(host)).toContain("meet at the bridge");

    rerender(host, { nodeTtlMs: 10 * MINUTE });
    await flush();

    expect(shownText(host)).not.toContain("meet at the bridge");
  });

  it("prunes results that arrive already past their retention", async () => {
    const expired = post("m1", "meet at the bridge", "general", Date.now() - 120 * MINUTE);
    const host = await searchFor("bridge", [expired, post("m2", "the bridge is closed")], { nodeTtlMs: 60 * MINUTE });

    expect(shownText(host)).not.toContain("meet at the bridge");
    expect(shownText(host)).toContain("the bridge is closed");
  });

  it("runs the search on screen again once per resync and shows the new answer", async () => {
    const host = await searchFor("bridge", [post("m1", "meet at the bridge"), post("m2", "the bridge is closed")]);
    expect(requests).toHaveLength(1);

    // While the socket was down, m1 was deleted and m2 edited.
    answer = searchAnswer([post("m2", "the bridge reopened")]);
    rerender(host, { resyncCount: 1 });
    await flush();

    expect(requests.map((request) => request.path)).toEqual(["/api/search?q=bridge", "/api/search?q=bridge"]);
    expect(shownText(host)).not.toContain("meet at the bridge");
    expect(shownText(host)).toContain("the bridge reopened");

    // Another render with the same count is not another resync.
    rerender(host, { resyncCount: 1, nodeTtlMs: 60 * MINUTE });
    await flush();
    expect(requests).toHaveLength(2);
  });

  it("a resync that lands while a search is out runs the search again once that one has answered", async () => {
    let land: (response: Response) => void = () => undefined;
    answer = () => new Promise<Response>((resolve) => (land = resolve));
    const host = mount();
    await flush();
    await submit(host, "bridge");

    rerender(host, { resyncCount: 1 });
    await flush();
    expect(requests).toHaveLength(1);

    // The answer was written before the resync caught up: m1 has since been deleted, m2 edited.
    answer = searchAnswer([post("m2", "the bridge reopened")]);
    land(new Response(JSON.stringify({ results: [post("m1", "meet at the bridge"), post("m2", "the bridge is closed")] })));
    await flush();
    await flush();

    expect(requests.map((request) => request.path)).toEqual(["/api/search?q=bridge", "/api/search?q=bridge"]);
    expect(shownText(host)).not.toContain("meet at the bridge");
    expect(shownText(host)).toContain("the bridge reopened");
  });

  it("runs nothing on a resync when no results are on screen", async () => {
    const host = mount();
    await flush();

    rerender(host, { resyncCount: 1 });
    await flush();

    expect(requests).toEqual([]);
  });

  it("shows nothing stale when the search after a resync fails", async () => {
    const host = await searchFor("bridge", [post("m1", "meet at the bridge")]);

    answer = async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 });
    rerender(host, { resyncCount: 1 });
    await flush();

    expect(requests).toHaveLength(2);
    expect(host.querySelector(".search-results")).toBeNull();
    expect(host.textContent).not.toContain("meet at the bridge");
    expect(host.querySelector(".notice-danger")).not.toBeNull();
  });

  it("stops listening when it unmounts", async () => {
    // Preact 11 runs an unmounted component's effect cleanups after the next paint (see test-setup.ts). A
    // busy machine can run that later than any fixed wait, so wait for the count itself: first for the
    // previous test's cleanups, then for this one's.
    const noneListening = (): Promise<void> =>
      vi.waitFor(() => expect(subscriptions.active).toBe(0), { timeout: 5000 });
    await noneListening();
    mount();
    await flush();
    expect(subscriptions.active).toBe(1);

    unmountAll();

    await noneListening();
  });
});

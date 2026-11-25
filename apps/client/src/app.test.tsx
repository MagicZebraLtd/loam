import { createTransportIdentity, openTransport, sealTransport, transportServerAccept } from "@loam/crypto";
import { type Channel, MEMBER_RULES_VERSION, type Message, type NetworkConfig, type User } from "@loam/schema";
import { IDBFactory } from "fake-indexeddb";
import { render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./app";
import { captureAdminClaimCode, takeAdminClaimCode } from "./lib/admin-link";
import { captureInviteCode } from "./lib/invite";
import { CONFIRMED_USER_KEY } from "./lib/identity";
import { linkCodePresentAtStartup } from "./lib/link-code-fragment";
import { destroyDatabase, getAllRecords, putRecord, putRecords, resetLocalStoreForTests } from "./lib/local-store";
import { captureJoinKey, resetTransportStateForTests } from "./lib/transport";
import { isWipeTombstoned, setWipeTombstone } from "./lib/wipe";
import { openTunnelRequest, tunnelDescriptorReply } from "./test-support/tunnel";
import { forgetRememberedSearch } from "./views/SearchView";

// App-level boot tests (pre-release review 2026-09-25): mount the real `App` against a stubbed node (fetch +
// WebSocket) and a fresh fake IndexedDB, to check what the boot does with the cache it hydrates.

// Whether the page was opened from a "link another node" QR is module state set by main.tsx; stub it so a test
// can flip it without touching the URL.
vi.mock("./lib/link-code-fragment", () => ({ linkCodePresentAtStartup: vi.fn(() => false) }));

// What every component's `useState` held at each render while `recording` is on, so a test can check what a
// wipe leaves in the page's memory behind the wiped screen (which renders none of it). Off by default.
const stateLog = vi.hoisted(() => ({ recording: false, values: [] as unknown[] }));
vi.mock("preact/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("preact/hooks")>();
  return {
    ...actual,
    useState: ((initial: unknown) => {
      const pair = actual.useState(initial);
      if (stateLog.recording) {
        stateLog.values.push(pair[0]);
      }
      return pair;
    }) as typeof actual.useState,
  };
});

/** The full flag set a real node advertises; the boot validates it against the shared schema. */
const networkConfig: NetworkConfig = {
  nodeName: "Test node",
  enablePublicChannels: true,
  enablePrivateChannels: true,
  enableUserChannels: true,
  enableReplies: true,
  enableDMs: true,
  enableReactions: true,
  enableMarkdown: true,
  enableAttachments: true,
  enableLocationSharing: false,
  enablePresence: true,
  enableMesh: false,
  enableLLMChat: false,
  enableLLMStreaming: false,
  allowUserDisplayNameEdit: true,
  allowUserAvatarEdit: true,
  allowUserAvatarUpload: true,
  allowAdminClaim: false,
  joinPolicy: "open",
  securityProfile: "custom",
  transportEncryption: "off",
  dbEncryption: "off",
  locale: "en",
  devMode: false,
};

// Agreed to the member rules, so the app opens on its content rather than the Welcome screen.
const me: User = { id: "user.me", displayName: "Me", type: "human", isAdmin: false, createdAt: 1, ephemeral: true, rulesVersion: MEMBER_RULES_VERSION };
const troll: User = { id: "user.troll", displayName: "Troll", type: "human", isAdmin: false, createdAt: 1, ephemeral: true };
// A whole channel record: the boot drops any channel row that fails the shared schema.
const general: Channel = {
  id: "general",
  name: "general",
  visibility: "public",
  allowPosting: "everyone",
  allowReplies: true,
  discoverable: true,
  createdAt: 1,
};

function post(id: string, authorId: string, body: string): Message {
  return { id, type: "channelPost", channelId: "general", authorId, body, createdAt: 100 } as Message;
}

/** Never settles: keeps a request "in flight" for the whole test. */
function pending(): Promise<Response> {
  return new Promise<Response>(() => {});
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/**
 * The node's answer to a tunnelled `GET /api/config` (a bound client reads its network settings there, not
 * from the bootstrap): the `config` it holds plus `currentUser`, sealed in a tunnel descriptor. Undefined for
 * any other tunnelled request, which the caller then handles (usually by never answering).
 */
function tunnelledConfigReply(sessionKey: string, init: RequestInit | undefined, config: object, currentUser: User): Response | undefined {
  const envelope = openTunnelRequest(sessionKey, init);
  if (envelope?.b.m !== "GET" || envelope.b.p !== "/api/config") {
    return undefined;
  }
  const bodyB64 = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify({ ...config, currentUser }))));
  return tunnelDescriptorReply(sessionKey, envelope, { status: 200, bodyB64 });
}

interface NodeOptions {
  /** The identity the node confirms for this browser. */
  currentUser?: User;
  /** `/api/users/me/blocks`: a list, or `"fail"` (500), or `"hang"` (never answers). */
  blocks?: string[] | "fail" | "hang";
  /** Everything else content-shaped (channels, users, messages) never answers unless set here. */
  content?: boolean;
  searchResults?: Message[];
  /** `POST /api/admin/claim`: the status to answer (200 = the caller becomes admin). */
  claimStatus?: number;
  /** What `/api/bootstrap` answers instead of a well-formed bootstrap. */
  bootstrapBody?: unknown;
  /** Flags to change from the default network config. */
  networkConfig?: Partial<NetworkConfig>;
}

function stubNode(options: NodeOptions = {}) {
  let currentUser = options.currentUser ?? me;
  const bootstrap = { joinUrl: "http://node.test/", websocketPath: "/ws", networkConfig: { ...networkConfig, ...options.networkConfig } };
  const fetchMock = vi.fn(async (input: string, _init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/admin/claim") {
      const status = options.claimStatus ?? 200;
      if (status !== 200) {
        return json({ error: "Invalid admin secret" }, status);
      }
      // Like the real node: the claim sticks, so later reads return the admin record.
      currentUser = { ...currentUser, isAdmin: true, pending: false };
      return json(currentUser);
    }
    if (url === "/api/bootstrap") {
      return json("bootstrapBody" in options ? options.bootstrapBody : bootstrap);
    }
    if (url === "/api/config") {
      return json({ ...bootstrap, currentUser });
    }
    if (url === "/api/users/me/blocks") {
      if (options.blocks === "fail") {
        return json({ error: "boom" }, 500);
      }
      if (options.blocks === undefined || options.blocks === "hang") {
        return pending();
      }
      return json({ blockedUserIds: options.blocks });
    }
    if (url.startsWith("/api/search")) {
      return json({ results: options.searchResults ?? [] });
    }
    if (!options.content) {
      return pending();
    }
    if (url === "/api/channels") {
      return json([general]);
    }
    if (url === "/api/users") {
      return json([currentUser.id === me.id ? currentUser : me, troll]);
    }
    return pending();
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** A WebSocket that never connects (the tests are about the REST boot and the cache). */
class IdleWebSocket {
  static readonly OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send(): void {}
  close(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

/** A WebSocket the test opens, feeds and closes; every one the app creates is kept, newest last. */
class LiveWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static sockets: LiveWebSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    LiveWebSocket.sockets.push(this);
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  deliver(event: unknown): void {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
  drop(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  send(): void {}
  close(): void {
    this.readyState = 3;
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}

let container: HTMLDivElement | undefined;

async function settle(rounds = 40): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function boot(path: string): Promise<HTMLDivElement> {
  window.history.replaceState(null, "", path);
  container = document.createElement("div");
  document.body.appendChild(container);
  render(<App />, container);
  await settle();
  return container;
}

async function seedCache(records: { messages?: Message[]; channels?: Channel[]; blockList?: { userId: string; ids: string[] } }) {
  await putRecords("channels", records.channels ?? [general]);
  await putRecords("messages", records.messages ?? []);
  if (records.blockList) {
    await putRecord("sync", { id: "blockList", userId: records.blockList.userId, blockedUserIds: records.blockList.ids });
  }
  // A fresh page load: drop the seeding connection so the app opens its own.
  resetLocalStoreForTests();
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  resetLocalStoreForTests();
  resetTransportStateForTests();
  localStorage.clear();
  vi.stubGlobal("WebSocket", IdleWebSocket);
});

afterEach(async () => {
  if (container) {
    render(null, container);
    container.remove();
    container = undefined;
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await destroyDatabase().catch(() => undefined);
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("identity-change purge at boot", () => {
  it("the first confirmation does NOT purge the cache", async () => {
    await seedCache({ messages: [post("m1", troll.id, "cached hello")] });
    stubNode();

    await boot("/settings");
    expect(localStorage.getItem(CONFIRMED_USER_KEY)).toBe(me.id);
    expect((await getAllRecords<Message>("messages")).map((message) => message.id)).toEqual(["m1"]);
  });

  it("the same confirmed identity again does not purge either", async () => {
    localStorage.setItem(CONFIRMED_USER_KEY, me.id);
    await seedCache({ messages: [post("m1", troll.id, "cached hello")] });
    stubNode();

    await boot("/settings");
    expect((await getAllRecords<Message>("messages")).map((message) => message.id)).toEqual(["m1"]);
  });

  it("a DIFFERENT confirmed identity purges the cached content (memory and IndexedDB)", async () => {
    localStorage.setItem(CONFIRMED_USER_KEY, "user.previous");
    await seedCache({
      messages: [post("m1", troll.id, "the previous identity's cached post")],
      blockList: { userId: "user.previous", ids: [troll.id] },
    });
    stubNode();

    const host = await boot("/channel/general");
    expect(localStorage.getItem(CONFIRMED_USER_KEY)).toBe(me.id);
    expect(await getAllRecords("messages")).toEqual([]);
    // The cached block list went with it.
    expect((await getAllRecords<{ id: string }>("sync")).map((record) => record.id)).not.toContain("blockList");
    expect(host.textContent).not.toContain("the previous identity's cached post");
  });
});

describe("message retention on this device (review 2026-11-07 F-030)", () => {
  const HOUR = 3_600_000;
  const aged = (id: string, ageMs: number, body: string): Message => ({ ...post(id, troll.id, body), createdAt: Date.now() - ageMs }) as Message;

  it("drops cached messages past the remembered TTL before anything renders, even if the node no longer says", async () => {
    localStorage.setItem(CONFIRMED_USER_KEY, me.id);
    await seedCache({ messages: [aged("old", 2 * HOUR, "expired words"), aged("new", 60_000, "recent words")] });
    await putRecord("sync", { id: "retention", messageTtlMs: HOUR });
    resetLocalStoreForTests();
    stubNode({ blocks: "hang" });

    const host = await boot("/channel/general");
    expect(host.textContent).toContain("recent words");
    expect(host.textContent).not.toContain("expired words");
    expect((await getAllRecords<Message>("messages")).map((message) => message.id)).toEqual(["new"]);
  });

  it("drops cached messages past the TTL the node reports, and remembers it for an offline start", async () => {
    localStorage.setItem(CONFIRMED_USER_KEY, me.id);
    await seedCache({ messages: [aged("old", 2 * HOUR, "expired words"), aged("new", 60_000, "recent words")] });
    stubNode({ blocks: "hang", networkConfig: { messageTtlMs: HOUR } });

    const host = await boot("/channel/general");
    expect(host.textContent).not.toContain("expired words");
    expect((await getAllRecords<Message>("messages")).map((message) => message.id)).toEqual(["new"]);
    expect(await getAllRecords("sync")).toContainEqual({ id: "retention", messageTtlMs: HOUR });
  });
});

describe("the cached block list (review 2026-09-25 #4)", () => {
  it("hides a blocked author's cached posts from the first render while the block fetch fails", async () => {
    localStorage.setItem(CONFIRMED_USER_KEY, me.id);
    await seedCache({
      messages: [post("m1", troll.id, "nasty cached words")],
      blockList: { userId: me.id, ids: [troll.id] },
    });
    stubNode({ blocks: "fail" });

    const host = await boot("/channel/general");
    expect(host.textContent).toContain("Message from a blocked user");
    expect(host.textContent).not.toContain("nasty cached words");
  });

  it("ignores a cached list that belongs to another identity", async () => {
    localStorage.setItem(CONFIRMED_USER_KEY, me.id);
    await seedCache({
      messages: [post("m1", troll.id, "ordinary cached words")],
      blockList: { userId: "user.someone-else", ids: [troll.id] },
    });
    stubNode({ blocks: "hang" });

    const host = await boot("/channel/general");
    expect(host.textContent).toContain("ordinary cached words");
  });

  it("caches the fetched list for the confirmed identity", async () => {
    stubNode({ blocks: [troll.id], content: true });

    await boot("/settings");
    expect(await getAllRecords("sync")).toContainEqual({ id: "blockList", userId: me.id, blockedUserIds: [troll.id] });
  });
});

describe("another tab confirming a different identity (review 2026-09-25 #7)", () => {
  it("drops this tab's in-memory content", async () => {
    localStorage.setItem(CONFIRMED_USER_KEY, me.id);
    await seedCache({ messages: [post("m1", troll.id, "still on screen")] });
    stubNode();
    // jsdom has no navigation; the reload that follows the purge is just reported and ignored.
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const host = await boot("/channel/general");
    expect(host.textContent).toContain("still on screen");

    window.dispatchEvent(new StorageEvent("storage", { key: CONFIRMED_USER_KEY, newValue: "user.new" }));
    await settle();
    expect(host.textContent).not.toContain("still on screen");
  });

  it("ignores a sibling confirming the SAME identity", async () => {
    localStorage.setItem(CONFIRMED_USER_KEY, me.id);
    await seedCache({ messages: [post("m1", troll.id, "still on screen")] });
    stubNode();

    const host = await boot("/channel/general");
    window.dispatchEvent(new StorageEvent("storage", { key: CONFIRMED_USER_KEY, newValue: me.id }));
    await settle();
    expect(host.textContent).toContain("still on screen");
  });
});

describe("search results from a blocked author (review 2026-09-25 #3)", () => {
  it("collapse to the blocked placeholder", async () => {
    stubNode({ blocks: [troll.id], content: true, searchResults: [post("m1", troll.id, "findable nasty words")] });

    const host = await boot("/search");
    const input = host.querySelector<HTMLInputElement>('input[type="search"]')!;
    input.value = "nasty";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await settle(5);
    host.querySelector<HTMLFormElement>(".search-form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();

    expect(host.querySelector(".search-results")?.textContent).toContain("Message from a blocked user");
    expect(host.textContent).not.toContain("findable nasty words");
  });
});

describe("the host terminal's one-time admin link", () => {
  const CODE = "abcdefghijklmnopqrstuv";

  function claims(fetchMock: ReturnType<typeof stubNode>) {
    return fetchMock.mock.calls.filter(([url]) => url === "/api/admin/claim");
  }

  afterEach(() => {
    takeAdminClaimCode();
  });

  it("claims admin with the code once at boot and shows the admin area", async () => {
    window.history.replaceState(null, "", `/#a=${CODE}`);
    captureAdminClaimCode();
    const fetchMock = stubNode({ content: true });
    const root = await boot("/channels");

    expect(claims(fetchMock)).toHaveLength(1);
    expect(JSON.parse(String(claims(fetchMock)[0]![1]?.body))).toEqual({ secret: CODE });
    expect(root.textContent).toContain("Admin");
  });

  it("drops a refused code instead of presenting it again", async () => {
    window.history.replaceState(null, "", `/#a=${CODE}`);
    captureAdminClaimCode();
    const fetchMock = stubNode({ claimStatus: 403 });
    await boot("/channels");
    expect(claims(fetchMock)).toHaveLength(1);
    expect(takeAdminClaimCode()).toBeUndefined();
  });

  it("presents the code even in a browser that is already admin, so the server spends it", async () => {
    window.history.replaceState(null, "", `/#a=${CODE}`);
    captureAdminClaimCode();
    const fetchMock = stubNode({ currentUser: { ...me, isAdmin: true } });
    const root = await boot("/channels");
    expect(claims(fetchMock)).toHaveLength(1);
    expect(root.textContent).toContain("Admin");
  });
});

describe("the Android host's own WebView", () => {
  const HOST_TOKEN = "host-token-0123456789abcdefghijklmnopq";

  afterEach(() => {
    delete (window as { __loamHostDeviceToken?: string }).__loamHostDeviceToken;
  });

  it("presents the host token even when already admin, so the node knows who the phone's notifications are for", async () => {
    (window as { __loamHostDeviceToken?: string }).__loamHostDeviceToken = HOST_TOKEN;
    const fetchMock = stubNode({ currentUser: { ...me, isAdmin: true } });
    await boot("/channels");

    const claims = fetchMock.mock.calls.filter(([url]) => url === "/api/admin/claim");
    expect(claims).toHaveLength(1);
    expect(JSON.parse(String(claims[0]![1]?.body))).toEqual({ secret: HOST_TOKEN });
  });
});

describe("the Welcome screen (member rules)", () => {
  it("greets someone who hasn't agreed yet instead of opening the network", async () => {
    stubNode({ currentUser: { ...me, rulesVersion: undefined } });
    const root = await boot("/channels");
    expect(root.querySelector(".welcome-screen")).not.toBeNull();
    expect(root.querySelector(".welcome-agree")?.textContent).toContain("18");
  });

  it("greets someone again when the rules have changed since they agreed", async () => {
    stubNode({ currentUser: { ...me, rulesVersion: MEMBER_RULES_VERSION - 1 } });
    const root = await boot("/channels");
    expect(root.querySelector(".welcome-screen")).not.toBeNull();
  });

  it("opens straight onto the network for someone who has agreed", async () => {
    stubNode();
    const root = await boot("/channels");
    expect(root.querySelector(".welcome-screen")).toBeNull();
  });
});

describe("an invite code scanned from the host's screen", () => {
  it("says the code was not accepted on a first visit, when the node refuses it", async () => {
    // A newcomer on an approval network: no identity recorded yet, so the node's confirmed id replaces the
    // page's placeholder while the code is being redeemed.
    const newcomer: User = { ...me, id: "user.newcomer", pending: true, rulesVersion: undefined };
    const fetchMock = stubNode({ currentUser: newcomer, networkConfig: { joinPolicy: "approval" } });
    const redeems: string[] = [];
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      if (String(input) === "/api/access/redeem") {
        redeems.push(String(init?.body));
        // A real round trip: long enough for the page to re-render under the confirmed id meanwhile.
        await new Promise((resolve) => setTimeout(resolve, 300));
        return json({ error: "That invite code has expired", code: "invite_invalid" }, 403);
      }
      return fetchMock(input, init);
    });
    window.history.replaceState(null, "", "/#i=expiredcode");
    captureInviteCode();

    const root = await boot("/channels");
    await new Promise((resolve) => setTimeout(resolve, 400));
    await settle();
    expect(redeems).toHaveLength(1);
    expect(root.textContent).toContain("You're in the queue");
    expect(root.textContent).toContain("That invite code has expired. Scan the code on the host's screen again");
  });
});

describe("a wiped device rejoining by its join QR", () => {
  const RESUME_AAD = "POST /api/session/resume";

  /**
   * A node pinned to `host`: answers the QR-pinned handshake (or refuses it) and the sealed identity resume
   * the way the real server does, so a boot with a `#k=` can run to the point where the wipe tombstone is
   * lifted. Of the tunnelled requests only the network settings (`/api/config`) are answered: these tests are
   * about the gate, not the roster.
   */
  function stubPinnedNode(host: ReturnType<typeof createTransportIdentity>, options: { handshake?: "ok" | "fail" } = {}) {
    let sessionKey: string | undefined;
    const bootstrap = {
      joinUrl: "http://node.test/",
      websocketPath: "/ws",
      networkConfig: { ...networkConfig, transportEncryption: "required", transportPublicKey: host.publicKey },
    };
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/bootstrap") {
        return json(bootstrap);
      }
      if (url === "/api/transport/handshake") {
        if (options.handshake === "fail") {
          return json({ error: "internal_error" }, 500);
        }
        const { clientEphemeralPublic } = JSON.parse(String(init?.body)) as { clientEphemeralPublic: string };
        const accepted = transportServerAccept({ hostSecret: host.secretKey, clientEphemeralPublic });
        sessionKey = accepted.sessionKey;
        return json({ sessionId: "sess-1", hostEphemeralPublic: accepted.hostEphemeralPublic, hostPublicKey: host.publicKey });
      }
      if (url === "/api/session/resume" && sessionKey) {
        const { enc } = JSON.parse(String(init?.body)) as { enc: string };
        const envelope = JSON.parse(openTransport(sessionKey, enc, RESUME_AAD) ?? "{}") as { s?: number };
        const reply = { s: envelope.s, m: "POST", p: "/api/session/resume", currentUser: me, token: "token-1" };
        const replyAad = `loam.transport.response.v2 ${JSON.stringify(["POST", "/api/session/resume", envelope.s, 200])}`;
        return new Response(JSON.stringify({ enc: sealTransport(sessionKey, JSON.stringify(reply), replyAad) }), {
          status: 200,
          headers: { "content-type": "application/json", "x-loam-enc": "1" },
        });
      }
      if (url === "/api/transport/tunnel" && sessionKey) {
        return tunnelledConfigReply(sessionKey, init, bootstrap, me) ?? pending();
      }
      return pending();
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function handshakes(fetchMock: ReturnType<typeof stubPinnedNode>) {
    return fetchMock.mock.calls.filter(([url]) => url === "/api/transport/handshake");
  }

  afterEach(() => {
    delete (window as { __loamHostTransportKey?: unknown }).__loamHostTransportKey;
  });

  it("with no key at load, boot stays on the wiped screen and never talks to the node", async () => {
    setWipeTombstone();
    const fetchMock = stubPinnedNode(createTransportIdentity());
    const root = await boot("/channels");

    expect(root.textContent).toContain("Device wiped");
    expect(handshakes(fetchMock)).toHaveLength(0);
    expect(isWipeTombstoned()).toBe(true);
  });

  it("a #k= scanned at load lets boot handshake, and the tombstone is lifted once the handshake succeeds", async () => {
    const host = createTransportIdentity();
    setWipeTombstone();
    // As main.tsx does: the fragment is read (and stripped) before the app renders.
    window.history.replaceState(null, "", `/#k=${host.publicKey}`);
    captureJoinKey();
    const fetchMock = stubPinnedNode(host);
    const root = await boot("/channels");

    expect(root.textContent).not.toContain("Device wiped");
    expect(handshakes(fetchMock)).toHaveLength(1);
    await vi.waitFor(() => expect(isWipeTombstoned()).toBe(false));
  });

  it("keeps the tombstone when the handshake fails (a stale QR never lifts the gate by itself)", async () => {
    const host = createTransportIdentity();
    setWipeTombstone();
    window.history.replaceState(null, "", `/#k=${host.publicKey}`);
    captureJoinKey();
    const fetchMock = stubPinnedNode(host, { handshake: "fail" });
    const root = await boot("/channels");

    expect(root.textContent).not.toContain("Device wiped");
    expect(handshakes(fetchMock).length).toBeGreaterThan(0);
    expect(isWipeTombstoned()).toBe(true);
  });

  it("the Android host's injected key counts as a rejoin for its own WebView", async () => {
    const host = createTransportIdentity();
    setWipeTombstone();
    (window as { __loamHostTransportKey?: unknown }).__loamHostTransportKey = host.publicKey;
    captureJoinKey();
    const fetchMock = stubPinnedNode(host);
    const root = await boot("/channels");

    expect(root.textContent).not.toContain("Device wiped");
    expect(handshakes(fetchMock)).toHaveLength(1);
    await vi.waitFor(() => expect(isWipeTombstoned()).toBe(false));
  });
});

describe("the boot validates what the node sends", () => {
  it("a bootstrap of the wrong shape is a readable boot error, not a TypeError", async () => {
    stubNode({ bootstrapBody: { joinUrl: "http://node.test/", websocketPath: "/ws", networkConfig: { nodeName: "x" } } });
    const host = await boot("/channels");
    expect(host.textContent).toContain("The server returned an unrecognised configuration payload.");
  });

  it("a page opened from a node-link QR says the code was for another node, once connected", async () => {
    vi.mocked(linkCodePresentAtStartup).mockReturnValue(true);
    try {
      // The block list must answer: the boot pass only ends (and says this) once the roster has loaded.
      stubNode({ content: true, blocks: [] });
      const host = await boot("/channels");
      expect(host.querySelector(".connection-error")?.textContent).toContain(
        "That QR code links another LOAM node to this network.",
      );
    } finally {
      vi.mocked(linkCodePresentAtStartup).mockReturnValue(false);
    }
  });

  it("says nothing about node links on an ordinary join", async () => {
    stubNode({ content: true, blocks: [] });
    const host = await boot("/channels");
    expect(host.textContent).not.toContain("That QR code links another LOAM node");
  });
});

describe("an open search follows what the socket says", () => {
  const dmToMe = { id: "m3", type: "dm", recipientUserId: me.id, authorId: troll.id, body: "the bridge, privately", createdAt: 100 } as Message;

  function searchRequests(fetchMock: ReturnType<typeof stubNode>): number {
    return fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/search")).length;
  }

  async function openSearch(options: NodeOptions): Promise<{ host: HTMLDivElement; fetchMock: ReturnType<typeof stubNode> }> {
    // The Search screen remembers the last term in module memory; start each test without one.
    forgetRememberedSearch();
    LiveWebSocket.sockets = [];
    vi.stubGlobal("WebSocket", LiveWebSocket);
    const fetchMock = stubNode(options);
    const host = await boot("/search");
    LiveWebSocket.sockets.at(-1)!.open();
    const input = host.querySelector<HTMLInputElement>('input[type="search"]')!;
    input.value = "bridge";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await settle(5);
    host.querySelector<HTMLFormElement>(".search-form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    return { host, fetchMock };
  }

  it("drops deleted rows, rewrites edited ones and drops a removed channel's rows", async () => {
    const { host } = await openSearch({
      content: true,
      blocks: [],
      searchResults: [post("m1", troll.id, "meet at the bridge"), post("m2", troll.id, "the bridge is closed"), dmToMe],
    });
    const shown = (): string => host.querySelector(".search-results")?.textContent ?? "";
    expect(shown()).toContain("meet at the bridge");
    const socket = LiveWebSocket.sockets.at(-1)!;

    socket.deliver({ type: "messageDeleted", messageId: "m1" });
    socket.deliver({ type: "messageUpdated", message: post("m2", troll.id, "the bridge reopened") });
    await settle();
    expect(shown()).not.toContain("meet at the bridge");
    expect(shown()).toContain("the bridge reopened");

    socket.deliver({ type: "channelRemoved", channelId: "general" });
    await settle();
    expect(shown()).not.toContain("the bridge reopened");
    expect(shown()).toContain("the bridge, privately");
  });

  it("runs the search again once the resync after a reconnect has finished", async () => {
    const options: NodeOptions = { content: true, blocks: [], searchResults: [post("m1", troll.id, "meet at the bridge")] };
    const { host, fetchMock } = await openSearch(options);
    expect(searchRequests(fetchMock)).toBe(1);

    // The socket drops, the message is deleted while it is down, and the device reconnects.
    options.searchResults = [];
    LiveWebSocket.sockets.at(-1)!.drop();
    window.dispatchEvent(new Event("online"));
    await settle();
    LiveWebSocket.sockets.at(-1)!.open();
    await settle();

    expect(searchRequests(fetchMock)).toBe(2);
    expect(host.textContent).not.toContain("meet at the bridge");
    expect(host.querySelector(".empty-note")?.textContent).toBe("No messages matched.");
  });

  it("starts empty, and never searches the old term, when the reconnect confirms a different identity", async () => {
    // The node keeps answering with the same rows, so only the screen itself can make them go.
    const { host, fetchMock } = await openSearch({
      content: true,
      blocks: [],
      searchResults: [post("m1", troll.id, "meet at the bridge")],
    });
    expect(host.querySelector(".search-results")?.textContent).toContain("meet at the bridge");

    // From here the node hands this browser a new identity (its session was reset while the socket was down).
    const newcomer: User = { ...me, id: "user.newcomer" };
    let switchedAt: number | undefined;
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      if (String(input) === "/api/config") {
        switchedAt ??= fetchMock.mock.calls.length;
        return json({ joinUrl: "http://node.test/", websocketPath: "/ws", networkConfig, currentUser: newcomer });
      }
      return fetchMock(input, init);
    });
    LiveWebSocket.sockets.at(-1)!.drop();
    window.dispatchEvent(new Event("online"));
    await settle();
    LiveWebSocket.sockets.at(-1)!.open();
    await settle();

    expect(localStorage.getItem(CONFIRMED_USER_KEY)).toBe(newcomer.id);
    expect(switchedAt).toBeDefined();
    const searchesAsNewcomer = fetchMock.mock.calls.slice(switchedAt).filter(([url]) => String(url).startsWith("/api/search"));
    expect(searchesAsNewcomer).toEqual([]);
    expect(host.querySelector(".search-results")).toBeNull();
    expect(host.textContent).not.toContain("meet at the bridge");
    expect(host.querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe("");
  });
});

describe("a pinned client's socket and boot (review 2026-11-18)", () => {
  const PIN_KEY = `loam.transportHostKey.${window.location.origin}`;
  const RESUME_AAD = "POST /api/session/resume";

  /** A WebSocket the test drives; keeps every one the app creates, newest last, with its URL and what it sent. */
  class DrivenWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    static sockets: DrivenWebSocket[] = [];
    readyState = 0;
    sent: string[] = [];
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(readonly url: string) {
      DrivenWebSocket.sockets.push(this);
    }
    open(): void {
      this.readyState = 1;
      this.onopen?.();
    }
    receive(data: string): void {
      this.onmessage?.({ data });
    }
    drop(): void {
      this.readyState = 3;
      this.onclose?.();
    }
    send(data: string): void {
      this.sent.push(data);
    }
    close(): void {
      this.readyState = 3;
    }
    addEventListener(): void {}
    removeEventListener(): void {}
  }

  /**
   * A node for a client pinned to `real`: answers handshakes (as `real`, or as `impostor` from the handshake
   * number `forgedFrom` on), the sealed resume, the bootstrap and the tunnelled `/api/config`; other content
   * requests never answer. Exposes the
   * session key of the latest handshake, so a test can seal the socket's challenge and frames.
   */
  function stubPinnedNode(real: ReturnType<typeof createTransportIdentity>, options: { impostor?: ReturnType<typeof createTransportIdentity>; forgedFrom?: number } = {}) {
    const state = { sessionKey: undefined as string | undefined, handshakes: 0 };
    const bootstrap = {
      joinUrl: "http://node.test/",
      websocketPath: "/ws",
      networkConfig: { ...networkConfig, transportEncryption: "optional", transportPublicKey: real.publicKey },
    };
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/bootstrap") {
        return json(bootstrap);
      }
      if (url === "/api/transport/handshake") {
        state.handshakes += 1;
        const forged = options.impostor !== undefined && state.handshakes >= (options.forgedFrom ?? Infinity);
        const host = forged ? options.impostor! : real;
        const { clientEphemeralPublic } = JSON.parse(String(init?.body)) as { clientEphemeralPublic: string };
        const accepted = transportServerAccept({ hostSecret: host.secretKey, clientEphemeralPublic });
        if (!forged) {
          state.sessionKey = accepted.sessionKey;
        }
        return json({ sessionId: `sess-${state.handshakes}`, hostEphemeralPublic: accepted.hostEphemeralPublic, hostPublicKey: host.publicKey });
      }
      if (url === "/api/session/resume" && state.sessionKey) {
        const { enc } = JSON.parse(String(init?.body)) as { enc: string };
        const envelope = JSON.parse(openTransport(state.sessionKey, enc, RESUME_AAD) ?? "{}") as { s?: number };
        const reply = { s: envelope.s, m: "POST", p: "/api/session/resume", currentUser: me, token: "token-1" };
        return new Response(JSON.stringify({ enc: sealTransport(state.sessionKey, JSON.stringify(reply), `loam.transport.response.v2 ${JSON.stringify(["POST", "/api/session/resume", envelope.s, 200])}`) }), {
          status: 200,
          headers: { "content-type": "application/json", "x-loam-enc": "1" },
        });
      }
      if (url === "/api/transport/tunnel" && state.sessionKey) {
        return tunnelledConfigReply(state.sessionKey, init, bootstrap, me) ?? pending();
      }
      return pending();
    });
    vi.stubGlobal("fetch", fetchMock);
    return { fetchMock, state };
  }

  /** Answer the newest socket's challenge (repeating the `cn` it sent) under `sessionKey`; returns its connection id. */
  function confirmSocket(socket: DrivenWebSocket, sessionKey: string): string {
    const cn = new URLSearchParams(socket.url.split("?")[1]).get("cn");
    const connectionId = "conn-1";
    socket.receive(sealTransport(sessionKey, JSON.stringify({ type: "challenge", connectionId, nonce: "n", cn }), "loam.ws.challenge.v1"));
    expect(socket.sent).toHaveLength(1); // the proof
    return connectionId;
  }

  /** One sealed application frame for `connectionId`. */
  function frame(sessionKey: string, connectionId: string, q: number, event: unknown): string {
    return sealTransport(sessionKey, JSON.stringify({ q, f: JSON.stringify(event) }), `loam.ws.frame.v1 ${connectionId}`);
  }

  beforeEach(() => {
    DrivenWebSocket.sockets = [];
    vi.stubGlobal("WebSocket", DrivenWebSocket);
  });

  it("with a pin and a bootstrap that never answers, what the member types and sends never goes out in clear", async () => {
    localStorage.setItem(PIN_KEY, createTransportIdentity().publicKey);
    localStorage.setItem(CONFIRMED_USER_KEY, me.id);
    await seedCache({ messages: [post("m1", troll.id, "cached hello")] });
    const fetchMock = vi.fn(async () => pending());
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const host = await boot("/channel/general");
    // The identity splash lifts after 1.5 s whatever the network does, and the cached conversation shows.
    await new Promise((resolve) => setTimeout(resolve, 1_700));
    await settle();
    expect(host.textContent).toContain("cached hello");

    const field = host.querySelector<HTMLTextAreaElement>(".conversation .composer textarea")!;
    field.value = "words typed off the hotspot";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    host.querySelector<HTMLFormElement>(".conversation form.composer")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();

    // Only the cookie-free bootstrap went out; no message, no typing ping, and no cookie config.
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(["/api/bootstrap"]);
    expect(DrivenWebSocket.sockets).toHaveLength(0);
  });

  it("once a resync gates on a rescan, the socket is closed, stays closed, and a plaintext wipe frame changes nothing", async () => {
    const real = createTransportIdentity();
    localStorage.setItem(PIN_KEY, real.publicKey);
    const { state } = stubPinnedNode(real, { impostor: createTransportIdentity(), forgedFrom: 2 });

    const root = await boot("/channels");
    expect(DrivenWebSocket.sockets).toHaveLength(1);
    const first = DrivenWebSocket.sockets[0]!;
    expect(first.url).toContain("enc=sess-1");
    first.open();
    confirmSocket(first, state.sessionKey!);

    // The socket drops and the device comes back online: the reconnect's handshake is answered by someone
    // on the path naming another key, which breaks the pin. No socket opens under the old session; the
    // resync that follows shows the rescan gate.
    first.drop();
    window.dispatchEvent(new Event("online"));
    await settle();
    expect(DrivenWebSocket.sockets).toEqual([first]);
    expect(root.textContent).toContain("Scan the join QR to connect securely");
    expect(first.readyState).toBe(DrivenWebSocket.CLOSED);

    // Nothing more is tried behind the gate: no reconnect, no handshake.
    const handshakesAtGate = state.handshakes;
    window.dispatchEvent(new Event("online"));
    await settle();
    expect(state.handshakes).toBe(handshakesAtGate);
    expect(DrivenWebSocket.sockets).toHaveLength(1);

    // A plaintext frame written to that socket is not an event.
    first.receive(JSON.stringify({ type: "wipe" }));
    await settle();
    expect(localStorage.getItem(PIN_KEY)).toBe(real.publicKey);
    expect(root.textContent).not.toContain("Device wiped");
    expect(root.textContent).toContain("Scan the join QR to connect securely");
  });

  it("a reconnect that finds the node holding another key shows the rescan gate instead of looping on a dead session", async () => {
    const real = createTransportIdentity();
    localStorage.setItem(PIN_KEY, real.publicKey);
    // The node was reset while this phone slept: from the second handshake on it holds a new key.
    const { state } = stubPinnedNode(real, { impostor: createTransportIdentity(), forgedFrom: 2 });
    /** Let pending promise work run without moving the fake clock. */
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 50; i += 1) {
        await Promise.resolve();
      }
    };

    const root = await boot("/channels");
    const first = DrivenWebSocket.sockets[0]!;
    first.open();
    confirmSocket(first, state.sessionKey!);
    await settle();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      first.drop();
      await flush();
      await vi.advanceTimersByTimeAsync(1_100);
      await flush();

      expect(state.handshakes).toBe(2);
      expect(DrivenWebSocket.sockets).toHaveLength(1);
      expect(root.textContent).toContain("Scan the join QR to connect securely");

      // Behind the gate nothing more is tried, however long the page stays open.
      await vi.advanceTimersByTimeAsync(120_000);
      await flush();
      expect(DrivenWebSocket.sockets).toHaveLength(1);
      expect(state.handshakes).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a frame sequence gap closes the socket and reconnects through the normal path, never faster than the backoff", async () => {
    const real = createTransportIdentity();
    localStorage.setItem(PIN_KEY, real.publicKey);
    const { state } = stubPinnedNode(real);
    /** Let pending promise work run without moving the fake clock. */
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 50; i += 1) {
        await Promise.resolve();
      }
    };

    await boot("/channels");
    const first = DrivenWebSocket.sockets[0]!;
    first.open();
    await settle();
    // From here the clock moves only when the test moves it (`settle` would move it 20 ms a round).
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const connectionId = confirmSocket(first, state.sessionKey!);
      first.receive(frame(state.sessionKey!, connectionId, 1, { type: "ping" }));
      first.receive(frame(state.sessionKey!, connectionId, 2, { type: "presence", onlineUserIds: [] }));
      first.receive(frame(state.sessionKey!, connectionId, 4, { type: "presence", onlineUserIds: [] }));
      await flush();
      expect(first.readyState).toBe(DrivenWebSocket.CLOSED);
      expect(DrivenWebSocket.sockets).toHaveLength(1);

      // The reconnect waits out a backoff longer than the plain one-second retry, then reopens.
      await vi.advanceTimersByTimeAsync(1_900);
      await flush();
      expect(DrivenWebSocket.sockets).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(200);
      await flush();
      expect(DrivenWebSocket.sockets).toHaveLength(2);
      expect(state.handshakes).toBe(2); // the normal reconnect path: a fresh session first

      // A second gap in a row waits longer still, though the new socket's open reset the ordinary backoff.
      const second = DrivenWebSocket.sockets[1]!;
      second.open();
      await flush();
      const nextId = confirmSocket(second, state.sessionKey!);
      second.receive(frame(state.sessionKey!, nextId, 2, { type: "ping" }));
      await flush();
      expect(second.readyState).toBe(DrivenWebSocket.CLOSED);
      await vi.advanceTimersByTimeAsync(3_900);
      await flush();
      expect(DrivenWebSocket.sockets).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(200);
      await flush();
      expect(DrivenWebSocket.sockets).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a DM to the assistant names the destination this screen shows (docs/06)", () => {
  const bot: User = { id: "llm.ollama.gemma4", displayName: "Assistant", type: "bot", isAdmin: false, createdAt: 1, ephemeral: false };
  const ada: User = { id: "user.ada", displayName: "Ada", type: "human", isAdmin: false, createdAt: 1, ephemeral: true };
  const local: Partial<NetworkConfig> = {
    enableLLMChat: true,
    enableLLMStreaming: true,
    assistantDestination: { kind: "host" },
    assistantDestinationRevision: "a".repeat(32),
  };
  const online: Partial<NetworkConfig> = {
    ...local,
    assistantDestination: { kind: "online", host: "chat.example.com" },
    assistantDestinationRevision: "b".repeat(32),
  };

  /**
   * A node with the assistant on `local`. A DM to the bot is refused (409) and the node switches to `online`
   * at that moment, as if the host had saved the switch just before; a DM to anyone else is accepted.
   */
  function stubAssistantNode() {
    let current = local;
    const posts: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      const bootstrap = { joinUrl: "http://node.test/", websocketPath: "/ws", networkConfig: { ...networkConfig, ...current } };
      if (url === "/api/bootstrap") {
        return json(bootstrap);
      }
      if (url === "/api/config") {
        return json({ ...bootstrap, currentUser: me });
      }
      if (url === "/api/users/me/blocks") {
        return json({ blockedUserIds: [] });
      }
      if (url === "/api/channels") {
        return json([general]);
      }
      if (url === "/api/users") {
        return json([me, bot, ada]);
      }
      if (url === "/api/dms") {
        return json({ conversations: [] });
      }
      if (url.startsWith("/api/dms/")) {
        return json([]);
      }
      if (url === "/api/messages" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posts.push(body);
        if (body.recipientUserId === bot.id) {
          current = online;
          return json({ error: "The assistant now answers from somewhere else; check where, then send again", code: "assistant_destination_changed" }, 409);
        }
        return json({ message: { id: "msg_1", type: "dm", authorId: me.id, recipientUserId: body.recipientUserId, body: body.body, createdAt: 200 } }, 201);
      }
      return pending();
    });
    vi.stubGlobal("fetch", fetchMock);
    return { fetchMock, posts };
  }

  /** Type `text` into the conversation's composer and submit it. */
  async function send(host: HTMLElement, text: string): Promise<void> {
    const field = host.querySelector<HTMLTextAreaElement>(".conversation .composer textarea")!;
    field.value = text;
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    host.querySelector<HTMLFormElement>(".conversation form.composer")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
  }

  const bootstrapReads = (fetchMock: ReturnType<typeof vi.fn>): number =>
    fetchMock.mock.calls.filter(([input]) => String(input) === "/api/bootstrap").length;

  it("sends the revision with a DM to the assistant, and on a refusal keeps the draft, reloads the config and says why", async () => {
    const { fetchMock, posts } = stubAssistantNode();
    const host = await boot(`/dm/${bot.id}`);
    expect(host.querySelector(".conversation-header")?.textContent).toContain("Runs on the host's computer");
    const readsBefore = bootstrapReads(fetchMock);

    await send(host, "a question for the local model");

    expect(posts).toEqual([{ type: "dm", recipientUserId: bot.id, body: "a question for the local model", assistantDestinationRevision: "a".repeat(32) }]);
    expect(host.querySelector(".connection-error")?.textContent).toContain(
      "The assistant now answers from somewhere else. Check where, then send again.",
    );
    // The config was read again, so the header names the new destination and its acknowledgement gate
    // holds the composer until the member agrees.
    expect(bootstrapReads(fetchMock)).toBeGreaterThan(readsBefore);
    expect(host.querySelector(".conversation-header")?.textContent).toContain("Answers come from chat.example.com, an online service");
    expect(host.querySelector(".conversation .composer-disabled")?.textContent).toContain("Read the notice above");

    const acknowledge = [...host.querySelectorAll<HTMLButtonElement>(".assistant-banner button")].find((button) => button.textContent === "I understand");
    acknowledge!.click();
    await settle();
    expect(host.querySelector<HTMLTextAreaElement>(".conversation .composer textarea")?.value).toBe("a question for the local model");
  });

  it("sends no revision with a DM to a person", async () => {
    const { posts } = stubAssistantNode();
    const host = await boot(`/dm/${ada.id}`);

    await send(host, "hello Ada");

    expect(posts).toEqual([{ type: "dm", recipientUserId: ada.id, body: "hello Ada" }]);
    expect(host.querySelector(".connection-error")).toBeNull();
  });
});

describe("what this device keeps after a conversation, a wipe or a bad row (review 2026-11-18)", () => {
  /** A WebSocket the test opens and feeds; every one the app creates is kept, newest last. */
  class FedWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    static sockets: FedWebSocket[] = [];
    readyState = 0;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() {
      FedWebSocket.sockets.push(this);
    }
    open(): void {
      this.readyState = 1;
      this.onopen?.();
    }
    deliver(event: unknown): void {
      this.onmessage?.({ data: JSON.stringify(event) });
    }
    send(): void {}
    close(): void {
      this.readyState = 3;
    }
    addEventListener(): void {}
    removeEventListener(): void {}
  }

  const LAST_CONVERSATION = "loam.lastConversation";
  const side: Channel = { ...general, id: "side", name: "side" };
  const peer: User = { ...troll, id: "user.peer", displayName: "Peer" };
  const dmWith = (id: string, peerId: string, body: string): Message =>
    ({ id, type: "dm", authorId: peerId, recipientUserId: me.id, body, createdAt: 100 }) as Message;
  const inboxEntry = (userId: string) => ({ userId, lastMessageAt: 100, lastAuthorId: userId });

  /** A node answering the content routes in `routes` (by exact path); anything else never answers. */
  function stubContentNode(routes: Record<string, unknown>, currentUser: User = me) {
    const bootstrap = { joinUrl: "http://node.test/", websocketPath: "/ws", networkConfig };
    const answers: Record<string, unknown> = {
      "/api/channels": [general],
      "/api/users": [currentUser, troll],
      "/api/users/me/blocks": { blockedUserIds: [] },
      ...routes,
    };
    const fetchMock = vi.fn(async (input: string) => {
      const url = String(input);
      if (url === "/api/bootstrap") {
        return json(bootstrap);
      }
      if (url === "/api/config") {
        return json({ ...bootstrap, currentUser });
      }
      return url in answers ? json(answers[url]) : pending();
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  /** The read markers this device has stored, or undefined when it holds none. */
  async function storedReads(): Promise<Record<string, number> | undefined> {
    const records = await getAllRecords<{ id: string; reads?: Record<string, number> }>("sync");
    return records.find((record) => record.id === "conversationReads")?.reads;
  }

  async function seedReads(reads: Record<string, number>): Promise<void> {
    await putRecord("sync", { id: "conversationReads", reads });
    resetLocalStoreForTests();
  }

  /** Every recorded state value as one string, Sets and Maps included. */
  function recordedState(): string {
    return stateLog.values
      .map((value) => {
        try {
          return JSON.stringify(value, (_key, inner: unknown) =>
            inner instanceof Set ? [...inner] : inner instanceof Map ? [...inner.entries()] : inner,
          );
        } catch {
          return String(value);
        }
      })
      .join("\n");
  }

  beforeEach(() => {
    FedWebSocket.sockets = [];
    vi.stubGlobal("WebSocket", FedWebSocket);
    localStorage.setItem(CONFIRMED_USER_KEY, me.id);
  });

  afterEach(() => {
    stateLog.recording = false;
    stateLog.values = [];
  });

  describe("read markers go when their conversation goes", () => {
    it("a resync drops the markers of channels the node no longer lists and of DM partners no longer held", async () => {
      await seedCache({ messages: [dmWith("d1", troll.id, "still here"), dmWith("d2", "user.gone", "deleted on the node")] });
      await seedReads({ "channel:general": 100, "channel:deleted": 90, "dm:user.troll": 100, "dm:user.gone": 80 });
      localStorage.setItem(LAST_CONVERSATION, "/dm/user.gone");
      stubContentNode({ "/api/dms": { conversations: [inboxEntry(troll.id)] } });

      await boot("/settings");

      await vi.waitFor(async () => expect(await storedReads()).toEqual({ "channel:general": 100, "dm:user.troll": 100 }));
      expect(localStorage.getItem(LAST_CONVERSATION)).toBeNull();
    });

    it("keeps the remembered conversation when it is still here", async () => {
      await seedReads({ "channel:general": 100 });
      localStorage.setItem(LAST_CONVERSATION, "/channel/general");
      stubContentNode({ "/api/dms": { conversations: [] } });

      await boot("/settings");

      expect(await storedReads()).toEqual({ "channel:general": 100 });
      expect(localStorage.getItem(LAST_CONVERSATION)).toBe("/channel/general");
    });

    it("a removed channel takes its marker and the remembered path with it", async () => {
      await seedCache({ channels: [general, side] });
      await seedReads({ "channel:general": 100, "channel:side": 100 });
      localStorage.setItem(LAST_CONVERSATION, "/channel/side");
      stubContentNode({ "/api/channels": [general, side], "/api/dms": { conversations: [] } });

      await boot("/settings");
      FedWebSocket.sockets.at(-1)!.open();
      FedWebSocket.sockets.at(-1)!.deliver({ type: "channelRemoved", channelId: "side" });
      await settle();

      expect(await storedReads()).toEqual({ "channel:general": 100 });
      expect(localStorage.getItem(LAST_CONVERSATION)).toBeNull();
    });

    it("a banned session keeps no markers", async () => {
      await seedReads({ "channel:general": 100, "dm:user.troll": 100 });
      localStorage.setItem(LAST_CONVERSATION, "/dm/user.troll");
      stubContentNode({}, { ...me, banned: true });

      await boot("/settings");

      expect(await storedReads()).toBeUndefined();
      expect(localStorage.getItem(LAST_CONVERSATION)).toBeNull();
    });
  });

  describe("a wipe empties the page's memory too", () => {
    it("after a wipe frame no state holds the DM inbox, read markers, presence, typing or toasts", async () => {
      await seedReads({ [`dm:${peer.id}`]: 100 });
      stubContentNode({ "/api/users": [me, troll, peer], "/api/dms": { conversations: [inboxEntry(peer.id)] } });
      const host = await boot("/settings");
      const socket = FedWebSocket.sockets.at(-1)!;
      socket.open();
      socket.deliver({ type: "presence", onlineUserIds: [peer.id] });
      socket.deliver({ type: "typing", userId: peer.id });
      socket.deliver({ type: "messageCreated", message: dmWith("d1", peer.id, "toast words") });
      await settle();
      expect(host.querySelector(".toast-stack")?.textContent).toContain("toast words");

      // Sanity: the recording sees all of it before the wipe.
      stateLog.recording = true;
      socket.deliver({ type: "presence", onlineUserIds: [peer.id] });
      await settle();
      expect(recordedState()).toContain(peer.id);
      expect(recordedState()).toContain("toast words");

      stateLog.values = [];
      socket.deliver({ type: "wipe" });
      await settle();

      expect(host.textContent).toContain("Disconnected");
      expect(stateLog.values.length).toBeGreaterThan(0);
      expect(recordedState()).not.toContain(peer.id);
      expect(recordedState()).not.toContain("toast words");
    });

    it("an identity change takes the toasts and the error banner with it", async () => {
      vi.mocked(linkCodePresentAtStartup).mockReturnValue(true);
      // jsdom has no navigation; the reload that follows the purge is just reported and ignored.
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        stubContentNode({ "/api/dms": { conversations: [] } });
        const host = await boot("/settings");
        const socket = FedWebSocket.sockets.at(-1)!;
        socket.open();
        socket.deliver({ type: "messageCreated", message: post("p1", troll.id, "toast words") });
        await settle();
        expect(host.querySelector(".toast-stack")?.textContent).toContain("toast words");
        expect(host.querySelector(".connection-error")).not.toBeNull();

        window.dispatchEvent(new StorageEvent("storage", { key: CONFIRMED_USER_KEY, newValue: "user.new" }));
        await settle();

        expect(host.querySelector(".toast-stack")?.textContent ?? "").not.toContain("toast words");
        expect(host.querySelector(".connection-error")).toBeNull();
      } finally {
        vi.mocked(linkCodePresentAtStartup).mockReturnValue(false);
      }
    });
  });

  describe("lists from the node are checked entry by entry", () => {
    it("keeps the good rows and stores nothing of a bad one", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      await seedCache({ messages: [dmWith("d-gone", "user.gone", "deleted on the node")] });
      const badChannel = { ...general, id: "channel.bad", name: "" };
      const badUser = { ...troll, id: "user.bad", type: "robot" };
      const badMessage = { ...post("m.bad", troll.id, "x"), body: 5 };
      stubContentNode({
        "/api/channels": [general, badChannel],
        "/api/users": [me, troll, badUser],
        "/api/messages/general": [post("m.good", troll.id, "a good post"), badMessage],
        // One bad inbox row no longer throws the whole inbox away.
        "/api/dms": { conversations: [inboxEntry(troll.id), { userId: "user.bad2", lastMessageAt: "soon" }] },
      });

      const host = await boot("/channel/general");

      expect(host.textContent).toContain("a good post");
      expect((await getAllRecords<Channel>("channels")).map((channel) => channel.id)).toEqual(["general"]);
      const users = (await getAllRecords<User>("users")).map((user) => user.id);
      expect(users).toContain(troll.id);
      expect(users).not.toContain("user.bad");
      // The good inbox row still applies: the cached DM with someone it doesn't list is gone.
      expect((await getAllRecords<Message>("messages")).map((message) => message.id)).toEqual(["m.good"]);
    });
  });
});

describe("the route stays in the address's fragment (a reload never sends a conversation id)", () => {
  function reply(id: string, parentMessageId: string, body: string): Message {
    return { id, type: "channelReply", channelId: "general", parentMessageId, authorId: troll.id, body, createdAt: 200 } as Message;
  }

  it("opening a thread and then a DM leaves the path at /", async () => {
    localStorage.setItem(CONFIRMED_USER_KEY, me.id);
    await seedCache({ messages: [post("m1", troll.id, "a post with a reply"), reply("m2", "m1", "the reply")] });
    stubNode({ content: true, blocks: [] });
    const host = await boot("/channel/general");

    host.querySelector<HTMLButtonElement>(".thread-button")!.click();
    await settle();
    expect(host.querySelector(".thread-panel")).not.toBeNull();
    expect(window.location.pathname).toBe("/");
    expect(window.location.hash).toBe("#/channel/general/thread/m1");

    const toggle = Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.includes("New message"))!;
    toggle.click();
    await settle(5);
    document.querySelector<HTMLAnchorElement>(`.new-message-dialog a[href$="/dm/${troll.id}"]`)!.click();
    await settle();
    expect(host.querySelector(".conversation-header")?.textContent).toContain("Troll");
    expect(window.location.pathname).toBe("/");
    expect(window.location.hash).toBe(`#/dm/${troll.id}`);
  });

  it("a thread whose first post isn't held keeps the conversation on screen, and opens once the post arrives", async () => {
    localStorage.setItem(CONFIRMED_USER_KEY, me.id);
    const fetchMock = stubNode({ content: true, blocks: [] });
    // The history answers a moment after the shell renders, as on a cold deep link.
    let answerHistory: ((response: Response) => void) | undefined;
    vi.stubGlobal("fetch", (input: string, init?: RequestInit) => {
      if (String(input).startsWith("/api/messages/general")) {
        return new Promise<Response>((resolve) => {
          answerHistory = resolve;
        });
      }
      return fetchMock(input, init);
    });
    const host = await boot("/#/channel/general/thread/m1");

    const shell = host.querySelector(".app-shell")!;
    expect(shell.classList.contains("thread-open")).toBe(false);
    expect(host.querySelector(".conversation")).not.toBeNull();
    expect(host.querySelector(".thread-panel")).toBeNull();

    await vi.waitFor(() => expect(answerHistory).toBeDefined());
    answerHistory!(json([post("m1", troll.id, "the first post"), reply("m2", "m1", "the reply")]));
    await settle();
    expect(host.querySelector(".app-shell")!.classList.contains("thread-open")).toBe(true);
    expect(host.querySelector(".thread-panel")).not.toBeNull();
  });

  it("a deep link from before the change (/dm/<id>) still opens that DM, and the path becomes /", async () => {
    localStorage.setItem(CONFIRMED_USER_KEY, me.id);
    stubNode({ content: true, blocks: [] });
    const host = await boot(`/dm/${troll.id}`);

    expect(host.querySelector(".conversation-header")?.textContent).toContain("Troll");
    expect(window.location.pathname).toBe("/");
    expect(window.location.hash).toBe(`#/dm/${troll.id}`);
  });

  it("a join link's #k= is not a route: the app opens on the channel list", async () => {
    stubNode({ content: true, blocks: [] });
    await boot("/#k=0123456789abcdefghijklmnopqrstuvwxyzABCDEFG");

    expect(window.location.pathname).toBe("/");
    expect(window.location.hash).toBe("#/channels");
  });

  it("reads a #/search?q= deep link once and replaces the address before the request goes out", async () => {
    forgetRememberedSearch();
    const fetchMock = stubNode({ content: true, blocks: [] });
    const addresses: string[] = [];
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      if (String(input).startsWith("/api/search")) {
        addresses.push(`${window.location.pathname}${window.location.search}${window.location.hash}`);
      }
      return fetchMock(input, init);
    });
    const host = await boot("/#/search?q=bridge");

    expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/search")).map(([url]) => url)).toEqual(["/api/search?q=bridge"]);
    expect(addresses).toEqual(["/#/search"]);
    expect(window.location.hash).toBe("#/search");
    expect(host.querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe("bridge");
  });

  it("a #/search?q= deep link waits for the session, and runs once after the screen remounts as the confirmed person", async () => {
    forgetRememberedSearch();
    // A first visit, so the confirmed id replaces the page's placeholder and the screen remounts under it.
    const fetchMock = stubNode({ content: true, blocks: [] });
    let releaseBootstrap: (() => void) | undefined;
    const bootstrapHeld = new Promise<void>((resolve) => {
      releaseBootstrap = resolve;
    });
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      if (String(input) === "/api/bootstrap") {
        await bootstrapHeld;
      }
      return fetchMock(input, init);
    });
    const searches = (): unknown[] => fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/search")).map(([url]) => url);

    const host = await boot("/#/search?q=bridge");
    // The shell (and the Search screen) shows once the identity splash gives up waiting, still with no session.
    await new Promise((resolve) => setTimeout(resolve, 1_700));
    await settle();
    expect(host.querySelector('input[type="search"]')).not.toBeNull();
    expect(searches()).toEqual([]);
    expect(window.location.hash).toBe("#/search");

    releaseBootstrap!();
    await vi.waitFor(() => expect(searches()).toEqual(["/api/search?q=bridge"]));
    await settle();
    expect(searches()).toEqual(["/api/search?q=bridge"]);
    expect(window.location.hash).toBe("#/search");
    expect(host.querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe("bridge");
  });

  it("the Mesh screen starts empty when the node confirms a different identity", async () => {
    const meshConfig = { ...networkConfig, enableMesh: true };
    LiveWebSocket.sockets = [];
    vi.stubGlobal("WebSocket", LiveWebSocket);
    const fetchMock = stubNode({ content: true, blocks: [], networkConfig: { enableMesh: true } });
    let newcomerConfirmed = false;
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/mesh/identity") {
        return pending();
      }
      if (url === "/api/mesh/contacts") {
        // The first identity's address book; the newcomer's never answers, so only a fresh screen is empty.
        return newcomerConfirmed ? pending() : json([{ meshId: "mesh.oldfriend", displayName: "Old friend" }]);
      }
      if (newcomerConfirmed && url === "/api/config") {
        return json({ joinUrl: "http://node.test/", websocketPath: "/ws", networkConfig: meshConfig, currentUser: { ...me, id: "user.newcomer" } });
      }
      return fetchMock(input, init);
    });
    const host = await boot("/mesh");
    LiveWebSocket.sockets.at(-1)!.open();
    await settle();
    expect(host.textContent).toContain("Old friend");

    // The node hands this browser a new identity while the socket is down (its session was reset).
    newcomerConfirmed = true;
    LiveWebSocket.sockets.at(-1)!.drop();
    window.dispatchEvent(new Event("online"));
    await settle();
    LiveWebSocket.sockets.at(-1)!.open();
    await settle();

    expect(localStorage.getItem(CONFIRMED_USER_KEY)).toBe("user.newcomer");
    expect(host.textContent).not.toContain("Old friend");
  });
});

describe("a pinned client takes its network settings through the tunnel (review 2026-11-18)", () => {
  const PIN_KEY = `loam.transportHostKey.${window.location.origin}`;
  const bot: User = { id: "llm.ollama.gemma4", displayName: "Assistant", type: "bot", isAdmin: false, createdAt: 1, ephemeral: false };
  const onHost: Partial<NetworkConfig> = {
    enableLLMChat: true,
    enableLLMStreaming: true,
    assistantDestination: { kind: "host" },
    assistantDestinationRevision: "a".repeat(32),
  };
  const online: Partial<NetworkConfig> = {
    ...onHost,
    assistantDestination: { kind: "online", host: "chat.example.com" },
    assistantDestinationRevision: "b".repeat(32),
  };

  /** The base64 of a JSON value, as a tunnel descriptor's `bodyB64`. */
  function base64Json(value: unknown): string {
    return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))));
  }

  /**
   * A node for a client pinned to `host`. The plaintext `/api/bootstrap` answers with `bootstrapConfig` and
   * the join URL `http://forged.test/` (what someone on the path could put there); the tunnelled
   * `/api/config` answers with `state.tunnelConfig` and the real join URL, or with `state.configStatus` when
   * that is set. A DM to the bot is refused with a 409, and the tunnelled config then switches to `online`.
   */
  function stubTunnelNode(host: ReturnType<typeof createTransportIdentity>, bootstrapConfig: Partial<NetworkConfig>, tunnelConfig: Partial<NetworkConfig>) {
    const state = {
      sessionKey: undefined as string | undefined,
      tunnelConfig,
      configStatus: undefined as number | undefined,
      handshakes: 0,
      resumes: 0,
      tunnelledConfigReads: 0,
    };
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/bootstrap") {
        return json({ joinUrl: "http://forged.test/", websocketPath: "/ws", networkConfig: { ...networkConfig, transportEncryption: "optional", transportPublicKey: host.publicKey, ...bootstrapConfig } });
      }
      if (url === "/api/transport/handshake") {
        state.handshakes += 1;
        const { clientEphemeralPublic } = JSON.parse(String(init?.body)) as { clientEphemeralPublic: string };
        const accepted = transportServerAccept({ hostSecret: host.secretKey, clientEphemeralPublic });
        state.sessionKey = accepted.sessionKey;
        return json({ sessionId: `sess-${state.handshakes}`, hostEphemeralPublic: accepted.hostEphemeralPublic, hostPublicKey: host.publicKey });
      }
      const key = state.sessionKey!;
      const { enc } = JSON.parse(String(init?.body)) as { enc: string };
      if (url === "/api/session/resume") {
        state.resumes += 1;
        const envelope = JSON.parse(openTransport(key, enc, "POST /api/session/resume") ?? "{}") as { s: number };
        const reply = { s: envelope.s, m: "POST", p: "/api/session/resume", currentUser: me, token: "token-1" };
        const aad = `loam.transport.response.v2 ${JSON.stringify(["POST", "/api/session/resume", envelope.s, 200])}`;
        return new Response(JSON.stringify({ enc: sealTransport(key, JSON.stringify(reply), aad) }), { status: 200, headers: { "x-loam-enc": "1" } });
      }
      if (url !== "/api/transport/tunnel") {
        return pending();
      }
      const envelope = openTunnelRequest(key, init)!;
      const b = envelope.b as { m: string; p: string; body?: Record<string, unknown> };
      const inner = (status: number, value: unknown) => tunnelDescriptorReply(key, envelope, { status, bodyB64: base64Json(value) });
      if (b.p === "/api/config") {
        state.tunnelledConfigReads += 1;
        if (state.configStatus !== undefined) {
          return inner(state.configStatus, { error: "Internal server error", code: "internal_error" });
        }
        return inner(200, { joinUrl: "http://node.test/", websocketPath: "/ws", currentUser: me, networkConfig: { ...networkConfig, transportEncryption: "optional", transportPublicKey: host.publicKey, ...state.tunnelConfig } });
      }
      if (b.p === "/api/users/me/blocks") return inner(200, { blockedUserIds: [] });
      if (b.p === "/api/channels") return inner(200, [general]);
      if (b.p === "/api/users") return inner(200, [me, bot]);
      if (b.p === "/api/dms") return inner(200, { conversations: [] });
      if (b.p.startsWith("/api/dms/")) return inner(200, []);
      if (b.p === "/api/messages" && b.m === "POST" && b.body?.recipientUserId === bot.id) {
        state.tunnelConfig = online;
        return inner(409, { error: "The assistant now answers from somewhere else; check where, then send again", code: "assistant_destination_changed" });
      }
      return pending();
    });
    vi.stubGlobal("fetch", fetchMock);
    return { fetchMock, state };
  }

  const bootstrapReads = (fetchMock: ReturnType<typeof vi.fn>): number =>
    fetchMock.mock.calls.filter(([input]) => String(input) === "/api/bootstrap").length;

  it("shows the tunnelled assistant destination and prunes by the tunnelled retention, not the bootstrap's", async () => {
    const host = createTransportIdentity();
    localStorage.setItem(PIN_KEY, host.publicKey);
    // The plaintext bootstrap names a destination on the host while passing the real revision through, and
    // a longer retention; the tunnelled copy is the node's own.
    const { state } = stubTunnelNode(host, { ...online, assistantDestination: { kind: "host" }, messageTtlMs: 7 * 86_400_000 }, { ...online, messageTtlMs: 3_600_000 });
    const root = await boot(`/dm/${bot.id}`);

    const header = root.querySelector(".conversation-header")?.textContent ?? "";
    expect(header).toContain("Answers come from chat.example.com, an online service");
    expect(header).not.toContain("Runs on the host's computer");
    expect(state.tunnelledConfigReads).toBeGreaterThan(0);
    await vi.waitFor(async () => expect(await getAllRecords("sync")).toContainEqual({ id: "retention", messageTtlMs: 3_600_000 }));
  });

  it("after a 409 assistant_destination_changed, reloads the settings through the tunnel without a new session", async () => {
    const host = createTransportIdentity();
    localStorage.setItem(PIN_KEY, host.publicKey);
    // The bootstrap keeps saying "on the host"; only the node's tunnelled answer says where replies now go.
    const { fetchMock, state } = stubTunnelNode(host, onHost, onHost);
    const root = await boot(`/dm/${bot.id}`);
    expect(root.querySelector(".conversation-header")?.textContent).toContain("Runs on the host's computer");
    const before = { bootstraps: bootstrapReads(fetchMock), handshakes: state.handshakes, resumes: state.resumes, reads: state.tunnelledConfigReads };

    const field = root.querySelector<HTMLTextAreaElement>(".conversation .composer textarea")!;
    field.value = "a question for the local model";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    root.querySelector<HTMLFormElement>(".conversation form.composer")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();

    expect(root.querySelector(".conversation-header")?.textContent).toContain("Answers come from chat.example.com, an online service");
    expect(state.tunnelledConfigReads).toBe(before.reads + 1);
    expect(bootstrapReads(fetchMock)).toBe(before.bootstraps);
    expect(state.handshakes).toBe(before.handshakes);
    expect(state.resumes).toBe(before.resumes);
  });

  it("a failed tunnelled config read fails the boot; the bootstrap copy is never used instead", async () => {
    const host = createTransportIdentity();
    localStorage.setItem(PIN_KEY, host.publicKey);
    const { state } = stubTunnelNode(host, { ...onHost, messageTtlMs: 7 * 86_400_000 }, online);
    state.configStatus = 500;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const root = await boot(`/dm/${bot.id}`);

    expect(root.textContent).not.toContain("Runs on the host's computer");
    expect(state.tunnelledConfigReads).toBeGreaterThan(0);
    expect(await getAllRecords("sync")).not.toContainEqual({ id: "retention", messageTtlMs: 7 * 86_400_000 });
  });
});

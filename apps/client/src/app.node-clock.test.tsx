// A host's clock is often wrong off-grid (a Raspberry Pi has no battery clock). Messages carry the host's
// stamps, so retention has to be judged by the host's clock, not this device's.
import { type Channel, MEMBER_RULES_VERSION, type Message, type NetworkConfig, type User } from "@loam/schema";
import { IDBFactory } from "fake-indexeddb";
import { render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./app";
import { CONFIRMED_USER_KEY } from "./lib/identity";
import { destroyDatabase, getAllRecords, resetLocalStoreForTests } from "./lib/local-store";
import { forgetNodeClockForTests } from "./lib/retention";
import { resetTransportStateForTests } from "./lib/transport";

vi.mock("./lib/link-code-fragment", () => ({ linkCodePresentAtStartup: vi.fn(() => false) }));

const HOUR = 3_600_000;

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
  // The `hardened` profile's forced retention: one hour.
  messageTtlMs: HOUR,
};

const me: User = { id: "user.me", displayName: "Me", type: "human", isAdmin: false, createdAt: 1, ephemeral: true, rulesVersion: MEMBER_RULES_VERSION };
const other: User = { id: "user.other", displayName: "Other", type: "human", isAdmin: false, createdAt: 1, ephemeral: true };
const general: Channel = { id: "general", name: "general", visibility: "public", allowPosting: "everyone", allowReplies: true, discoverable: true, createdAt: 1 };
const second: Channel = { ...general, id: "second", name: "second" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

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

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  resetLocalStoreForTests();
  resetTransportStateForTests();
  localStorage.clear();
  forgetNodeClockForTests();
  LiveWebSocket.sockets = [];
  vi.stubGlobal("WebSocket", LiveWebSocket);
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

describe("retention on a network whose host clock is behind this device's", () => {
  it("keeps a message the host stamped a moment ago, although this device's clock says it is two hours old", async () => {
    localStorage.setItem(CONFIRMED_USER_KEY, me.id);
    const serverClock = (): number => Date.now() - 2 * HOUR;
    const sent: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        const url = String(input);
        const bootstrap = { joinUrl: "http://node.test/", websocketPath: "/ws", networkConfig, serverTime: serverClock() };
        if (url === "/api/bootstrap") return json(bootstrap);
        if (url === "/api/config") return json({ ...bootstrap, currentUser: me });
        if (url === "/api/users/me/blocks") return json({ blockedUserIds: [] });
        if (url === "/api/channels") return json([general]);
        if (url === "/api/users") return json([me, other]);
        if (url === "/api/dms") return json({ conversations: [] });
        if (url === "/api/messages/general") return json([]);
        if (url === "/api/messages" && init?.method === "POST") {
          const request = JSON.parse(String(init.body)) as { body: string };
          sent.push(request.body);
          // The node stamps the message with ITS clock.
          return json({ message: { id: "mine", type: "channelPost", channelId: "general", authorId: me.id, body: request.body, createdAt: serverClock() } });
        }
        return new Promise<Response>(() => {});
      }),
    );

    window.history.replaceState(null, "", "/#/channel/general");
    container = document.createElement("div");
    document.body.appendChild(container);
    render(<App />, container);
    await settle();

    const socket = LiveWebSocket.sockets.at(-1)!;
    socket.open();
    await settle();

    // Someone posts right now; the node stamps it with its own clock.
    socket.deliver({
      type: "messageCreated",
      message: { id: "live1", type: "channelPost", channelId: "general", authorId: other.id, body: "are you there?", createdAt: serverClock() },
    });
    await settle();
    expect(container.textContent).toContain("are you there?");
    expect((await getAllRecords<Message>("messages")).map((message) => message.id)).toEqual(["live1"]);

    // An ordinary event that changes the channel list (someone creates a channel) re-runs the prune at once;
    // without it the 60 s interval does the same.
    socket.deliver({ type: "channelUpserted", channel: second });
    await settle();

    // The node (one hour's retention) keeps it for another hour, so this device does too.
    expect(container.textContent).toContain("are you there?");
    expect((await getAllRecords<Message>("messages")).map((message) => message.id)).toEqual(["live1"]);
  });
});

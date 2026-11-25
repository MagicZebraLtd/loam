// Member safety: nobody can wear another person's name or avatar, a removed picture is gone at once, a
// moderator removes only what they can see or what was reported, mesh sender records stay out of shared
// views, a shadow ban sends nothing, and an attachment's stored name fits its type.
import { existsSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { MessageSchema } from "@loam/schema";

import type { LoamApp } from "./app.js";
import { displayNameComparisonForm, makeUser, stripControlAndFormatCharacters } from "./identity.js";
import { attachmentStoredName, sanitizeAttachmentName } from "./media.js";
import { type InjectResponse, makeApp, newSession, reopenApp, teardownApps } from "./test-support/app-harness.js";

afterEach(teardownApps);

const editable = { identity: { allowUserDisplayNameEdit: true, allowUserAvatarEdit: true, allowUserAvatarUpload: true } };
const botId = "llm.bot.test";
const withAssistant = {
  ...editable,
  llm: { ollama: { enabled: true, baseUrl: "http://localhost:11434", model: "m", botId, botDisplayName: "Helper Bot" } },
};

function patch(app: LoamApp, cookie: string, url: string, payload: unknown): Promise<InjectResponse> {
  return app.server.inject({ method: "PATCH", url, headers: { cookie }, payload: payload as Record<string, unknown> });
}

describe("displayNameComparisonForm", () => {
  it("folds case, hidden characters and whitespace runs", () => {
    expect(displayNameComparisonForm("Alice")).toBe("alice");
    expect(displayNameComparisonForm("ALICE")).toBe("alice");
    expect(displayNameComparisonForm("Al\u200Dice")).toBe("alice");
    expect(displayNameComparisonForm("  Alice \t ")).toBe("alice");
    expect(displayNameComparisonForm("Alice   Smith")).toBe("alice smith");
    expect(displayNameComparisonForm("\u202EAlice\uFEFF")).toBe("alice");
    expect(displayNameComparisonForm("\u200B\u2060\u00AD")).toBe("");
  });

  it("applies NFKC where the runtime has it", () => {
    expect(displayNameComparisonForm("\uFF21lice")).toBe("alice");
  });

  it("still strips, collapses and lower-cases when normalize does nothing or throws", () => {
    const noop = vi.spyOn(String.prototype, "normalize").mockImplementation(function (this: string) {
      return String(this);
    });
    try {
      expect(displayNameComparisonForm("AL\u200Dice  B")).toBe("alice b");
    } finally {
      noop.mockRestore();
    }
    const throwing = vi.spyOn(String.prototype, "normalize").mockImplementation(() => {
      throw new RangeError("no ICU");
    });
    try {
      expect(displayNameComparisonForm("Al\u2066ice")).toBe("alice");
    } finally {
      throwing.mockRestore();
    }
  });

  it("strips each listed control and format range", () => {
    const hidden = "\u0000\u001F\u007F\u009F\u00AD\u061C\u180E\u200B\u200F\u202A\u202E\u2060\u2064\u2066\u206F\uFEFF\uFFF9\uFFFB";
    expect(stripControlAndFormatCharacters(`a${hidden}b`)).toBe("ab");
  });
});

describe("names and avatar seeds on profile edits", () => {
  it("refuses another member's name in any disguise", async () => {
    const app = await makeApp(editable);
    await newSession(app);
    const alice = await newSession(app);
    const mallory = await newSession(app);
    expect((await patch(app, alice.cookie, "/api/users/me", { displayName: "Alice Smith" })).statusCode).toBe(200);

    for (const copy of ["Alice Smith", "alice SMITH", "Alice\u200D Smith", "Alice Smith   ", "Alice   Smith"]) {
      const taken = await patch(app, mallory.cookie, "/api/users/me", { displayName: copy });
      expect(taken.statusCode).toBe(400);
      expect(taken.json()).toMatchObject({ code: "display_name_taken" });
    }
  });

  it("refuses the assistant's name, and a name made only of hidden characters", async () => {
    const app = await makeApp(withAssistant);
    await newSession(app);
    const member = await newSession(app);
    const bot = await patch(app, member.cookie, "/api/users/me", { displayName: "helper bot" });
    expect(bot.statusCode).toBe(400);
    expect(bot.json()).toMatchObject({ code: "display_name_taken" });

    const empty = await patch(app, member.cookie, "/api/users/me", { displayName: "\u200B\u200D" });
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toMatchObject({ code: "invalid_user_update" });
  });

  it("treats blank-looking fillers and variation selectors as hidden when comparing names, and stores an emoji name as typed", async () => {
    const app = await makeApp(editable);
    await newSession(app);
    const sam = await newSession(app);
    const copier = await newSession(app);
    expect((await patch(app, sam.cookie, "/api/users/me", { displayName: "Sam" })).statusCode).toBe(200);

    for (const copy of ["Samㅤ", "S͏am", "Sam️", "Sam\u{E0041}", "Sam\u{E0100}", "ᅟSamᅠ", "Samﾠ"]) {
      const taken = await patch(app, copier.cookie, "/api/users/me", { displayName: copy });
      expect(taken.statusCode).toBe(400);
      expect(taken.json()).toMatchObject({ code: "display_name_taken" });
    }

    const blank = await patch(app, copier.cookie, "/api/users/me", { displayName: "⠀⠀" });
    expect(blank.statusCode).toBe(400);
    expect(blank.json()).toMatchObject({ code: "invalid_user_update" });

    const heart = "Sam ❤️";
    expect((await patch(app, copier.cookie, "/api/users/me", { displayName: heart })).statusCode).toBe(200);
    expect(app.store.loadUsers().find((user) => user.id === copier.userId)?.displayName).toBe(heart);
  });

  it("lets a member keep their own name and use their own id or a typed word as a seed", async () => {
    const app = await makeApp(editable);
    await newSession(app);
    const alice = await newSession(app);
    expect((await patch(app, alice.cookie, "/api/users/me", { displayName: "Alice" })).statusCode).toBe(200);
    expect((await patch(app, alice.cookie, "/api/users/me", { displayName: "Alice" })).statusCode).toBe(200);
    expect((await patch(app, alice.cookie, "/api/users/me", { displayName: "ALICE" })).statusCode).toBe(200);
    expect(
      (await patch(app, alice.cookie, "/api/users/me", { avatar: { kind: "generated", seed: alice.userId, mode: "face" } })).statusCode,
    ).toBe(200);
    expect(
      (await patch(app, alice.cookie, "/api/users/me", { avatar: { kind: "generated", seed: "sunflower", mode: "face" } })).statusCode,
    ).toBe(200);
    // Sent back unchanged with the next save, it is still hers.
    expect(
      (await patch(app, alice.cookie, "/api/users/me", { displayName: "ALICE", avatar: { kind: "generated", seed: "sunflower", mode: "pattern" } }))
        .statusCode,
    ).toBe(200);
  });

  it("refuses a seed that is another person's id or seed, or a reserved id prefix", async () => {
    const app = await makeApp(withAssistant);
    await newSession(app);
    const alice = await newSession(app);
    const mallory = await newSession(app);
    expect(
      (await patch(app, alice.cookie, "/api/users/me", { avatar: { kind: "generated", seed: "sunflower" } })).statusCode,
    ).toBe(200);

    for (const seed of [alice.userId, "sunflower", botId, "user.0000000000000000", "llm.anything", "mesh.abc"]) {
      const refused = await patch(app, mallory.cookie, "/api/users/me", { avatar: { kind: "generated", seed, mode: "face" } });
      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toMatchObject({ code: "invalid_user_update" });
    }
  });

  it("lets two people who already share a seed keep it when they save", async () => {
    const { app, dataDir } = await makeApp(editable);
    await newSession(app);
    const alice = await newSession(app);
    const bob = await newSession(app);
    // As an earlier version left them: both chose the same word before seeds had to differ.
    for (const session of [alice, bob]) {
      const user = app.store.loadUsers().find((candidate) => candidate.id === session.userId)!;
      app.store.upsertUser({ ...user, avatar: { kind: "generated", seed: "sunflower", mode: "face" } });
    }
    const reopened = await reopenApp(app, dataDir);

    const saved = await patch(reopened, bob.cookie, "/api/users/me", {
      displayName: "Bob the builder",
      avatar: { kind: "generated", seed: "sunflower", mode: "pattern" },
    });
    expect(saved.statusCode).toBe(200);
    // Taking it up anew is still refused.
    const carol = await newSession(reopened);
    expect(
      (await patch(reopened, carol.cookie, "/api/users/me", { avatar: { kind: "generated", seed: "sunflower" } })).statusCode,
    ).toBe(400);
  });

  it("applies both rules to the admin's edit of a member", async () => {
    const app = await makeApp(editable);
    const admin = await newSession(app);
    const alice = await newSession(app);
    const member = await newSession(app);
    expect((await patch(app, alice.cookie, "/api/users/me", { displayName: "Alice" })).statusCode).toBe(200);

    const name = await patch(app, admin.cookie, `/api/users/${member.userId}`, { displayName: "alice" });
    expect(name.statusCode).toBe(400);
    expect(name.json()).toMatchObject({ code: "display_name_taken" });
    const seed = await patch(app, admin.cookie, `/api/users/${member.userId}`, { avatar: { kind: "generated", seed: alice.userId } });
    expect(seed.statusCode).toBe(400);
    expect(seed.json()).toMatchObject({ code: "invalid_user_update" });
    expect((await patch(app, admin.cookie, `/api/users/${member.userId}`, { avatar: { kind: "generated", seed: member.userId } })).statusCode).toBe(200);
  });
});

describe("a removed profile picture", () => {
  const webp = Buffer.from("RIFF\0\0\0\0WEBP").toString("base64");

  it("is deleted from disk and no longer served as soon as the avatar changes", async () => {
    const { app, dataDir } = await makeApp(editable);
    await newSession(app);
    const member = await newSession(app);
    const upload = await app.server.inject({
      method: "PUT",
      url: "/api/users/me/avatar-image",
      headers: { cookie: member.cookie },
      payload: { mimeType: "image/webp", data: webp },
    });
    expect(upload.statusCode).toBe(200);
    const imageId = (upload.json() as { avatar: { imageId: string } }).avatar.imageId;
    const file = join(dataDir, "avatars", `${imageId}.webp`);
    expect(existsSync(file)).toBe(true);
    expect((await app.server.inject({ method: "GET", url: `/api/avatars/${imageId}.webp` })).statusCode).toBe(200);

    const switched = await patch(app, member.cookie, "/api/users/me", { avatar: { kind: "generated", seed: member.userId } });
    expect(switched.statusCode).toBe(200);
    expect(existsSync(file)).toBe(false);
    expect((await app.server.inject({ method: "GET", url: `/api/avatars/${imageId}.webp` })).statusCode).toBe(404);
  });

  it("is also deleted when an admin resets it", async () => {
    const { app, dataDir } = await makeApp(editable);
    const admin = await newSession(app);
    const member = await newSession(app);
    const upload = await app.server.inject({
      method: "PUT",
      url: "/api/users/me/avatar-image",
      headers: { cookie: member.cookie },
      payload: { mimeType: "image/webp", data: webp },
    });
    const imageId = (upload.json() as { avatar: { imageId: string } }).avatar.imageId;
    expect((await patch(app, admin.cookie, `/api/users/${member.userId}`, { avatar: { kind: "generated", seed: member.userId } })).statusCode).toBe(200);
    expect(existsSync(join(dataDir, "avatars", `${imageId}.webp`))).toBe(false);
  });

  it("is swept on the 30 second reaper tick when nothing references it, but never while it is fresh", async () => {
    vi.useFakeTimers({ toFake: ["setInterval"] });
    const { app, dataDir } = await makeApp(editable);
    const member = await newSession(app);
    await app.server.inject({
      method: "PUT",
      url: "/api/users/me/avatar-image",
      headers: { cookie: member.cookie },
      payload: { mimeType: "image/webp", data: webp },
    });
    const stale = join(dataDir, "avatars", "avt_0123456789abcdef.webp");
    const fresh = join(dataDir, "avatars", "avt_fedcba9876543210.webp");
    writeFileSync(stale, "RIFF\0\0\0\0WEBP");
    writeFileSync(fresh, "RIFF\0\0\0\0WEBP");
    const old = new Date(Date.now() - 60 * 60_000);
    utimesSync(stale, old, old);

    vi.advanceTimersByTime(30_000);
    const deadline = Date.now() + 3_000;
    while (existsSync(stale) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });
});

describe("moderator message removal scope", () => {
  it("answers like an unknown message for a DM between two others, until one of them reports it", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const mod = await newSession(app);
    const alice = await newSession(app);
    const bob = await newSession(app);
    expect((await patch(app, admin.cookie, `/api/admin/users/${mod.userId}/roles`, { roles: ["moderator"] })).statusCode).toBe(200);
    const dm = await app.server.inject({
      method: "POST",
      url: "/api/messages",
      headers: { cookie: alice.cookie },
      payload: { type: "dm", recipientUserId: bob.userId, body: "just between us" },
    });
    const dmId = (dm.json() as { message: { id: string } }).message.id;
    const remove = (cookie: string, id: string) =>
      app.server.inject({ method: "POST", url: `/api/moderation/messages/${id}/remove`, headers: { cookie }, payload: {} });

    const unknown = await remove(mod.cookie, "msg_doesnotexist");
    for (const cookie of [mod.cookie, admin.cookie]) {
      const refused = await remove(cookie, dmId);
      expect(refused.statusCode).toBe(unknown.statusCode);
      expect(refused.json()).toEqual(unknown.json());
    }
    expect(app.store.loadMessages().find((message) => message.id === dmId)).toMatchObject({ body: "just between us" });

    const report = await app.server.inject({
      method: "POST",
      url: "/api/reports",
      headers: { cookie: bob.cookie },
      payload: { targetType: "message", targetId: dmId, reason: "harassment" },
    });
    expect(report.statusCode).toBe(201);
    expect((await remove(mod.cookie, dmId)).statusCode).toBe(200);
    expect(app.store.loadMessages().find((message) => message.id === dmId)).toMatchObject({ body: "" });
  });
});

describe("mesh sender records", () => {
  const meshId = "mesh.0123456789abcdef0123456789abcdef";

  /** A node with a mesh sender's display record that has mailed `recipient` only. */
  async function withMeshSender(): Promise<{
    app: LoamApp;
    admin: { cookie: string; userId: string };
    recipient: { cookie: string; userId: string };
    bystander: { cookie: string; userId: string };
  }> {
    const { app, dataDir } = await makeApp();
    const admin = await newSession(app);
    const recipient = await newSession(app);
    const bystander = await newSession(app);
    app.store.upsertUser(makeUser(meshId));
    app.store.insertMessage(
      MessageSchema.parse({
        id: "mesh_planted0001",
        type: "dm",
        authorId: meshId,
        recipientUserId: recipient.userId,
        body: "carried mail",
        createdAt: Date.now(),
        meta: { source: "system" },
      }),
    );
    return { app: await reopenApp(app, dataDir), admin, recipient, bystander };
  }

  /** Expect `response` to be exactly the answer `unknown` got. */
  function sameAs(response: InjectResponse, unknown: InjectResponse): void {
    expect(response.statusCode).toBe(unknown.statusCode);
    expect(response.json()).toEqual(unknown.json());
  }

  it("is left out of the moderation roster", async () => {
    const { app, admin } = await withMeshSender();
    const roster = (await app.server.inject({ method: "GET", url: "/api/moderation/users", headers: { cookie: admin.cookie } })).json() as {
      id: string;
    }[];
    expect(roster.length).toBeGreaterThan(0);
    expect(roster.some((user) => user.id === meshId)).toBe(false);
  });

  it("answers like an unknown id on the moderation, roles, promote, admin edit, approve and deny routes", async () => {
    const { app, admin } = await withMeshSender();
    const unknownId = "user.ffffffffffffffff";
    const routes: { method: "PATCH" | "POST"; url: (id: string) => string; payload?: Record<string, unknown> }[] = [
      { method: "PATCH", url: (id) => `/api/moderation/users/${id}`, payload: { banned: true } },
      { method: "PATCH", url: (id) => `/api/admin/users/${id}/roles`, payload: { roles: ["moderator"] } },
      { method: "POST", url: (id) => `/api/admin/users/${id}/promote` },
      { method: "PATCH", url: (id) => `/api/users/${id}`, payload: { displayName: "Renamed" } },
      { method: "POST", url: (id) => `/api/access/users/${id}/approve` },
      { method: "POST", url: (id) => `/api/access/users/${id}/deny` },
    ];
    for (const route of routes) {
      const send = (id: string) =>
        app.server.inject({ method: route.method, url: route.url(id), headers: { cookie: admin.cookie }, ...(route.payload ? { payload: route.payload } : {}) });
      sameAs(await send(meshId), await send(unknownId));
    }
    const stored = app.store.loadUsers().find((user) => user.id === meshId);
    expect(stored?.banned).toBeUndefined();
    expect(stored?.isAdmin).toBe(false);
    expect(stored?.roles).toBeUndefined();
  });

  it("answers a DM like an unknown recipient unless the sender has mailed the caller", async () => {
    const { app, recipient, bystander } = await withMeshSender();
    const dm = (cookie: string, recipientUserId: string) =>
      app.server.inject({ method: "POST", url: "/api/messages", headers: { cookie }, payload: { type: "dm", recipientUserId, body: "hi" } });

    sameAs(await dm(bystander.cookie, meshId), await dm(bystander.cookie, "user.ffffffffffffffff"));
    const seen = await dm(recipient.cookie, meshId);
    expect(seen.statusCode).toBe(403);
    expect(seen.json()).toMatchObject({ code: "dm_unavailable" });
  });

  it("answers a user report like an unknown user unless the reporter can see the sender", async () => {
    const { app, recipient, bystander } = await withMeshSender();
    const report = (cookie: string, targetId: string) =>
      app.server.inject({ method: "POST", url: "/api/reports", headers: { cookie }, payload: { targetType: "user", targetId, reason: "spam" } });

    sameAs(await report(bystander.cookie, meshId), await report(bystander.cookie, "user.ffffffffffffffff"));
    expect((await report(recipient.cookie, meshId)).statusCode).toBe(201);
  });
});

describe("shadow ban broadcasts", () => {
  type WireEvent = { type?: string; user?: { id?: string; banned?: boolean; roles?: string[] } };
  const openSockets: WebSocket[] = [];

  afterEach(() => {
    for (const socket of openSockets) {
      socket.close();
    }
    openSockets.length = 0;
  });

  function connect(baseUrl: string, cookie: string): Promise<WireEvent[]> {
    return new Promise((resolve, reject) => {
      const socket = new (WebSocket as unknown as new (url: string, opts: unknown) => WebSocket)(`${baseUrl.replace("http", "ws")}/ws`, {
        headers: { cookie },
      });
      const events: WireEvent[] = [];
      socket.addEventListener("message", (event) => events.push(JSON.parse(String((event as MessageEvent).data)) as WireEvent));
      socket.addEventListener("open", () => {
        openSockets.push(socket);
        resolve(events);
      });
      socket.addEventListener("error", () => reject(new Error("websocket failed to connect")));
    });
  }

  async function waitFor(check: () => boolean): Promise<boolean> {
    const deadline = Date.now() + 3_000;
    while (!check() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return check();
  }

  it("sends no userUpserted for a shadow ban or its lifting, while a role change and a ban still go out", async () => {
    const app = await makeApp();
    const admin = await newSession(app);
    const target = await newSession(app);
    const bystander = await newSession(app);
    const baseUrl = await app.server.listen({ port: 0, host: "127.0.0.1" });
    const targetEvents = await connect(baseUrl, target.cookie);
    const bystanderEvents = await connect(baseUrl, bystander.cookie);
    const adminEvents = await connect(baseUrl, admin.cookie);
    const upserts = (events: WireEvent[]) => events.filter((event) => event.type === "userUpserted" && event.user?.id === target.userId);
    const moderate = (payload: Record<string, unknown>) => patch(app, admin.cookie, `/api/moderation/users/${target.userId}`, payload);

    expect((await moderate({ shadowBanned: true })).statusCode).toBe(200);
    expect((await moderate({ shadowBanned: false })).statusCode).toBe(200);
    expect((await patch(app, admin.cookie, `/api/admin/users/${target.userId}/roles`, { roles: ["greeter"] })).statusCode).toBe(200);
    expect(await waitFor(() => upserts(targetEvents).length > 0 && upserts(bystanderEvents).length > 0)).toBe(true);
    // The role change is the only upsert either socket saw: the shadow ban and its lifting sent nothing.
    expect(upserts(targetEvents)).toHaveLength(1);
    expect(upserts(targetEvents)[0]?.user?.roles).toEqual(["greeter"]);
    expect(upserts(bystanderEvents)).toHaveLength(1);

    expect((await moderate({ banned: true })).statusCode).toBe(200);
    expect(await waitFor(() => upserts(adminEvents).some((event) => event.user?.banned === true))).toBe(true);
  });
});

describe("attachment stored names", () => {
  it("strips hidden characters and falls back to the default name", () => {
    expect(sanitizeAttachmentName("in\u202Evoice\u200B.pdf")).toBe("invoice.pdf");
    expect(sanitizeAttachmentName("\u202E\u200B\u2066")).toBe("file");
  });

  it("makes the name end with an extension that fits the declared type", () => {
    expect(attachmentStoredName("update.apk", "text/plain")).toBe("update.apk.txt");
    expect(attachmentStoredName("invoice\u202Efdp.exe", "application/pdf")).toBe("invoicefdp.exe.pdf");
    expect(attachmentStoredName("notes.txt", "text/plain")).toBe("notes.txt");
    expect(attachmentStoredName("server.log", "text/plain")).toBe("server.log");
    expect(attachmentStoredName("REPORT.PDF", "application/pdf")).toBe("REPORT.PDF");
    expect(attachmentStoredName("Deck.PPTX", "application/vnd.openxmlformats-officedocument.presentationml.presentation")).toBe("Deck.PPTX");
    expect(attachmentStoredName("\u202E\u200B", "text/csv")).toBe("file.csv");
    expect(attachmentStoredName(undefined, "application/zip")).toBe("file.zip");
    const long = attachmentStoredName(`${"a".repeat(255)}`, "application/json");
    expect(long).toHaveLength(255);
    expect(long.endsWith(".json")).toBe(true);
  });

  it("stores the fitted name on upload", async () => {
    const app = await makeApp();
    const member = await newSession(app);
    const upload = (name: string, mimeType: string) =>
      app.server.inject({
        method: "POST",
        url: "/api/attachments",
        headers: { cookie: member.cookie },
        payload: { mimeType, data: Buffer.from("hello").toString("base64"), name },
      });
    const apk = await upload("update.apk", "text/plain");
    expect(apk.statusCode).toBe(201);
    expect(apk.json()).toMatchObject({ name: "update.apk.txt" });
    expect((await upload("cv\u202Efdp.exe", "application/pdf")).json()).toMatchObject({ name: "cvfdp.exe.pdf" });
    expect((await upload("table.CSV", "text/csv")).json()).toMatchObject({ name: "table.CSV" });
  });
});

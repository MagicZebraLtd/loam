// Liveness, public bootstrap, authenticated config, and cookie session end, registered over the shared
// AppContext.
import type { AppContext } from "./app-context.js";
import { sessionCookieName } from "./defaults.js";
import { readCookie } from "./identity.js";

/** Register liveness, public bootstrap, authenticated config, and cookie session end. */
export function registerSessionRoutes(ctx: AppContext): void {
  // Liveness probe that mints NO identity — the Android host launcher polls this before loading the
  // WebView. Polling /api/config here would consume the one-time `firstUser` admin grant with a
  // throwaway loopback session, leaving the real operator (and the kill switch) locked out.
  ctx.server.get("/api/health", async () => ({ ok: true }));

  // Public, cookie-free bootstrap (docs/20). Returns ONLY public data — node name, version, connection
  // details, and the network config (which advertises the transport mode + host public key). Mints NO
  // identity and sets NO cookie, so a `required`/bound client can learn how to connect before it has a
  // session, and no bearer credential is ever established over plaintext. The client fetches this FIRST,
  // with `credentials: "omit"`. Unlike `/api/config`, it never returns `currentUser`.
  //
  // `hostNoLocalCache` (docs/02): a browser on the host machine itself (loopback: the `loamnet` operator's own
  // browser, which no launcher injects into) is told to keep no IndexedDB copy while the database is encrypted,
  // the hint the desktop and Android hosts give their own windows as `window.__loamHostNoLocalCache`. That
  // copy would sit on the host's disk in the clear, outside the key, and outlive an Emergency Reset or an
  // ephemeral key. Never sent to a LAN joiner (the tunnel forwards the real caller's address); behind a
  // same-host reverse proxy every caller is loopback and simply caches nothing.
  ctx.server.get("/api/bootstrap", async (request) => ({
    nodeName: ctx.appConfig.node.name,
    version: ctx.options.version ?? "dev",
    joinUrl: `http://${ctx.currentJoinHost()}:${ctx.clientPort}`,
    websocketPath: "/ws",
    networkConfig: ctx.currentNetworkConfig(),
    ...(ctx.dbState.encryptionEnabled && ctx.requestFromLoopback(request) ? { hostNoLocalCache: true } : {}),
  }));

  ctx.server.get("/api/config", async (request, reply) => {
    const currentUser = ctx.ensureSessionUser(ctx.getSessionUserId(request, reply));

    return {
      nodeName: ctx.appConfig.node.name,
      version: ctx.options.version ?? "dev",
      joinUrl: `http://${ctx.currentJoinHost()}:${ctx.clientPort}`,
      websocketPath: "/ws",
      currentUser: ctx.rolesVisibleUser(currentUser),
      networkConfig: ctx.currentNetworkConfig(),
    };
  });

  // End the caller's own session: invalidate the token server-side and clear the cookie. A device
  // wipe calls this so that a reload afterwards mints a FRESH identity instead of re-presenting the
  // same HttpOnly cookie (which JS can't clear) and re-hydrating the wiped identity (docs/15 #4).
  // Deliberately unauthenticated and side-effect-only — it never mints a session, and an absent or
  // unknown cookie is a no-op success.
  ctx.server.post("/api/session/end", async (request, reply) => {
    const token = readCookie(request.headers.cookie, sessionCookieName);
    if (token) {
      // The host phone forgetting its own identity: stop notifying it for that person.
      if (ctx.hostDeviceUserId !== undefined && ctx.sessions.get(token) === ctx.hostDeviceUserId) {
        ctx.hostDeviceUserId = undefined;
      }
      ctx.sessions.delete(token);
      ctx.store.deleteSession(token);
    }
    // Match the mint path's attributes (incl. conditional Secure over TLS) so the browser reliably
    // delete-matches and clears the cookie.
    const secure = request.protocol === "https";
    reply.header(
      "set-cookie",
      `${sessionCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`,
    );
    return { ok: true };
  });
}

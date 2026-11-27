/**
 * The app's router state, kept in the address's fragment (`http://<node>/#/dm/<id>`). A browser never sends
 * the fragment, so a reload, a restored tab or a phone reloading an evicted tab asks the node for `/` alone:
 * no conversation id, thread id or channel id crosses the Wi-Fi in clear. (The service worker that would
 * answer those reloads from one request for `/` can't register on a plain-HTTP LAN origin, docs/08.)
 *
 * Inside the app a route is the same path string it always was (`/dm/<id>`, `/search?q=…`), so `parseRoute`
 * and every `location.route("/…")` call are unchanged; only the address it is written to moved. The shape
 * is the part of `preact-iso`'s `useLocation` the app used.
 *
 * A fragment that does not start with `#/` is never a route. The start-up parameters (`#k=`, `a=`, `i=`,
 * `l=`) are read and stripped in main.tsx before the app renders, and their readers split the whole fragment
 * on `&`: so a route's own query must never use the names `k`, `a`, `i` or `l`.
 */
import { createContext, type ComponentChildren } from "preact";
import { useContext, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";

/** What `useLocation` hands a component: the current route and the way to change it. */
export interface Location {
  /** The route as the app writes it: a path plus any query (`/search?q=…`). */
  url: string;
  /** The route's path, without its query or a trailing slash (`/` at least). */
  path: string;
  /** The route's query parameters. */
  query: Record<string, string>;
  /** Go to `url` (a route path), adding a history entry, or replacing the current one when `replace`. */
  route: (url: string, replace?: boolean) => void;
}

/** Only parses a route; nothing is ever fetched from it. */
const ROUTE_BASE = "http://loam.invalid";

const LocationContext = createContext<Location | undefined>(undefined);

/** The address that carries `route`: the path is always `/`, the route is the fragment. */
function addressFor(route: string): string {
  return `/#${route}`;
}

/**
 * The route the current address carries. A `#/…` fragment is the route. Otherwise a path other than `/` is an
 * address from before routes moved into the fragment, or a link from outside (a bookmark, the Android host
 * opening `/privacy`): it is the route, path plus query. Anything else is `/`. Whenever the path is not `/`
 * the address is rewritten in place to `/#<route>` (history state kept), so the next reload sends only `/`.
 */
export function routeFromAddress(): string {
  const { hash, pathname, search } = window.location;
  const route = hash.startsWith("#/") ? hash.slice(1) : pathname !== "/" ? `${pathname}${search}` : "/";
  if (pathname !== "/") {
    window.history.replaceState(window.history.state, "", addressFor(route));
  }
  return route;
}

/** The fragment parameters `main.tsx` reads once, at page load: a join link's key, admin, invite and link codes. */
const STARTUP_FRAGMENT_PARAMS = ["k", "a", "i", "l"];

/** Whether `hash` is a join link's fragment (`#k=…`, `#k=…&a=…`) rather than a route. */
function carriesStartupParameter(hash: string): boolean {
  if (hash.startsWith("#/")) {
    return false;
  }
  const params = new URLSearchParams(hash.slice(1));
  return STARTUP_FRAGMENT_PARAMS.some((name) => params.has(name));
}

/** Split a route into its path (trailing slashes dropped) and its query, the way `preact-iso` did. */
function parseRouteUrl(url: string): { path: string; query: Record<string, string> } {
  try {
    // Prefixed rather than resolved against a base, so a route like `//name` stays a path, never a host.
    const parsed = new URL(`${ROUTE_BASE}${url.startsWith("/") ? url : `/${url}`}`);
    return { path: parsed.pathname.replace(/\/+$/g, "") || "/", query: Object.fromEntries(parsed.searchParams) };
  } catch {
    return { path: "/", query: {} };
  }
}

/**
 * Holds the current route for everything under it. Follows back, forward and a fragment edited by hand
 * (`popstate` and `hashchange`; one fragment change fires both, and the second changes nothing).
 */
export function LocationProvider({
  children,
  reload = () => window.location.reload(),
}: {
  children?: ComponentChildren;
  /** Loads the page again. The browser's own by default; a test passes its own. */
  reload?: () => void;
}) {
  const [url, setUrl] = useState(routeFromAddress);
  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  useLayoutEffect(() => {
    /** Take the route from the address the browser moved to. */
    function follow(): void {
      setUrl(routeFromAddress());
    }
    /**
     * The address moved while the page was open. A join link opened in a tab that already shows LOAM (pasted
     * over the address, or tapped) changes only the fragment, so the browser loads nothing and `main.tsx`,
     * which reads `#k=` and the other start-up parameters once at page load, never sees them. Load the page
     * again and leave the fragment for it. Only a move does this, never the first look at the address below,
     * so a fragment the start-up code left in place can't reload the page in a loop.
     */
    function moved(): void {
      if (carriesStartupParameter(window.location.hash)) {
        reloadRef.current();
        return;
      }
      follow();
    }
    addEventListener("popstate", moved);
    addEventListener("hashchange", moved);
    // The address may have moved between the first render and this subscription.
    follow();
    return () => {
      removeEventListener("popstate", moved);
      removeEventListener("hashchange", moved);
    };
  }, []);

  const value = useMemo<Location>(
    () => ({
      url,
      ...parseRouteUrl(url),
      route: (next: string, replace = false) => {
        if (replace) {
          window.history.replaceState(window.history.state, "", addressFor(next));
        } else if (new URL(addressFor(next), window.location.href).href !== window.location.href) {
          // Going where the address already is adds no entry, so one Back always leaves the screen.
          window.history.pushState(null, "", addressFor(next));
        }
        setUrl(next);
      },
    }),
    [url],
  );

  return <LocationContext.Provider value={value}>{children}</LocationContext.Provider>;
}

/**
 * Whether a click on a link is a plain primary-button click the app should route itself. A modifier or
 * another button asks the browser for a new tab or window (or a download), so that click is left alone.
 */
export function isPlainClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/** The current route; must be called under a `LocationProvider`. */
export function useLocation(): Location {
  const location = useContext(LocationContext);
  if (!location) {
    throw new Error("useLocation needs a LocationProvider above it");
  }
  return location;
}

/**
 * Which web pages the desktop app will open in the computer's browser. The host window may ask only for pages
 * LOAM knows (its website, its GitHub releases, its Ko-fi page, and the running node's own pages); the client window's links
 * (a message's link, opened with target=_blank) may be any http(s) page, as in any browser, but never another
 * scheme: a `file:` or custom-protocol link could start a program. Pure, so it is unit-tested.
 */

/** Pages under these prefixes are LOAM's own. */
const KNOWN_PREFIXES = ["https://loamnet.com/", "https://www.loamnet.com/", "https://github.com/MagicZebraLtd/loam", "https://ko-fi.com/magiczebra"];

/** The URL parsed, or undefined. */
function parse(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

/** True when `href` is `prefix` itself or a page under it (`.../loam` must not match `.../loamevil`). */
function underPrefix(href: string, prefix: string): boolean {
  if (prefix.endsWith("/")) {
    return href.startsWith(prefix);
  }
  return href === prefix || ["/", "?", "#"].some((next) => href.startsWith(`${prefix}${next}`));
}

/** True for an http(s) URL with no credentials in it (a `user:pass@` link is a classic disguise). */
export function isWebUrl(url: string): boolean {
  const parsed = parse(url);
  return parsed !== undefined && (parsed.protocol === "http:" || parsed.protocol === "https:") && !parsed.username && !parsed.password;
}

/** The port `parsed` reaches, the scheme's default filled in where the URL leaves it out (`http://x/` is port 80). */
function effectivePort(parsed: URL): number {
  return parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
}

/**
 * True when the host window may open `url`: one of LOAM's own pages, or a page of the running node on one of
 * this computer's addresses (`nodeHosts`) and its port.
 */
export function isKnownExternalUrl(url: string, node: { port: number; hosts: readonly string[] } | undefined): boolean {
  const parsed = parse(url);
  if (!parsed || !isWebUrl(url)) {
    return false;
  }
  if (parsed.protocol === "https:" && KNOWN_PREFIXES.some((prefix) => underPrefix(parsed.href, prefix))) {
    return true;
  }
  if (!node || parsed.protocol !== "http:" || effectivePort(parsed) !== node.port) {
    return false;
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  return host === "127.0.0.1" || host === "localhost" || node.hosts.includes(host);
}

/**
 * True when `url` is on `origin` (the client window stays on the node it was opened for). Both sides are
 * parsed, so `http://127.0.0.1:80` and `http://127.0.0.1` are the same origin, as they are to a page; an
 * opaque origin (`file:`, `data:`, which the URL standard spells "null") never matches anything.
 */
export function isSameOrigin(url: string, origin: string | undefined): boolean {
  if (origin === undefined) {
    return false;
  }
  const parsed = parse(url);
  const expected = parse(origin);
  return parsed !== undefined && expected !== undefined && parsed.origin !== "null" && parsed.origin === expected.origin;
}

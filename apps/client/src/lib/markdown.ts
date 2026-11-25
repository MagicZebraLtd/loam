import DOMPurify from "dompurify";
import snarkdown from "snarkdown";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isSafeLink(href: string): boolean {
  try {
    const url = new URL(href, window.location.origin);
    return ["http:", "https:", "mailto:"].includes(url.protocol);
  } catch {
    return false;
  }
}

/**
 * The fragment parameters this app acts on at start-up: `k` (the join QR's host key, `transport.ts`), `a`
 * (an admin claim code, `admin-link.ts`), `i` (an invite code, `invite.ts`) and `l` (a node-link code,
 * `link-code-fragment.ts`). Each reader takes `<name>=` from `window.location.hash` split on `&`,
 * case-sensitively and without percent-decoding.
 */
const STARTUP_FRAGMENT_PARAMS = new Set(["k", "a", "i", "l"]);

/** Decode each `%XX` escape on its own, leaving a malformed `%` as it is (never throws). */
function percentDecodeTolerant(value: string): string {
  return value.replace(/%([0-9A-Fa-f]{2})/g, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

/** Whether `hash` (a URL's `#…`, or empty) has a parameter named `k`, `a`, `i` or `l`, ignoring case,
 * percent-encoding and surrounding spaces in the name. */
function hasStartupFragmentParam(hash: string): boolean {
  for (const part of hash.replace(/^#/, "").split("&")) {
    const equalsAt = part.indexOf("=");
    if (equalsAt !== -1 && STARTUP_FRAGMENT_PARAMS.has(percentDecodeTolerant(part.slice(0, equalsAt)).trim().toLowerCase())) {
      return true;
    }
  }
  return false;
}

/**
 * Drop the fragment from a message link when it carries a start-up parameter (see `STARTUP_FRAGMENT_PARAMS`).
 * Those fragments may only arrive from a scanned code or the host's own screen, never from a message: a posted
 * `#k=` would let any member hand others a key to pin (for this node's origin a remote lockout or, with an
 * on-path position, a key substitution), and a posted `#a=`, `#i=` or `#l=` would present someone else's code.
 * The fragment is judged as the browser will see it, after URL parsing, because the browser strips tab, CR and
 * LF from a URL first: `#<TAB>k=` reaches the opened page as `#k=`. The link still works; it just loses its
 * whole fragment, whatever the origin. Any other href is returned exactly as it was.
 */
function withoutStartupFragment(href: string): string {
  const hashAt = href.indexOf("#");
  if (hashAt === -1) {
    return href;
  }
  let hash: string;
  try {
    hash = new URL(href, window.location.origin).hash;
  } catch {
    // Unparseable here (the caller has already checked it parses): drop the fragment rather than guess.
    return href.slice(0, hashAt);
  }
  return hasStartupFragmentParam(hash) ? href.slice(0, hashAt) : href;
}

/**
 * Every element snarkdown 2.0.0 can emit, less `img` (see `imagesAsAltText`). Nothing else may reach the
 * page, so a malformed link (snarkdown builds one with `String.replace`, which expands `$` patterns in the
 * target) can't bring in an element of its own.
 */
const ALLOWED_TAGS = ["a", "em", "strong", "s", "br", "hr", "pre", "code", "blockquote", "ol", "ul", "li", "h1", "h2", "h3", "h4", "h5", "h6"];

/**
 * The one attribute a message may carry into the page: a link's `href`. The link hardening below runs after
 * the sanitiser and sets `rel` and `target` itself. The same `$`-pattern trick can put any attribute on a
 * link (`tabindex`, `title`, `download`, `name`, `data-*`, `aria-*`…), so none is trusted by default.
 */
const ALLOWED_ATTRIBUTES = ["href"];

/**
 * Replace each `<img>` snarkdown emitted with its alt text as plain text (nothing when it has none). Pictures
 * are shared as attachments. A message image could only load from the node itself (the page's CSP blocks
 * other hosts), so a post of hundreds of `![](/api/...)` would make every reader's browser send that many
 * requests to the node from the reader's own address, spending their rate budget, and on an encrypted network
 * each would be a clear-text GET showing a listener which devices rendered the post. The HTML is parsed into an
 * inert `<template>`, which loads nothing; the sanitiser then drops any `<img>` this missed.
 */
function imagesAsAltText(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  for (const img of Array.from(template.content.querySelectorAll("img"))) {
    img.replaceWith(img.getAttribute("alt") ?? "");
  }
  return template.innerHTML;
}

/**
 * Attributes a message may never carry into the page. snarkdown emits a fenced block's language tag as
 * `<pre class="code <lang>">`, and DOMPurify's defaults keep `class`, so a fence tagged `dialog`, `notice` or
 * `btn` would borrow the app's own styles and let a post impersonate a system notice or a control. The
 * markdown CSS styles `pre`/`code` by element, so nothing is lost by dropping the class.
 */
const FORBIDDEN_ATTRIBUTES = ["class", "id", "style"];

export function renderMarkdown(markdown: string): string {
  const html = imagesAsAltText(snarkdown(escapeHtml(markdown)));
  const template = document.createElement("template");
  template.innerHTML = DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ALLOWED_ATTRIBUTES,
    // DOMPurify keeps data-* and aria-* attributes whatever ALLOWED_ATTR says unless these are off.
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    FORBID_ATTR: FORBIDDEN_ATTRIBUTES,
  });

  for (const link of Array.from(template.content.querySelectorAll("a"))) {
    const href = link.getAttribute("href") ?? "";

    if (!isSafeLink(href)) {
      link.removeAttribute("href");
      continue;
    }

    const neutralised = withoutStartupFragment(href);
    if (neutralised !== href) {
      link.setAttribute("href", neutralised);
    }

    link.setAttribute("rel", "noreferrer");
    link.setAttribute("target", "_blank");
  }

  return template.innerHTML;
}

/**
 * Bounded cache of sanitized message HTML, keyed on `(id, editedAt, body)`. The whole `messages`
 * array is replaced on every socket event / stream delta, so without a cache every visible message
 * is re-run through snarkdown + DOMPurify on each delta. The body is part of the key so a streaming
 * message (same id, growing body) always re-renders, while every other visible row hits the cache.
 * FIFO eviction (delete-oldest) keeps it from growing without bound.
 */
const markdownCache = new Map<string, string>();
const MARKDOWN_CACHE_LIMIT = 500;

/** Drop every cached rendering — part of a device/node wipe, so rendered message bodies don't linger in
 * memory after the on-disk copy is gone. */
export function clearMarkdownCache(): void {
  markdownCache.clear();
}

/**
 * Cached wrapper around {@link renderMarkdown} for message bodies. Returns byte-identical HTML to a
 * direct `renderMarkdown(body)` call; the cache is invalidated whenever the body or `editedAt`
 * changes (a distinct key), so edits and streaming updates never show stale HTML.
 *
 * @param id - The message id (stable identity for the row).
 * @param body - The text to render (already resolved, e.g. via `bodyFor`).
 * @param editedAt - The message's edit timestamp, if any; part of the cache key.
 * @returns Sanitized, link-hardened HTML.
 */
export function renderMarkdownCached(id: string, body: string, editedAt?: number): string {
  // A JSON array, not a joined string: an id may hold any character (a sync peer can supply one), so a
  // separator could appear inside a part and two messages share a key.
  const key = JSON.stringify([id, editedAt ?? null, body]);
  const cached = markdownCache.get(key);

  if (cached !== undefined) {
    return cached;
  }

  const html = renderMarkdown(body);
  markdownCache.set(key, html);

  if (markdownCache.size > MARKDOWN_CACHE_LIMIT) {
    const oldest = markdownCache.keys().next().value;

    if (oldest !== undefined) {
      markdownCache.delete(oldest);
    }
  }

  return html;
}

/** Block-level elements whose boundaries become a space when Markdown is flattened to one line. */
const FLATTEN_BLOCKS = "p, li, br, h1, h2, h3, h4, h5, h6, blockquote, pre, ul, ol, hr, div";

/**
 * A message body as the plain text it reads as (for one-line previews such as search results): the
 * Markdown is rendered and sanitised exactly as in a bubble, then only its text is kept — `**bold**` reads
 * "bold", list items get a "•", and blocks are separated by spaces. The HTML is parsed into an inert
 * `<template>`, never into the page.
 */
export function markdownToPlainText(markdown: string): string {
  const template = document.createElement("template");
  template.innerHTML = renderMarkdown(markdown);
  for (const item of Array.from(template.content.querySelectorAll("li"))) {
    item.prepend("• ");
  }
  for (const block of Array.from(template.content.querySelectorAll(FLATTEN_BLOCKS))) {
    block.after(" ");
  }
  return (template.content.textContent ?? "").replace(/\s+/g, " ").trim();
}

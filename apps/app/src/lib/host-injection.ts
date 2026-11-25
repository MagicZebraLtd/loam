/**
 * What the host screen (`src/app/index.tsx`) hands its own WebView, and which pages and messages it trusts.
 *
 * react-native-webview runs `injectedJavaScriptBeforeContentLoaded` at the start of EVERY page, and its
 * `onShouldStartLoadWithRequest` guard fails open: on Android it waits 250 ms for the JS thread and then
 * allows the load (RNCWebViewClient, "defaulting to allow loading"). While the JS thread is busy (verifying a
 * model file hashes it in 8 MiB chunks), a tapped link can therefore load an outside page in this WebView.
 * So the injected globals are set only when the page's own origin is LOAM's, messages from any other origin
 * are ignored, and a foreign page the WebView reports is sent back to LOAM. Pure, so it is unit-tested.
 */
import { HOST_WEBVIEW_ORIGIN } from './join-url';

export type HostInjection = {
  /** The launcher's per-boot host token, once `ready` delivered it. */
  hostToken?: string;
  /** The `#k=<key>` fragment from the loopback bootstrap; empty when there is none. */
  transportKeyFragment: string;
  /** An encrypted network: the web client keeps no IndexedDB copy of messages. */
  noLocalCache: boolean;
};

/**
 * `value` as a JavaScript string literal for a script the WebView will run. `JSON.stringify` alone leaves
 * `<` (which could close a script element), U+2028 and U+2029 (line ends in older JavaScript) as they are;
 * here they are written as escapes, so the literal reads the same wherever the script text ends up.
 */
export function jsStringLiteral(value: string): string {
  return JSON.stringify(value).replace(/[<\u2028\u2029]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * The script for `injectedJavaScriptBeforeContentLoaded`: sets `__loamHostDeviceToken`,
 * `__loamHostTransportKey` and `__loamHostNoLocalCache` only on a page whose `location.origin` is LOAM's.
 */
export function hostInjectionScript({ hostToken, transportKeyFragment, noLocalCache }: HostInjection): string {
  const assignments =
    (hostToken ? `window.__loamHostDeviceToken = ${jsStringLiteral(hostToken)};` : '') +
    (transportKeyFragment
      ? `window.__loamHostTransportKey = ${jsStringLiteral(decodeURIComponent(transportKeyFragment.slice('#k='.length)))};`
      : '') +
    (noLocalCache ? 'window.__loamHostNoLocalCache = true;' : '');
  return `if (location.origin === ${jsStringLiteral(HOST_WEBVIEW_ORIGIN)}) { ${assignments} } true;`;
}

/** True when `url` belongs to the embedded server's origin (compares origins, not string prefixes). */
export function isLoamUrl(url: string | undefined): boolean {
  if (!url) {
    return false;
  }
  try {
    return new URL(url).origin === HOST_WEBVIEW_ORIGIN;
  } catch {
    return false;
  }
}

/**
 * Whether a WebView message comes from LOAM's own page. `url` is the event's `nativeEvent.url`: the posting
 * frame's origin (WebMessageListener) or the page URL (the older bridge). Anything else is ignored.
 */
export function acceptsWebViewMessage(url: string | undefined): boolean {
  return isLoamUrl(url);
}

/**
 * Whether the WebView reports a page that isn't LOAM's: then the screen stops it and loads LOAM again. No URL
 * yet and `about:blank` (the WebView's own start page) don't count.
 */
export function isForeignPage(url: string | undefined): boolean {
  return Boolean(url) && url !== 'about:blank' && !isLoamUrl(url);
}

/**
 * What the WebView does with a navigation: `load` LOAM's own pages, hand any other `http(s)` address to the
 * system browser (`external`), and refuse everything else (`block`). Every navigation reaches this, since the
 * WebView's `originWhitelist` is `['*']`: under a narrower list react-native-webview sends a URL that fails
 * it straight to Android as an intent and never asks the app. So `intent:`, `tel:`, `market:`, `file:`,
 * `javascript:`, `data:`, `blob:`, `about:blank` and an empty or unparseable URL are all blocked.
 */
export function navigationDecision(url: string | undefined): 'load' | 'external' | 'block' {
  // The scheme is read from the text and lower-cased here, not asked of `URL`: React Native's `URL` is a few
  // regular expressions that neither validate nor lower-case, so it would decide differently on the phone
  // than under test. The scheme comes before the origin: a `blob:` URL made by LOAM's page reports LOAM's
  // origin to a real URL parser, yet is no page to load.
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url ?? '')?.[1]?.toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') {
    return 'block';
  }
  return isLoamUrl(url) ? 'load' : 'external';
}

/**
 * What a finished WebView load does with a conversation waiting to be opened (a notification tapped before
 * the WebView could route): open it once LOAM's own page has loaded, else keep it for the next load, since a
 * route set on another page would write the conversation's id into that page's address.
 */
export function pendingConversationAfterLoad(
  pending: string | undefined,
  loadedUrl: string | undefined,
): { open: string | undefined; keep: string | undefined } {
  if (!pending) {
    return { open: undefined, keep: undefined };
  }
  return isLoamUrl(loadedUrl) ? { open: pending, keep: undefined } : { open: undefined, keep: pending };
}

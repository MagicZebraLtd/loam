// Moving the host's own WebView to a web client route (a conversation, the rules, the admin page).
//
// The web client keeps its route in the address's fragment (`/#/dm/<id>`, apps/client lib/location.tsx), which
// a browser never sends, so a reload asks the node for `/` alone. Setting `location.hash` changes the route in
// place: the client follows `hashchange`. Pure, so it is unit-testable without the RN import graph.

import { HOST_WEBVIEW_ORIGIN } from './join-url';

/**
 * The script `injectJavaScript` runs to open `path` (a route such as `/dm/<id>` or `/admin?section=llm`) in
 * the web client. It acts only on LOAM's own page, as `hostInjectionScript` does: the navigation guard lets a
 * load through when the JS thread is slow to answer, so another page can briefly hold the WebView, and a
 * route set there would put a conversation id in that page's address. It ends in `true`, as
 * `injectJavaScript` asks.
 */
export function webViewRouteScript(path: string): string {
  return `if (location.origin === ${JSON.stringify(HOST_WEBVIEW_ORIGIN)}) { location.hash = ${JSON.stringify(`#${path}`)}; } true;`;
}

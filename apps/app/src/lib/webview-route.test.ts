import { describe, expect, it } from 'vitest';

import { HOST_WEBVIEW_ORIGIN } from './join-url';
import { webViewRouteScript } from './webview-route';

/** Run a built script against a stand-in `location`, as the WebView would, and return what it set. */
function run(script: string, origin = HOST_WEBVIEW_ORIGIN): { hash: string; result: unknown; pathname: string } {
  const location = { hash: '', pathname: '/', origin };
  const result = new Function('location', 'history', `return eval(${JSON.stringify(script)});`)(location, {
    pushState: () => {
      throw new Error('the route must not go in the path');
    },
  });
  return { hash: location.hash, pathname: location.pathname, result };
}

describe('webViewRouteScript', () => {
  it('moves the web client to a route by its fragment, never its path', () => {
    const { hash, pathname, result } = run(webViewRouteScript('/dm/user.0123456789abcdef'));
    expect(hash).toBe('#/dm/user.0123456789abcdef');
    expect(pathname).toBe('/');
    // `injectJavaScript` wants the script to end in a value.
    expect(result).toBe(true);
  });

  it('carries a route query, such as the admin page section', () => {
    expect(run(webViewRouteScript('/admin?section=llm')).hash).toBe('#/admin?section=llm');
  });

  it('keeps a path that holds quotes inside its string', () => {
    expect(run(webViewRouteScript(`/channel/a'b"c`)).hash).toBe(`#/channel/a'b"c`);
  });
});

describe("the route script on a page that isn't LOAM's", () => {
  it('leaves the address alone, so a conversation id never reaches another page', () => {
    for (const origin of ['https://example.org', 'http://127.0.0.1:30000', 'http://localhost:3000', 'null']) {
      const { hash, result } = run(webViewRouteScript('/dm/user.0123456789abcdef'), origin);
      expect(hash, origin).toBe('');
      expect(result).toBe(true);
    }
  });
});

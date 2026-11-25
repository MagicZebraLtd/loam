import { describe, expect, it } from 'vitest';

import {
  acceptsWebViewMessage,
  hostInjectionScript,
  isForeignPage,
  isLoamUrl,
  navigationDecision,
  pendingConversationAfterLoad,
} from './host-injection';
import { HOST_WEBVIEW_ORIGIN } from './join-url';

type HostGlobals = {
  __loamHostDeviceToken?: unknown;
  __loamHostTransportKey?: unknown;
  __loamHostNoLocalCache?: unknown;
};

/** Run the injected script as the WebView would at page start, on a page at `origin`. */
function runOn(origin: string, script: string): HostGlobals {
  const window: HostGlobals = {};
  new Function('window', 'location', script)(window, { origin });
  return window;
}

const token = 'tok"en\\with \'quotes\' and </script>';
const key = 'abc+/=key';
const values = { hostToken: token, transportKeyFragment: `#k=${encodeURIComponent(key)}`, noLocalCache: true };

describe('the host injection script', () => {
  it("sets the token, the transport key and the no-cache flag on LOAM's own page", () => {
    const globals = runOn(HOST_WEBVIEW_ORIGIN, hostInjectionScript(values));
    expect(globals).toEqual({ __loamHostDeviceToken: token, __loamHostTransportKey: key, __loamHostNoLocalCache: true });
  });

  it('sets nothing on any other page, even one the WebView reached by a fail-open navigation', () => {
    for (const origin of ['https://example.com', 'http://127.0.0.1:3001', 'http://localhost:3000', 'null']) {
      expect(runOn(origin, hostInjectionScript(values))).toEqual({});
    }
  });

  it('leaves out what it was not given', () => {
    const globals = runOn(HOST_WEBVIEW_ORIGIN, hostInjectionScript({ transportKeyFragment: '', noLocalCache: false }));
    expect(globals).toEqual({});
  });
});

describe("messages from the WebView", () => {
  it("are accepted only from LOAM's own origin", () => {
    // The WebMessageListener reports the frame's origin; the older bridge reports the page URL.
    expect(acceptsWebViewMessage(HOST_WEBVIEW_ORIGIN)).toBe(true);
    expect(acceptsWebViewMessage(`${HOST_WEBVIEW_ORIGIN}/channels`)).toBe(true);
    expect(acceptsWebViewMessage('https://example.com/')).toBe(false);
    expect(acceptsWebViewMessage('http://127.0.0.1:3001/')).toBe(false);
    expect(acceptsWebViewMessage('about:blank')).toBe(false);
    expect(acceptsWebViewMessage('')).toBe(false);
    expect(acceptsWebViewMessage(undefined)).toBe(false);
  });
});

describe('a page the WebView reports', () => {
  it('is foreign when it is anywhere but LOAM, a blank page or no page yet', () => {
    expect(isForeignPage('https://example.com/')).toBe(true);
    expect(isForeignPage('http://localhost:3000/')).toBe(true);
    expect(isForeignPage('data:text/html,hi')).toBe(true);
    expect(isForeignPage(`${HOST_WEBVIEW_ORIGIN}/dm/user.abc`)).toBe(false);
    expect(isForeignPage('about:blank')).toBe(false);
    expect(isForeignPage('')).toBe(false);
    expect(isForeignPage(undefined)).toBe(false);
  });

  it('compares origins, not string prefixes', () => {
    expect(isLoamUrl(`${HOST_WEBVIEW_ORIGIN}.evil.example/`)).toBe(false);
    expect(isLoamUrl(`${HOST_WEBVIEW_ORIGIN}/`)).toBe(true);
  });
});

describe('where a WebView navigation goes', () => {
  it("loads LOAM's own pages, whatever the route or fragment", () => {
    expect(navigationDecision(`${HOST_WEBVIEW_ORIGIN}/`)).toBe('load');
    expect(navigationDecision(`${HOST_WEBVIEW_ORIGIN}/#/dm/user.0123456789abcdef`)).toBe('load');
    expect(navigationDecision(`${HOST_WEBVIEW_ORIGIN}/?x=1#k=abc`)).toBe('load');
  });

  it('hands every other http and https address to the system browser', () => {
    expect(navigationDecision('https://example.org/page')).toBe('external');
    expect(navigationDecision('http://192.168.1.20:3000/')).toBe('external');
    // Another port on the same loopback address is another origin.
    expect(navigationDecision('http://127.0.0.1:30000/')).toBe('external');
    expect(navigationDecision('http://localhost:3000/')).toBe('external');
    expect(navigationDecision('HTTPS://Example.org/')).toBe('external');
    expect(navigationDecision('HtTp://example.org/')).toBe('external');
  });

  it('refuses every other scheme, so nothing is offered to Android as an intent', () => {
    for (const url of [
      'intent://scan/#Intent;scheme=zxing;package=com.example;end',
      'INTENT://x#Intent;end',
      'tel:+15550100',
      'sms:+15550100',
      'market://details?id=com.example',
      'file:///sdcard/Download/x.html',
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,<p>hi</p>',
      `blob:${HOST_WEBVIEW_ORIGIN}/0123`,
      'about:blank',
      'mailto:someone@example.org',
      'ftp://example.org/',
      '',
      'not a url',
      'http//missing-colon',
    ]) {
      expect(navigationDecision(url), url).toBe('block');
    }
    expect(navigationDecision(undefined)).toBe('block');
  });
});

describe('a conversation waiting for the WebView to load', () => {
  it("is opened once LOAM's page has loaded, and then forgotten", () => {
    expect(pendingConversationAfterLoad('dm:user.1', `${HOST_WEBVIEW_ORIGIN}/#/channels`)).toEqual({
      open: 'dm:user.1',
      keep: undefined,
    });
  });

  it("waits for the next load when the page that loaded isn't LOAM's", () => {
    for (const url of ['https://example.org/', 'about:blank', '', undefined]) {
      expect(pendingConversationAfterLoad('dm:user.1', url)).toEqual({ open: undefined, keep: 'dm:user.1' });
    }
  });

  it('does nothing when no conversation is waiting', () => {
    expect(pendingConversationAfterLoad(undefined, `${HOST_WEBVIEW_ORIGIN}/`)).toEqual({ open: undefined, keep: undefined });
  });
});

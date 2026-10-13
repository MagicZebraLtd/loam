import { describe, expect, it, vi } from 'vitest';

import type { MessageNotificationContent } from '../../modules/loam-hotspot/src/LoamHotspot.types';
import {
  alertLevelForClientMessage,
  conversationPath,
  createMessageNotifier,
  type MessageNotifierDeps,
  notificationContent,
  parseMessageNotice,
} from './message-notifier';

const dm = { conversation: 'dm:user.abc', direct: true, author: 'pale.ember.dove', body: 'are you there?', attachment: false, location: false };
const post = {
  conversation: 'channel:general',
  direct: false,
  author: 'pale.ember.dove',
  channel: 'General',
  body: 'hello all',
  attachment: false,
  location: false,
};

function harness(overrides: Partial<MessageNotifierDeps> = {}) {
  const shown: MessageNotificationContent[] = [];
  let active = false;
  let stored: string | null = null;
  const clear = vi.fn();
  const deps: MessageNotifierDeps = {
    isAppActive: () => active,
    show: (content) => {
      shown.push(content);
      return true;
    },
    clear,
    readLevel: async () => stored,
    writeLevel: async (level) => {
      stored = level;
    },
    ...overrides,
  };
  return {
    notifier: createMessageNotifier(deps),
    shown,
    clear,
    setActive: (value: boolean) => {
      active = value;
    },
    setStored: (value: string | null) => {
      stored = value;
    },
    stored: () => stored,
  };
}

describe('message notices from main.js', () => {
  it('accepts a well-formed notice and nothing else', () => {
    expect(parseMessageNotice(dm)).toEqual(dm);
    expect(parseMessageNotice(post)).toEqual(post);
    expect(parseMessageNotice({ ...dm, conversation: 'user.abc' })).toBeUndefined();
    expect(parseMessageNotice({ ...dm, direct: 'yes' })).toBeUndefined();
    expect(parseMessageNotice({ ...post, channel: 7 })).toBeUndefined();
    expect(parseMessageNotice('dm:user.abc')).toBeUndefined();
  });

  it('maps a conversation to the web client path, escaping the id', () => {
    expect(conversationPath('dm:user.abc')).toBe('/dm/user.abc');
    expect(conversationPath('channel:a b/c')).toBe('/channel/a%20b%2Fc');
    expect(conversationPath('thread:x')).toBeUndefined();
  });

  it('reads the level the WebView posts, ignoring other messages', () => {
    expect(alertLevelForClientMessage({ type: 'loam-alerts', level: 'all' })).toBe('all');
    expect(alertLevelForClientMessage({ type: 'loam-alerts', level: 'loud' })).toBeUndefined();
    expect(alertLevelForClientMessage({ type: 'loam-theme', theme: 'dark' })).toBeUndefined();
  });
});

describe('notification text', () => {
  it('names the person for a DM and the channel for a post', () => {
    expect(notificationContent(dm, 1)).toMatchObject({ title: 'pale.ember.dove', text: 'are you there?', count: 1 });
    expect(notificationContent(post, 3)).toMatchObject({ title: '#General', text: 'pale.ember.dove: hello all', count: 3 });
  });

  it('describes a picture or a location sent without text', () => {
    expect(notificationContent({ ...dm, body: '', attachment: true }, 1).text).toBe('Sent a picture');
    expect(notificationContent({ ...dm, body: '', location: true }, 1).text).toBe('Shared a location');
  });

  it('keeps the lock screen to "New message"', () => {
    expect(notificationContent(dm, 1)).toMatchObject({ publicTitle: 'LOAM', publicText: 'New message', channelName: 'Messages' });
  });
});

describe('createMessageNotifier', () => {
  it('notifies direct messages by default, only while LOAM is in the background', () => {
    const { notifier, shown, setActive } = harness();

    expect(notifier.notice(dm)).toBe(true);
    expect(notifier.notice(post)).toBe(false);
    setActive(true);
    expect(notifier.notice(dm)).toBe(false);
    expect(shown).toHaveLength(1);
  });

  it('follows the level the person chose, and stores it', () => {
    const { notifier, shown, clear, stored } = harness();

    notifier.setLevel('all');
    expect(notifier.notice(post)).toBe(true);
    expect(stored()).toBe('all');

    notifier.setLevel('off');
    expect(clear).toHaveBeenCalledTimes(1);
    expect(notifier.notice(dm)).toBe(false);
    expect(shown).toHaveLength(1);
  });

  it('uses the stored level until the WebView says otherwise, and the WebView wins a race', async () => {
    const first = harness();
    first.setStored('off');
    await first.notifier.load();
    expect(first.notifier.notice(dm)).toBe(false);

    const second = harness();
    second.setStored('off');
    const loading = second.notifier.load();
    second.notifier.setLevel('all');
    await loading;
    expect(second.notifier.level()).toBe('all');
  });

  it('counts messages per conversation until LOAM comes to the front, which clears them', () => {
    const { notifier, shown, clear } = harness();

    notifier.notice(dm);
    notifier.notice(dm);
    expect(shown.map((content) => content.count)).toEqual([1, 2]);

    notifier.appBecameActive();
    expect(clear).toHaveBeenCalledTimes(1);
    notifier.notice(dm);
    expect(shown.at(-1)?.count).toBe(1);
  });

  it('ignores a malformed notice', () => {
    const { notifier, shown } = harness();
    expect(notifier.notice({ conversation: 'dm:x' })).toBe(false);
    expect(shown).toEqual([]);
  });
});

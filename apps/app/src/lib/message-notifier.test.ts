import { describe, expect, it, vi } from 'vitest';

import type { MessageNotificationContent } from '../../modules/loam-hotspot/src/LoamHotspot.types';
import {
  alertLevelForClientMessage,
  conversationPath,
  createMessageNotifier,
  type MessageNotifierDeps,
  notificationContent,
  parseMessageNotice,
  parseMessageWithdrawal,
} from './message-notifier';

const dm = {
  messageId: 'msg_dm1',
  conversation: 'dm:user.abc',
  direct: true,
  author: 'pale.ember.dove',
  body: 'are you there?',
  attachment: false,
  location: false,
};
const post = {
  messageId: 'msg_post1',
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
  const clearConversation = vi.fn<(conversation: string) => void>();
  const deps: MessageNotifierDeps = {
    isAppActive: () => active,
    show: (content) => {
      shown.push(content);
      return true;
    },
    clear,
    clearConversation,
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
    clearConversation,
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

  it('refuses a notice without a message id, which could never be taken back', () => {
    const withoutId: Record<string, unknown> = { ...dm };
    delete withoutId.messageId;
    expect(parseMessageNotice(withoutId)).toBeUndefined();
    expect(parseMessageNotice({ ...dm, messageId: '' })).toBeUndefined();
    expect(parseMessageNotice({ ...dm, messageId: 'x'.repeat(129) })).toBeUndefined();
    expect(parseMessageNotice({ ...dm, messageId: 7 })).toBeUndefined();
    expect(parseMessageNotice({ ...dm, messageId: 'x'.repeat(128) })?.messageId).toHaveLength(128);
  });

  it('accepts a withdrawal by message or by conversation, and nothing else', () => {
    expect(parseMessageWithdrawal({ messageId: 'msg_dm1' })).toEqual({ messageId: 'msg_dm1' });
    expect(parseMessageWithdrawal({ conversation: 'channel:general' })).toEqual({ conversation: 'channel:general' });
    expect(parseMessageWithdrawal({ messageId: '' })).toBeUndefined();
    expect(parseMessageWithdrawal({ messageId: 'x'.repeat(129) })).toBeUndefined();
    expect(parseMessageWithdrawal({ messageId: 'msg_dm1', conversation: 'channel:general' })).toBeUndefined();
    expect(parseMessageWithdrawal({ conversation: 'thread:x' })).toBeUndefined();
    expect(parseMessageWithdrawal({})).toBeUndefined();
    expect(parseMessageWithdrawal('msg_dm1')).toBeUndefined();
    expect(parseMessageWithdrawal(null)).toBeUndefined();
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

  it('removes what an earlier process left in the shade when it starts, once, before reading the level', async () => {
    // Nothing of an earlier process can be taken back: the server's record and `previews` died with it.
    const order: string[] = [];
    const { notifier } = harness({
      clear: () => order.push('clear'),
      readLevel: async () => {
        order.push('read');
        return null;
      },
    });
    await notifier.load();
    await notifier.load();
    expect(order).toEqual(['clear', 'read']);
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

  it('clears every notification and count on a reset', () => {
    const { notifier, shown, clear } = harness();

    notifier.notice(dm);
    notifier.clearAll();
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

describe('taking notifications back', () => {
  const otherDm = { ...dm, messageId: 'msg_other1', conversation: 'dm:user.xyz' };

  it('removes the conversation whose notification shows the withdrawn message, and lowers its count', () => {
    const { notifier, shown, clear, clearConversation } = harness();
    notifier.notice({ ...dm, messageId: 'msg_a' });
    notifier.notice({ ...dm, messageId: 'msg_b' });
    notifier.notice(otherDm);

    expect(notifier.withdraw({ messageId: 'msg_b' })).toBe(true);
    expect(clearConversation.mock.calls).toEqual([['dm:user.abc']]);
    expect(clear).not.toHaveBeenCalled();

    // The next message there counts the one still unseen, not the withdrawn one.
    notifier.notice({ ...dm, messageId: 'msg_c' });
    expect(shown.at(-1)).toMatchObject({ conversation: 'dm:user.abc', count: 2 });
    // The other conversation was left alone.
    notifier.notice({ ...otherDm, messageId: 'msg_other2' });
    expect(shown.at(-1)).toMatchObject({ conversation: 'dm:user.xyz', count: 2 });
  });

  it('does nothing for an older message the notification no longer shows, or one never shown', () => {
    const { notifier, clearConversation } = harness();
    notifier.notice({ ...dm, messageId: 'msg_a' });
    notifier.notice({ ...dm, messageId: 'msg_b' });

    expect(notifier.withdraw({ messageId: 'msg_a' })).toBe(false);
    expect(notifier.withdraw({ messageId: 'msg_unknown' })).toBe(false);
    expect(clearConversation).not.toHaveBeenCalled();
  });

  it('never counts below zero', () => {
    const { notifier, shown } = harness();
    notifier.notice({ ...dm, messageId: 'msg_a' });
    expect(notifier.withdraw({ messageId: 'msg_a' })).toBe(true);
    expect(notifier.withdraw({ messageId: 'msg_a' })).toBe(false);

    notifier.notice({ ...dm, messageId: 'msg_b' });
    expect(shown.at(-1)).toMatchObject({ count: 1 });
  });

  it('removes a whole conversation and forgets its count', () => {
    const { notifier, shown, clearConversation } = harness({});
    notifier.setLevel('all');
    notifier.notice(post);
    notifier.notice({ ...post, messageId: 'msg_post2' });
    notifier.notice(dm);

    expect(notifier.withdraw({ conversation: 'channel:general' })).toBe(true);
    expect(clearConversation.mock.calls).toEqual([['channel:general']]);
    // Its last message is forgotten too, and a conversation with nothing showing reports nothing removed.
    expect(notifier.withdraw({ messageId: 'msg_post2' })).toBe(false);
    expect(notifier.withdraw({ conversation: 'channel:general' })).toBe(false);

    notifier.notice({ ...post, messageId: 'msg_post3' });
    expect(shown.at(-1)).toMatchObject({ conversation: 'channel:general', count: 1 });
    // The DM was left alone.
    expect(notifier.withdraw({ messageId: dm.messageId })).toBe(true);
  });

  it('ignores a malformed withdrawal', () => {
    const { notifier, clearConversation } = harness();
    notifier.notice(dm);

    for (const raw of [undefined, null, 'msg_dm1', {}, { messageId: '' }, { conversation: 'user.abc' }, { messageId: 7 }]) {
      expect(notifier.withdraw(raw)).toBe(false);
    }
    expect(clearConversation).not.toHaveBeenCalled();
    expect(notifier.withdraw({ messageId: dm.messageId })).toBe(true);
  });

  it('has nothing to take back once LOAM came to the front, the level went off, or a reset cleared them', () => {
    const { notifier, clearConversation } = harness();

    notifier.notice(dm);
    notifier.appBecameActive();
    expect(notifier.withdraw({ messageId: dm.messageId })).toBe(false);

    notifier.notice(dm);
    notifier.clearAll();
    expect(notifier.withdraw({ messageId: dm.messageId })).toBe(false);

    notifier.notice(dm);
    notifier.setLevel('off');
    expect(notifier.withdraw({ messageId: dm.messageId })).toBe(false);

    expect(clearConversation).not.toHaveBeenCalled();
  });

  it('only tracks a notice that was actually shown', () => {
    const { notifier, clearConversation } = harness({ show: () => false });
    notifier.notice(dm);

    expect(notifier.withdraw({ messageId: dm.messageId })).toBe(false);
    expect(clearConversation).not.toHaveBeenCalled();
  });
});

// New-message notifications on the host phone (docs/04 "Message notifications"). The embedded server hands
// main.js each new message the host's own person can see (`globalThis.__loamNotifyHost`, apps/server
// realtime.ts `notifyHostDevice`), main.js posts it here as `loam-message-notice`, and this shows an Android
// notification while LOAM is in the background. Which messages notify is the level the person chose in the
// web client's Settings (Direct messages / Every message / Nothing), posted by the WebView as `loam-alerts`
// and kept in SecureStore so it applies before the WebView loads. When the message a notification shows is
// deleted, changed or put out of the person's reach, the server asks for it back (`__loamWithdrawHostNotice`,
// posted here as `loam-message-withdrawn`) and the notification goes. Pure: the native calls, app state and
// storage are injected (message-notifications.ts wires them), so the rules are unit-tested without a device.
import type { MessageNotificationContent } from '../../modules/loam-hotspot';
import { t } from './i18n';

/** Which messages notify; the web client's `AlertLevel` (apps/client/src/lib/alerts.ts). */
export type AlertLevel = 'dms' | 'all' | 'off';

export const DEFAULT_ALERT_LEVEL: AlertLevel = 'dms';

/** Where the level is kept between launches. */
export const ALERT_LEVEL_ITEM = 'loam.alertLevel';

/** One new message, as the server describes it (apps/server types.ts `HostMessageNotice`). */
export type MessageNotice = {
  /** The message's id, so its notification can be taken back. */
  messageId: string;
  conversation: string;
  direct: boolean;
  author: string;
  channel?: string;
  body: string;
  attachment: boolean;
  location: boolean;
};

/** A level from storage or a message; anything unknown is undefined. */
export function parseAlertLevel(raw: unknown): AlertLevel | undefined {
  return raw === 'dms' || raw === 'all' || raw === 'off' ? raw : undefined;
}

/** The level in a WebView message, or undefined when the message isn't a well-formed `loam-alerts`. */
export function alertLevelForClientMessage(message: unknown): AlertLevel | undefined {
  if (typeof message !== 'object' || message === null || (message as { type?: unknown }).type !== 'loam-alerts') {
    return undefined;
  }
  return parseAlertLevel((message as { level?: unknown }).level);
}

const CONVERSATION_PATTERN = /^(dm|channel):(.{1,128})$/s;

/** Whether `value` is a message id as the server sends one (1 to 128 characters, like its `IdSchema`). */
function isMessageId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128;
}

/** What the server asks to take back: the notification showing one message, or a whole conversation's. */
export type MessageWithdrawal = { messageId: string } | { conversation: string };

/** A `loam-message-withdrawn` from main.js, or undefined when it's malformed. */
export function parseMessageWithdrawal(raw: unknown): MessageWithdrawal | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const value = raw as Record<string, unknown>;
  if (value.messageId !== undefined) {
    return value.conversation === undefined && isMessageId(value.messageId) ? { messageId: value.messageId } : undefined;
  }
  if (typeof value.conversation === 'string' && CONVERSATION_PATTERN.test(value.conversation)) {
    return { conversation: value.conversation };
  }
  return undefined;
}

/** A notice from main.js, or undefined when it's malformed. A notice without a message id is refused: its
 * notification could never be taken back. */
export function parseMessageNotice(raw: unknown): MessageNotice | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const value = raw as Record<string, unknown>;
  if (
    !isMessageId(value.messageId) ||
    typeof value.conversation !== 'string' ||
    !CONVERSATION_PATTERN.test(value.conversation) ||
    typeof value.direct !== 'boolean' ||
    typeof value.author !== 'string' ||
    typeof value.body !== 'string' ||
    (value.channel !== undefined && typeof value.channel !== 'string')
  ) {
    return undefined;
  }
  return {
    messageId: value.messageId,
    conversation: value.conversation,
    direct: value.direct,
    author: value.author,
    channel: value.channel as string | undefined,
    body: value.body,
    attachment: value.attachment === true,
    location: value.location === true,
  };
}

/** The web client's path for a conversation key (`/dm/<id>`, `/channel/<id>`), or undefined. */
export function conversationPath(conversation: string): string | undefined {
  const match = CONVERSATION_PATTERN.exec(conversation);
  if (!match) {
    return undefined;
  }
  return `/${match[1]}/${encodeURIComponent(match[2])}`;
}

/** Whether a notice should become a notification right now. */
export function shouldNotify(notice: MessageNotice, level: AlertLevel, appActive: boolean): boolean {
  if (appActive || level === 'off') {
    return false;
  }
  return level === 'all' || notice.direct;
}

/** The notification for a notice, in the app's language. `count` messages have arrived there unseen. */
export function notificationContent(notice: MessageNotice, count: number): MessageNotificationContent {
  const text = notice.body || (notice.attachment ? t('notify.picture') : notice.location ? t('notify.location') : '');
  return {
    conversation: notice.conversation,
    title: notice.direct ? notice.author : t('notify.channelTitle', { channel: notice.channel ?? '' }),
    text: notice.direct ? text : t('notify.channelLine', { author: notice.author, text }),
    count,
    publicTitle: 'LOAM',
    publicText: t('notify.publicText'),
    channelName: t('notify.messagesChannel'),
    channelDescription: t('notify.messagesChannelDescription'),
  };
}

export type MessageNotifierDeps = {
  isAppActive: () => boolean;
  show: (content: MessageNotificationContent) => boolean;
  clear: () => void;
  /** Remove one conversation's notification. */
  clearConversation: (conversation: string) => void;
  readLevel: () => Promise<string | null>;
  writeLevel: (level: AlertLevel) => Promise<void>;
};

export type MessageNotifier = {
  /** Read the stored level once, first removing every message notification an earlier process left. Never rejects. */
  load: () => Promise<AlertLevel>;
  /** A `loam-message-notice` from main.js. Returns whether a notification was shown. */
  notice: (raw: unknown) => boolean;
  /**
   * A `loam-message-withdrawn` from main.js: the server took a message back (or the person lost a
   * conversation). Removes the notification still showing it. Returns whether a notification was removed.
   */
  withdraw: (raw: unknown) => boolean;
  /** The level the WebView posted: applies now and is stored. */
  setLevel: (level: AlertLevel) => void;
  /** LOAM came to the front: the person can see the messages, so their notifications go. */
  appBecameActive: () => void;
  /** Remove every message notification now (an Emergency Reset erased what they show). */
  clearAll: () => void;
  level: () => AlertLevel;
};

/**
 * How many of a conversation's counted messages are remembered by id, so a withdrawn one lowers the count.
 * Past this the oldest are dropped: withdrawing one of those leaves the count one high, which after 64 newer
 * unseen messages in one conversation changes nothing the person acts on, while the memory per conversation
 * stays a few kilobytes however busy it is. The message on display is the newest, so it is never dropped.
 */
export const MAX_COUNTED_MESSAGE_IDS = 64;

/** Build the notifier over `deps`. */
export function createMessageNotifier(deps: MessageNotifierDeps): MessageNotifier {
  let level: AlertLevel = DEFAULT_ALERT_LEVEL;
  let chosen = false;
  let loading: Promise<AlertLevel> | undefined;
  // Messages per conversation since LOAM was last in front.
  const counts = new Map<string, number>();
  // The ids of the messages each count stands for, oldest first (at most MAX_COUNTED_MESSAGE_IDS).
  const counted = new Map<string, string[]>();
  // The message whose text each conversation's notification shows now.
  const previews = new Map<string, string>();

  /** Forget every count and preview and remove every notification. */
  function forgetAll(): void {
    counts.clear();
    counted.clear();
    previews.clear();
    deps.clear();
  }

  /** One message fewer stands behind `conversation`'s count. */
  function lowerCount(conversation: string): void {
    const count = (counts.get(conversation) ?? 0) - 1;
    if (count > 0) {
      counts.set(conversation, count);
    } else {
      counts.delete(conversation);
    }
  }

  /** Forget `messageId` among the counted ones; returns its conversation, or undefined if it wasn't there. */
  function uncount(messageId: string): string | undefined {
    for (const [conversation, ids] of counted) {
      const index = ids.indexOf(messageId);
      if (index !== -1) {
        ids.splice(index, 1);
        if (ids.length === 0) {
          counted.delete(conversation);
        }
        return conversation;
      }
    }
    return undefined;
  }

  return {
    load() {
      if (!loading) {
        // The first call is this process starting (the host screen's first mount, before the runtime). A
        // notification an earlier process showed can never be taken back (the server's record and
        // `previews` died with it), so none is kept.
        forgetAll();
        loading = deps
          .readLevel()
          .then(
            (raw) => {
              const stored = parseAlertLevel(raw);
              if (stored && !chosen) {
                level = stored;
              }
              return level;
            },
            () => level,
          );
      }
      return loading;
    },
    notice(raw) {
      const notice = parseMessageNotice(raw);
      if (!notice || !shouldNotify(notice, level, deps.isAppActive())) {
        return false;
      }
      const count = (counts.get(notice.conversation) ?? 0) + 1;
      counts.set(notice.conversation, count);
      const ids = counted.get(notice.conversation) ?? [];
      ids.push(notice.messageId);
      if (ids.length > MAX_COUNTED_MESSAGE_IDS) {
        ids.shift();
      }
      counted.set(notice.conversation, ids);
      const shown = deps.show(notificationContent(notice, count));
      if (shown) {
        previews.set(notice.conversation, notice.messageId);
      }
      return shown;
    },
    withdraw(raw) {
      const withdrawal = parseMessageWithdrawal(raw);
      if (!withdrawal) {
        return false;
      }
      if ('conversation' in withdrawal) {
        const showing = previews.delete(withdrawal.conversation);
        counts.delete(withdrawal.conversation);
        counted.delete(withdrawal.conversation);
        deps.clearConversation(withdrawal.conversation);
        return showing;
      }
      // Forgotten once counted, so a repeated withdrawal lowers nothing.
      const counter = uncount(withdrawal.messageId);
      if (counter !== undefined) {
        lowerCount(counter);
      }
      // Only the newest message's text is on screen; an older one in the same conversation shows nowhere,
      // so its notification stays with the lower count showing on the next message.
      for (const [conversation, messageId] of previews) {
        if (messageId === withdrawal.messageId) {
          previews.delete(conversation);
          if (counter === undefined) {
            // Counted before the ones remembered (a run of notices the shade refused): still one fewer.
            lowerCount(conversation);
          }
          deps.clearConversation(conversation);
          return true;
        }
      }
      return false;
    },
    setLevel(next) {
      chosen = true;
      level = next;
      if (next === 'off') {
        forgetAll();
      }
      // Written every time (the WebView posts once per page load), so a stored level never lags the choice.
      void deps.writeLevel(next).catch(() => undefined);
    },
    appBecameActive() {
      forgetAll();
    },
    clearAll() {
      forgetAll();
    },
    level: () => level,
  };
}

// New-message notifications on the host phone (docs/04 "Message notifications"). The embedded server hands
// main.js each new message the host's own person can see (`globalThis.__loamNotifyHost`, apps/server
// realtime.ts `notifyHostDevice`), main.js posts it here as `loam-message-notice`, and this shows an Android
// notification while LOAM is in the background. Which messages notify is the level the person chose in the
// web client's Settings (Direct messages / Every message / Nothing), posted by the WebView as `loam-alerts`
// and kept in SecureStore so it applies before the WebView loads. Pure: the native calls, app state and
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

/** A notice from main.js, or undefined when it's malformed. */
export function parseMessageNotice(raw: unknown): MessageNotice | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const value = raw as Record<string, unknown>;
  if (
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
  readLevel: () => Promise<string | null>;
  writeLevel: (level: AlertLevel) => Promise<void>;
};

export type MessageNotifier = {
  /** Read the stored level once. Never rejects. */
  load: () => Promise<AlertLevel>;
  /** A `loam-message-notice` from main.js. Returns whether a notification was shown. */
  notice: (raw: unknown) => boolean;
  /** The level the WebView posted: applies now and is stored. */
  setLevel: (level: AlertLevel) => void;
  /** LOAM came to the front: the person can see the messages, so their notifications go. */
  appBecameActive: () => void;
  /** Remove every message notification now (an Emergency Reset erased what they show). */
  clearAll: () => void;
  level: () => AlertLevel;
};

/** Build the notifier over `deps`. */
export function createMessageNotifier(deps: MessageNotifierDeps): MessageNotifier {
  let level: AlertLevel = DEFAULT_ALERT_LEVEL;
  let chosen = false;
  let loading: Promise<AlertLevel> | undefined;
  // Messages per conversation since LOAM was last in front.
  const counts = new Map<string, number>();

  return {
    load() {
      if (!loading) {
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
      return deps.show(notificationContent(notice, count));
    },
    setLevel(next) {
      chosen = true;
      level = next;
      if (next === 'off') {
        counts.clear();
        deps.clear();
      }
      // Written every time (the WebView posts once per page load), so a stored level never lags the choice.
      void deps.writeLevel(next).catch(() => undefined);
    },
    appBecameActive() {
      counts.clear();
      deps.clear();
    },
    clearAll() {
      counts.clear();
      deps.clear();
    },
    level: () => level,
  };
}

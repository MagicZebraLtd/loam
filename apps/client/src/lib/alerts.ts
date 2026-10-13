/**
 * New-message alerts: a short tone and/or a vibration when a message arrives that the person isn't looking
 * at.
 *
 * A browser can't show system notifications here: the Notification and Push APIs need a secure context,
 * and a LOAM node is plain HTTP on the local network. So these alerts only play while the page is open.
 * Inside the Android host app the page is the host's own WebView: while LOAM is in the background the app
 * posts real Android notifications instead (`apps/app/src/lib/message-notifications.ts`), driven by the same
 * "which messages" choice, which this module hands to the app over the WebView bridge.
 *
 * The choice is a per-device convenience in localStorage, like the theme, and survives the identity-change
 * purge: it's a preference, not content.
 */

/** Which messages alert: direct messages only (the default), every message, or none. */
export type AlertLevel = "dms" | "all" | "off";

export const ALERT_LEVELS: readonly AlertLevel[] = ["dms", "all", "off"];

export type AlertPreferences = {
  level: AlertLevel;
  sound: boolean;
  vibrate: boolean;
};

export const ALERT_STORAGE_KEY = "loam.alerts";

export const DEFAULT_ALERT_PREFERENCES: AlertPreferences = { level: "dms", sound: true, vibrate: true };

/** A burst of messages alerts once: at most one alert in this window. */
export const ALERT_MIN_INTERVAL_MS = 2000;

/** Parse a stored value; anything missing or unknown falls back to the default for that field. */
export function parseAlertPreferences(value: unknown): AlertPreferences {
  let raw: unknown = value;
  if (typeof value === "string") {
    try {
      raw = JSON.parse(value);
    } catch {
      raw = undefined;
    }
  }
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    level: ALERT_LEVELS.includes(record.level as AlertLevel) ? (record.level as AlertLevel) : DEFAULT_ALERT_PREFERENCES.level,
    sound: typeof record.sound === "boolean" ? record.sound : DEFAULT_ALERT_PREFERENCES.sound,
    vibrate: typeof record.vibrate === "boolean" ? record.vibrate : DEFAULT_ALERT_PREFERENCES.vibrate,
  };
}

/** The saved preferences, or the defaults when storage is empty, unreadable or blocked. */
export function readAlertPreferences(): AlertPreferences {
  try {
    return parseAlertPreferences(window.localStorage.getItem(ALERT_STORAGE_KEY));
  } catch {
    return { ...DEFAULT_ALERT_PREFERENCES };
  }
}

/** Save the preferences. Best-effort: blocked storage just won't remember them. */
export function storeAlertPreferences(preferences: AlertPreferences): void {
  try {
    window.localStorage.setItem(ALERT_STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Private mode / blocked storage: the choice applies for this page only.
  }
}

/** The native Android host's WebView bridge, present only inside `apps/app`. */
function nativeBridge(): { postMessage: (message: string) => void } | undefined {
  return (window as unknown as { ReactNativeWebView?: { postMessage: (message: string) => void } }).ReactNativeWebView;
}

/** Whether this page is the Android host app's own WebView. */
export function inHostApp(): boolean {
  return !!nativeBridge();
}

/** Tell the Android host which messages should raise a notification while LOAM is in the background. */
export function postAlertLevelToHost(level: AlertLevel): void {
  try {
    nativeBridge()?.postMessage(JSON.stringify({ type: "loam-alerts", level }));
  } catch {
    // Best effort: a broken bridge leaves the app on its last known (or default) level.
  }
}

/** Save the preferences and pass the level on to the Android host. */
export function setAlertPreferences(preferences: AlertPreferences): void {
  storeAlertPreferences(preferences);
  postAlertLevelToHost(preferences.level);
}

/** What the page knows about a new message when deciding whether to alert. */
export type AlertContext = {
  preferences: AlertPreferences;
  /** A direct message to this person (not a channel post or reply). */
  direct: boolean;
  /** The message belongs to the conversation on screen. */
  inActiveConversation: boolean;
  /** The page is visible (`document.visibilityState === "visible"`). */
  pageVisible: boolean;
  /** The page is the Android host app's WebView. */
  hostApp: boolean;
};

/**
 * Whether a new message (already known not to be your own, a reaction or from someone you blocked) should
 * alert. Never for the conversation you're looking at; never in the host app while it's in the background,
 * where the app posts an Android notification instead (and would otherwise alert twice).
 */
export function shouldAlert(context: AlertContext): boolean {
  const { preferences } = context;
  if (preferences.level === "off" || (preferences.level === "dms" && !context.direct)) {
    return false;
  }
  if (!preferences.sound && !preferences.vibrate) {
    return false;
  }
  if (context.pageVisible && context.inActiveConversation) {
    return false;
  }
  return !(context.hostApp && !context.pageVisible);
}

type AudioContextConstructor = new () => AudioContext;

let audioContext: AudioContext | undefined;

/** The page's one AudioContext, created on first use; undefined where Web Audio is missing. */
function sharedAudioContext(): AudioContext | undefined {
  if (audioContext) {
    return audioContext;
  }
  const scope = window as unknown as { AudioContext?: AudioContextConstructor; webkitAudioContext?: AudioContextConstructor };
  const Constructor = scope.AudioContext ?? scope.webkitAudioContext;
  if (!Constructor) {
    return undefined;
  }
  try {
    audioContext = new Constructor();
  } catch {
    return undefined;
  }
  return audioContext;
}

/**
 * Browsers start audio suspended until the person interacts with the page. Resume it on their taps and key
 * presses until it is running (agreeing to the rules is one), so a later alert can play. Only some events
 * count as that interaction: for touch it is `pointerup`/`touchend`/`click`, not `pointerdown`
 * (https://html.spec.whatwg.org/multipage/interaction.html#activation-triggering-input-event), and a resume
 * outside one leaves the audio suspended, so every such event tries again until one works. Returns a
 * function that stops listening.
 */
export function unlockAudioOnFirstGesture(target: Window = window): () => void {
  const events = ["pointerup", "touchend", "click", "mousedown", "keydown"] as const;
  const unlock = (): void => {
    void resumeAudio().then(() => {
      if (sharedAudioContext()?.state === "running") {
        stop();
      }
    });
  };
  function stop(): void {
    for (const name of events) {
      target.removeEventListener(name, unlock, true);
    }
  }
  for (const name of events) {
    target.addEventListener(name, unlock, true);
  }
  return stop;
}

/** Resume the page's audio. Call it from a tap or key press: browsers refuse it otherwise. */
export async function resumeAudio(): Promise<void> {
  try {
    await sharedAudioContext()?.resume();
  } catch {
    // No audio on this page; alerts still vibrate where they can.
  }
}

/** Two soft rising notes, about a third of a second, made on the spot: no sound file to download. */
export function playChime(): void {
  const context = sharedAudioContext();
  if (!context || context.state !== "running") {
    return;
  }
  try {
    const start = context.currentTime;
    for (const [offset, frequency] of [
      [0, 660],
      [0.12, 880],
    ] as const) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start + offset);
      gain.gain.exponentialRampToValueAtTime(0.18, start + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.22);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start + offset);
      oscillator.stop(start + offset + 0.24);
    }
  } catch {
    // An audio failure never gets in the way of the message itself.
  }
}

/** A short double buzz, where the browser allows it (not on iPhones). */
export function buzz(): void {
  try {
    navigator.vibrate?.([60, 80, 60]);
  } catch {
    // Some browsers throw rather than ignore; the alert is best effort.
  }
}

/**
 * The alert to play now, honouring the preferences and `ALERT_MIN_INTERVAL_MS`. `effects` and `now` are
 * injectable for tests.
 */
export function createAlerter(
  effects: { sound: () => void; vibrate: () => void } = { sound: playChime, vibrate: buzz },
  now: () => number = Date.now,
): (preferences: AlertPreferences) => void {
  let last = Number.NEGATIVE_INFINITY;
  return (preferences) => {
    const at = now();
    if (at - last < ALERT_MIN_INTERVAL_MS) {
      return;
    }
    last = at;
    if (preferences.sound) {
      effects.sound();
    }
    if (preferences.vibrate) {
      effects.vibrate();
    }
  };
}

/**
 * Called once before the first render: resume audio on the first gesture, and hand the saved level to the
 * Android host (a no-op in a browser). Follows a change made in another tab, like the theme.
 */
export function installAlerts(): void {
  unlockAudioOnFirstGesture();
  postAlertLevelToHost(readAlertPreferences().level);
  window.addEventListener("storage", (event) => {
    if (event.key === ALERT_STORAGE_KEY || event.key === null) {
      postAlertLevelToHost(readAlertPreferences().level);
    }
  });
}

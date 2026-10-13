import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ALERT_MIN_INTERVAL_MS,
  ALERT_STORAGE_KEY,
  type AlertContext,
  DEFAULT_ALERT_PREFERENCES,
  createAlerter,
  parseAlertPreferences,
  readAlertPreferences,
  setAlertPreferences,
  shouldAlert,
} from "./alerts";

type BridgeWindow = Window & { ReactNativeWebView?: { postMessage: (message: string) => void } };

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  delete (window as BridgeWindow).ReactNativeWebView;
});

describe("alert preferences", () => {
  it("defaults to direct messages with sound and vibration", () => {
    expect(readAlertPreferences()).toEqual({ level: "dms", sound: true, vibrate: true });
  });

  it("keeps each valid field and defaults the rest", () => {
    expect(parseAlertPreferences('{"level":"all","sound":false}')).toEqual({ level: "all", sound: false, vibrate: true });
    expect(parseAlertPreferences('{"level":"loud","sound":"yes","vibrate":false}')).toEqual({ level: "dms", sound: true, vibrate: false });
    expect(parseAlertPreferences("not json")).toEqual(DEFAULT_ALERT_PREFERENCES);
    expect(parseAlertPreferences(null)).toEqual(DEFAULT_ALERT_PREFERENCES);
  });

  it("saves them and passes the level to the Android host app", () => {
    const posted: string[] = [];
    (window as BridgeWindow).ReactNativeWebView = { postMessage: (message) => posted.push(message) };

    setAlertPreferences({ level: "off", sound: true, vibrate: false });

    expect(JSON.parse(localStorage.getItem(ALERT_STORAGE_KEY) ?? "")).toEqual({ level: "off", sound: true, vibrate: false });
    expect(readAlertPreferences().level).toBe("off");
    expect(posted.map((message) => JSON.parse(message))).toEqual([{ type: "loam-alerts", level: "off" }]);
  });
});

describe("shouldAlert", () => {
  const base: AlertContext = {
    preferences: DEFAULT_ALERT_PREFERENCES,
    direct: true,
    inActiveConversation: false,
    pageVisible: true,
    hostApp: false,
  };

  it("alerts for a direct message in another conversation", () => {
    expect(shouldAlert(base)).toBe(true);
  });

  it("follows the level", () => {
    expect(shouldAlert({ ...base, direct: false })).toBe(false);
    expect(shouldAlert({ ...base, direct: false, preferences: { ...base.preferences, level: "all" } })).toBe(true);
    expect(shouldAlert({ ...base, preferences: { ...base.preferences, level: "off" } })).toBe(false);
  });

  it("stays quiet with both sound and vibration off", () => {
    expect(shouldAlert({ ...base, preferences: { level: "all", sound: false, vibrate: false } })).toBe(false);
  });

  it("never alerts for the conversation on screen, but does once the page is hidden", () => {
    expect(shouldAlert({ ...base, inActiveConversation: true })).toBe(false);
    expect(shouldAlert({ ...base, inActiveConversation: true, pageVisible: false })).toBe(true);
  });

  it("leaves a hidden host app to its Android notification", () => {
    expect(shouldAlert({ ...base, hostApp: true })).toBe(true);
    expect(shouldAlert({ ...base, hostApp: true, pageVisible: false })).toBe(false);
  });
});

describe("createAlerter", () => {
  it("plays what is switched on, once per burst", () => {
    const sound = vi.fn();
    const vibrate = vi.fn();
    let now = 1_000;
    const alert = createAlerter({ sound, vibrate }, () => now);

    alert({ level: "all", sound: true, vibrate: false });
    now += ALERT_MIN_INTERVAL_MS - 1;
    alert({ level: "all", sound: true, vibrate: true });
    expect(sound).toHaveBeenCalledTimes(1);
    expect(vibrate).not.toHaveBeenCalled();

    now += 1;
    alert({ level: "all", sound: false, vibrate: true });
    expect(sound).toHaveBeenCalledTimes(1);
    expect(vibrate).toHaveBeenCalledTimes(1);
  });
});

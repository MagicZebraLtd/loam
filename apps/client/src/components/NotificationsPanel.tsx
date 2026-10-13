import { useId, useState } from "preact/hooks";

import { t } from "../i18n";
import {
  ALERT_LEVELS,
  type AlertLevel,
  type AlertPreferences,
  buzz,
  inHostApp,
  playChime,
  readAlertPreferences,
  resumeAudio,
  setAlertPreferences,
} from "../lib/alerts";
import { CardHeader, SwitchRow } from "./ScreenParts";

/** The translated name of each level. */
function levelLabel(level: AlertLevel): string {
  return level === "all" ? t("settings.alertsAll") : level === "off" ? t("settings.alertsOff") : t("settings.alertsDms");
}

/**
 * Settings card for new-message alerts (lib/alerts.ts): which messages alert, and whether they play a
 * sound, vibrate, or both. Remembered on this device only. In the Android host app the level also decides
 * which messages raise an Android notification while LOAM is in the background.
 */
export function NotificationsPanel() {
  const [preferences, setPreferences] = useState<AlertPreferences>(readAlertPreferences);
  const groupName = useId();
  const hostApp = inHostApp();

  function update(next: Partial<AlertPreferences>): void {
    const merged = { ...preferences, ...next };
    setPreferences(merged);
    setAlertPreferences(merged);
  }

  function tryIt(): void {
    if (preferences.sound) {
      void resumeAudio().then(playChime);
    }
    if (preferences.vibrate) {
      buzz();
    }
  }

  const off = preferences.level === "off";

  return (
    <div className="card notifications-card">
      <CardHeader
        description={hostApp ? t("settings.alertsNoteHost") : t("settings.alertsNote")}
        title={t("settings.alertsTitle")}
      />
      <fieldset className="field alert-level-field">
        <legend className="field-label">{t("settings.alertsLevel")}</legend>
        {ALERT_LEVELS.map((level) => (
          <label className="check-row" key={level}>
            <input
              checked={preferences.level === level}
              name={groupName}
              onInput={() => update({ level })}
              type="radio"
              value={level}
            />
            {levelLabel(level)}
          </label>
        ))}
      </fieldset>
      <div className="switch-list">
        <SwitchRow checked={preferences.sound} disabled={off} label={t("settings.alertsSound")} onChange={(sound) => update({ sound })} />
        <SwitchRow
          checked={preferences.vibrate}
          description={t("settings.alertsVibrateNote")}
          disabled={off}
          label={t("settings.alertsVibrate")}
          onChange={(vibrate) => update({ vibrate })}
        />
      </div>
      <button
        className="btn btn-secondary btn-sm"
        disabled={off || (!preferences.sound && !preferences.vibrate)}
        onClick={tryIt}
        type="button"
      >
        {t("settings.alertsTry")}
      </button>
    </div>
  );
}

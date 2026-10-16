import { useEffect, useRef, useState } from "preact/hooks";

import type { DesktopBridge, UpdateCheckResult } from "../../shared/ipc";
import { t } from "../lib/strings";

/**
 * "Check for updates": asks GitHub only when pressed, never on its own (LOAM phones nowhere), and opens the
 * download page in the browser. Nothing is downloaded or installed from here.
 */
export function UpdateCheck({ bridge }: { bridge: DesktopBridge }) {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<UpdateCheckResult>();
  // The check can take up to 10 s, and the screen may be left in that time.
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  async function check(): Promise<void> {
    setChecking(true);
    setResult(undefined);
    let next: UpdateCheckResult;
    try {
      next = await bridge.checkForUpdates();
    } catch {
      next = { ok: false, error: "bad_response" };
    }
    if (mounted.current) {
      setResult(next);
      setChecking(false);
    }
  }

  return (
    <div className="stack">
      <div>
        <button className="btn btn-secondary" disabled={checking} onClick={() => void check()} type="button">
          {checking ? t("update.checking") : t("update.check")}
        </button>
      </div>
      <div aria-live="polite" className="stack">
        {result?.ok && result.newer ? (
          <div className="notice update-available">
            <span>{t("update.newer", { latest: result.latest, current: result.current })}</span>
            <button className="btn btn-primary btn-sm" onClick={() => void bridge.openExternal(result.url)} type="button">
              {t("update.download")}
            </button>
          </div>
        ) : null}
        {result?.ok && !result.newer ? <p className="muted">{t("update.current", { version: result.current })}</p> : null}
        {result && !result.ok ? (
          <p className="form-error">
            {result.error === "offline" ? t("update.offline") : result.error === "timeout" ? t("update.timeout") : t("update.badResponse")}
          </p>
        ) : null}
      </div>
      <p className="field-hint">{t("update.note")}</p>
    </div>
  );
}

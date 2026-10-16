import { useState } from "preact/hooks";

import type { DesktopBridge, DesktopState } from "../../shared/ipc";
import { NewNetworkCard } from "../components/NewNetworkCard";
import { attempt } from "../lib/attempt";
import { MAX_PASSPHRASE } from "../lib/limits";
import { t } from "../lib/strings";

/**
 * A passphrase network at launch: the passphrase starts it. It is never stored, so a forgotten one can't
 * be recovered; the way out is to erase the network and start a new one (press and hold).
 */
export function UnlockScreen({ bridge, state }: { bridge: DesktopBridge; state: Extract<DesktopState, { phase: "locked" }> }) {
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const name = state.network?.nodeName;
  const shownError = error ?? (state.wrongPassphrase ? t("unlock.wrong") : undefined);

  async function submit(event: Event): Promise<void> {
    event.preventDefault();
    if (!passphrase) {
      setError(t("unlock.missing"));
      return;
    }
    setError(undefined);
    setBusy(true);
    const result = await attempt(() => bridge.unlock({ passphrase }));
    // Don't keep the passphrase in the page longer than the attempt.
    setPassphrase("");
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
    }
  }

  return (
    <main className="screen">
      <div className="screen-column">
        <form className="card" noValidate onSubmit={(event) => void submit(event)}>
          <h1>{name ? t("unlock.title", { name }) : t("unlock.titlePlain")}</h1>
          <p className="muted">{t("unlock.body")}</p>
          <label className={`field${shownError ? " has-error" : ""}`}>
            <span className="field-label">{t("unlock.label")}</span>
            <input
              aria-invalid={shownError ? true : undefined}
              autoComplete="current-password"
              autoFocus
              className="input"
              maxLength={MAX_PASSPHRASE}
              name="passphrase"
              onInput={(event) => setPassphrase(event.currentTarget.value)}
              type="password"
              value={passphrase}
            />
            {shownError ? (
              <span className="field-error" role="alert">
                {shownError}
              </span>
            ) : null}
          </label>
          <div className="actions">
            <button className="btn btn-primary" disabled={busy} type="submit">
              {busy ? t("unlock.working") : t("unlock.submit")}
            </button>
          </div>
        </form>
        <NewNetworkCard body="unlock.forgotBody" bridge={bridge} hold="settings.newHold" title="unlock.forgotTitle" />
      </div>
    </main>
  );
}

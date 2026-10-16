import { useState } from "preact/hooks";

import type { DesktopBridge, DesktopState } from "../../shared/ipc";
import { NewNetworkCard } from "../components/NewNetworkCard";
import { attempt } from "../lib/attempt";
import { MAX_PASSPHRASE, MIN_NEW_PASSPHRASE } from "../lib/limits";
import { newPassphraseErrors } from "../lib/setup-form";
import { t } from "../lib/strings";

type Errors = { passphrase?: string; confirm?: string; submit?: string };

/**
 * A passphrase network at launch: the passphrase starts it. It is never stored, so a forgotten one can't
 * be recovered; the way out is to erase the network and start a new one (press and hold).
 *
 * `fresh`: an Emergency Reset finished at this launch and erased the network, so the passphrase typed now
 * becomes the new network's. Nothing old is left to check it against, so it is asked for twice and held to
 * Setup's rules, and there's no "forgot it" way out (there is nothing to forget yet).
 */
export function UnlockScreen({ bridge, state }: { bridge: DesktopBridge; state: Extract<DesktopState, { phase: "locked" }> }) {
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const name = state.network?.nodeName;
  const { fresh } = state;
  const passphraseError = errors.passphrase ?? errors.submit ?? (!fresh && state.wrongPassphrase ? t("unlock.wrong") : undefined);

  async function submit(event: Event): Promise<void> {
    event.preventDefault();
    const problems: Errors = fresh ? newPassphraseErrors(passphrase, confirm) : passphrase ? {} : { passphrase: t("unlock.missing") };
    if (problems.passphrase || problems.confirm) {
      setErrors(problems);
      return;
    }
    setErrors({});
    setBusy(true);
    const result = await attempt(() => bridge.unlock({ passphrase }));
    // Don't keep the passphrase in the page longer than the attempt.
    setPassphrase("");
    setConfirm("");
    setBusy(false);
    if (!result.ok) {
      setErrors({ submit: result.error });
    }
  }

  const title = fresh ? t("unlock.freshTitle") : name ? t("unlock.title", { name }) : t("unlock.titlePlain");
  const submitLabel = fresh ? (busy ? t("unlock.freshWorking") : t("unlock.freshSubmit")) : busy ? t("unlock.working") : t("unlock.submit");

  return (
    <main className="screen">
      <div className="screen-column">
        <form className="card" noValidate onSubmit={(event) => void submit(event)}>
          <h1>{title}</h1>
          <p className="muted">{fresh ? t("unlock.freshBody") : t("unlock.body")}</p>
          <label className={`field${passphraseError ? " has-error" : ""}`}>
            <span className="field-label">{t("unlock.label")}</span>
            <input
              aria-describedby={fresh ? "unlock-passphrase-hint" : undefined}
              aria-invalid={passphraseError ? true : undefined}
              autoComplete={fresh ? "new-password" : "current-password"}
              autoFocus
              className="input"
              maxLength={MAX_PASSPHRASE}
              name="passphrase"
              onInput={(event) => setPassphrase(event.currentTarget.value)}
              type="password"
              value={passphrase}
            />
            {fresh ? (
              <span className="field-hint" id="unlock-passphrase-hint">
                {t("setup.passphraseHint", { min: MIN_NEW_PASSPHRASE })}
              </span>
            ) : null}
            {passphraseError ? (
              <span className="field-error" role="alert">
                {passphraseError}
              </span>
            ) : null}
          </label>
          {fresh ? (
            <label className={`field${errors.confirm ? " has-error" : ""}`}>
              <span className="field-label">{t("setup.passphraseConfirmLabel")}</span>
              <input
                aria-invalid={errors.confirm ? true : undefined}
                autoComplete="new-password"
                className="input"
                maxLength={MAX_PASSPHRASE}
                name="confirm"
                onInput={(event) => setConfirm(event.currentTarget.value)}
                type="password"
                value={confirm}
              />
              {errors.confirm ? (
                <span className="field-error" role="alert">
                  {errors.confirm}
                </span>
              ) : null}
            </label>
          ) : null}
          <div className="actions">
            <button className="btn btn-primary" disabled={busy} type="submit">
              {submitLabel}
            </button>
          </div>
        </form>
        {fresh ? null : <NewNetworkCard body="unlock.forgotBody" bridge={bridge} hold="settings.newHold" title="unlock.forgotTitle" />}
      </div>
    </main>
  );
}

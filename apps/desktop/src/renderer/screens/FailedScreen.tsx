import { useState } from "preact/hooks";

import type { DesktopBridge, DesktopState } from "../../shared/ipc";
import { NewNetworkCard } from "../components/NewNetworkCard";
import { attempt } from "../lib/attempt";
import { errorCopy } from "../lib/errors";
import { RELEASES_PAGE } from "../lib/limits";
import { t } from "../lib/strings";

/**
 * The node couldn't start or stopped running: what happened in plain words, what to do, and Try again
 * (`start()`). Where the data can't be opened as it is, a press-and-hold offers to start a new network
 * instead. The main process's English detail sits under "Details" for bug reports, never on its own.
 */
export function FailedScreen({ bridge, state }: { bridge: DesktopBridge; state: Extract<DesktopState, { phase: "failed" }> }) {
  const copy = errorCopy(state.error.code);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function retry(): Promise<void> {
    setBusy(true);
    setError(undefined);
    const result = await attempt(() => bridge.start());
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
    }
  }

  return (
    <main className="screen">
      <div className="screen-column">
        <section aria-labelledby="failed-title" className="card" role="alert">
          <h1 id="failed-title">{t(copy.title)}</h1>
          <p>{t(copy.body)}</p>
          {state.error.detail ? (
            <details className="failed-detail">
              <summary>{t("common.details")}</summary>
              <code>{state.error.detail}</code>
            </details>
          ) : null}
          <div className="actions">
            <button className="btn btn-primary" disabled={busy} onClick={() => void retry()} type="button">
              {t("failed.retry")}
            </button>
            {copy.download ? (
              <button className="btn btn-secondary" onClick={() => void bridge.openExternal(RELEASES_PAGE)} type="button">
                {t("failed.download")}
              </button>
            ) : null}
          </div>
          {error ? <p className="form-error">{error}</p> : null}
        </section>
        {copy.newNetwork ? (
          <NewNetworkCard
            body="failed.newNetworkBody"
            bridge={bridge}
            failed="failed.newNetworkFailed"
            hold="failed.newNetworkHold"
            title="failed.newNetworkTitle"
          />
        ) : null}
      </div>
    </main>
  );
}

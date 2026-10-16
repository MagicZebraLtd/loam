import { useState } from "preact/hooks";

import type { DesktopBridge, DesktopState } from "../../shared/ipc";
import { attempt } from "../lib/attempt";
import { t } from "../lib/strings";

/** The host stopped the network: say so, and start it again in one press. */
export function StoppedScreen({ bridge, state }: { bridge: DesktopBridge; state: DesktopState }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const name = state.network?.nodeName;

  async function start(): Promise<void> {
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
        <section className="card">
          <span className="status-pill status-offline">
            <span className="status-dot" />
          </span>
          <h1>{name ? t("stopped.title", { name }) : t("stopped.titlePlain")}</h1>
          <p className="muted">{t("stopped.body")}</p>
          {state.network?.encryption === "ephemeral" ? <p className="notice">{t("stopped.ephemeral")}</p> : null}
          <div className="actions">
            <button className="btn btn-primary" disabled={busy} onClick={() => void start()} type="button">
              {t("stopped.start")}
            </button>
          </div>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
        </section>
      </div>
    </main>
  );
}

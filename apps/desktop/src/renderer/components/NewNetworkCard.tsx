import { useState } from "preact/hooks";

import type { DesktopBridge } from "../../shared/ipc";
import { attempt } from "../lib/attempt";
import { t, type StringKey } from "../lib/strings";
import { HoldToConfirm } from "./HoldToConfirm";

/**
 * "Start a new network": erase this one (an Emergency Reset if it's running, its data otherwise) and go
 * back to setup, behind a press-and-hold. Used by Settings, Unlock (a forgotten passphrase) and Failed.
 */
export function NewNetworkCard({
  body,
  bridge,
  failed = "settings.newFailed",
  hold,
  title,
}: {
  body: StringKey;
  bridge: DesktopBridge;
  failed?: StringKey;
  hold: StringKey;
  title: StringKey;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function erase(): Promise<void> {
    setBusy(true);
    setError(undefined);
    const result = await attempt(() => bridge.newNetwork());
    setBusy(false);
    if (!result.ok) {
      setError(t(failed, { error: result.error }));
    }
  }

  return (
    <section aria-labelledby="new-network-title" className="card card-danger">
      <h2 className="card-title" id="new-network-title">
        {t(title)}
      </h2>
      <p className="muted">{t(body)}</p>
      <HoldToConfirm disabled={busy} label={t(hold)} onConfirm={() => void erase()} />
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

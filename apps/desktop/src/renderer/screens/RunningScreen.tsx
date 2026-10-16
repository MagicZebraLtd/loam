import { useCallback, useEffect, useRef, useState } from "preact/hooks";

import type { DesktopBridge, DesktopState } from "../../shared/ipc";
import { HoldToConfirm } from "../components/HoldToConfirm";
import { HostNote } from "../components/HostNote";
import { QrCode } from "../components/QrCode";
import { SupportDialog } from "../components/SupportDialog";
import { attempt } from "../lib/attempt";
import { connectedText, peopleText, typedAddress } from "../lib/format";
import { needsHostAck } from "../lib/limits";
import { hasInvite, hasKey } from "../lib/link-code";
import { t } from "../lib/strings";
import { DisplayMode } from "./DisplayMode";
import { LinkNode } from "./LinkNode";

type View = "main" | "display" | "link";

/**
 * The running network (the Android share screen and the TUI's Join screen): its name, the join QR and the
 * address with Copy, who is connected, and what the host does next: open LOAM (as admin, by the injected
 * host token), show the code full-window, link another node, or stop. Closing the window keeps it running.
 */
export function RunningScreen({ bridge, state }: { bridge: DesktopBridge; state: Extract<DesktopState, { phase: "running" }> }) {
  const { node } = state;
  const [view, setView] = useState<View>("main");
  const [copied, setCopied] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string>();
  const displayButton = useRef<HTMLButtonElement>(null);
  const linkButton = useRef<HTMLButtonElement>(null);
  const returnTo = useRef<View>("main");
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>();
  // A network that keeps its messages only while it runs loses them for good when stopped.
  const ephemeral = node.dbEncryption === "ephemeral";

  useEffect(() => () => clearTimeout(copiedTimer.current), []);

  // Back on the main view, focus goes back to the button that left it.
  useEffect(() => {
    if (view === "main" && returnTo.current !== "main") {
      (returnTo.current === "display" ? displayButton : linkButton).current?.focus();
      returnTo.current = "main";
    }
  }, [view]);

  // Stable, so Display mode's Esc listener isn't re-bound on every state push.
  const viewRef = useRef(view);
  viewRef.current = view;
  const leave = useCallback(() => {
    returnTo.current = viewRef.current;
    setView("main");
  }, []);

  async function copy(): Promise<void> {
    try {
      await bridge.copy(node.joinUrl);
    } catch {
      return;
    }
    setCopied(true);
    clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 2_000);
  }

  async function stop(): Promise<void> {
    setStopping(true);
    setError(undefined);
    const result = await attempt(() => bridge.stop());
    setStopping(false);
    if (!result.ok) {
      setError(result.error);
    }
  }

  if (view === "display") {
    return <DisplayMode joinUrl={node.joinUrl} nodeName={node.nodeName} onExit={leave} />;
  }
  if (view === "link") {
    return <LinkNode bridge={bridge} joinUrl={node.joinUrl} onBack={leave} />;
  }

  const { people } = node;
  return (
    <main className="screen">
      <div className="screen-column">
        {needsHostAck(state.settings.hostAck) ? (
          <HostNote>
            <div>
              <button className="btn btn-primary btn-sm" onClick={() => void bridge.acknowledgeHost()} type="button">
                {t("hostNote.agree")}
              </button>
            </div>
          </HostNote>
        ) : null}

        <section aria-labelledby="running-name" className="card running">
          <div className="running-head">
            <h1 id="running-name">{node.nodeName}</h1>
            <span className="status-pill status-live">
              <span className="status-dot" />
              {t("running.status")}
            </span>
          </div>
          {node.resetting ? (
            <p className="notice notice-danger" role="alert">
              {t("running.resetting")}
            </p>
          ) : null}
          <div className="running-join">
            <QrCode className="running-qr" fallback={t("running.qrUnavailable")} value={node.joinUrl} />
            <div className="running-info">
              <p>{t("running.scan")}</p>
              <div className="join-url">
                <code>{typedAddress(node.joinUrl)}</code>
                <button className="btn btn-secondary btn-sm" onClick={() => void copy()} type="button">
                  {copied ? t("common.copied") : t("common.copy")}
                </button>
              </div>
              {hasKey(node.joinUrl) ? <p className="muted">{t("running.keyNote")}</p> : null}
              {hasInvite(node.joinUrl) ? <p className="notice">{t("running.inviteNote")}</p> : null}
              <p className="running-count" aria-live="polite">
                <strong>{connectedText(node.clients.length)}</strong>
                <span className="muted">
                  {peopleText(people.total, people.online)}
                  {people.pending ? ` · ${t("running.pending", { n: people.pending })}` : ""}
                </span>
              </p>
              {people.admins === 0 ? <p className="notice">{t("running.noAdmin")}</p> : null}
            </div>
          </div>
          <div className="actions">
            <button className="btn btn-primary" onClick={() => void bridge.openClient()} type="button">
              {t("running.open")}
            </button>
            <button className="btn btn-secondary" onClick={() => setView("display")} ref={displayButton} type="button">
              {t("running.display")}
            </button>
            <button className="btn btn-secondary" onClick={() => setView("link")} ref={linkButton} type="button">
              {t("running.link")}
            </button>
          </div>
        </section>

        <section className="card">
          {ephemeral ? (
            <>
              <p className="muted">{t("running.stopEphemeral")}</p>
              <HoldToConfirm disabled={stopping} label={stopping ? t("running.stopping") : t("running.stopHold")} onConfirm={() => void stop()} />
            </>
          ) : (
            <div>
              <button className="btn btn-secondary" disabled={stopping} onClick={() => void stop()} type="button">
                {stopping ? t("running.stopping") : t("running.stop")}
              </button>
            </div>
          )}
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <p className="muted">{t("running.closeNote")}</p>
          <SupportDialog bridge={bridge} />
        </section>
      </div>
    </main>
  );
}

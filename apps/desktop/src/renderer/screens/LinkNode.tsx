import type { HostCode } from "@loam/schema";
import { useEffect, useRef, useState } from "preact/hooks";

import type { DesktopBridge } from "../../shared/ipc";
import { QrCode } from "../components/QrCode";
import { attempt } from "../lib/attempt";
import { shortTime } from "../lib/format";
import { linkCodeUrl } from "../lib/link-code";
import { t } from "../lib/strings";

type Shown = { kind: "loading" } | { kind: "code"; code: HostCode } | { kind: "failed"; error: string };

/**
 * "Link another LOAM node" (server `sync-links.ts`, apps/app/src/components/link-node.tsx): the host shows a
 * single-use, 10-minute code that another LOAM phone scans from its setup screens. Showing it is the
 * approval, so a fresh code is made only when this view opens or New code is pressed; leaving doesn't
 * cancel one already shown (it simply expires).
 */
export function LinkNode({ bridge, joinUrl, onBack }: { bridge: DesktopBridge; joinUrl: string; onBack: () => void }) {
  const [shown, setShown] = useState<Shown>({ kind: "loading" });
  const [attemptCount, setAttemptCount] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    heading.current?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setShown({ kind: "loading" });
    void attempt(() => bridge.host.linkCode()).then((result) => {
      if (!cancelled) {
        setShown(result.ok ? { kind: "code", code: result.value } : { kind: "failed", error: result.error });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [bridge, attemptCount]);

  const linkUrl = shown.kind === "code" ? linkCodeUrl(joinUrl, shown.code.code) : undefined;

  return (
    <main className="screen">
      <div className="screen-column">
        <div>
          <button className="btn btn-ghost btn-sm" onClick={onBack} type="button">
            {t("common.back")}
          </button>
        </div>
        <section aria-labelledby="link-title" className="card link-node">
          <h1 id="link-title" ref={heading} tabIndex={-1}>
            {t("link.title")}
          </h1>
          <p>{t("link.body")}</p>
          <p className="muted">{t("link.sameNetwork")}</p>
          <div aria-live="polite" className="link-code">
            {shown.kind === "loading" ? <p className="muted">{t("link.loading")}</p> : null}
            {shown.kind === "failed" ? <p className="form-error">{t("link.failed", { error: shown.error })}</p> : null}
            {shown.kind === "code" && !linkUrl ? <p className="form-error">{t("link.noKey")}</p> : null}
            {shown.kind === "code" && linkUrl ? (
              <>
                <QrCode className="link-qr" ecLevel="M" fallback={t("running.qrUnavailable")} value={linkUrl} />
                <p className="muted">{t("link.expires", { time: shortTime(shown.code.expiresAt) })}</p>
              </>
            ) : null}
          </div>
          <p className="muted">{t("link.summary")}</p>
          <div className="actions">
            <button
              className="btn btn-secondary"
              disabled={shown.kind === "loading"}
              onClick={() => setAttemptCount((count) => count + 1)}
              type="button"
            >
              {t("link.again")}
            </button>
          </div>
        </section>
      </div>
    </main>
  );
}

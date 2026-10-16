import { useEffect, useRef } from "preact/hooks";

import { QrCode } from "../components/QrCode";
import { typedAddress } from "../lib/format";
import { t } from "../lib/strings";

/**
 * Display mode (apps/app/src/components/display-mode.tsx): the join QR filling the window, for a screen
 * left where people can see it, with the network's name above and the address below. Esc or the button
 * leaves. Unlike the phone's, leaving takes no press-and-hold: a desktop window can be closed or switched
 * away from anyway, so a hold would protect nothing.
 */
export function DisplayMode({ joinUrl, nodeName, onExit }: { joinUrl: string; nodeName?: string; onExit: () => void }) {
  const exitButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    exitButton.current?.focus();
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        onExit();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onExit]);

  return (
    <div aria-labelledby="display-heading" aria-modal="true" className="display-mode" role="dialog">
      <h1 className="display-heading" id="display-heading">
        {nodeName ? t("display.heading", { name: nodeName }) : t("display.headingPlain")}
      </h1>
      <QrCode className="display-qr" fallback={t("running.qrUnavailable")} value={joinUrl} />
      <p className="display-url">{typedAddress(joinUrl)}</p>
      <div className="display-exit">
        <button className="btn btn-secondary" onClick={onExit} ref={exitButton} type="button">
          {t("display.exit")}
        </button>
        <span className="muted">{t("display.exitHint")}</span>
      </div>
    </div>
  );
}

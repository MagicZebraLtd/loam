import { useEffect, useRef, useState } from "preact/hooks";

import type { DesktopBridge } from "../../shared/ipc";
import { t } from "../lib/strings";

/** LOAM's Ko-fi page (also in .github/FUNDING.yml); allowed in main/external-links.ts. */
export const SUPPORT_URL = "https://ko-fi.com/magiczebra";

/**
 * A quiet "Support LOAM" link button and the modal it opens: what LOAM costs to make and a button to Ko-fi.
 * It never opens on its own. Esc, the backdrop and Close dismiss it, and focus goes back to the button.
 */
export function SupportDialog({ bridge }: { bridge: DesktopBridge }) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    panel.current?.focus();
    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        close();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  /** Close and put focus back on the opener. */
  function close(): void {
    setOpen(false);
    opener.current?.focus();
  }

  return (
    <>
      <button className="btn btn-ghost btn-sm support-link" onClick={() => setOpen(true)} ref={opener} type="button">
        {t("support.open")}
      </button>
      {open ? (
        <div
          className="dialog-backdrop"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              close();
            }
          }}
        >
          <div aria-labelledby="support-title" aria-modal="true" className="dialog" ref={panel} role="dialog" tabIndex={-1}>
            <div className="dialog-header">
              <h2 className="dialog-title" id="support-title">
                {t("support.title")}
              </h2>
            </div>
            <div className="dialog-body">
              <p>{t("support.body")}</p>
              <p className="support-url">{SUPPORT_URL}</p>
              <div className="dialog-actions">
                <button className="btn btn-secondary" onClick={close} type="button">
                  {t("common.close")}
                </button>
                <button className="btn btn-primary" onClick={() => void bridge.openExternal(SUPPORT_URL)} type="button">
                  {t("support.kofi")}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

import type { ComponentChildren } from "preact";

import { t } from "../lib/strings";

/**
 * "You run this network": what hosting means, in the TUI's words (packages/tui/src/app.ts `hostNotice`,
 * `HOST_ACK_VERSION`), shown until the host has acknowledged it once. The caller supplies the control that
 * acknowledges it (setup's checkbox, or a button on the Running screen).
 */
export function HostNote({ children, titleId = "host-note-title" }: { children?: ComponentChildren; titleId?: string }) {
  return (
    <section aria-labelledby={titleId} className="card host-note">
      <h2 className="card-title" id={titleId}>
        {t("hostNote.title")}
      </h2>
      <p>{t("hostNote.stored")}</p>
      <p>{t("hostNote.reports")}</p>
      <p>{t("hostNote.child")}</p>
      <p className="muted">{t("hostNote.more")}</p>
      {children}
    </section>
  );
}

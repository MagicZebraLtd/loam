import loamMark from "@client-assets/loam.svg";

import { t, type StringKey } from "../lib/strings";

export type Tab = "network" | "people" | "activity" | "settings";

export const TABS: readonly { id: Tab; label: StringKey }[] = [
  { id: "network", label: "tabs.network" },
  { id: "people", label: "tabs.people" },
  { id: "activity", label: "tabs.activity" },
  { id: "settings", label: "tabs.settings" },
];

/**
 * The bar along the top once a network exists: the mark, the network's name, and the four screens (the
 * TUI's tabs). Plain buttons in a nav, with the current one marked, so Tab and Enter are all it takes.
 */
export function TabBar({
  current,
  nodeName,
  onSelect,
  pending = 0,
}: {
  current: Tab;
  nodeName?: string;
  onSelect: (tab: Tab) => void;
  /** People waiting for approval, as a badge on People. */
  pending?: number;
}) {
  return (
    <header className="topbar">
      <div className="topbar-brand">
        <img alt="" className="topbar-mark" src={loamMark} />
        <span className="topbar-name">{nodeName || t("app.name")}</span>
      </div>
      <nav aria-label={t("tabs.label")} className="tabs">
        {TABS.map((tab) => (
          <button
            aria-current={tab.id === current ? "page" : undefined}
            className={`tab${tab.id === current ? " is-current" : ""}`}
            key={tab.id}
            onClick={() => onSelect(tab.id)}
            type="button"
          >
            {t(tab.label)}
            {tab.id === "people" && pending > 0 ? <span className="unread-badge">{pending > 99 ? "99+" : pending}</span> : null}
          </button>
        ))}
      </nav>
    </header>
  );
}

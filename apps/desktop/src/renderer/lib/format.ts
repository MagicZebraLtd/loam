/** Small formatting helpers shared by the screens. */
import { t } from "./strings";

/** `HH:MM:SS` in local time (as the TUI's Activity screen shows it). */
export function clock(time: number): string {
  const date = new Date(time);
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((part) => String(part).padStart(2, "0")).join(":");
}

/** `HH:MM` in local time, for "works until". */
export function shortTime(time: number): string {
  const date = new Date(time);
  return [date.getHours(), date.getMinutes()].map((part) => String(part).padStart(2, "0")).join(":");
}

/** "No one has joined yet", "1 phone connected" or "N phones connected". */
export function connectedText(count: number): string {
  if (count <= 0) return t("running.connectedNone");
  return count === 1 ? t("running.connectedOne") : t("running.connectedMany", { n: count });
}

/** "N people, M online", singular when there is one. */
export function peopleText(total: number, online: number): string {
  return total === 1 ? t("running.peopleOne", { online }) : t("running.people", { total, online });
}

/** The address joiners can type: the join URL without its `#k=…` fragment (the key only travels in the QR). */
export function typedAddress(joinUrl: string): string {
  const hash = joinUrl.indexOf("#");
  return (hash === -1 ? joinUrl : joinUrl.slice(0, hash)).replace(/\/$/, "");
}

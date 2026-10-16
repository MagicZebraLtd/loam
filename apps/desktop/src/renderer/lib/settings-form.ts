/**
 * The Settings screen's launcher fields (port, join address, activity detail) as a `SettingsUpdate`, checked
 * the way the main process will check them (`SettingsUpdateSchema` in ipc.ts), so a mistake shows beside
 * its field instead of as a refused save.
 */
import type { HostLogLevel } from "@loam/schema";

import type { DesktopSettingsView, SettingsUpdate } from "../../shared/ipc";
import { t } from "./strings";

/** `JoinHostSchema`'s pattern in ipc.ts: an IPv4 literal or a DNS name. Kept equal by settings-form.test.ts. */
export const JOIN_HOST_PATTERN =
  /^(?:\d{1,3}(?:\.\d{1,3}){3}|[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)$/;

export type SettingsForm = {
  /** As typed; blank means the default port. */
  port: string;
  /** As typed or chosen; blank means automatic. */
  joinHost: string;
  logLevel: HostLogLevel;
};

export type SettingsErrors = Partial<Record<"port" | "joinHost", string>>;

/** The form's starting values, from the saved settings. */
export function settingsFormFrom(settings: DesktopSettingsView): SettingsForm {
  return { port: settings.port === undefined ? "" : String(settings.port), joinHost: settings.joinHost ?? "", logLevel: settings.logLevel };
}

/** A port as typed: `null` for blank (the default), the number when valid, else undefined. */
export function parsePort(value: string): number | null | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (!/^\d{1,5}$/.test(trimmed)) {
    return undefined;
  }
  const port = Number(trimmed);
  return port >= 1 && port <= 65535 ? port : undefined;
}

/** Whether a join address is one the main process accepts (blank is "automatic", always fine). */
export function validJoinHost(value: string): boolean {
  const trimmed = value.trim();
  return !trimmed || (trimmed.length <= 253 && JOIN_HOST_PATTERN.test(trimmed));
}

/** The update to send, or the errors to show. Every field is sent, so the saved settings match the form. */
export function settingsUpdateFrom(form: SettingsForm): { ok: true; update: SettingsUpdate } | { ok: false; errors: SettingsErrors } {
  const errors: SettingsErrors = {};
  const port = parsePort(form.port);
  if (port === undefined) {
    errors.port = t("settings.portInvalid");
  }
  if (!validJoinHost(form.joinHost)) {
    errors.joinHost = t("settings.joinHostInvalid");
  }
  if (port === undefined || errors.joinHost) {
    return { ok: false, errors };
  }
  const joinHost = form.joinHost.trim();
  return { ok: true, update: { port, joinHost: joinHost || null, logLevel: form.logLevel } };
}

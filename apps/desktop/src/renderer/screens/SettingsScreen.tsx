import type { DbEncryptionMode, HostLogLevel, TransportEncryption } from "@loam/schema";
import { useState } from "preact/hooks";

import type { DesktopBridge, DesktopState } from "../../shared/ipc";
import { HoldToConfirm } from "../components/HoldToConfirm";
import { NewNetworkCard } from "../components/NewNetworkCard";
import { SupportDialog } from "../components/SupportDialog";
import { UpdateCheck } from "../components/UpdateCheck";
import { attempt } from "../lib/attempt";
import { DEFAULT_PORT } from "../lib/limits";
import { type SettingsErrors, settingsFormFrom, settingsUpdateFrom } from "../lib/settings-form";
import { t, type StringKey } from "../lib/strings";

const STORAGE_LABEL: Record<DbEncryptionMode, StringKey> = {
  off: "encryption.off",
  ephemeral: "encryption.ephemeral",
  passphrase: "encryption.passphrase",
  persistent: "encryption.persistent",
};

const TRANSPORT_LABEL: Record<TransportEncryption, StringKey> = {
  optional: "settings.transportOptional",
  required: "settings.transportRequired",
  off: "settings.transportOff",
};

type Note = { kind: "ok" | "error"; text: string };

/**
 * Settings (the launcher's own, from desktop.json; the network's settings are in the web app's admin page):
 * the port and join address for the next start, how much the Activity screen shows, the encryption in
 * force (read-only: it was fixed at setup), updates, the data folder, and the two erasing actions behind a
 * press-and-hold.
 */
export function SettingsScreen({ bridge, state }: { bridge: DesktopBridge; state: DesktopState }) {
  const running = state.phase === "running" ? state.node : undefined;
  // Seeded once: state pushes arrive every few seconds and mustn't undo what's being typed.
  const [form, setForm] = useState(() => settingsFormFrom(state.settings));
  const [errors, setErrors] = useState<SettingsErrors>({});
  const [saving, setSaving] = useState(false);
  const [saveNote, setSaveNote] = useState<Note>();
  const [resetting, setResetting] = useState(false);
  const [resetNote, setResetNote] = useState<Note>();

  async function save(event: Event): Promise<void> {
    event.preventDefault();
    const checked = settingsUpdateFrom(form);
    if (!checked.ok) {
      setErrors(checked.errors);
      setSaveNote(undefined);
      return;
    }
    setErrors({});
    setSaving(true);
    const result = await attempt(() => bridge.updateSettings(checked.update));
    setSaving(false);
    if (result.ok) {
      setForm(settingsFormFrom(result.value));
      setSaveNote({ kind: "ok", text: t("common.saved") });
    } else {
      setSaveNote({ kind: "error", text: t("settings.saveFailed", { error: result.error }) });
    }
  }

  async function emergencyReset(): Promise<void> {
    setResetting(true);
    setResetNote(undefined);
    const result = await attempt(() => bridge.host.emergencyReset());
    setResetting(false);
    if (!result.ok) {
      setResetNote({ kind: "error", text: t("settings.resetFailed", { error: result.error }) });
    } else if (result.value.complete) {
      setResetNote({ kind: "ok", text: t("settings.resetDone") });
    } else {
      setResetNote({ kind: "error", text: t(result.value.journaled ? "settings.resetJournaled" : "settings.resetUnrecorded") });
    }
  }

  // The addresses to choose from, keeping a pinned one that this computer no longer has (so it shows).
  const addresses = running ? [...new Set([...(form.joinHost ? [form.joinHost] : []), ...running.addresses])] : [];
  const storage = running?.dbEncryption ?? state.network?.encryption;

  return (
    <main className="screen">
      <div className="screen-column">
        <h1>{t("settings.title")}</h1>

        <form aria-labelledby="settings-startup" className="card" noValidate onSubmit={(event) => void save(event)}>
          <h2 className="card-title" id="settings-startup">
            {t("settings.startupTitle")}
          </h2>
          <label className={`field${errors.port ? " has-error" : ""}`}>
            <span className="field-label">{t("settings.portLabel")}</span>
            <input
              aria-describedby="settings-port-hint"
              aria-invalid={errors.port ? true : undefined}
              className="input input-short"
              inputMode="numeric"
              max={65535}
              min={1}
              name="port"
              onInput={(event) => setForm({ ...form, port: event.currentTarget.value })}
              placeholder={String(DEFAULT_PORT)}
              type="number"
              value={form.port}
            />
            <span className="field-hint" id="settings-port-hint">
              {t("settings.portHint")}
            </span>
            {errors.port ? <span className="field-error">{errors.port}</span> : null}
          </label>

          <label className={`field${errors.joinHost ? " has-error" : ""}`}>
            <span className="field-label">{t("settings.joinHostLabel")}</span>
            {running ? (
              <select className="select" name="joinHost" onChange={(event) => setForm({ ...form, joinHost: event.currentTarget.value })} value={form.joinHost}>
                <option value="">{t("settings.joinHostAuto")}</option>
                {addresses.map((address) => (
                  <option key={address} value={address}>
                    {address}
                  </option>
                ))}
              </select>
            ) : (
              <input
                aria-invalid={errors.joinHost ? true : undefined}
                autoComplete="off"
                className="input"
                name="joinHost"
                onInput={(event) => setForm({ ...form, joinHost: event.currentTarget.value })}
                placeholder={t("settings.joinHostAuto")}
                spellcheck={false}
                type="text"
                value={form.joinHost}
              />
            )}
            <span className="field-hint">{running ? t("settings.joinHostHint") : t("settings.joinHostTextHint")}</span>
            {errors.joinHost ? <span className="field-error">{errors.joinHost}</span> : null}
          </label>

          <label className="field">
            <span className="field-label">{t("settings.logLevelLabel")}</span>
            <select
              className="select"
              name="logLevel"
              onChange={(event) => setForm({ ...form, logLevel: event.currentTarget.value as HostLogLevel })}
              value={form.logLevel}
            >
              <option value="info">{t("settings.logInfo")}</option>
              <option value="debug">{t("settings.logDebug")}</option>
            </select>
          </label>

          <div className="actions">
            <button className="btn btn-primary" disabled={saving} type="submit">
              {t("common.save")}
            </button>
            {saveNote ? (
              <span className={saveNote.kind === "error" ? "form-error" : "muted"} role={saveNote.kind === "error" ? "alert" : "status"}>
                {saveNote.text}
              </span>
            ) : null}
          </div>
        </form>

        <section aria-labelledby="settings-security" className="card">
          <h2 className="card-title" id="settings-security">
            {t("settings.securityTitle")}
          </h2>
          <dl className="facts">
            <dt>{t("settings.storage")}</dt>
            <dd>{storage ? t(STORAGE_LABEL[storage]) : t("settings.unknown")}</dd>
            {running ? (
              <>
                <dt>{t("settings.connections")}</dt>
                <dd>{t(TRANSPORT_LABEL[running.transportEncryption])}</dd>
              </>
            ) : null}
          </dl>
          <p className="field-hint">{t("settings.storageFixed")}</p>
        </section>

        <section aria-labelledby="settings-updates" className="card">
          <h2 className="card-title" id="settings-updates">
            {t("update.title")}
          </h2>
          <UpdateCheck bridge={bridge} />
          <SupportDialog bridge={bridge} />
        </section>

        <section aria-labelledby="settings-data" className="card">
          <h2 className="card-title" id="settings-data">
            {t("settings.dataTitle")}
          </h2>
          <p className="muted">{t("settings.dataBody")}</p>
          <code className="path">{state.settings.dataDir}</code>
          <div>
            <button className="btn btn-secondary" onClick={() => void bridge.openDataFolder()} type="button">
              {t("settings.openDataFolder")}
            </button>
          </div>
        </section>

        <section aria-labelledby="settings-reset" className="card card-danger">
          <h2 className="card-title" id="settings-reset">
            {t("settings.resetTitle")}
          </h2>
          <p className="muted">{t("settings.resetBody")}</p>
          {running ? (
            <HoldToConfirm disabled={resetting} label={t("settings.resetHold")} onConfirm={() => void emergencyReset()} />
          ) : (
            <p className="field-hint">{t("settings.resetNotRunning")}</p>
          )}
          {resetNote ? (
            <p className={resetNote.kind === "error" ? "form-error" : "muted"} role={resetNote.kind === "error" ? "alert" : "status"}>
              {resetNote.text}
            </p>
          ) : null}
        </section>

        {state.network ? <NewNetworkCard body="settings.newBody" bridge={bridge} hold="settings.newHold" title="settings.newTitle" /> : null}

        <p className="muted about">{t("settings.version", { version: state.settings.version })}</p>
      </div>
    </main>
  );
}

import type { DbEncryptionMode, SetupPreset } from "@loam/schema";
import { useState } from "preact/hooks";

import type { DesktopBridge, DesktopState } from "../../shared/ipc";
import { HostNote } from "../components/HostNote";
import { MAX_NODE_NAME, MAX_PASSPHRASE, MIN_NEW_PASSPHRASE, needsHostAck } from "../lib/limits";
import { availableEncryption, defaultEncryption, type SetupErrors, validateSetup } from "../lib/setup-form";
import { t, type StringKey } from "../lib/strings";

const PRESETS: readonly { preset: SetupPreset; title: StringKey; body: StringKey; note?: StringKey }[] = [
  { preset: "community", title: "setup.communityTitle", body: "setup.communityBody", note: "setup.communityNote" },
  { preset: "private", title: "setup.privateTitle", body: "setup.privateBody", note: "setup.privateNote" },
  { preset: "custom", title: "setup.customTitle", body: "setup.customBody" },
];

const ENCRYPTION_COPY: Record<DbEncryptionMode, { title: StringKey; body: StringKey }> = {
  persistent: { title: "encryption.persistent", body: "encryption.persistentBody" },
  passphrase: { title: "encryption.passphrase", body: "encryption.passphraseBody" },
  ephemeral: { title: "encryption.ephemeral", body: "encryption.ephemeralBody" },
  off: { title: "encryption.off", body: "encryption.offBody" },
};

/**
 * First run (apps/app/src/components/setup-wizard.tsx, on one page since a desktop window has the room): the
 * network's name, what kind of network it is, how its messages are stored, a passphrase when that's the
 * choice, and the one-time "You run this network" note. Nothing starts until Start is pressed and the form
 * checks out; the main process checks the request again.
 */
export function SetupScreen({ bridge, state }: { bridge: DesktopBridge; state: DesktopState }) {
  const { capabilities } = state;
  const mustAck = needsHostAck(state.settings.hostAck);
  const [nodeName, setNodeName] = useState("");
  const [preset, setPreset] = useState<SetupPreset>("community");
  const [encryption, setEncryption] = useState<DbEncryptionMode>(() => defaultEncryption("community", capabilities));
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [errors, setErrors] = useState<SetupErrors>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const modes = availableEncryption(capabilities);

  function choosePreset(next: SetupPreset): void {
    setPreset(next);
    // Each kind of network comes with its own storage; the host can still change it below.
    setEncryption(defaultEncryption(next, capabilities));
  }

  async function submit(event: Event): Promise<void> {
    event.preventDefault();
    const checked = validateSetup(
      { nodeName, preset, encryption, passphrase, confirm, acknowledged: acknowledged || !mustAck },
      capabilities,
    );
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    setFailure(undefined);
    setBusy(true);
    try {
      if (mustAck) {
        await bridge.acknowledgeHost();
      }
      const result = await bridge.setup(checked.request);
      if (!result.ok) {
        setFailure(t("setup.failed", { error: result.error }));
      }
    } catch (cause) {
      setFailure(t("setup.failed", { error: cause instanceof Error ? cause.message : String(cause) }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="screen">
      <form className="screen-column" noValidate onSubmit={(event) => void submit(event)}>
        <div className="hero">
          <h1>{t("setup.welcomeTitle")}</h1>
          <p className="lead">{t("setup.welcomeBody")}</p>
        </div>

        <section className="card">
          <label className={`field${errors.nodeName ? " has-error" : ""}`}>
            <span className="field-label">{t("setup.nameLabel")}</span>
            <input
              aria-describedby="setup-name-hint"
              aria-invalid={errors.nodeName ? true : undefined}
              autoComplete="off"
              className="input"
              maxLength={MAX_NODE_NAME}
              name="nodeName"
              onInput={(event) => setNodeName(event.currentTarget.value)}
              placeholder="LOAM"
              spellcheck={false}
              type="text"
              value={nodeName}
            />
            <span className="field-hint" id="setup-name-hint">
              {t("setup.nameHint")}
            </span>
            {errors.nodeName ? <span className="field-error">{errors.nodeName}</span> : null}
          </label>
        </section>

        <section aria-labelledby="setup-type-title" className="card choice-group">
          <h2 className="card-title" id="setup-type-title">
            {t("setup.typeTitle")}
          </h2>
          <p className="muted">{t("setup.typeBody")}</p>
          <div aria-labelledby="setup-type-title" className="choice-list" role="radiogroup">
            {PRESETS.map((option) => (
              <label className={`choice${preset === option.preset ? " is-selected" : ""}`} key={option.preset}>
                <input checked={preset === option.preset} name="preset" onChange={() => choosePreset(option.preset)} type="radio" value={option.preset} />
                <span className="choice-text">
                  <span className="choice-title">{t(option.title)}</span>
                  <span className="choice-body">{t(option.body)}</span>
                  {option.note ? <span className="choice-note">{t(option.note)}</span> : null}
                </span>
              </label>
            ))}
          </div>
        </section>

        <section aria-labelledby="setup-storage-title" className={`card choice-group${errors.encryption ? " has-error" : ""}`}>
          <h2 className="card-title" id="setup-storage-title">
            {t("setup.storageTitle")}
          </h2>
          <p className="muted">{t("setup.storageBody")}</p>
          <div aria-labelledby="setup-storage-title" className="choice-list" role="radiogroup">
            {modes.map((mode) => (
              <label className={`choice${encryption === mode ? " is-selected" : ""}`} key={mode}>
                <input checked={encryption === mode} name="encryption" onChange={() => setEncryption(mode)} type="radio" value={mode} />
                <span className="choice-text">
                  <span className="choice-title">{t(ENCRYPTION_COPY[mode].title)}</span>
                  <span className="choice-body">{t(ENCRYPTION_COPY[mode].body)}</span>
                </span>
              </label>
            ))}
          </div>
          {capabilities.keychain ? null : <p className="notice">{t("setup.keychainMissing")}</p>}
          {errors.encryption ? <span className="field-error">{errors.encryption}</span> : null}

          {encryption === "passphrase" ? (
            <div className="field-pair">
              <label className={`field${errors.passphrase ? " has-error" : ""}`}>
                <span className="field-label">{t("setup.passphraseLabel")}</span>
                <input
                  aria-describedby="setup-passphrase-hint"
                  aria-invalid={errors.passphrase ? true : undefined}
                  autoComplete="new-password"
                  className="input"
                  maxLength={MAX_PASSPHRASE}
                  name="passphrase"
                  onInput={(event) => setPassphrase(event.currentTarget.value)}
                  type="password"
                  value={passphrase}
                />
                <span className="field-hint" id="setup-passphrase-hint">
                  {t("setup.passphraseHint", { min: MIN_NEW_PASSPHRASE })}
                </span>
                {errors.passphrase ? <span className="field-error">{errors.passphrase}</span> : null}
              </label>
              <label className={`field${errors.confirm ? " has-error" : ""}`}>
                <span className="field-label">{t("setup.passphraseConfirmLabel")}</span>
                <input
                  aria-invalid={errors.confirm ? true : undefined}
                  autoComplete="new-password"
                  className="input"
                  maxLength={MAX_PASSPHRASE}
                  name="confirm"
                  onInput={(event) => setConfirm(event.currentTarget.value)}
                  type="password"
                  value={confirm}
                />
                {errors.confirm ? <span className="field-error">{errors.confirm}</span> : null}
              </label>
            </div>
          ) : null}
        </section>

        {mustAck ? (
          <HostNote>
            <label className="check-row">
              <input checked={acknowledged} name="acknowledged" onChange={(event) => setAcknowledged(event.currentTarget.checked)} type="checkbox" />
              <span>{t("hostNote.agree")}</span>
            </label>
            {errors.acknowledged ? <span className="field-error">{errors.acknowledged}</span> : null}
          </HostNote>
        ) : null}

        <div className="actions">
          <button className="btn btn-primary" disabled={busy} type="submit">
            {busy ? t("setup.starting") : t("setup.start")}
          </button>
        </div>
        {failure ? (
          <p className="form-error" role="alert">
            {failure}
          </p>
        ) : null}
      </form>
    </main>
  );
}

/**
 * The Setup screen's rules, kept apart from the screen so they are testable: which storage modes this
 * computer can offer, each preset's default, and turning the form into a `SetupRequest` (or the errors to
 * show beside each field).
 */
import type { DbEncryptionMode, SetupPreset } from "@loam/schema";

import type { DesktopCapabilities, SetupRequest } from "../../shared/ipc";
import { MAX_NODE_NAME, MAX_PASSPHRASE, MIN_NEW_PASSPHRASE } from "./limits";
import { t } from "./strings";

/** The storage modes, in the order the screen lists them. */
export const ENCRYPTION_ORDER: readonly DbEncryptionMode[] = ["persistent", "passphrase", "ephemeral", "off"];

/** The storage modes this computer can offer: the keychain one only when there is a keychain to keep the key. */
export function availableEncryption(capabilities: DesktopCapabilities): DbEncryptionMode[] {
  return ENCRYPTION_ORDER.filter((mode) => mode !== "persistent" || capabilities.keychain);
}

/**
 * A preset's storage, as `presetDbMode` (@loam/schema) chooses it: Private keeps nothing past a stop, the
 * others keep the key in the keychain. With no keychain, a passphrase is the safe way to keep a key, so it
 * takes the keychain's place.
 */
export function defaultEncryption(preset: SetupPreset, capabilities: DesktopCapabilities): DbEncryptionMode {
  if (preset === "private") {
    return "ephemeral";
  }
  return capabilities.keychain ? "persistent" : "passphrase";
}

export type SetupForm = {
  nodeName: string;
  preset: SetupPreset;
  encryption: DbEncryptionMode;
  passphrase: string;
  confirm: string;
  /** The host ticked "I understand" (or acknowledged the note before). */
  acknowledged: boolean;
};

export type SetupErrors = Partial<Record<"nodeName" | "encryption" | "passphrase" | "confirm" | "acknowledged", string>>;

/**
 * What's wrong with a new network's passphrase and its repeat, if anything: required, at least
 * {@link MIN_NEW_PASSPHRASE} characters, at most the contract's cap, and typed the same twice. Shared by Setup
 * and the Unlock screen's fresh mode (a passphrase network erased by an Emergency Reset gets a new one).
 */
export function newPassphraseErrors(passphrase: string, confirm: string): Pick<SetupErrors, "passphrase" | "confirm"> {
  if (!passphrase) {
    return { passphrase: t("setup.passphraseMissing") };
  }
  if (passphrase.length < MIN_NEW_PASSPHRASE) {
    return { passphrase: t("setup.passphraseShort", { min: MIN_NEW_PASSPHRASE }) };
  }
  if (passphrase.length > MAX_PASSPHRASE) {
    return { passphrase: t("setup.passphraseLong", { max: MAX_PASSPHRASE }) };
  }
  return confirm === passphrase ? {} : { confirm: t("setup.passphraseMismatch") };
}

export type SetupValidation = { ok: true; request: SetupRequest } | { ok: false; errors: SetupErrors };

/**
 * Check the form and build the request the main process expects (which validates it again). The name may
 * be blank (the node then uses "LOAM"); a passphrase is sent only for the passphrase mode, exactly as
 * `SetupRequestSchema` requires.
 */
export function validateSetup(form: SetupForm, capabilities: DesktopCapabilities): SetupValidation {
  const errors: SetupErrors = {};
  const nodeName = form.nodeName.trim();
  if (nodeName.length > MAX_NODE_NAME) {
    errors.nodeName = t("setup.nameTooLong", { max: MAX_NODE_NAME });
  }
  if (!availableEncryption(capabilities).includes(form.encryption)) {
    errors.encryption = t("setup.keychainMissing");
  }
  if (form.encryption === "passphrase") {
    Object.assign(errors, newPassphraseErrors(form.passphrase, form.confirm));
  }
  if (!form.acknowledged) {
    errors.acknowledged = t("setup.ackRequired");
  }
  if (Object.keys(errors).length) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    request: {
      nodeName,
      preset: form.preset,
      encryption: form.encryption,
      ...(form.encryption === "passphrase" ? { passphrase: form.passphrase } : {}),
    },
  };
}

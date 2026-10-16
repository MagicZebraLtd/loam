/**
 * What a first-run setup's choices mean, shared by every host launcher (the Android app, the desktop app)
 * so they can never disagree: the node settings each preset writes and how the host should store the
 * network's data. Kept free of any platform API so it is testable and the same everywhere.
 *
 * Presets are named security profiles (docs/09) plus the identity and presence flags a profile doesn't
 * cover; the profile itself forces the join policy, message lifetime, remote kill switch and transport
 * encryption. "custom" writes only the name and language and leaves every other setting to the admin
 * screens.
 */
import type { DbEncryptionMode, Locale, LoamConfigUpdate } from "./index.js";

export type SetupPreset = "private" | "community" | "custom";
export const SETUP_PRESETS: readonly SetupPreset[] = ["private", "community", "custom"];

/**
 * The node this one links to when it joins another network, from its "Link a node" code: its address, the
 * key to pin, and the single-use code (used on the first sync round, then removed from the config).
 */
export type SetupPeer = { url: string; transportKey: string; linkCode: string };

/** The network name used when the person leaves it blank. */
export const DEFAULT_NODE_NAME = "LOAM";
const MAX_NODE_NAME = 80;

/** The node name to use: trimmed, the default when blank, at most 80 characters (the server's limit). */
export function cleanNodeName(name: string): string {
  const trimmed = name.trim().slice(0, MAX_NODE_NAME).trim();
  return trimmed || DEFAULT_NODE_NAME;
}

/**
 * The initial `config.json` (a `LoamConfigUpdate`) for a new network. Written by the launcher before the
 * server's first boot on an empty data folder, so it's the node's starting configuration; admins can
 * change any of it later.
 */
export function presetConfig(preset: SetupPreset, nodeName: string, locale: Locale, peer?: SetupPeer): LoamConfigUpdate {
  const node = { name: cleanNodeName(nodeName), locale };
  // Joining another network: sync with that node from the first start, its key pinned, holding the link
  // code the first sync round uses so that node syncs with this one too (docs/11).
  const sync: Pick<LoamConfigUpdate, "sync"> = peer
    ? { sync: { enabled: true, peers: [{ url: peer.url, transportKey: peer.transportKey, linkCode: peer.linkCode }] } }
    : {};
  if (preset === "private") {
    return {
      ...sync,
      node,
      security: { profile: "hardened" },
      identity: { allowUserDisplayNameEdit: false, allowUserAvatarEdit: false, allowUserAvatarUpload: false },
      features: { enablePresence: false },
    };
  }
  if (preset === "community") {
    return {
      ...sync,
      node,
      security: { profile: "standard" },
      identity: { allowUserDisplayNameEdit: true, allowUserAvatarEdit: true, allowUserAvatarUpload: true },
      features: { enablePresence: true },
    };
  }
  return { ...sync, node };
}

/**
 * How the host stores a new network's data: Private keeps it only as long as the host runs (an ephemeral
 * key, so nothing is readable once it stops); Community encrypts it with a key the host keeps (the phone's
 * keystore, the desktop's keychain), so it survives restarts. Custom leaves the choice to the host's own
 * encryption setting (undefined here).
 */
export function presetDbMode(preset: SetupPreset): DbEncryptionMode | undefined {
  return preset === "private" ? "ephemeral" : preset === "community" ? "persistent" : undefined;
}

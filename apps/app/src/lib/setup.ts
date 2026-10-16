/**
 * The first-run setup's decisions, kept free of React Native and storage so they're testable: the small
 * record the app keeps about the network it set up, and (from @loam/schema, shared with the desktop app)
 * what each preset means: the node settings it writes and how the data is kept.
 */
import {
  cleanNodeName,
  DEFAULT_NODE_NAME,
  presetConfig,
  presetDbMode,
  SETUP_PRESETS,
  type SetupPeer,
  type SetupPreset,
} from '@loam/schema';

// The presets themselves (what each one writes and how its data is kept) live in @loam/schema so the
// desktop app sets up a network exactly as this app does; re-exported here for the screens and tests.
export { cleanNodeName, DEFAULT_NODE_NAME, presetConfig, presetDbMode, SETUP_PRESETS, type SetupPeer, type SetupPreset };

/** Where people connect: this phone's Wi-Fi network, its own hotspot, or another LOAM network as a node. */
export type SetupConnection = 'wifi' | 'hotspot' | 'join';

/** What the app remembers about the network it set up (SecureStore `loam.setup`). */
export type SetupRecord = {
  preset: SetupPreset;
  nodeName: string;
  connection: SetupConnection;
  /** Set when `connection` is 'join', for the new network only: never remembered (its code is single-use). */
  peer?: SetupPeer;
};

export const SETUP_RECORD_ITEM = 'loam.setup';

/** Parse the stored record; anything malformed counts as none. */
export function parseSetupRecord(value: string | null | undefined): SetupRecord | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const raw = JSON.parse(value) as Partial<SetupRecord>;
    if (
      (SETUP_PRESETS as readonly string[]).includes(raw.preset ?? '') &&
      typeof raw.nodeName === 'string' &&
      (raw.connection === 'wifi' || raw.connection === 'hotspot' || raw.connection === 'join')
    ) {
      return {
        preset: raw.preset as SetupPreset,
        nodeName: cleanNodeName(raw.nodeName),
        connection: raw.connection,
      };
    }
  } catch {
    // Not JSON: treat as no record.
  }
  return undefined;
}

/**
 * Whether there's a previous network worth offering to continue: a database exists, and it wasn't kept
 * under a key that only lived in memory (an ephemeral network can never be reopened; the launcher erases
 * its leftovers at the next boot).
 */
export function hasContinuableNetwork(files: { database: boolean; ephemeralMarker: boolean }): boolean {
  return files.database && !files.ephemeralMarker;
}

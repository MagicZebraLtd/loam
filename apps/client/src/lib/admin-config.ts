import type { LoamConfig, LoamConfigUpdate, SyncPeer } from "@loam/schema";

/**
 * The admin screen edits a draft of the node config while other writers keep going: the host's terminal UI,
 * a second admin, a node linking itself with a code, a profile switch. Saving whole sections from the draft
 * would put back every value that changed elsewhere since the page loaded (review 2026-11-07 F-041), so the
 * screen sends only what its admin changed ({@link configDelta}) and carries those edits onto each newer
 * copy of the config it hears about ({@link rebaseConfig}).
 */

/** The flat sections of `LoamConfig` the form edits field by field. `llm` has one more level, `sync.peers`
 *  is a list; both are handled on their own below. */
const FLAT_SECTIONS = ["node", "identity", "features", "admin", "killSwitch", "retention", "security", "access", "mesh"] as const;

/** Read-only fields the form never sends (the server reports them). */
const READ_ONLY: Partial<Record<string, ReadonlySet<string>>> = { openai: new Set(["apiKeySet"]) };

type FieldMap = Record<string, unknown>;

/** Deep equality for config values (plain JSON: objects, arrays, primitives). */
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Every field name either side has. */
function fieldNames(a: FieldMap, b: FieldMap): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])];
}

/**
 * The value that clears a field the draft left empty but the saved config has. JSON drops `undefined`, so a
 * cleared retention or sync token needs the explicit clear the server understands; any other field has none
 * and keeps its saved value, as a whole-section save always did.
 */
function clearedValue(section: string, field: string): unknown {
  if (section === "retention" && field === "messageTtlMs") {
    return null;
  }
  if (section === "sync" && field === "token") {
    return "";
  }
  return undefined;
}

/** The fields of one section the draft changed from the base, as an update (absent when there are none). */
function sectionDelta(section: string, draft: FieldMap, base: FieldMap, skip: ReadonlySet<string> = new Set()): FieldMap | undefined {
  const delta: FieldMap = {};
  for (const field of fieldNames(draft, base)) {
    if (skip.has(field) || READ_ONLY[section]?.has(field) || same(draft[field], base[field])) {
      continue;
    }
    const value = draft[field] === undefined ? clearedValue(section, field) : draft[field];
    if (value !== undefined) {
      delta[field] = value;
    }
  }
  return Object.keys(delta).length ? delta : undefined;
}

/** One section with the draft's own edits (fields that differ from the base) laid over the fresh copy. */
function rebaseSection<T extends object>(draft: T, base: T, fresh: T): T {
  const draftFields = draft as FieldMap;
  const baseFields = base as FieldMap;
  const result: FieldMap = { ...(fresh as FieldMap) };
  for (const field of fieldNames(draftFields, baseFields)) {
    if (!same(draftFields[field], baseFields[field])) {
      if (draftFields[field] === undefined) {
        delete result[field];
      } else {
        result[field] = draftFields[field];
      }
    }
  }
  return result as T;
}

/**
 * The peer list with the draft's own additions and removals applied to the fresh list, so a peer that linked
 * itself (or that another admin added) while the form was open is kept, and one the admin removed stays gone.
 */
function rebasePeers(draft: SyncPeer[], base: SyncPeer[], fresh: SyncPeer[]): SyncPeer[] {
  if (same(draft, base)) {
    return fresh;
  }
  const draftUrls = new Set(draft.map((peer) => peer.url));
  const baseUrls = new Set(base.map((peer) => peer.url));
  const freshUrls = new Set(fresh.map((peer) => peer.url));
  const removed = new Set(base.filter((peer) => !draftUrls.has(peer.url)).map((peer) => peer.url));
  const added = draft.filter((peer) => !baseUrls.has(peer.url) && !freshUrls.has(peer.url));
  return [...fresh.filter((peer) => !removed.has(peer.url)), ...added];
}

/**
 * The update that applies the draft's changes, and nothing else, to the config it was edited from. An empty
 * object means the admin changed nothing. The admin passphrase and panic token are typed in fields of their
 * own and added by the caller; the chat service's API key rides here only when one was typed (the server
 * never returns it).
 */
export function configDelta(draft: LoamConfig, base: LoamConfig): LoamConfigUpdate {
  const update: Record<string, unknown> = {};
  for (const section of FLAT_SECTIONS) {
    const delta = sectionDelta(section, draft[section] as FieldMap, base[section] as FieldMap);
    if (delta) {
      update[section] = delta;
    }
  }

  const llm: FieldMap = {};
  for (const backend of ["ollama", "openai", "onDevice"] as const) {
    const delta = sectionDelta(backend, draft.llm[backend] as FieldMap, base.llm[backend] as FieldMap);
    if (delta) {
      llm[backend] = delta;
    }
  }
  if (Object.keys(llm).length) {
    update.llm = llm;
  }

  // `peers` replaces the whole list on the server, so it goes as a list, and only when the draft changed it.
  const sync = sectionDelta("sync", draft.sync as FieldMap, base.sync as FieldMap, new Set(["peers"])) ?? {};
  if (!same(draft.sync.peers, base.sync.peers)) {
    sync.peers = draft.sync.peers;
  }
  if (Object.keys(sync).length) {
    update.sync = sync;
  }
  return update as LoamConfigUpdate;
}

/**
 * The draft carried onto a newer copy of the config: every field the admin changed from `base` keeps the
 * admin's value, every other one takes `fresh`'s. With no edits this is `fresh` itself.
 */
export function rebaseConfig(draft: LoamConfig, base: LoamConfig, fresh: LoamConfig): LoamConfig {
  const result = { ...fresh } as LoamConfig;
  for (const section of FLAT_SECTIONS) {
    (result as Record<string, unknown>)[section] = rebaseSection(draft[section], base[section], fresh[section]);
  }
  result.llm = {
    ollama: rebaseSection(draft.llm.ollama, base.llm.ollama, fresh.llm.ollama),
    openai: rebaseSection(draft.llm.openai, base.llm.openai, fresh.llm.openai),
    onDevice: rebaseSection(draft.llm.onDevice, base.llm.onDevice, fresh.llm.onDevice),
  };
  const { peers: draftPeers, ...draftSync } = draft.sync;
  const { peers: basePeers, ...baseSync } = base.sync;
  const { peers: freshPeers, ...freshSync } = fresh.sync;
  result.sync = {
    ...rebaseSection(draftSync, baseSync, freshSync),
    peers: rebasePeers(draftPeers, basePeers, freshPeers),
  } as LoamConfig["sync"];
  return result;
}

/** Whether an update carries anything at all. */
export function isEmptyConfigUpdate(update: LoamConfigUpdate): boolean {
  return Object.keys(update).length === 0;
}

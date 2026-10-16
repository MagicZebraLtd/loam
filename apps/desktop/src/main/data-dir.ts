/**
 * The node's data folder (`userData/node`, LOAM_DATA_DIR): created private to this user, written with a new
 * network's starting config, and emptied when the host discards the network.
 */
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { LoamConfigUpdate } from "@loam/schema";

import { fsyncDirectory, writePrivateFile } from "./durable-files.js";

/** The node's config file (the server's default: `<dataDir>/config.json`). */
export const CONFIG_FILE = "config.json";

/** Create the folder, private to this user (the database holds every message and the raw session tokens). */
export function ensureDataDir(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
}

/**
 * Delete everything in the folder (database, media, config, journals) and check it is empty. Returns the names
 * still there, if any: a file another program holds open on Windows, say. Deleting is not secure erasure on
 * flash storage (docs/02); an encrypted network's real wipe is destroying its key.
 */
export function emptyDataDir(dataDir: string): string[] {
  ensureDataDir(dataDir);
  for (const name of readdirSync(dataDir)) {
    try {
      rmSync(join(dataDir, name), { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Reported below, by what is left.
    }
  }
  const left = readdirSync(dataDir);
  if (left.length === 0) {
    fsyncDirectory(dataDir);
  }
  return left;
}

/**
 * Write a new network's starting config.json (before its first boot), durably replacing any old one: the bytes
 * are fsynced before the rename and the folder after it, so a power cut right after setup can't leave a torn
 * file that the next boot refuses to start from.
 */
export function writeInitialConfig(dataDir: string, config: LoamConfigUpdate): void {
  ensureDataDir(dataDir);
  writePrivateFile(join(dataDir, CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`);
}

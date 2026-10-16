/**
 * Whether the SQLCipher driver loads, resolved exactly as the server bundle resolves it (from dist/main/, where
 * scripts/native.mjs puts it in dist/main/node_modules/). Checked BEFORE an encrypted boot, as the `loamnet`
 * launcher does (cli/bin/loam.js `encryptedDriverLoads`): if the keyed open fails inside the server on a fresh
 * data folder, its recovery path is the wrong place to discover a missing driver. `require` only loads the JS
 * wrapper; opening an in-memory database forces the native addon.
 */
import { createRequire } from "node:module";

type Database = new (path: string) => { pragma(source: string, options?: { simple: boolean }): unknown; close(): void };

/**
 * True when better-sqlite3-multiple-ciphers loads next to `bundlePath` with its cipher codec compiled in.
 * `PRAGMA cipher` names the default cipher only in a SQLite3MultipleCiphers build (a plain SQLite answers
 * nothing); `PRAGMA key` itself can't be tried here, since an in-memory database refuses a key.
 */
export function encryptedDriverLoads(bundlePath: string): boolean {
  try {
    const Driver = createRequire(bundlePath)("better-sqlite3-multiple-ciphers") as Database;
    const db = new Driver(":memory:");
    try {
      const cipher = db.pragma("cipher", { simple: true });
      return typeof cipher === "string" && cipher.length > 0;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

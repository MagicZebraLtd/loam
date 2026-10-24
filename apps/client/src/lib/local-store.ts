type StoreName = "channels" | "messages" | "sync" | "users";

type StoredRecord = {
  id: string;
};

const DB_NAME = "loam-poc";
const DB_VERSION = 1;
const STORE_NAMES: StoreName[] = ["channels", "messages", "sync", "users"];
// PERSISTENT wipe-pending flag (docs/20). A wipe whose IndexedDB deletion is DEFERRED (another tab still
// holds the DB → `deleteDatabase` blocks) leaves this set in localStorage, so it SURVIVES a reload — unlike
// the in-memory latch, which would reset and let the pending-deletion DB rehydrate. While set, the store
// stays latched (no hydration) and the deletion is retried on boot; it's cleared only once deletion succeeds.
const WIPE_PENDING_KEY = "loam.wipePending";

let databasePromise: Promise<IDBDatabase> | undefined;

function readWipePending(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(WIPE_PENDING_KEY) === "1";
  } catch {
    return false;
  }
}

// Latched by markLocalStoreWiped(): once wiped, no read or write may re-open (and thus re-create) the
// database, closing the race where an in-flight fetch resolves AFTER a wipe and rebuilds the just-deleted
// DB (docs/15 #4). Initialised from the PERSISTENT flag so a reload during a deferred wipe stays latched
// (docs/20) rather than rehydrating the DB that's still pending deletion.
let wiped = readWipePending();

function clearWipePending(): void {
  try {
    localStorage.removeItem(WIPE_PENDING_KEY);
  } catch {
    // ignore — a missing/blocked localStorage just means the flag was never persistable
  }
}

/** Latch this page load as wiped so no later read/write re-creates the just-deleted database, AND persist
 * that intent (docs/20) so a reload before the deletion finishes doesn't rehydrate the DB. The app calls
 * this from its device/node wipe flow, separately from destroyDatabase() (docs/15 #4). */
export function markLocalStoreWiped(): void {
  purgeRefusedCopy();
  wiped = true;
  try {
    localStorage.setItem(WIPE_PENDING_KEY, "1");
  } catch {
    // ignore — the in-memory latch above still holds for this page load
  }
}

/**
 * Boot recovery (docs/20): if a prior wipe left the DB pending deletion (its `deleteDatabase` was deferred
 * by another open tab), keep the store latched (no hydration) and RETRY the deletion — which succeeds once
 * the other tab has closed, clearing the persistent flag. Best-effort; a still-blocked retry just leaves
 * the flag set for the next boot. Call once at startup.
 */
export async function recoverPendingWipe(): Promise<void> {
  purgeRefusedCopy();
  if (!readWipePending()) {
    return;
  }
  wiped = true; // never hydrate a DB that's pending deletion
  await destroyDatabase().catch(() => undefined);
}

/** Test-only: clear the wipe latch (memory + persistent flag) + cached connection so each test starts from
 * a clean module. */
export function resetLocalStoreForTests(): void {
  wiped = false;
  databasePromise = undefined;
  refusedCopyPurged = false;
  clearWipePending();
}

/**
 * A host app's own window may say that no copy of the network belongs on this device's storage: the desktop
 * app (apps/desktop/src/preload/client.cts) and the Android host's WebView (apps/app/src/app/index.tsx) set
 * `window.__loamHostNoLocalCache` before the page's scripts run on every encrypted network, since this
 * IndexedDB copy would sit on disk outside the database's key. The app
 * then holds what it shows in memory only and loads it from the node (on loopback) on every page load.
 * localStorage (the identity token, preferences) is untouched: it holds no messages.
 */
function localCacheRefused(): boolean {
  return typeof window !== "undefined" && window.__loamHostNoLocalCache === true;
}

function indexedDbPresent(): boolean {
  return typeof indexedDB !== "undefined";
}

function hasIndexedDb(): boolean {
  return indexedDbPresent() && !localCacheRefused();
}

// Whether this page load has already asked for the refused copy's deletion (see `purgeRefusedCopy`).
let refusedCopyPurged = false;

/**
 * When the host app refuses a local copy, delete the database a build from before the refusal wrote: the
 * Android host's WebView only started refusing in 0.7.0, so an upgraded phone can still hold one in the
 * clear. Once per page load, from the first call of any store API; fire-and-forget, so no read waits on
 * it. This page never opens a connection while refused, so nothing of its own can block the deletion; a
 * blocked request still lands once the other holder closes.
 */
function purgeRefusedCopy(): void {
  if (refusedCopyPurged || !localCacheRefused() || !indexedDbPresent()) {
    return;
  }
  refusedCopyPurged = true;
  deleteDatabaseFile().catch(() => undefined);
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function openDatabase(): Promise<IDBDatabase> {
  if (!hasIndexedDb()) {
    return Promise.reject(new Error("IndexedDB is not available."));
  }

  if (wiped) {
    return Promise.reject(new Error("Local database was wiped."));
  }

  if (!databasePromise) {
    databasePromise = openConnection(DB_VERSION).catch((error: unknown) => {
      // The database on disk is NEWER than this page's code (a sibling tab loaded a newer build and upgraded
      // it). Open it at whatever version it has: the stores this build knows are kept across upgrades, so it
      // stays usable instead of dead until a reload.
      // Duck-typed: a `DOMException` need not be an `Error` instance in every runtime.
      if (typeof error === "object" && error !== null && (error as { name?: unknown }).name === "VersionError") {
        return openConnection(undefined);
      }
      throw error;
    });
    databasePromise.catch(() => {
      databasePromise = undefined;
    });
  }

  return databasePromise;
}

/** One `indexedDB.open`, at `version` (creating the stores on upgrade) or at the current version when omitted. */
function openConnection(version: number | undefined): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = version === undefined ? indexedDB.open(DB_NAME) : indexedDB.open(DB_NAME, version);

    request.onupgradeneeded = () => {
      const database = request.result;

      for (const storeName of STORE_NAMES) {
        if (!database.objectStoreNames.contains(storeName)) {
          database.createObjectStore(storeName, { keyPath: "id" });
        }
      }
    };

    request.onsuccess = () => {
      const database = request.result;
      // Close this connection the moment ANOTHER tab deletes or upgrades the DB (docs/20): either blocks while
      // this tab holds a connection, so reacting to `versionchange` by closing lets it proceed instead of
      // hanging. The two cases then differ: a DELETION (`newVersion === null`, a device wipe in a sibling tab)
      // latches `wiped`, so this tab never re-opens and rehydrates the DB the other tab is erasing. An
      // UPGRADE (a sibling tab running a newer build bumped `DB_VERSION`) only drops the cached connection:
      // the next read or write re-opens on demand, at the new version if need be (see `openDatabase`).
      // Latching on an upgrade would silently stop every other open tab reading and writing until a reload.
      database.onversionchange = (event) => {
        if (event.newVersion === null) {
          wiped = true;
        }
        database.close();
        databasePromise = undefined;
      };
      resolve(database);
    };
    request.onerror = (event) => {
      // Handled here (the promise rejects); without this an unhandled IndexedDB error event is rethrown.
      event.preventDefault();
      reject(request.error);
    };
  });
}

export async function getAllRecords<T>(storeName: StoreName): Promise<T[]> {
  purgeRefusedCopy();
  if (!hasIndexedDb() || wiped) {
    return [];
  }

  const database = await openDatabase();
  const transaction = database.transaction(storeName, "readonly");
  const records = await requestToPromise<T[]>(transaction.objectStore(storeName).getAll());
  await transactionDone(transaction);
  return records;
}

export async function putRecords<T extends StoredRecord>(
  storeName: StoreName,
  records: T[],
): Promise<void> {
  purgeRefusedCopy();
  if (!hasIndexedDb() || wiped || !records.length) {
    return;
  }

  const database = await openDatabase();
  const transaction = database.transaction(storeName, "readwrite");
  const store = transaction.objectStore(storeName);

  for (const record of records) {
    store.put(record);
  }

  await transactionDone(transaction);
}

export async function putRecord<T extends StoredRecord>(
  storeName: StoreName,
  record: T,
): Promise<void> {
  await putRecords(storeName, [record]);
}

export async function deleteRecord(storeName: StoreName, id: string): Promise<void> {
  await deleteRecords(storeName, [id]);
}

/** Delete several records in one transaction (a missing id is not an error). */
export async function deleteRecords(storeName: StoreName, ids: readonly string[]): Promise<void> {
  purgeRefusedCopy();
  if (!hasIndexedDb() || wiped || !ids.length) {
    return;
  }

  const database = await openDatabase();
  const transaction = database.transaction(storeName, "readwrite");
  const store = transaction.objectStore(storeName);

  for (const id of ids) {
    store.delete(id);
  }

  await transactionDone(transaction);
}

/** One `indexedDB.deleteDatabase` of the local database, rejecting when it is blocked (see `destroyDatabase`). */
function deleteDatabaseFile(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    // Another tab still holds a connection: the browser defers the deletion until it closes
    // (that tab purges itself too on the wipe event). Surface it so callers know the wipe is
    // deferred rather than complete — the PERSISTENT flag stays set so a reload retries (docs/20).
    request.onblocked = () => reject(new Error("Database deletion deferred: another tab holds a connection."));
  });
}

/**
 * Delete the entire local database (kill-switch purge). Closes the cached connection first, since
 * deletion blocks while a connection is open. Runs when the host app refuses a local copy too: this page
 * wrote nothing, but a copy an older build wrote may still be there.
 */
export async function destroyDatabase(): Promise<void> {
  if (!indexedDbPresent()) {
    clearWipePending(); // nothing to delete → the wipe is complete, not pending
    return;
  }
  if (localCacheRefused()) {
    refusedCopyPurged = true; // the deletion below is the refused copy's purge too
  }

  if (databasePromise) {
    const database = await databasePromise.catch(() => undefined);
    database?.close();
    databasePromise = undefined;
  }

  await deleteDatabaseFile();

  // Only reached when deleteDatabase actually RESOLVED — the DB is gone, so the wipe is no longer pending.
  clearWipePending();
}

/**
 * Empty every object store while leaving the database itself usable (no wipe latch). Used when the
 * server-confirmed identity changed underneath this browser: the cached
 * channels/DMs/users/read markers belonged to the previous identity and must not be shown to — or merged
 * into — the new one, but unlike a wipe the app carries straight on with the new identity.
 */
export async function clearAllRecords(): Promise<void> {
  purgeRefusedCopy();
  if (!hasIndexedDb() || wiped) {
    return;
  }

  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAMES, "readwrite");

  for (const storeName of STORE_NAMES) {
    transaction.objectStore(storeName).clear();
  }

  await transactionDone(transaction);
}

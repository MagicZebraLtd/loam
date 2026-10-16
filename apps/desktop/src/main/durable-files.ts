/**
 * Files the launcher must be able to trust after a crash or a power cut: the device secret, the settings and
 * the wipe journal. Written privately beside their final name and renamed over it once their bytes are on
 * disk (so a reader finds the old file or the new one, never a torn one), and removed in a way that is proven
 * (the name is looked up again) and made durable (the folder is fsynced, where the platform allows it).
 */
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** The error code Node uses for "no such file", the only proof of absence. */
export function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

/** The name `writePrivateFile` writes beside `path` before renaming over it. */
export function temporaryName(path: string): string {
  return `${path}.tmp`;
}

/**
 * fsync a directory, so the renames and unlinks in it survive a power cut. True on Windows without trying: it
 * has no directory fsync, and NTFS makes them as durable as it can. False when durability can't be proven.
 */
export function fsyncDirectory(dir: string): boolean {
  if (process.platform === "win32") {
    return true;
  }
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Write `bytes` to `path`, private to this user (mode 0600, in a 0700 folder): to the temporary name first,
 * fsynced, then renamed over `path`, then the folder fsynced. A leftover temporary file is removed before
 * writing, because `mode` applies only to a new file.
 */
export function writePrivateFile(path: string, bytes: Buffer | string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = temporaryName(path);
  rmSync(temporary, { force: true });
  const fd = openSync(temporary, "w", 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  fsyncDirectory(dir);
}

/**
 * Remove every file in `paths` (one that is already missing is fine) and PROVE each gone by looking it up
 * again. False when one remains or can't be checked. The caller fsyncs the folder when that matters.
 */
export function removeProven(paths: readonly string[]): boolean {
  for (const path of paths) {
    try {
      unlinkSync(path);
    } catch (error) {
      if (!isMissing(error)) {
        return false;
      }
    }
    try {
      lstatSync(path);
      return false;
    } catch (error) {
      if (!isMissing(error)) {
        return false;
      }
    }
  }
  return true;
}

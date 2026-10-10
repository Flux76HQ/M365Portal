// A throwaway `DATA_DIR`. Tests that touch the disk (SQLite, the asset store, the readiness probe)
// get a fresh private directory, and it is gone when the test ends, so nothing leaks into the next
// test or into the machine (the hostile-corpus runner later asserts that nothing is left behind).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onTestFinished } from 'vitest';

export interface TempDataDir {
  /** Absolute path of the directory; it exists, it is empty and only its owner can use it (0700). */
  readonly path: string;
  /** Delete the directory and everything in it. Safe to call more than once. */
  remove(): Promise<void>;
}

/**
 * Run `callback` when the current test ends. Outside a test (a `beforeAll` hook, a script) there
 * is nothing to attach to, and the caller must call `remove()` itself.
 */
export function afterCurrentTest(callback: () => Promise<void> | void): void {
  try {
    onTestFinished(callback);
  } catch {
    // Not inside a test: the helper that called us documents `remove()` for that case.
  }
}

/** Create a private temporary directory below the system temporary directory. */
export async function createTempDataDir(prefix = 'm365portal-data-'): Promise<TempDataDir> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  const remove = async (): Promise<void> => {
    await rm(path, { recursive: true, force: true, maxRetries: 3 });
  };
  afterCurrentTest(remove);
  return { path, remove };
}

/** Run `callback` with a fresh data directory and remove it afterwards, also when the callback throws. */
export async function withTempDataDir<T>(callback: (path: string) => Promise<T>): Promise<T> {
  const dir = await createTempDataDir();
  try {
    return await callback(dir.path);
  } finally {
    await dir.remove();
  }
}

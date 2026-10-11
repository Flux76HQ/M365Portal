// The branding housekeeping (T-A-084; data-model 9, FR-A-091, FR-A-096; plan 7.1 steps 7 and 10):
//
//   branding-tmp      everything in `branding/.tmp/` older than 10 minutes (an interrupted write)
//   branding-staged   unreferenced assets whose timer (as last refreshed by a re-stage) is older than
//                     24 hours: the row and then the file. A referenced hash is never selected
//   branding-orphans  `branding/*.png` with no registry row, older than one hour
//
// They are registered with the sweeper registry of the server (`deps.sweepers`), which runs them at
// start and then every hour, and survives a failing one. Each is also exported as a plain function
// that takes the time, so the tests drive them with a fake clock instead of waiting.
//
// "Older than" for files is the modification time the file system reports; for rows it is the
// timestamp in the row. Both are compared with the injected clock, never with `Date.now()`.
//
// Deleting a row before its file is deliberate: a failure in between leaves an orphan file, which
// the orphan sweeper removes an hour later, never a row without a file (invariant I-4). Both steps
// are idempotent.
import { lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { LIMITS } from '@m365portal/shared/limits';
import { withTransaction, type DatabaseHandle } from '../db/index.js';
import type { Sweeper } from '../lifecycle/sweepers.js';
import type { Logger } from '../logging/logger.js';
import { isAssetHash, type AssetStore } from './asset-store.js';
import { deleteExpiredAssets, findAsset, referencedHashes } from './repository.js';

/** Temporary files older than this many milliseconds are removed (10 minutes). */
export const TEMP_FILE_MAX_AGE_MS = 600_000;
/** Image files without a row older than this many milliseconds are removed (one hour). */
export const ORPHAN_FILE_MAX_AGE_MS = 3_600_000;

export interface SweepDependencies {
  readonly store: AssetStore;
  /** The open database, or `undefined` in degraded mode (the sweepers then have nothing to do). */
  readonly database: () => DatabaseHandle | undefined;
  readonly now: () => number;
}

async function entriesOf(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return [];
    throw error;
  }
}

/** Remove the entries of the temporary directory whose age is over the limit. */
export async function sweepTemporaryFiles(dependencies: SweepDependencies): Promise<number> {
  const { store, now } = dependencies;
  let removed = 0;
  for (const name of await entriesOf(store.tempDirectory)) {
    const path = join(store.tempDirectory, name);
    try {
      const info = await lstat(path);
      if (now() - info.mtimeMs < TEMP_FILE_MAX_AGE_MS) continue;
      await rm(path, { recursive: true, force: true });
      removed += 1;
    } catch (error) {
      // Gone since the listing: somebody else (the write that owned it) cleaned up.
      if ((error as { code?: unknown }).code !== 'ENOENT') throw error;
    }
  }
  return removed;
}

/** Delete the unreferenced assets that stayed unreferenced for over 24 hours; returns their hashes. */
export async function sweepExpiredAssets(dependencies: SweepDependencies): Promise<string[]> {
  const db = dependencies.database();
  if (db === undefined) return [];
  const cutoff = new Date(dependencies.now() - LIMITS.staging.retentionMs).toISOString();
  // Select and delete in one transaction: a re-stage cannot slip in between and lose its timer.
  const expired = withTransaction(db, (tx) => deleteExpiredAssets(tx, cutoff));
  for (const hash of expired) await dependencies.store.remove(hash);
  return expired;
}

/** Delete image files that no row accounts for and that are older than an hour; returns their names. */
export async function sweepOrphanFiles(dependencies: SweepDependencies): Promise<string[]> {
  const db = dependencies.database();
  if (db === undefined) return [];
  const { store, now } = dependencies;
  const removed: string[] = [];
  for (const name of await entriesOf(store.directory)) {
    if (!name.endsWith('.png')) continue;
    const path = join(store.directory, name);
    try {
      const info = await lstat(path);
      if (!info.isFile() || now() - info.mtimeMs < ORPHAN_FILE_MAX_AGE_MS) continue;
      // A row, however old or new, owns its file.
      if (findAsset(db, name.slice(0, -'.png'.length)) !== undefined) continue;
      await rm(path, { force: true });
      removed.push(name);
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'ENOENT') throw error;
    }
  }
  return removed;
}

/**
 * Start-up check (FR-A-096): every referenced asset has its file. A missing one is logged as
 * `branding_asset_missing` (warn) and nothing else happens: serving that hash answers 404, the UI
 * falls back to the monogram and `/readyz` stays 200. Returns the hashes that are missing.
 */
export async function checkReferencedAssets(
  dependencies: SweepDependencies & { readonly log: Pick<Logger, 'warn'> },
): Promise<string[]> {
  const db = dependencies.database();
  if (db === undefined) return [];
  const missing: string[] = [];
  for (const hash of referencedHashes(db)) {
    if (!isAssetHash(hash) || !(await dependencies.store.has(hash))) {
      missing.push(hash);
      dependencies.log.warn(
        { event: 'branding_asset_missing', sha256: hash },
        'branding_asset_missing',
      );
    }
  }
  return missing;
}

/** The three hourly sweepers, ready for `deps.sweepers.register`. */
export function createBrandingSweepers(dependencies: SweepDependencies): Sweeper[] {
  return [
    {
      name: 'branding-tmp',
      run: async () => {
        await sweepTemporaryFiles(dependencies);
      },
    },
    {
      name: 'branding-staged',
      run: async () => {
        await sweepExpiredAssets(dependencies);
      },
    },
    {
      name: 'branding-orphans',
      run: async () => {
        await sweepOrphanFiles(dependencies);
      },
    },
  ];
}

/** Register the sweepers with the registry of the server (`ModuleDeps.sweepers`). */
export function registerBrandingSweepers(
  registry: { register(sweeper: Sweeper): void },
  dependencies: SweepDependencies,
): void {
  for (const sweeper of createBrandingSweepers(dependencies)) registry.register(sweeper);
}

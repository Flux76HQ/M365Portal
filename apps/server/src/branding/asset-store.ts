// The asset store (T-A-084; FR-A-084 and FR-A-089 atomic writes, FR-A-091, PD-07, PD-10; I-3, I-4,
// I-5; E-05): the content-addressed PNG files in `${DATA_DIR}/branding/` and their rows in the
// registry.
//
// Files
//   A file is written to `${DATA_DIR}/branding/.tmp/<random>`, flushed, and renamed to
//   `<sha256 of its bytes>.png` in the directory above. The temporary directory is on the same
//   volume as the target, never `/tmp`, so the rename cannot fail with `EXDEV`; the temporary file
//   is removed on success, on failure and when the caller gives up. Identical bytes converge on one
//   file, so writing them again is harmless. Nothing is written before the pipeline has accepted the
//   bytes: the upload is buffered in memory (FR-A-084).
//
// Rows
//   `register` is the synchronous step of plan 8.5 stage 9: one existence check, one quota check and
//   one write, inside the caller's transaction, so two requests cannot both pass a quota that only
//   one of them fits in, and an asset that is uploaded again cannot be swept between the upload and
//   the apply (FR-A-091):
//     - a row that does not exist is inserted as unreferenced, if the quota has room (32 files and
//       32 MiB, I-5) -> `created: true`;
//     - a row that is unreferenced gets a fresh 24-hour timer, and counts once -> `created: false`;
//     - a row that is referenced by the applied branding is left alone -> `created: false`.
//   Variants the server derives itself (the compact logo and the icons) are registered without the
//   quota: they are at most six per apply, they are the server's own work and not an upload, and an
//   apply must not fail because the administrator has staged a lot of logos.
import { randomBytes, createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { LIMITS } from '@m365portal/shared/limits';
import { ProblemError } from '../http/problem.js';
import type { DatabaseHandle } from '../db/index.js';
import {
  findAsset,
  insertUnreferencedAsset,
  refreshUnreferenced,
  stagingUsage,
  type AssetRow,
} from './repository.js';

/** The directory of the images below `DATA_DIR` (data-model 2). */
export const BRANDING_DIRECTORY = 'branding';
/** The staging directory of atomic writes below the images directory. */
export const TEMP_DIRECTORY = '.tmp';

const HASH_PATTERN = /^[0-9a-f]{64}$/;

/** True for 64 lower-case hexadecimal characters: the only name a stored image can have. */
export function isAssetHash(value: unknown): value is string {
  return typeof value === 'string' && HASH_PATTERN.test(value);
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A row is registered, but its file is not on disk (I-4 broken). */
export class AssetFileMissingError extends Error {
  constructor() {
    super('the image file of a registered asset is missing');
    this.name = 'AssetFileMissingError';
  }
}

/**
 * The few file operations the store performs, so a test can make one of them fail and see that no
 * temporary file is left behind. The default is the real file system.
 */
export interface StoreFileOperations {
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>;
  /** Create `path` (it must not exist), write all of `bytes`, flush to disk, close. */
  writeNew(path: string, bytes: Uint8Array, mode: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  readFile(path: string): Promise<Buffer>;
  exists(path: string): Promise<boolean>;
}

export const realFileOperations: StoreFileOperations = {
  mkdir: (path, options) => mkdir(path, options),
  async writeNew(path, bytes, mode) {
    const handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      mode,
    );
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  rename: (from, to) => rename(from, to),
  unlink: (path) => unlink(path),
  readFile: (path) => readFile(path),
  async exists(path) {
    try {
      await stat(path);
      return true;
    } catch (error) {
      if ((error as { code?: unknown }).code === 'ENOENT') return false;
      throw error;
    }
  },
};

export interface AssetStoreOptions {
  /** `DATA_DIR`. */
  readonly dataDir: string;
  /** Milliseconds since the epoch; the one wall clock. */
  readonly now: () => number;
  /** Names of temporary files. Default: 16 random bytes in hexadecimal. */
  readonly randomName?: () => string;
  readonly files?: StoreFileOperations;
}

/** What `register` needs to know about a processed image. */
export interface AssetMetadata {
  readonly sha256: string;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  readonly luminance: number | null;
}

export interface Registered {
  readonly asset: AssetRow;
  /** True when this call inserted the row. */
  readonly created: boolean;
}

export interface AssetStore {
  /** `${DATA_DIR}/branding`. */
  readonly directory: string;
  /** `${DATA_DIR}/branding/.tmp`. */
  readonly tempDirectory: string;
  /** The path of the file of `sha256`; throws for anything that is not a lower-case hash. */
  pathOf(sha256: string): string;
  /** Create the two directories (mode 0700) if they are missing. */
  ensureDirectories(): Promise<void>;
  /** Write `bytes` atomically as `<sha256>.png`; returns the hash. */
  write(bytes: Uint8Array): Promise<string>;
  /** The bytes of the file of `sha256`, or `AssetFileMissingError`. */
  read(sha256: string): Promise<Buffer>;
  has(sha256: string): Promise<boolean>;
  /** Remove the file of `sha256` if it exists. */
  remove(sha256: string): Promise<void>;
  /**
   * Plan 8.5 stage 9, the registry part: insert, or refresh the timer of an unreferenced row, under
   * the staging quota. Synchronous; the caller's transaction (or `stage`'s own) holds the write lock.
   * Throws `ProblemError('staging_quota_exceeded')` when a new row does not fit.
   */
  registerStaged(db: DatabaseHandle, metadata: AssetMetadata): Registered;
  /**
   * Would `registerStaged` accept this image right now? True for a row that exists (it does not
   * count twice) and for a new row that fits the quota. Read-only: the route asks it before it
   * writes the file, so a refused upload leaves nothing on disk; `registerStaged` asks again under
   * the write lock, which is the check that counts.
   */
  fitsQuota(db: DatabaseHandle, metadata: AssetMetadata): boolean;
  /** Register a variant the server derived: same as `registerStaged`, without the quota. */
  registerDerived(db: DatabaseHandle, metadata: AssetMetadata): Registered;
}

export function createAssetStore(options: AssetStoreOptions): AssetStore {
  const files = options.files ?? realFileOperations;
  const randomName = options.randomName ?? ((): string => randomBytes(16).toString('hex'));
  const directory = join(options.dataDir, BRANDING_DIRECTORY);
  const tempDirectory = join(directory, TEMP_DIRECTORY);

  const pathOf = (sha256: string): string => {
    if (!isAssetHash(sha256)) throw new RangeError('an asset name is 64 lower-case hex digits');
    return join(directory, `${sha256}.png`);
  };

  const iso = (): string => new Date(options.now()).toISOString();
  /** The oldest timer that still counts as waiting: now minus the 24 hours of retention. */
  const liveSince = (): string =>
    new Date(options.now() - LIMITS.staging.retentionMs).toISOString();

  function fits(db: DatabaseHandle, metadata: AssetMetadata): boolean {
    if (findAsset(db, metadata.sha256) !== undefined) return true;
    const usage = stagingUsage(db, liveSince());
    return (
      usage.files + 1 <= LIMITS.staging.quotaFiles &&
      usage.bytes + metadata.bytes <= LIMITS.staging.quotaBytes
    );
  }

  function register(db: DatabaseHandle, metadata: AssetMetadata, quota: boolean): Registered {
    const existing = findAsset(db, metadata.sha256);
    if (existing !== undefined) {
      // Identical bytes: nothing new. An unreferenced row starts its 24 hours again; a referenced
      // one is the applied branding's and is not touched.
      if (existing.unreferencedAt !== null) {
        const at = iso();
        refreshUnreferenced(db, metadata.sha256, at);
        return { asset: { ...existing, unreferencedAt: at }, created: false };
      }
      return { asset: existing, created: false };
    }
    if (quota && !fits(db, metadata)) throw new ProblemError('staging_quota_exceeded');
    const createdAt = iso();
    insertUnreferencedAsset(db, { ...metadata, createdAt });
    return {
      asset: { ...metadata, createdAt, unreferencedAt: createdAt },
      created: true,
    };
  }

  return {
    directory,
    tempDirectory,
    pathOf,

    async ensureDirectories() {
      await files.mkdir(tempDirectory, { recursive: true, mode: 0o700 });
    },

    async write(bytes) {
      const hash = sha256Hex(bytes);
      const target = pathOf(hash);
      // The directory may have been removed under a running server (a restore, a clean-up): make it.
      await files.mkdir(tempDirectory, { recursive: true, mode: 0o700 });
      const temporary = join(tempDirectory, randomName());
      try {
        await files.writeNew(temporary, bytes, 0o600);
        await files.rename(temporary, target);
      } catch (error) {
        // Success, failure and abort all end without a temporary file.
        await files.unlink(temporary).catch(() => undefined);
        throw error;
      }
      return hash;
    },

    async read(sha256) {
      try {
        return await files.readFile(pathOf(sha256));
      } catch (error) {
        if ((error as { code?: unknown }).code === 'ENOENT') throw new AssetFileMissingError();
        throw error;
      }
    },

    has: (sha256) => files.exists(pathOf(sha256)),

    async remove(sha256) {
      await files.unlink(pathOf(sha256)).catch((error: unknown) => {
        if ((error as { code?: unknown }).code !== 'ENOENT') throw error;
      });
    },

    fitsQuota: fits,
    registerStaged: (db, metadata) => register(db, metadata, true),
    registerDerived: (db, metadata) => register(db, metadata, false),
  };
}

// T-A-084 (asset store): the file side of the store and the invariants of the registry I-3, I-4 and
// I-5 (data-model 6), and the foreign key that protects a referenced asset (PR-14). The rest of the
// task (staging, the quota, the sweepers on a fake clock) is in `upload-pipeline.test.ts`.
//
// What is proven, by looking at the disk and the tables and not at the code:
//   - a file is written to `branding/.tmp/` and renamed to `<sha256>.png`; never anywhere else, with
//     mode 0600, and the temporary file is gone after a success, a failed write and a failed rename;
//   - identical bytes are one file; a name that is not 64 lower-case hex digits is refused before it
//     touches a path;
//   - after applies, retirements and re-stagings: every referenced hash has a row with no timestamp,
//     every other row has one, every row has a file whose bytes hash to its name, and at most 32 rows
//     and 32 MiB wait (the quota is also tested at its edges);
//   - deleting a referenced row fails in the database even though no sweeper is involved.
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { LIMITS } from '@m365portal/shared/limits';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import {
  AssetFileMissingError,
  createAssetStore,
  isAssetHash,
  realFileOperations,
  type AssetMetadata,
  type StoreFileOperations,
} from '../../src/branding/asset-store.js';
import { referencedHashes } from '../../src/branding/repository.js';
import { withTransaction } from '../../src/db/index.js';
import { createFakeClock } from '../helpers/fake-clock.js';
import { createTempDataDir } from '../helpers/temp-data-dir.js';
import { createBrandingStorage, distinctPng, solidPng } from './branding-fixture.js';

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

async function plainStore(files?: StoreFileOperations, names: string[] = []) {
  const dir = await createTempDataDir();
  const clock = createFakeClock();
  let counter = 0;
  const store = createAssetStore({
    dataDir: dir.path,
    now: () => clock.nowMs(),
    randomName: () => names[counter++] ?? `tmp-${String(counter)}`,
    ...(files === undefined ? {} : { files }),
  });
  return { dir: dir.path, clock, store };
}

async function listing(directory: string): Promise<string[]> {
  return (await readdir(directory)).sort();
}

describe('the files of the asset store (FR-A-084, FR-A-089)', () => {
  it('creates the directories with mode 0700 below DATA_DIR', async () => {
    const { dir, store } = await plainStore();
    await store.ensureDirectories();
    expect(store.directory).toBe(join(dir, 'branding'));
    expect(store.tempDirectory).toBe(join(dir, 'branding', '.tmp'));
    for (const path of [store.directory, store.tempDirectory]) {
      expect((await stat(path)).mode & 0o777).toBe(0o700);
    }
  });

  it('writes <sha256>.png with mode 0600 and leaves nothing in .tmp', async () => {
    const { store } = await plainStore();
    const bytes = await solidPng(40, 30, [10, 20, 30]);
    const hash = await store.write(bytes);

    expect(hash).toBe(sha(bytes));
    expect(isAssetHash(hash)).toBe(true);
    expect(await readFile(store.pathOf(hash))).toEqual(bytes);
    expect((await stat(store.pathOf(hash))).mode & 0o777).toBe(0o600);
    expect(await listing(store.tempDirectory)).toEqual([]);
    expect(await listing(store.directory)).toEqual(['.tmp', `${hash}.png`]);
  });

  it('writes through the temporary directory of the same volume, never /tmp', async () => {
    const seen: string[] = [];
    const recording: StoreFileOperations = {
      ...realFileOperations,
      writeNew: (path, bytes, mode) => {
        seen.push(path);
        return realFileOperations.writeNew(path, bytes, mode);
      },
      rename: (from, to) => {
        seen.push(`${from} -> ${to}`);
        return realFileOperations.rename(from, to);
      },
    };
    const { store } = await plainStore(recording, ['abc123']);
    const hash = await store.write(await solidPng(8, 8, [1, 2, 3]));
    expect(seen).toEqual([
      join(store.tempDirectory, 'abc123'),
      `${join(store.tempDirectory, 'abc123')} -> ${join(store.directory, `${hash}.png`)}`,
    ]);
    // The harness data directory is itself below /tmp; what matters is that the store never leaves
    // its own `branding/.tmp` for the staging of a write.
    expect(seen.every((entry) => entry.startsWith(store.tempDirectory))).toBe(true);
  });

  it('converges identical bytes on one file', async () => {
    const { store } = await plainStore();
    const bytes = await solidPng(20, 20, [200, 100, 50]);
    const first = await store.write(bytes);
    const second = await store.write(bytes);
    expect(second).toBe(first);
    expect((await listing(store.directory)).filter((name) => name.endsWith('.png'))).toHaveLength(
      1,
    );
    expect(await listing(store.tempDirectory)).toEqual([]);
  });

  it('removes the temporary file when the write fails halfway', async () => {
    const failing: StoreFileOperations = {
      ...realFileOperations,
      async writeNew(path, bytes, mode) {
        // Half of the file reaches the disk, then the volume says no.
        await realFileOperations.writeNew(path, bytes.subarray(0, 10), mode);
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      },
    };
    const { store } = await plainStore(failing);
    await expect(store.write(await solidPng(8, 8, [9, 9, 9]))).rejects.toMatchObject({
      code: 'ENOSPC',
    });
    expect(await listing(store.tempDirectory)).toEqual([]);
    expect((await listing(store.directory)).filter((name) => name.endsWith('.png'))).toEqual([]);
  });

  it('removes the temporary file when the rename fails', async () => {
    const failing: StoreFileOperations = {
      ...realFileOperations,
      rename: () => Promise.reject(Object.assign(new Error('read-only'), { code: 'EROFS' })),
    };
    const { store } = await plainStore(failing);
    await expect(store.write(await solidPng(8, 8, [7, 7, 7]))).rejects.toMatchObject({
      code: 'EROFS',
    });
    expect(await listing(store.tempDirectory)).toEqual([]);
  });

  it('recreates the directories when they were removed under a running server', async () => {
    const { store } = await plainStore();
    const hash = await store.write(await solidPng(8, 8, [1, 1, 1]));
    expect(await store.has(hash)).toBe(true);
    await store.remove(hash);
    expect(await store.has(hash)).toBe(false);
    // Removing what is not there is not an error.
    await store.remove(hash);
  });

  it('reads a stored file and reports a missing one as AssetFileMissingError', async () => {
    const { store } = await plainStore();
    const bytes = await solidPng(8, 8, [5, 5, 5]);
    const hash = await store.write(bytes);
    expect(await store.read(hash)).toEqual(bytes);
    await expect(store.read('0'.repeat(64))).rejects.toBeInstanceOf(AssetFileMissingError);
  });

  it.each([
    '../../etc/passwd',
    '',
    'a'.repeat(63),
    'a'.repeat(65),
    'A'.repeat(64),
    `${'a'.repeat(60)}.png`,
    `${'a'.repeat(63)}\0`,
    `${'a'.repeat(62)}/.`,
  ])('refuses the name %j before it becomes a path', async (name) => {
    const { store } = await plainStore();
    expect(isAssetHash(name)).toBe(false);
    expect(() => store.pathOf(name)).toThrow(RangeError);
    await expect(store.read(name)).rejects.toThrow(RangeError);
  });
});

describe('the registry invariants (data-model 6: I-3, I-4, I-5)', () => {
  /** I-3, I-4 and I-5 over the live tables and the live directory. */
  async function assertInvariants(
    storage: Awaited<ReturnType<typeof createBrandingStorage>>,
  ): Promise<void> {
    const referenced = new Set(referencedHashes(storage.database));
    const rows = storage.assets();
    // I-3: referenced rows have no timestamp, every other row has one, every reference has a row.
    for (const hash of referenced) {
      const row = rows.find((candidate) => candidate.sha256 === hash);
      expect(row, `a row for the referenced ${hash.slice(0, 8)}`).toBeDefined();
      expect(row?.unreferenced_at).toBeNull();
    }
    for (const row of rows) {
      if (!referenced.has(row.sha256)) expect(row.unreferenced_at).not.toBeNull();
    }
    // I-4: a file for every row, and its bytes hash to its name.
    for (const row of rows) {
      const bytes = await readFile(storage.store.pathOf(row.sha256));
      expect(sha(bytes)).toBe(row.sha256);
      expect(bytes.length).toBe(row.bytes);
    }
    // I-5: the quota.
    const usage = storage.usage();
    expect(usage.files).toBeLessThanOrEqual(LIMITS.staging.quotaFiles);
    expect(usage.bytes).toBeLessThanOrEqual(LIMITS.staging.quotaBytes);
  }

  async function stage(
    storage: Awaited<ReturnType<typeof createBrandingStorage>>,
    seed: number,
    slot: 'logoLight' | 'logoDark' | 'compact' = 'logoLight',
  ): Promise<string> {
    const processed = await storage.images.process({ bytes: await distinctPng(seed), slot });
    const sha256 = await storage.store.write(processed.png);
    withTransaction(storage.database, (tx) =>
      storage.store.registerStaged(tx, {
        sha256,
        bytes: processed.png.length,
        width: processed.width,
        height: processed.height,
        luminance: processed.luminance,
      }),
    );
    return sha256;
  }

  it('holds on a fresh installation: the default branding references only its icons', async () => {
    const storage = await createBrandingStorage();
    expect(referencedHashes(storage.database)).toHaveLength(5);
    await assertInvariants(storage);
  });

  it('holds after staging, applying, retiring and re-applying logos', async () => {
    const storage = await createBrandingStorage();
    const first = await stage(storage, 1);
    const second = await stage(storage, 2);
    await assertInvariants(storage);

    await storage.service.apply(
      { orgName: 'Acme', accent: '#0078d4', logos: { light: first, dark: null, compact: null } },
      1,
      { actor: { kind: 'preview', id: 'preview' } },
    );
    await assertInvariants(storage);
    expect(referencedHashes(storage.database)).toContain(first);

    // The second logo replaces the first; the first is retired, not deleted (Undo needs it).
    await storage.service.apply(
      { orgName: 'Acme', accent: '#0078d4', logos: { light: second, dark: null, compact: null } },
      2,
      { actor: { kind: 'preview', id: 'preview' } },
    );
    await assertInvariants(storage);
    const retired = storage.assets().find((row) => row.sha256 === first);
    expect(retired?.unreferenced_at).not.toBeNull();

    // The retired one can be applied again within its 24 hours.
    await storage.service.apply(
      { orgName: 'Acme', accent: '#0078d4', logos: { light: first, dark: null, compact: null } },
      3,
      { actor: { kind: 'preview', id: 'preview' } },
    );
    await assertInvariants(storage);
    expect(storage.assets().find((row) => row.sha256 === first)?.unreferenced_at).toBeNull();
  });

  it('holds at the edge of the quota: 32 files, then the 33rd is refused', async () => {
    const storage = await createBrandingStorage();
    const before = storage.usage().files;
    for (let seed = 0; seed < LIMITS.staging.quotaFiles - before; seed += 1) {
      await stage(storage, seed);
    }
    expect(storage.usage().files).toBe(LIMITS.staging.quotaFiles);
    await assertInvariants(storage);
    await expect(stage(storage, 99)).rejects.toMatchObject({ code: 'staging_quota_exceeded' });
    expect(storage.usage().files).toBe(LIMITS.staging.quotaFiles);
  });

  it('cannot be broken by a sweeper bug: the database refuses to delete a referenced asset', async () => {
    const storage = await createBrandingStorage();
    const [hash] = referencedHashes(storage.database);
    expect(hash).toBeDefined();
    const attempt = (): unknown =>
      storage.database.sqlite.prepare('DELETE FROM branding_asset WHERE sha256 = ?').run(hash);
    expect(attempt).toThrow(/FOREIGN KEY/);
    expect(storage.assets().some((row) => row.sha256 === hash)).toBe(true);
  });

  it('the invariant check itself fails on a row whose file is gone or changed (negative fixture)', async () => {
    const storage = await createBrandingStorage();
    const [hash] = referencedHashes(storage.database);
    expect(hash).toBeDefined();
    await assertInvariants(storage);

    await storage.store.remove(hash ?? '');
    await expectGuardFails(assertInvariants, storage);
  });
});

describe('the quota decision of registerStaged', () => {
  function metadata(index: number, bytes = 1000): AssetMetadata {
    return {
      sha256: index.toString(16).padStart(64, '0'),
      bytes,
      width: 10,
      height: 10,
      luminance: 0.5,
    };
  }

  it('allows 32 files of a total of exactly 32 MiB and refuses the next byte', async () => {
    const storage = await createBrandingStorage();
    const existing = storage.usage();
    const each = LIMITS.staging.quotaBytes / LIMITS.staging.quotaFiles;
    const room = LIMITS.staging.quotaFiles - existing.files;
    // The derived icons of the default branding are referenced, so nothing is staged yet.
    expect(existing).toEqual({ files: 0, bytes: 0 });
    for (let index = 1; index <= room; index += 1) {
      withTransaction(storage.database, (tx) =>
        storage.store.registerStaged(tx, metadata(index, each)),
      );
    }
    expect(storage.usage()).toEqual({
      files: LIMITS.staging.quotaFiles,
      bytes: LIMITS.staging.quotaBytes,
    });
    expect(storage.store.fitsQuota(storage.database, metadata(1000))).toBe(false);
    expect(() =>
      withTransaction(storage.database, (tx) => storage.store.registerStaged(tx, metadata(1000))),
    ).toThrow(expect.objectContaining({ code: 'staging_quota_exceeded' }));
  });

  it('refuses a file that would push the bytes over 32 MiB while the file count has room', async () => {
    const storage = await createBrandingStorage();
    // One row holds at most 2 MiB (a CHECK of the table), so 32 MiB takes 15 full files and a rest.
    for (let index = 1; index <= 15; index += 1) {
      withTransaction(storage.database, (tx) =>
        storage.store.registerStaged(tx, metadata(index, LIMITS.body.logoFileBytes)),
      );
    }
    const rest = LIMITS.staging.quotaBytes - 15 * LIMITS.body.logoFileBytes - 10;
    withTransaction(storage.database, (tx) => storage.store.registerStaged(tx, metadata(16, rest)));
    expect(storage.usage().files).toBeLessThan(LIMITS.staging.quotaFiles);
    expect(storage.store.fitsQuota(storage.database, metadata(17, 10))).toBe(true);
    expect(storage.store.fitsQuota(storage.database, metadata(17, 11))).toBe(false);
    expect(() =>
      withTransaction(storage.database, (tx) => storage.store.registerStaged(tx, metadata(17, 11))),
    ).toThrow(expect.objectContaining({ code: 'staging_quota_exceeded' }));
  });

  it('counts identical bytes once and lets them in at a full quota', async () => {
    const storage = await createBrandingStorage();
    for (let index = 1; index <= LIMITS.staging.quotaFiles; index += 1) {
      withTransaction(storage.database, (tx) => storage.store.registerStaged(tx, metadata(index)));
    }
    expect(storage.store.fitsQuota(storage.database, metadata(7))).toBe(true);
    const again = withTransaction(storage.database, (tx) =>
      storage.store.registerStaged(tx, metadata(7)),
    );
    expect(again.created).toBe(false);
    expect(storage.usage().files).toBe(LIMITS.staging.quotaFiles);
  });

  it('leaves a referenced row alone and does not count it', async () => {
    const storage = await createBrandingStorage();
    const [hash] = referencedHashes(storage.database);
    const row = storage.assets().find((candidate) => candidate.sha256 === hash);
    expect(row).toBeDefined();
    const result = withTransaction(storage.database, (tx) =>
      storage.store.registerStaged(tx, {
        sha256: hash ?? '',
        bytes: row?.bytes ?? 1,
        width: 32,
        height: 32,
        luminance: null,
      }),
    );
    expect(result.created).toBe(false);
    expect(result.asset.unreferencedAt).toBeNull();
    expect(
      storage.assets().find((candidate) => candidate.sha256 === hash)?.unreferenced_at,
    ).toBeNull();
    expect(storage.usage().files).toBe(0);
  });

  it('registers derived variants without the quota', async () => {
    const storage = await createBrandingStorage();
    for (let index = 1; index <= LIMITS.staging.quotaFiles; index += 1) {
      withTransaction(storage.database, (tx) => storage.store.registerStaged(tx, metadata(index)));
    }
    const derived = withTransaction(storage.database, (tx) =>
      storage.store.registerDerived(tx, metadata(500)),
    );
    expect(derived.created).toBe(true);
  });
});

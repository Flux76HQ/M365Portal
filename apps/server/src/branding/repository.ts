// The registry repository (T-A-084; data-model 4.1 and 4.2, PD-10, invariants I-1 to I-5): every
// statement that reads or writes `branding` and `branding_asset`, and nothing else. Typed Drizzle
// queries only; no SQL is assembled from strings (FR-A-060).
//
// Every function takes a `DatabaseHandle`. A caller that needs several of them to be all-or-nothing
// passes the `Tx` of its `withTransaction` (a `Tx` is a handle), which is how the apply flow keeps
// the branding row, the `unreferenced_at` flags and the audit entry in one `BEGIN IMMEDIATE`.
// Nothing here opens a transaction of its own, so nothing here decides what belongs together.
//
// Timestamps are the fixed-width UTC text of the schema (`2026-10-10T12:00:00.000Z`), which sorts
// the way time does, so "older than" is a plain string comparison.
import { and, asc, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { branding, brandingAsset, type DatabaseHandle } from '../db/index.js';

export type AssetRow = typeof brandingAsset.$inferSelect;
export type BrandingRow = typeof branding.$inferSelect;

/** The roles in which `branding` references an asset, by column name. */
export const ASSET_ROLE_COLUMNS = [
  'logoLight',
  'logoDark',
  'logoCompact',
  'iconFavicon32',
  'iconApple180',
  'iconPwa192',
  'iconPwa512',
  'iconMaskable512',
] as const;
export type AssetRole = (typeof ASSET_ROLE_COLUMNS)[number];

// ---------------------------------------------------------------------------------------------
// branding_asset
// ---------------------------------------------------------------------------------------------

export function findAsset(db: DatabaseHandle, sha256: string): AssetRow | undefined {
  return db.orm.select().from(brandingAsset).where(eq(brandingAsset.sha256, sha256)).get();
}

/** The rows that exist among `hashes`, by hash. */
export function findAssets(
  db: DatabaseHandle,
  hashes: readonly string[],
): ReadonlyMap<string, AssetRow> {
  const unique = [...new Set(hashes)];
  if (unique.length === 0) return new Map();
  const rows = db.orm
    .select()
    .from(brandingAsset)
    .where(inArray(brandingAsset.sha256, unique))
    .all();
  return new Map(rows.map((row) => [row.sha256, row]));
}

/**
 * How many assets wait for an apply, and how many bytes they hold (the staging quota, I-5). Only
 * assets whose timer is still running count: `since` is the oldest `unreferenced_at` that is still
 * within the retention (now minus 24 hours). A row older than that is garbage that the hourly sweeper
 * has not removed yet, and it must not keep an administrator from uploading.
 */
export function stagingUsage(
  db: DatabaseHandle,
  since: string,
): { readonly files: number; readonly bytes: number } {
  const row = db.orm
    .select({
      files: sql<number>`count(*)`,
      bytes: sql<number>`coalesce(sum(${brandingAsset.bytes}), 0)`,
    })
    .from(brandingAsset)
    .where(and(isNotNull(brandingAsset.unreferencedAt), gte(brandingAsset.unreferencedAt, since)))
    .get();
  return { files: row?.files ?? 0, bytes: row?.bytes ?? 0 };
}

/**
 * The part of the staging usage that is the Undo target: the masters the most recent apply retired.
 * They carry exactly the timestamp of that apply (`branding.updated_at`, written in the same
 * transaction), and were created before it, which is how they are told from uploads that wait (an
 * upload born in the same millisecond as an apply is not mistaken for a retired master). Only rows whose timer still runs.
 */
export function retainedUsage(
  db: DatabaseHandle,
  retiredAt: string,
  since: string,
): { readonly files: number; readonly bytes: number } {
  if (retiredAt < since) return { files: 0, bytes: 0 };
  const row = db.orm
    .select({
      files: sql<number>`count(*)`,
      bytes: sql<number>`coalesce(sum(${brandingAsset.bytes}), 0)`,
    })
    .from(brandingAsset)
    .where(and(eq(brandingAsset.unreferencedAt, retiredAt), lt(brandingAsset.createdAt, retiredAt)))
    .get();
  return { files: row?.files ?? 0, bytes: row?.bytes ?? 0 };
}

/**
 * The next apply ends the Undo of the one before it: the masters retired at `retiredAt` (the
 * previous apply) lose their 24 hours and become garbage for the hourly sweeper (`expiredAt` is
 * older than the retention). Undo only ever goes back one change, so nothing needs them any more.
 * Referenced rows have no timestamp and are never matched.
 */
export function expireRetiredAssets(
  db: DatabaseHandle,
  retiredAt: string,
  expiredAt: string,
): void {
  db.orm
    .update(brandingAsset)
    .set({ unreferencedAt: expiredAt })
    .where(and(eq(brandingAsset.unreferencedAt, retiredAt), lt(brandingAsset.createdAt, retiredAt)))
    .run();
}

export interface NewAsset {
  readonly sha256: string;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  readonly luminance: number | null;
  readonly createdAt: string;
}

/** A new row, unreferenced since `createdAt`: an upload waiting to be applied (PD-10). */
export function insertUnreferencedAsset(db: DatabaseHandle, asset: NewAsset): void {
  db.orm
    .insert(brandingAsset)
    .values({ ...asset, unreferencedAt: asset.createdAt })
    .run();
}

/** Restart the 24-hour timer of a row that is unreferenced; a referenced row is left alone. */
export function refreshUnreferenced(db: DatabaseHandle, sha256: string, at: string): boolean {
  const result = db.orm
    .update(brandingAsset)
    .set({ unreferencedAt: at })
    .where(and(eq(brandingAsset.sha256, sha256), isNotNull(brandingAsset.unreferencedAt)))
    .run();
  return result.changes > 0;
}

/** The apply flips these to "referenced". */
export function markReferenced(db: DatabaseHandle, hashes: readonly string[]): void {
  const unique = [...new Set(hashes)];
  if (unique.length === 0) return;
  db.orm
    .update(brandingAsset)
    .set({ unreferencedAt: null })
    .where(inArray(brandingAsset.sha256, unique))
    .run();
}

/** The apply flips the retired ones to "unreferenced since `at`": they keep 24 hours (Undo). */
export function markUnreferenced(db: DatabaseHandle, hashes: readonly string[], at: string): void {
  const unique = [...new Set(hashes)];
  if (unique.length === 0) return;
  db.orm
    .update(brandingAsset)
    .set({ unreferencedAt: at })
    .where(inArray(brandingAsset.sha256, unique))
    .run();
}

/**
 * Delete the rows that have been unreferenced since before `cutoff` and that the branding row does
 * not reference, and return their hashes (the caller removes the files). The referenced hashes are
 * excluded here and not only by the flag, so a row whose flag is wrong is still never deleted
 * (PR-14); the foreign key is the third line of defence. The caller runs this in a transaction.
 */
export function deleteExpiredAssets(db: DatabaseHandle, cutoff: string): string[] {
  const referenced = new Set(referencedHashes(db));
  const expired = db.orm
    .select({ sha256: brandingAsset.sha256 })
    .from(brandingAsset)
    .where(and(isNotNull(brandingAsset.unreferencedAt), lt(brandingAsset.unreferencedAt, cutoff)))
    .orderBy(asc(brandingAsset.sha256))
    .all()
    .map((row) => row.sha256)
    .filter((hash) => !referenced.has(hash));
  if (expired.length > 0) {
    db.orm.delete(brandingAsset).where(inArray(brandingAsset.sha256, expired)).run();
  }
  return expired;
}

// ---------------------------------------------------------------------------------------------
// branding
// ---------------------------------------------------------------------------------------------

export function readBranding(db: DatabaseHandle): BrandingRow | undefined {
  return db.orm.select().from(branding).where(eq(branding.id, 1)).get();
}

/** The hash behind each role of a branding row; a role without an asset is absent. */
export function roleHashesOf(row: BrandingRow): Partial<Record<AssetRole, string>> {
  const hashes: Partial<Record<AssetRole, string>> = {};
  for (const role of ASSET_ROLE_COLUMNS) {
    const hash = row[role];
    if (hash !== null) hashes[role] = hash;
  }
  return hashes;
}

/** The distinct hashes the applied branding references. */
export function referencedHashes(db: DatabaseHandle): string[] {
  const row = readBranding(db);
  return row === undefined ? [] : [...new Set(Object.values(roleHashesOf(row)))];
}

export type NewBrandingRow = Omit<BrandingRow, 'id'>;

export function insertBranding(db: DatabaseHandle, row: NewBrandingRow): void {
  db.orm
    .insert(branding)
    .values({ ...row, id: 1 })
    .run();
}

/**
 * Replace the branding row, but only when it is still at `expectedRevision`; returns whether it was.
 * The revision moves by exactly one (I-2), in this one statement.
 */
export function replaceBranding(
  db: DatabaseHandle,
  expectedRevision: number,
  row: Omit<NewBrandingRow, 'revision'>,
): boolean {
  const result = db.orm
    .update(branding)
    .set({ ...row, revision: expectedRevision + 1 })
    .where(and(eq(branding.id, 1), eq(branding.revision, expectedRevision)))
    .run();
  return result.changes > 0;
}

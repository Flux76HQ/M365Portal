// The Drizzle schema of Phase A (FR-A-066, data-model section 4): `branding`, `branding_asset` and
// `audit_log`. The migration bookkeeping (`__drizzle_migrations`) belongs to the Drizzle migrator and
// is deliberately not declared here, and neither are the three audit triggers (data-model 7.1):
// they are hand-written SQL in migration 0000, and the committed snapshots are taken from the
// migrated database for that reason (PD-05).
//
// Two rules for editing this file:
//   - A change here is a new migration. `drizzle-kit generate` produces it and the drift check
//     fails until it exists (FR-A-062). A migration that was merged is never edited (data-model 8.1).
//   - The CHECK constraints write their numbers as literals on purpose. A CHECK is part of the table
//     as the migration created it; if it followed `LIMITS`, changing a limit would silently make this
//     file disagree with every database that already exists. The limit and the CHECK change together,
//     in a migration, or not at all.
//
// A CHECK describes a shape or a closed set that will not grow (data-model 4.4). It never lists the
// values later phases extend (`actor_kind`, `action`, `target_type`, `reason_code`,
// `updated_by_kind`): SQLite cannot alter a CHECK, and rebuilding an append-only audit table would
// mean dropping and recreating its triggers. The writers validate those with Zod enums instead.
import { sql } from 'drizzle-orm';
import {
  blob,
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/** `2026-10-10T12:00:00.000Z`: UTC, milliseconds, the `Z`. SQLite `GLOB` is case-sensitive. */
const TIMESTAMP_GLOB =
  "'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'";

/** Six lower-case hex digits after the hash sign. */
const ACCENT_GLOB = "'#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'";

// ---------------------------------------------------------------------------------------------
// branding_asset: the registry of content-addressed PNG files in /data/branding (data-model 4.2)
// ---------------------------------------------------------------------------------------------

export const brandingAsset = sqliteTable(
  'branding_asset',
  {
    /** 64 lower-case hex digits: also the name of `/data/branding/<sha256>.png`. */
    sha256: text('sha256').primaryKey(),
    bytes: integer('bytes').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    /** Alpha-weighted mean relative luminance, 0..1, for the contrasting plate behind a logo. */
    luminance: real('luminance'),
    createdAt: text('created_at').notNull(),
    /** NULL while the applied branding references the asset; else when it stopped being referenced. */
    unreferencedAt: text('unreferenced_at'),
  },
  (table) => [
    // Only unreferenced rows are ever looked up by this column (the sweeper, the quota).
    index('branding_asset_unreferenced_idx')
      .on(table.unreferencedAt)
      .where(sql`unreferenced_at IS NOT NULL`),
    check(
      'branding_asset_sha256_shape',
      sql.raw(`length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'`),
    ),
    check('branding_asset_bytes_range', sql.raw('bytes BETWEEN 1 AND 2097152')),
    check('branding_asset_width_range', sql.raw('width BETWEEN 1 AND 1024')),
    check('branding_asset_height_range', sql.raw('height BETWEEN 1 AND 1024')),
    check(
      'branding_asset_luminance_range',
      sql.raw('luminance IS NULL OR luminance BETWEEN 0 AND 1'),
    ),
    check('branding_asset_created_at_shape', sql.raw(`created_at GLOB ${TIMESTAMP_GLOB}`)),
    check(
      'branding_asset_unreferenced_at_shape',
      sql.raw(`unreferenced_at IS NULL OR unreferenced_at GLOB ${TIMESTAMP_GLOB}`),
    ),
  ],
);

// ---------------------------------------------------------------------------------------------
// branding: the typed, single-row settings record (data-model 4.1)
// ---------------------------------------------------------------------------------------------

export const branding = sqliteTable(
  'branding',
  {
    /** Always 1. */
    id: integer('id').primaryKey(),
    /** At least 1; +1 per accepted change. */
    revision: integer('revision').notNull(),
    /** NFC, trimmed, validated by the shared normaliser (the 64-grapheme limit lives there). */
    orgName: text('org_name').notNull(),
    /** The chosen colour, lower-case `#rrggbb`. */
    accent: text('accent').notNull(),
    logoLight: text('logo_light').references(() => brandingAsset.sha256, { onDelete: 'restrict' }),
    logoDark: text('logo_dark').references(() => brandingAsset.sha256, { onDelete: 'restrict' }),
    logoCompact: text('logo_compact').references(() => brandingAsset.sha256, {
      onDelete: 'restrict',
    }),
    /** 1 when `logo_compact` was derived from a master, 0 when it was uploaded or is absent. */
    logoCompactDerived: integer('logo_compact_derived').notNull().default(0),
    iconFavicon32: text('icon_favicon32')
      .notNull()
      .references(() => brandingAsset.sha256, { onDelete: 'restrict' }),
    iconApple180: text('icon_apple180')
      .notNull()
      .references(() => brandingAsset.sha256, { onDelete: 'restrict' }),
    iconPwa192: text('icon_pwa192')
      .notNull()
      .references(() => brandingAsset.sha256, { onDelete: 'restrict' }),
    iconPwa512: text('icon_pwa512')
      .notNull()
      .references(() => brandingAsset.sha256, { onDelete: 'restrict' }),
    iconMaskable512: text('icon_maskable512')
      .notNull()
      .references(() => brandingAsset.sha256, { onDelete: 'restrict' }),
    /** UTC ISO-8601 with milliseconds. */
    updatedAt: text('updated_at').notNull(),
    /** `preview` or `system` in Phase A; deliberately not a CHECK (data-model 4.4). */
    updatedByKind: text('updated_by_kind').notNull(),
    updatedById: text('updated_by_id').notNull(),
  },
  () => [
    check('branding_single_row', sql.raw('id = 1')),
    check('branding_revision_positive', sql.raw('revision >= 1')),
    // Bytes, not characters: SQLite cannot count graphemes, the shared normaliser does (64).
    check('branding_org_name_bytes', sql.raw('length(CAST(org_name AS BLOB)) BETWEEN 1 AND 256')),
    check('branding_accent_shape', sql.raw(`accent GLOB ${ACCENT_GLOB}`)),
    check('branding_logo_compact_derived_flag', sql.raw('logo_compact_derived IN (0, 1)')),
    check(
      'branding_logo_compact_derived_needs_logo',
      sql.raw('logo_compact_derived = 0 OR logo_compact IS NOT NULL'),
    ),
    check('branding_updated_at_shape', sql.raw(`updated_at GLOB ${TIMESTAMP_GLOB}`)),
  ],
);

// ---------------------------------------------------------------------------------------------
// audit_log: append-only, hash-chained (data-model 4.3 and 7)
// ---------------------------------------------------------------------------------------------

export const auditLog = sqliteTable(
  'audit_log',
  {
    /** No AUTOINCREMENT: the writer assigns `MAX(seq) + 1` inside the append transaction. */
    seq: integer('seq').primaryKey(),
    /** UTC ISO-8601 with milliseconds, from the injected clock. */
    ts: text('ts').notNull(),
    /** `anonymous`, `preview` or `system` now; `user` and `break_glass` later. */
    actorKind: text('actor_kind').notNull(),
    actorId: text('actor_id').notNull(),
    /** The vocabulary of data-model 7.4: a route id or an `entity.verb`. */
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    /** `success`, `denied`, `rejected` or `error`: the one closed set. */
    outcome: text('outcome').notNull(),
    /** A stable problem or denial code. */
    reasonCode: text('reason_code'),
    /** Personal data. It lives in this table and its backups only, never in a log line. */
    clientIp: text('client_ip'),
    requestId: text('request_id'),
    /** Canonical JSON text, at most 4,096 bytes. */
    detail: text('detail').notNull().default('{}'),
    /** 32 bytes: the `hash` of the previous entry, or 32 zero bytes for `seq = 1`. */
    prevHash: blob('prev_hash', { mode: 'buffer' }).notNull(),
    /** 32 bytes: SHA-256 over `prev_hash` and the canonical entry. */
    hash: blob('hash', { mode: 'buffer' }).notNull(),
  },
  (table) => [
    uniqueIndex('audit_log_hash_uq').on(table.hash),
    check('audit_log_ts_shape', sql.raw(`ts GLOB ${TIMESTAMP_GLOB}`)),
    check(
      'audit_log_outcome_set',
      sql.raw(`outcome IN ('success', 'denied', 'rejected', 'error')`),
    ),
    check(
      'audit_log_detail_json',
      sql.raw('json_valid(detail) = 1 AND length(CAST(detail AS BLOB)) <= 4096'),
    ),
    check('audit_log_hash_sizes', sql.raw('length(prev_hash) = 32 AND length(hash) = 32')),
  ],
);

export type BrandingRow = typeof branding.$inferSelect;
export type BrandingAssetRow = typeof brandingAsset.$inferSelect;
export type AuditLogRow = typeof auditLog.$inferSelect;

// Phase B (FR-B-701): the 17 tables of migration `0001_phase_b` live in `schema/phase-b.ts`; this
// re-export is what the Drizzle config and every consumer of `schema.ts` see.
export * from './schema/phase-b.js';

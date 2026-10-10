# Data Model: M365Portal Phase A

**Spec**: [spec.md](spec.md) (FR-A-060 to FR-A-066, FR-A-070 to FR-A-075, section 6.6) | **Plan**: [plan.md](plan.md) (PD-05, PD-06, PD-10, PD-12, PD-21) | **API**: [contracts/phase-a-api.md](contracts/phase-a-api.md)

This document is the single description of what Phase A persists, how it is protected, and how it may change. Everything here is Phase A. Phases B to D add tables through new migrations; section 11 lists what this schema deliberately leaves open for them.

## Samenvatting (Nederlands)

Fase A bewaart drie dingen in één SQLite-bestand (`/data/m365portal.sqlite`, WAL): de huisstijl (`branding`, precies één rij), een register van afbeeldingsbestanden op hash (`branding_asset`) en een onveranderbaar auditlog met SHA-256-hashketen (`audit_log`), plus de migratieadministratie van Drizzle. De afbeeldingen zelf staan als `<sha256>.png` in `/data/branding/`. Migraties zijn alleen vooruit, checksum-bewaakt en krijgen vooraf een back-up; van elke uitgebrachte schemaversie staat een momentopname in de repository, en een upgradetest bewijst dat een oud schema correct naar het nieuwe gaat. De audittriggers (UPDATE/DELETE geweigerd, schakel-controle bij INSERT) zijn handgeschreven migratie-SQL en staan daarom níet in het Drizzle-schema; de momentopnames worden uit de gemigreerde database gemaakt.

## 1. Scope and mapping from the task text

The task text asked for "settings, branding_assets, audit_log with hash chain, schema_migrations bookkeeping if needed". The Phase A set is:

| Table | Role | Note |
|---|---|---|
| `branding` | The typed, single-row settings record of Phase A (organisation name, accent, logo and icon references, revision) | There is **no** generic `settings` key-value table: an untyped bag would need its own validation per key, and Phase A has exactly one settings record. Phase B adds typed tables or columns when it has tenant settings |
| `branding_asset` | Registry of content-addressed PNG files in `/data/branding` | Spec name `branding_asset` (FR-A-066) |
| `audit_log` | Append-only, hash-chained audit entries | |
| `__drizzle_migrations` | Migration bookkeeping, created and written by the Drizzle migrator | Not declared in the TypeScript schema; read by the migration wrapper (PD-06). The spec's "migration bookkeeping" and the task's `schema_migrations` are this table |

## 2. Storage layout on disk

```text
${DATA_DIR}                         default /data, owned by uid 65532, directories 0700, files 0600 (process umask 077)
├── m365portal.sqlite               the database (+ m365portal.sqlite-wal and -shm while open)
├── branding/
│   ├── <sha256>.png                content-addressed images: masters, derived compact, icons (name = SHA-256 of the file bytes)
│   └── .tmp/                       staging for atomic writes (write here, fsync, rename into place); swept at start and hourly
└── backups/
    └── pre-migrate-<from>-<to>.sqlite   consistent copy taken before pending migrations, e.g. pre-migrate-0000-0001.sqlite; the newest 3 are kept
```

- The database and the image directory live on the **same filesystem** (the volume), so the final rename in an atomic write cannot fail with `EXDEV`. Nothing in Phase A is written to `/tmp` (SA-04).
- The volume must be a local disk and exactly one container may use it (SQLite WAL needs shared memory on one host; sqlite.org/wal.html, checked in the spec; A-57).
- The backups contain the audit log and therefore client addresses; they have the same protection and the same personal-data status as the live database.

## 3. Entity relationships

```text
branding (1 row, id = 1)
   ├─ logo_light, logo_dark, logo_compact ──────► branding_asset.sha256   (nullable, ON DELETE RESTRICT)
   └─ icon_favicon32, icon_apple180, icon_pwa192,
      icon_pwa512, icon_maskable512 ────────────► branding_asset.sha256   (not null, ON DELETE RESTRICT)

audit_log (append-only chain; no foreign keys: an entry must survive whatever it refers to)
   target_type / target_id are plain text, e.g. ('branding', '1') or ('branding_asset', '<sha256>')
```

An asset row can be referenced by several roles at once (the same bytes may serve as the light master and an icon source); the rows are keyed by content, not by role.

## 4. Tables

Definitions are written in the Drizzle `sqlite-core` style the implementation will use. Names, types and constraints are normative; helper names are confirmed by `pnpm typecheck` (UNVERIFIED which `check()` and partial-index helpers 0.45.4 exposes: a missing helper is replaced by the equivalent line in the hand-written migration section, and the schema parity test (section 8.5) covers the difference).

### 4.1 `branding`

```ts
export const branding = sqliteTable('branding', {
  id: integer('id').primaryKey(),                                   // always 1
  revision: integer('revision').notNull(),                          // >= 1, +1 per accepted change
  orgName: text('org_name').notNull(),                              // NFC, trimmed, validated by the shared normaliser
  accent: text('accent').notNull(),                                 // chosen colour, lowercase #rrggbb
  logoLight: text('logo_light').references(() => brandingAsset.sha256, { onDelete: 'restrict' }),
  logoDark: text('logo_dark').references(() => brandingAsset.sha256, { onDelete: 'restrict' }),
  logoCompact: text('logo_compact').references(() => brandingAsset.sha256, { onDelete: 'restrict' }),
  logoCompactDerived: integer('logo_compact_derived').notNull().default(0), // 1 when logoCompact was derived, not uploaded
  iconFavicon32: text('icon_favicon32').notNull().references(() => brandingAsset.sha256, { onDelete: 'restrict' }),
  iconApple180: text('icon_apple180').notNull().references(() => brandingAsset.sha256, { onDelete: 'restrict' }),
  iconPwa192: text('icon_pwa192').notNull().references(() => brandingAsset.sha256, { onDelete: 'restrict' }),
  iconPwa512: text('icon_pwa512').notNull().references(() => brandingAsset.sha256, { onDelete: 'restrict' }),
  iconMaskable512: text('icon_maskable512').notNull().references(() => brandingAsset.sha256, { onDelete: 'restrict' }),
  updatedAt: text('updated_at').notNull(),                          // UTC ISO-8601 with milliseconds
  updatedByKind: text('updated_by_kind').notNull(),                 // 'preview' | 'system' in Phase A (not a CHECK, see 4.4)
  updatedById: text('updated_by_id').notNull(),
});
```

| Constraint | Text |
|---|---|
| Single row | `CHECK (id = 1)` |
| Revision | `CHECK (revision >= 1)` |
| Name size | `CHECK (length(CAST(org_name AS BLOB)) BETWEEN 1 AND 256)` (bytes; the 64-grapheme limit is enforced by the shared normaliser because SQLite cannot count graphemes) |
| Accent shape | `CHECK (accent GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')` (`GLOB` is case-sensitive, so uppercase is rejected) |
| Derived flag | `CHECK (logo_compact_derived IN (0, 1))` and `CHECK (logo_compact_derived = 0 OR logo_compact IS NOT NULL)` |
| Time shape | `CHECK (updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')` |

The row does not exist before the first start completes storage initialisation; after it, it always exists (PD-12). The "default organisation name" flag is derived (`orgName === DEFAULT_ORG_NAME`), not stored.

### 4.2 `branding_asset`

```ts
export const brandingAsset = sqliteTable('branding_asset', {
  sha256: text('sha256').primaryKey(),                              // 64 lowercase hex = name of /data/branding/<sha256>.png
  bytes: integer('bytes').notNull(),
  width: integer('width').notNull(),
  height: integer('height').notNull(),
  luminance: real('luminance'),                                     // alpha-weighted mean relative luminance, 0..1; used for the contrasting plate
  createdAt: text('created_at').notNull(),
  unreferencedAt: text('unreferenced_at'),                          // NULL while referenced by the applied branding
}, (t) => [index('branding_asset_unreferenced_idx').on(t.unreferencedAt)]);
```

| Constraint | Text |
|---|---|
| Hash shape | `CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*')` |
| Sizes | `CHECK (bytes BETWEEN 1 AND 2097152)`, `CHECK (width BETWEEN 1 AND 1024)`, `CHECK (height BETWEEN 1 AND 1024)` |
| Luminance | `CHECK (luminance IS NULL OR luminance BETWEEN 0 AND 1)` |
| Time shapes | the same `GLOB` as `branding.updated_at` for `created_at` and, when not null, `unreferenced_at` |

Semantics (PD-10): `unreferenced_at IS NULL` means "referenced by the applied branding"; a non-null value is the moment the asset became unreferenced (an upload that has not been applied yet, or an asset a later apply retired). "Staged" in the spec and the API means `unreferenced_at IS NOT NULL`. Unreferenced assets are served only to an actor holding `settings:branding` (FR-A-090).

The partial form of the index (`WHERE unreferenced_at IS NOT NULL`) is preferred if the Drizzle helper supports it (UNVERIFIED); otherwise the plain index is used. At most 32 rows and 32 MiB (the sum of `bytes`) may have `unreferenced_at IS NOT NULL`.

### 4.3 `audit_log`

```ts
export const auditLog = sqliteTable('audit_log', {
  seq: integer('seq').primaryKey(),                                 // no AUTOINCREMENT: assigned explicitly as MAX(seq)+1 inside the append transaction
  ts: text('ts').notNull(),                                         // UTC ISO-8601 with milliseconds, from the injected clock
  actorKind: text('actor_kind').notNull(),                          // 'anonymous' | 'preview' | 'system' now; 'user', 'break_glass' later
  actorId: text('actor_id').notNull(),
  action: text('action').notNull(),                                 // vocabulary in section 7.3
  targetType: text('target_type'),
  targetId: text('target_id'),
  outcome: text('outcome').notNull(),                               // 'success' | 'denied' | 'rejected' | 'error'
  reasonCode: text('reason_code'),                                  // stable problem or denial code
  clientIp: text('client_ip'),                                      // personal data; audit table only
  requestId: text('request_id'),
  detail: text('detail').notNull().default('{}'),                   // canonical JSON text, at most 4096 bytes
  prevHash: blob('prev_hash', { mode: 'buffer' }).notNull(),        // 32 bytes
  hash: blob('hash', { mode: 'buffer' }).notNull(),                 // 32 bytes, SHA-256
}, (t) => [uniqueIndex('audit_log_hash_uq').on(t.hash)]);
```

| Constraint | Text |
|---|---|
| Time shape | the `GLOB` of section 4.1 |
| Outcome set | `CHECK (outcome IN ('success', 'denied', 'rejected', 'error'))` (closed set) |
| Detail | `CHECK (json_valid(detail) = 1 AND length(CAST(detail AS BLOB)) <= 4096)` (JSON functions are part of the bundled SQLite; checked by `server/db.test.ts`) |
| Hash sizes | `CHECK (length(prev_hash) = 32 AND length(hash) = 32)` |

### 4.4 Rules for constraints

- A `CHECK` describes a **shape or a closed set that will not grow** (hex, timestamp format, byte lengths, JSON validity, `outcome`). It never lists values later phases extend (`actor_kind`, `action`, `target_type`, `reason_code`, `updated_by_kind`): SQLite cannot alter a `CHECK`, and a table rebuild of an append-only audit table would have to drop and recreate its triggers. Those values are validated by the writer with a Zod enum instead.
- Foreign keys from `branding` use `ON DELETE RESTRICT`: deleting a referenced asset fails in the database even if the sweeper had a bug (PR-14).
- Defaults appear in the TypeScript schema **and** in the generated SQL (`DEFAULT 0`, `DEFAULT '{}'`); the parity test (8.5) fails if they ever differ.

## 5. Connection settings

Applied by `db/open.ts` on every connection, in this order:

| Pragma | Value | Why |
|---|---|---|
| `journal_mode` | `WAL` | Readers do not block the writer; checkpointed at shutdown |
| `synchronous` | `FULL` | An audit log should survive power loss; the write rate is tiny |
| `foreign_keys` | `ON`, except `OFF` while the migration wrapper runs (PD-06), then back `ON` | The Drizzle migrator opens its own transaction in which `PRAGMA foreign_keys = OFF` is a no-op, so the connection must be opened with it off for table-rebuild migrations (probe P12) |
| `busy_timeout` | `5000` | Short waits instead of immediate `SQLITE_BUSY` |
| `temp_store` | `MEMORY` | No spill files outside `/data` |

Every query is parameterised through Drizzle or prepared statements; no SQL is assembled from strings outside migration files (lint rule `no-string-built-sql`, FR-A-060).

## 6. Invariants

| ID | Invariant | Maintained by | Checked by |
|---|---|---|---|
| I-1 | After start-up initialisation exactly one `branding` row exists, `id = 1` | `CHECK (id = 1)`, initialisation code | `server/branding/branding-api.test.ts` |
| I-2 | `branding.revision` increases by exactly 1 per accepted change (apply, reset, import) and never otherwise | single update statement in the apply transaction | `server/branding/concurrency.test.ts` |
| I-3 | Every non-null asset reference in `branding` exists in `branding_asset` and has `unreferenced_at IS NULL`; every other row has it set | foreign keys; the apply transaction flips the flags | `server/branding/upload-pipeline.test.ts` |
| I-4 | For every `branding_asset` row a file `<sha256>.png` exists, and its bytes hash to `sha256` | write file then insert row; start-up check logs `branding_asset_missing` | `server/branding/serve-assets.test.ts` |
| I-5 | At most 32 rows and 32 MiB with `unreferenced_at IS NOT NULL` | quota check before staging | `server/branding/upload-pipeline.test.ts` |
| I-6 | `audit_log.seq` is contiguous from 1; each `prev_hash` equals the previous `hash` (32 zero bytes for `seq = 1`); each `hash` equals the recomputed value | `BEFORE INSERT` trigger plus the writer | `server/audit.test.ts`, `verifyChain` |
| I-7 | No `audit_log` row is ever updated or deleted | `BEFORE UPDATE` and `BEFORE DELETE` triggers | `server/audit.test.ts` (tamper fixtures drop the triggers inside the test) |
| I-8 | A branding change and its audit entry commit together or not at all | one `BEGIN IMMEDIATE` transaction | `server/audit-integration.test.ts` (fault injected between the two) |
| I-9 | Accent is stored as lowercase `#rrggbb`; the organisation name is stored NFC-normalised | shared normalisers, `CHECK` | `shared/accent.property.test.ts`, `shared/org-name.test.ts` |
| I-10 | `audit_log.detail` never holds a secret or a request body; images appear by hash and size only | writer allow-list of detail keys | `server/audit-integration.test.ts` |

## 7. Audit log

### 7.1 Triggers (hand-written migration SQL; not in the Drizzle schema)

```sql
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

CREATE TRIGGER audit_log_chain_link BEFORE INSERT ON audit_log
WHEN NEW.seq <> COALESCE((SELECT MAX(seq) FROM audit_log), 0) + 1
  OR NEW.prev_hash <> COALESCE((SELECT hash FROM audit_log WHERE seq = (SELECT MAX(seq) FROM audit_log)), zeroblob(32))
BEGIN SELECT RAISE(ABORT, 'audit_log chain link violated'); END;
```

The third trigger is defence in depth: SQLite cannot compute SHA-256, but it can refuse an insert whose `seq` or `prev_hash` does not continue the chain, so even a buggy writer cannot fork it. Because it requires `seq = MAX(seq) + 1`, an `INSERT OR REPLACE` that targets an existing `seq` is also refused. All three live in the first migration (`0000_init.sql`), after the generated table statements, behind a comment that marks the hand-written section.

### 7.2 Canonical form and hash

The hashed object has exactly these keys: `seq`, `ts`, `actor_kind`, `actor_id`, `action`, `target_type`, `target_id`, `outcome`, `reason_code`, `client_ip`, `request_id`, `detail`. Absent values are JSON `null`; `detail` is embedded as its **stored text** (a JSON string value, not a parsed object), so any byte change to the stored text, including whitespace, changes the hash.

```text
canonical(entry) = JSON text with keys sorted by UTF-16 code unit, no insignificant whitespace,
                   strings as JSON.stringify writes them, numbers only as safe integers
hash             = SHA-256( prev_hash (32 bytes) || UTF-8(canonical(entry)) )
first prev_hash  = 32 zero bytes
```

`detail` is built by the writer from a flat map of allowed keys (strings truncated to 256 bytes at a code-point boundary, integers, booleans, short string arrays), serialised with the same canonicaliser, and capped at 4,096 bytes; an over-long map is replaced by `{"keys":[...],"truncated":true}`.

### 7.3 Append and verify

- **Append** (`audit/writer.ts`, the only code that inserts): synchronous, inside `BEGIN IMMEDIATE` (`db.transaction(fn).immediate()`), reads the head (`seq`, `hash`), assigns `seq = head + 1`, computes the hash, inserts, commits, then logs `{seq, hash}` (FR-A-074). If the append is part of a branding change it runs in that change's transaction (I-8). If the append for a denial fails, the request answers 503 instead of 403 (PD-21).
- **Verify** (`verifyChain(db, { from?, to? })`): streams rows with `iterate()` in `seq` order, in constant memory; checks contiguity, `prev_hash` linkage, and the recomputed hash; returns `{ ok, checked, firstBadSeq?, triggersMissing }`, where `triggersMissing` lists any of the three trigger names absent from `sqlite_master` (additive to the spec's shape). With `from > 1` the stored hash of `from - 1` is read and trusted as the starting point. Exposed as `node dist/cli.js verify-audit [--from N --to M]` (read-only connection, exit 1 when not ok).
- **Limits (documented in `docs/security.md`)**: tail truncation is not detectable offline (the logged head `seq` and `hash` let an external pipeline anchor the chain); an attacker who can write the database file can drop the triggers and recompute the whole chain. This is tamper evidence, not tamper proofing.

### 7.4 Action vocabulary (Phase A)

| `action` | `target_type` / `target_id` | `outcome` values | `detail` keys |
|---|---|---|---|
| `branding.init` | `branding` / `1` | `success` (actor `system`) | `revision` |
| `branding.asset.stage` | `branding_asset` / output hash, or empty when rejected | `success`, `rejected`, `denied` | `slot`, `bytes` (of the upload), `sha256` (of the output; of the upload when rejected), `created`, `warnings` (codes) |
| `branding.apply` | `branding` / `1` | `success`, `denied` | `fromRevision`, `toRevision`, `orgNameOld`, `orgNameNew`, `accentOld`, `accentNew`, asset hashes per role |
| `branding.reset` | `branding` / `1` | `success`, `denied` | `fromRevision`, `toRevision` |
| `branding.import` | `branding` / `1` | `success`, `rejected`, `denied` | `dryRun`, `schemaVersion`, `bytes`, image hashes per slot, warnings (codes) |
| `branding.export` | `branding` / `1` | `success` | `revision`, `bytes` |

A denied write (permission, Origin or CSRF) is recorded with `action` equal to the **route id** (for example `branding.apply`), `outcome = denied`, `reason_code` one of `permission_denied`, `origin_not_allowed`, `csrf_invalid`, and `detail` holding `permission`, `method` and the route template; the `request_id` and `client_ip` columns are filled. Precondition failures (412, 428) and validation failures (422) of apply and reset are not audited, because no change was attempted; rejected uploads and imports are (FR-A-072). Rate-limited requests (429) are never audited (FR-A-034).

## 8. Migrations

### 8.1 Policy

1. **Forward-only.** There are no down migrations. A mistake is fixed by a new migration.
2. **Immutable once merged.** A migration file and its journal entry never change after they reach the integration branch. The CI check "Schema snapshot check" compares `apps/server/schema-snapshots/migrations.json` (tag, SHA-256, schema version) with the base ref and fails if an entry present there changed; the runtime guard (8.2) refuses to start on a mismatch.
3. **Generated, then reviewed.** SQL comes from `drizzle-kit generate`; hand-written statements (triggers, data fixes) are added to the migration file in a marked section or through `drizzle-kit generate --custom`. Application code never runs inside a migration.
4. **Journal discipline.** Entry `when` values strictly increase and tags are `NNNN_<slug>` in sequence (the stock migrator skips a migration whose `when` is older than the newest applied one: probe P13); `server/migrations.test.ts` asserts both.
5. **Table rebuilds are dangerous.** `drizzle-kit` rebuilds a table (`__new_x`, copy, drop, rename) to add a `UNIQUE`, change a default or a `NOT NULL`. Under `foreign_keys = ON` that cascades deletes into child rows (probe P12). The wrapper runs migrations with foreign keys off and runs `foreign_key_check` afterwards, and every rebuild migration needs an upgrade-test fixture with child rows.
6. **Defaults are stated twice** (TypeScript and SQL); the parity test compares them. A new `NOT NULL` column needs a default.
7. **Destructive changes** (drop column or table) need an ADR; the pre-migration backup always exists for them.
8. **No down-level start.** A database newer than the application is refused (`schema_newer_than_app`), untouched.

### 8.2 Runtime wrapper (PD-06)

On every start, after the database opens with foreign keys off: read all `__drizzle_migrations` rows ordered by `id`; load the shipped migrations with `readMigrationFiles` (it yields each file's SHA-256 `hash` and the journal `folderMillis`); compare by position. More rows than shipped files, or a newest applied `created_at` greater than the newest shipped `when`, means `schema_newer_than_app` (exit non-zero before listening, database untouched). Any other difference in `hash` or `created_at` means `migration_checksum_mismatch` (exit non-zero). If migrations are pending and the database already has applied rows, take a backup with the SQLite online backup API to `backups/pre-migrate-<from>-<to>.sqlite` (the first install on an empty database takes none) and delete older backups beyond the newest 3. Run the stock migrator (all pending migrations in one transaction: V-05). Then `PRAGMA foreign_key_check` must return nothing, foreign keys go back on, and the rows are re-read and compared with the shipped files.

### 8.3 Snapshot rule (baseline section 2)

- **What is committed.** For every schema version that ships, `apps/server/schema-snapshots/<NNNN>-<tag>.sql`: the DDL of a database produced by applying migrations `0000` to that version to an empty database, taken from `sqlite_master` (tables, then indexes, then triggers, each sorted by name; `sqlite_%` objects and `__drizzle_migrations` excluded), with a header (`-- schema-version: N`, `-- last-migration: <tag>`, `-- generated by apps/server/scripts/schema-snapshot.ts; do not edit`). It is committed in the same commit as the migration, before it is needed.
- **Why from the migrated database.** `drizzle-kit export` renders the TypeScript schema and would omit the hand-written triggers (PD-05). The snapshot must describe what an upgraded database actually contains.
- **`migrations.json`** lists, per migration, its tag, SHA-256 and schema version (8.1, item 2).
- **Commands.** `pnpm schema:snapshot` regenerates the snapshot and the manifest of the current version; `pnpm schema:check` is what CI runs ("Schema snapshot check": the snapshot of the current version regenerates identically, the file exists, released entries are unchanged; "Schema drift check": `drizzle-kit generate` into a clean copy produces no new file). Failure messages end with the exact command to run.
- **Version mapping.** The application version for a given schema version is derivable from a release tag (`git show v0.2.0:apps/server/drizzle/meta/_journal.json`); the snapshots do not duplicate it.

### 8.4 Upgrade test (baseline section 2)

`server/migrations.upgrade.test.ts`, for every older snapshot N and the newest snapshot M: build a database from snapshot N's SQL, insert the `__drizzle_migrations` rows for migrations up to N (hash and `when` from the shipped files), seed rows in every table including child rows that reference parents (a `branding` row referencing assets, audit entries), run the **real** start-up wrapper, then compare tables, columns (name, type, not-null, default, primary key), indexes, foreign keys and trigger SQL with a database built from snapshot M, assert `foreign_key_check` is empty, assert every seeded row is intact, and assert the audit chain still verifies. Phase A has one schema version, so the harness is proven on a **synthetic pair** (a fixture migration that adds a column with `DEFAULT 1` in SQL while its snapshot says `DEFAULT 0`) that must fail: a guard nobody has seen fail is an assumption with a green tick (baseline section 2).

### 8.5 Source-level parity test

`server/schema-parity.test.ts` builds database A from the output of `drizzle-kit export` (the TypeScript schema) and database B from the migrations, and compares tables, columns, types, not-null flags, defaults, indexes and foreign keys, ignoring triggers. This is the cheap guard the baseline asks for ("parse both sides and assert they agree"); the negative fixture is a migration whose SQL default differs from the schema's `.default()`.

## 9. Files and sweepers

| Job | When | Rule |
|---|---|---|
| Temporary files | start, then hourly | Delete everything in `branding/.tmp/` older than 10 minutes |
| Unreferenced assets | start, then hourly | Delete rows (and their files) where `unreferenced_at` is older than 24 hours and the hash is not referenced by `branding`; file first or row first is irrelevant because both are idempotent; a referenced hash is never selected |
| Orphan files | start, then hourly | Delete `branding/*.png` that have no registry row and are older than one hour (an interrupted write) |
| Missing files | start only | For each referenced asset whose file is missing, log `branding_asset_missing` (warn); serving that hash answers 404 and the UI falls back to the monogram; `/readyz` stays 200 |

All writes of image files are atomic: write to `.tmp/<random>`, flush, rename to `<sha256>.png`. Identical bytes converge on one file; a rename onto an existing identical file is harmless.

## 10. Backup, restore, retention and classification

- **Backup.** Stop the container (or accept a slightly inconsistent copy without stopping: not recommended), copy **all of `/data`** including any `-wal` and `-shm` files. Restore by copying back with the same ownership (uid 65532) while the container is stopped. The automatic pre-migration copy is a convenience, not a substitute.
- **Retention.** Audit entries are kept indefinitely until Phase D defines retention (OD-10); backups: the newest 3 pre-migration copies; unreferenced images: 24 hours.
- **Personal data.** `audit_log.client_ip` is personal data and exists only in the audit table and its backups; logs never carry it (FR-A-051, FR-A-073, BC-14). The organisation name is data supplied by the administrator and may be personal if the administrator makes it so; it is not treated as secret.
- **Secrets.** Phase A stores none (no keys, tokens or certificates). Phase B adds encrypted secrets with their own table and key handling.

## 11. What Phases B to D add (so Phase A does not block them)

| Phase | Additive change | Why Phase A already allows it |
|---|---|---|
| B | Tables for sessions, roles, permissions, assignments, group-membership cache, setup state, encrypted secrets; new `actor_kind` values `user` and `break_glass`; tenant-derived default organisation name | No `CHECK` on `actor_kind`, `action`, `target_type`, `reason_code` or `updated_by_kind`; `branding` is a typed row that can gain columns with defaults |
| C | Cache tables for Graph data, if any | New tables only |
| D | Audit filters (indexes on `ts`, `actor_id`, `action`, `outcome`), retention job, export | Indexes are additive migrations; the table is small until then; the canonical form already carries every column a filter needs |

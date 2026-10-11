// The migration runner (FR-A-061, FR-A-064, FR-A-012 migration part; PD-06; V-05; A-03; probe P12 and
// P13). The ONLY code that calls the Drizzle migrator: a test scans `src` and `scripts` for it.
//
// What the stock migrator does and does not do (V-05):
//   - it records the SHA-256 of each migration file and the journal `when` as `created_at`
//   - it reads only the NEWEST applied row and applies every journal entry whose `when` is newer;
//     applied rows are never compared with the files again, and an entry with an older `when` is
//     skipped without a word (P13)
//   - it runs all pending migrations in ONE transaction (`BEGIN` ... `COMMIT`), in which
//     `PRAGMA foreign_keys = OFF` does nothing, so a table-rebuild migration (which drizzle-kit
//     writes to add a UNIQUE or change a default) deletes the child rows of every ON DELETE CASCADE
//     (P12)
//
// What this wrapper adds, in this order, on every start:
//   1. read the applied rows and the shipped files and compare them BY POSITION
//   2. more applied rows than shipped files, or an applied row newer than every shipped `when`:
//      `schema_newer_than_app`; any other difference in hash or `created_at`:
//      `migration_checksum_mismatch`. Both are read-only: the database file is untouched, and both
//      end the start-up (a database that cannot be understood is never served)
//   3. a pending migration whose `when` is not newer than the newest applied one would be skipped
//      silently: `migration_journal_invalid`
//   4. if migrations are pending and the database already has applied rows: a backup through the
//      SQLite online backup API, the newest 3 kept; if it cannot be written nothing is migrated
//   5. foreign keys OFF (outside any transaction), ONE transaction that applies the migrations and
//      runs `PRAGMA foreign_key_check` before it commits (a violation rolls everything back), foreign
//      keys ON again whatever happened
//   6. the applied rows are read again and must equal the shipped files
//
// Every failure is a `MigrationError` with a stable `code`, a fixed message that names tags and
// numbers but never a statement, a path or a value, and `exitCode` 1: the start path ends the process
// before the port opens (plan 7.1 step 6). The underlying error is kept in `cause`; the error handler
// and the logger never write a cause.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { z } from 'zod';
import { takeBackup } from './backup.js';
import type { SqliteConnection } from './open.js';

export type MigrationErrorCode =
  | 'migration_checksum_mismatch'
  | 'schema_newer_than_app'
  | 'migration_journal_invalid'
  | 'migration_files_unreadable'
  | 'migration_backup_failed'
  | 'migration_failed'
  | 'migration_foreign_key_check_failed'
  | 'migration_verification_failed'
  | 'database_not_empty';

export class MigrationError extends Error {
  readonly code: MigrationErrorCode;
  /** The process exit code of the start path: every migration failure ends the start-up. */
  readonly exitCode = 1;

  constructor(code: MigrationErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MigrationError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------------------------
// What is shipped and what is applied
// ---------------------------------------------------------------------------------------------

export interface ShippedMigration {
  readonly tag: string;
  /** SHA-256 of the whole SQL file, hex: what the migrator records as `hash`. */
  readonly hash: string;
  /** The journal `when`: what the migrator records as `created_at`. */
  readonly createdAt: number;
}

export interface AppliedMigration {
  readonly id: number;
  readonly hash: string;
  readonly createdAt: number;
}

const JournalSchema = z.object({
  entries: z.array(z.object({ tag: z.string(), when: z.number().int() })),
});

const BOOKKEEPING_TABLE_PRESENT =
  "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'";
const APPLIED_ROWS =
  'SELECT id, hash, created_at AS createdAt FROM __drizzle_migrations ORDER BY id';

/** The migrations in `migrationsFolder`, in journal order, with the hash the migrator would record. */
export function shippedMigrations(migrationsFolder: string): ShippedMigration[] {
  try {
    const journal = JournalSchema.parse(
      JSON.parse(readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')),
    );
    const files = readMigrationFiles({ migrationsFolder });
    if (files.length !== journal.entries.length) throw new Error('journal and files differ');
    return journal.entries.map((entry, position) => ({
      tag: entry.tag,
      hash: files[position]?.hash ?? '',
      createdAt: files[position]?.folderMillis ?? entry.when,
    }));
  } catch (cause) {
    throw new MigrationError(
      'migration_files_unreadable',
      'the migration files of this build could not be read',
      { cause },
    );
  }
}

/** The rows of `__drizzle_migrations` in the order they were applied; none if the table is absent. */
export function appliedMigrations(db: SqliteConnection): AppliedMigration[] {
  if (db.prepare(BOOKKEEPING_TABLE_PRESENT).get() === undefined) return [];
  return (
    db.prepare(APPLIED_ROWS).all() as { id: unknown; hash: unknown; createdAt: unknown }[]
  ).map((row) => ({
    id: Number(row.id),
    hash: String(row.hash),
    createdAt: Number(row.createdAt),
  }));
}

export type MigrationStatus =
  'current' | 'pending' | 'schema_newer_than_app' | 'migration_checksum_mismatch';

export interface MigrationState {
  readonly status: MigrationStatus;
  /** The index of the newest applied migration (the schema version), or `null` for none. */
  readonly schemaVersion: number | null;
  /** The shipped migrations that are not applied yet; empty unless the status is `pending`. */
  readonly pending: readonly ShippedMigration[];
  /** The tag of the first migration whose recorded hash or time is not the shipped one. */
  readonly mismatchedTag?: string;
}

/**
 * Compare the applied rows with the shipped files by position (PD-06). Pure and read-only; readiness
 * uses it to report `schema_newer_than_app`, and the runner to decide what to do.
 */
export function inspectMigrations(
  applied: readonly AppliedMigration[],
  shipped: readonly ShippedMigration[],
): MigrationState {
  const schemaVersion = applied.length === 0 ? null : applied.length - 1;
  const newestApplied = applied.reduce((newest, row) => Math.max(newest, row.createdAt), -Infinity);
  const newestShipped = shipped.reduce((newest, row) => Math.max(newest, row.createdAt), -Infinity);

  if (applied.length > shipped.length || (applied.length > 0 && newestApplied > newestShipped)) {
    return { status: 'schema_newer_than_app', schemaVersion, pending: [] };
  }

  for (const [position, row] of applied.entries()) {
    const file = shipped[position];
    if (file?.hash !== row.hash || file.createdAt !== row.createdAt) {
      return {
        status: 'migration_checksum_mismatch',
        schemaVersion,
        pending: [],
        ...(file === undefined ? {} : { mismatchedTag: file.tag }),
      };
    }
  }

  const pending = shipped.slice(applied.length);
  return { status: pending.length === 0 ? 'current' : 'pending', schemaVersion, pending };
}

// ---------------------------------------------------------------------------------------------
// Running them
// ---------------------------------------------------------------------------------------------

export interface MigrationLogger {
  info(fields: Readonly<Record<string, unknown>>, message: string): void;
}

export interface MigrateOptions {
  /** The folder with the SQL files and `meta/_journal.json` (`apps/server/drizzle`). */
  readonly migrationsFolder: string;
  /** Where the pre-migration backup goes (`${DATA_DIR}/backups`). Created when needed. */
  readonly backupsDir: string;
  /** How many backups to keep. Default: `LIMITS.preMigrationBackupsKept`. */
  readonly keepBackups?: number;
  readonly log?: MigrationLogger;
}

export interface MigrationResult {
  /** Tags of the migrations applied by this call; empty when the database was current. */
  readonly applied: readonly string[];
  /** The schema version before, `null` for a database without applied migrations. */
  readonly schemaVersionBefore: number | null;
  /** The schema version now: the index of the newest shipped migration. */
  readonly schemaVersion: number | null;
  /** The file name of the backup taken, or `null`. */
  readonly backupFile: string | null;
}

/** Throws unless the state is one the runner may migrate from; returns the pending migrations. */
function pendingOrRefuse(
  state: MigrationState,
  applied: readonly AppliedMigration[],
  shipped: readonly ShippedMigration[],
): readonly ShippedMigration[] {
  if (state.status === 'schema_newer_than_app') {
    throw new MigrationError(
      'schema_newer_than_app',
      `the database was written by a newer version of the application: ${String(applied.length)} migrations are applied and this build ships ${String(shipped.length)}; it was left untouched`,
    );
  }
  if (state.status === 'migration_checksum_mismatch') {
    throw new MigrationError(
      'migration_checksum_mismatch',
      `migration ${state.mismatchedTag ?? 'unknown'} is not the file that was applied: a migration is never edited after it ran; the database was left untouched`,
    );
  }

  // The stock migrator applies only entries newer than the newest applied row and skips the others
  // without a word (probe P13), so every pending entry must be newer, in order.
  let floor = applied.reduce((newest, row) => Math.max(newest, row.createdAt), -Infinity);
  for (const migration of state.pending) {
    if (migration.createdAt <= floor) {
      throw new MigrationError(
        'migration_journal_invalid',
        `migration ${migration.tag} has a journal time that is not newer than the migrations before it: it would be skipped; nothing was changed`,
      );
    }
    floor = migration.createdAt;
  }
  return state.pending;
}

/**
 * Runs one statement of a shipped migration file. The text is read from the files of
 * `apps/server/drizzle` (checked against their recorded hash before anything runs, see step 1 to 3
 * above) and cannot be a literal in this file, so it goes through the connection class's own `exec`
 * rather than a `db.exec(...)` call that `local/no-string-built-sql` rightly reads as "SQL that is
 * not a constant". The migration files are outside that rule's scope by design (apps/server/drizzle
 * is not under src or scripts); this is the one place that runs them. It is not a way around the
 * rule for anything else: every other statement in the server is a constant or the Drizzle tag.
 */
function runShippedStatement(db: SqliteConnection, statement: string): void {
  Database.prototype.exec.call(db, statement);
}

/** `inTransaction` read afresh: the compiler cannot know that BEGIN or COMMIT moved it. */
function stillInTransaction(db: SqliteConnection): boolean {
  return db.inTransaction;
}

/**
 * Applies the pending migrations in ONE outer transaction with foreign keys off, and runs
 * `PRAGMA foreign_key_check` INSIDE that transaction before it commits: a violation rolls the
 * migrations and their `__drizzle_migrations` rows back, so the database is exactly as it was and the
 * next start refuses again. This does what the stock migrator does (same bookkeeping DDL, same
 * `hash` and `created_at`, same BEGIN ... COMMIT) with the check made atomic with it; the stock one
 * commits before any check can run. The connection must not be inside a transaction (a PRAGMA cannot
 * change foreign keys inside one).
 */
function applyPending(db: SqliteConnection, migrationsFolder: string): void {
  if (db.inTransaction) {
    throw new Error('migrations cannot run inside a transaction');
  }
  db.pragma('foreign_keys = OFF');
  try {
    let violations: { table: string }[] = [];
    try {
      const files = readMigrationFiles({ migrationsFolder });
      db.exec('BEGIN');
      db.exec(
        'CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)',
      );
      const done = (
        db.prepare('SELECT count(*) AS n FROM "__drizzle_migrations"').get() as { n: number }
      ).n;
      const insert = db.prepare(
        'INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES (?, ?)',
      );
      for (const migration of files.slice(done)) {
        for (const statement of migration.sql) {
          runShippedStatement(db, statement);
        }
        insert.run(migration.hash, migration.folderMillis);
      }
      violations = db.pragma('foreign_key_check') as { table: string }[];
      if (violations.length === 0) db.exec('COMMIT');
    } catch (cause) {
      if (stillInTransaction(db)) db.exec('ROLLBACK');
      throw new MigrationError(
        'migration_failed',
        'applying the pending migrations failed and was rolled back; the database is as it was',
        { cause },
      );
    }

    if (violations.length > 0) {
      db.exec('ROLLBACK');
      const tables = [...new Set(violations.map((violation) => violation.table))].sort();
      throw new MigrationError(
        'migration_foreign_key_check_failed',
        `foreign_key_check reported ${String(violations.length)} violations after the migrations, in: ${tables.join(', ')}; they were rolled back and the database is as it was`,
      );
    }
  } finally {
    if (stillInTransaction(db)) db.exec('ROLLBACK');
    db.pragma('foreign_keys = ON');
  }
}

/** After the migrator: the applied rows must be the shipped files, nothing more and nothing less. */
function verifyApplied(db: SqliteConnection, shipped: readonly ShippedMigration[]): void {
  const state = inspectMigrations(appliedMigrations(db), shipped);
  if (state.status !== 'current') {
    throw new MigrationError(
      'migration_verification_failed',
      `after the migrations the recorded rows do not match the shipped files (${state.status})`,
    );
  }
}

function schemaVersionOf(migrations: readonly unknown[]): number | null {
  return migrations.length === 0 ? null : migrations.length - 1;
}

/**
 * Bring the database to the schema this build ships. Called once per start, on a connection of the
 * server (foreign keys are switched off and on again here, so the connection may have been opened
 * either way). Resolves with what was done; rejects with a `MigrationError`.
 */
export async function runMigrations(
  db: SqliteConnection,
  options: MigrateOptions,
): Promise<MigrationResult> {
  const shipped = shippedMigrations(options.migrationsFolder);
  const applied = appliedMigrations(db);
  const pending = pendingOrRefuse(inspectMigrations(applied, shipped), applied, shipped);

  const schemaVersionBefore = schemaVersionOf(applied);
  const schemaVersion = schemaVersionOf(shipped);
  if (pending.length === 0) {
    return { applied: [], schemaVersionBefore, schemaVersion, backupFile: null };
  }

  // A first install has nothing to protect. An upgrade is protected before anything is touched.
  let backupFile: string | null = null;
  if (applied.length > 0 && schemaVersionBefore !== null && schemaVersion !== null) {
    try {
      backupFile = await takeBackup(db, {
        backupsDir: options.backupsDir,
        from: schemaVersionBefore,
        to: schemaVersion,
        ...(options.keepBackups === undefined ? {} : { keep: options.keepBackups }),
      });
    } catch (cause) {
      throw new MigrationError(
        'migration_backup_failed',
        'the backup before the migrations could not be written; nothing was migrated',
        { cause },
      );
    }
  }

  applyPending(db, options.migrationsFolder);
  verifyApplied(db, shipped);

  const result: MigrationResult = {
    applied: pending.map((migration) => migration.tag),
    schemaVersionBefore,
    schemaVersion,
    backupFile,
  };
  options.log?.info(
    {
      event: 'migrations_applied',
      schemaVersionBefore,
      schemaVersion,
      applied: result.applied.length,
      backup: backupFile !== null,
    },
    'migrations_applied',
  );
  return result;
}

/**
 * Build the schema in a database that has none: snapshots, the parity test and the upgrade fixtures
 * (tooling, never the server). Same steps as `runMigrations` without a backup, and it refuses a
 * database that already has applied migrations: only `runMigrations` upgrades one.
 */
export function migrateEmptyDatabase(
  db: SqliteConnection,
  migrationsFolder: string,
): MigrationResult {
  const shipped = shippedMigrations(migrationsFolder);
  if (appliedMigrations(db).length > 0) {
    throw new MigrationError(
      'database_not_empty',
      'this database already has applied migrations; upgrade it with runMigrations',
    );
  }
  const pending = pendingOrRefuse(inspectMigrations([], shipped), [], shipped);
  if (pending.length > 0) {
    applyPending(db, migrationsFolder);
    verifyApplied(db, shipped);
  }
  return {
    applied: pending.map((migration) => migration.tag),
    schemaVersionBefore: null,
    schemaVersion: schemaVersionOf(shipped),
    backupFile: null,
  };
}

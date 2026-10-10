// Opening the database (FR-A-060, data-model section 5): one function, so that every connection the
// server makes has the same settings and no code can forget one.
//
//   journal_mode  WAL     readers do not block the writer; checkpointed at shutdown
//   synchronous   FULL    an audit log should survive power loss; the write rate is tiny
//   foreign_keys  ON      except OFF while the migration wrapper runs (PD-06, probe P12)
//   busy_timeout  5000    short waits instead of an immediate SQLITE_BUSY
//   temp_store    MEMORY  no spill files outside /data
//
// The busy timeout is set by the constructor option of better-sqlite3 (`sqlite3_busy_timeout`, which
// is what `PRAGMA busy_timeout` calls), so it is the busy handler from the very first statement:
// `journal_mode = WAL` itself needs a lock, and many connections that open a new file at once would
// otherwise fail before a PRAGMA further down could set it. It cannot be a PRAGMA here anyway: a
// PRAGMA takes no bound parameter, and SQL text is never built from a value (FR-A-060).
//
// A connection to a missing directory is a storage failure like any other (the storage probe creates
// the data directory; this function never does), and one that fails while it is being set up is
// closed again, so that a corrupt file does not leave a handle behind.
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

/** The name of the database file inside `DATA_DIR` (data-model section 2). */
export const DATABASE_FILE_NAME = 'm365portal.sqlite';

/** `busy_timeout` of every connection (data-model section 5), in milliseconds. */
export const BUSY_TIMEOUT_MS = 5000;

/** The raw better-sqlite3 connection. */
export type SqliteConnection = Database.Database;

/** Drizzle over the connection above, with the Phase A schema. */
export type OrmDatabase = BetterSQLite3Database<typeof schema> & { $client: SqliteConnection };

/**
 * What a query needs: the raw connection for prepared statements and the ORM for typed queries. Both
 * use the same connection, so inside a transaction they are inside the same transaction.
 */
export interface DatabaseHandle {
  readonly sqlite: SqliteConnection;
  readonly orm: OrmDatabase;
}

/** An open connection that its owner closes. */
export interface AppDatabase extends DatabaseHandle {
  readonly path: string;
  close(): void;
}

export interface OpenDatabaseOptions {
  /** Absolute path of the database file. The directory must exist. */
  readonly path: string;
  /**
   * Foreign keys on this connection. The default is on; only the migration wrapper passes `false`,
   * because a table-rebuild migration cascade-deletes child rows under `foreign_keys = ON`
   * (probe P12), and turns them on again afterwards.
   */
  readonly foreignKeys?: boolean;
  /** Open for reading only, and only if the file exists (`verify-audit`). */
  readonly readonly?: boolean;
  /** Overrides `BUSY_TIMEOUT_MS`. For tests that contend for the write lock. */
  readonly busyTimeoutMs?: number;
}

/** `${dataDir}/m365portal.sqlite`. */
export function databasePathOf(dataDir: string): string {
  return join(dataDir, DATABASE_FILE_NAME);
}

/** Thrown when the directory of the database file does not exist; classified as `SQLITE_CANTOPEN`. */
class DatabaseDirectoryMissingError extends Error {
  readonly code = 'SQLITE_CANTOPEN';

  constructor(options: { cause: unknown }) {
    super('the directory of the database file does not exist', options);
    this.name = 'DatabaseDirectoryMissingError';
  }
}

function connect(options: OpenDatabaseOptions, busyTimeoutMs: number): SqliteConnection {
  try {
    return new Database(options.path, {
      readonly: options.readonly === true,
      fileMustExist: options.readonly === true,
      timeout: busyTimeoutMs,
    });
  } catch (error) {
    // better-sqlite3 checks the directory itself and throws a TypeError without an SQLite code. For
    // everything downstream that is the same thing as SQLite failing to open the file.
    const code = (error as { code?: unknown }).code;
    if (error instanceof TypeError && code === undefined) {
      throw new DatabaseDirectoryMissingError({ cause: error });
    }
    throw error;
  }
}

/** The PRAGMAs of data-model section 5, in that order (`busy_timeout` is the constructor option). */
function applyPragmas(sqlite: SqliteConnection, options: OpenDatabaseOptions): void {
  // The journal mode is stored in the file, so a read-only connection must not (and cannot) set it.
  if (options.readonly !== true) sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = FULL');
  sqlite.pragma(options.foreignKeys === false ? 'foreign_keys = OFF' : 'foreign_keys = ON');
  sqlite.pragma('temp_store = MEMORY');
}

export function openDatabase(options: OpenDatabaseOptions): AppDatabase {
  const busyTimeoutMs = options.busyTimeoutMs ?? BUSY_TIMEOUT_MS;
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new RangeError('busyTimeoutMs must be a whole number of milliseconds, zero or more');
  }

  const sqlite = connect(options, busyTimeoutMs);
  try {
    applyPragmas(sqlite, options);
  } catch (error) {
    sqlite.close();
    throw error;
  }

  const orm = drizzle(sqlite, { schema });
  return {
    sqlite,
    orm,
    path: options.path,
    close: () => {
      sqlite.close();
    },
  };
}

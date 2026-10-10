// T-A-035: FR-A-060, FR-A-065 and FR-A-066 (data-model sections 4 and 5).
//
// What is proven here:
//   - every connection gets the PRAGMAs of data-model section 5, and only the migration wrapper may
//     ask for foreign keys off
//   - `schema.ts` declares exactly the three tables of Phase A as data-model section 4 writes them
//     (columns, nullability, defaults, `ON DELETE RESTRICT`, the names of the CHECKs and indexes)
//   - `withTransaction` is `BEGIN IMMEDIATE`, commits what the callback did and rolls everything back
//     when it throws
//   - the failures a real database produces (read-only, full, I/O error, busy, not a database)
//     arrive at the error handler as the 503 problems of FR-A-065
//
// The CHECK constraints themselves and the migrations are proven by `migrations.test.ts` (T-A-036);
// this file is about the handle every later task opens the database through.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { is } from 'drizzle-orm';
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { Hono } from 'hono';
import { describe, expect, it, onTestFinished } from 'vitest';
import { loadConfigOrThrow } from '../src/config/index.js';
import {
  auditLog,
  brandingAsset,
  branding,
  classifyStorageError,
  DATABASE_FILE_NAME,
  assertInTransaction,
  openDatabase,
  withTransaction,
  type AppDatabase,
  type OpenDatabaseOptions,
  type Tx,
} from '../src/db/index.js';
import * as schemaModule from '../src/db/schema.js';
import { createErrorHandler } from '../src/http/error-handler.js';
import { requestContext, type AppEnv } from '../src/http/request-context.js';
import { createTempDataDir } from './helpers/temp-data-dir.js';

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

async function databaseFile(): Promise<string> {
  const dir = await createTempDataDir();
  return join(dir.path, DATABASE_FILE_NAME);
}

/** Open a connection that is closed when the test ends. */
function open(options: OpenDatabaseOptions): AppDatabase {
  const database = openDatabase(options);
  onTestFinished(() => {
    if (database.sqlite.open) database.close();
  });
  return database;
}

function pragma(database: AppDatabase, name: string): unknown {
  return database.sqlite.pragma(name, { simple: true });
}

function errorOf(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('expected the action to throw');
}

// ---------------------------------------------------------------------------------------------
// PRAGMAs on every connection (data-model section 5)
// ---------------------------------------------------------------------------------------------

describe('connection PRAGMAs (FR-A-060)', () => {
  it('applies WAL, synchronous FULL, foreign keys ON, busy timeout 5000 and temp store MEMORY on every connection', async () => {
    const path = await databaseFile();

    // Three connections to the same file: the settings are per connection, so each one is checked.
    for (let n = 0; n < 3; n += 1) {
      const database = open({ path });
      expect(pragma(database, 'journal_mode')).toBe('wal');
      expect(pragma(database, 'synchronous')).toBe(2); // FULL
      expect(pragma(database, 'foreign_keys')).toBe(1);
      expect(pragma(database, 'busy_timeout')).toBe(5000);
      expect(pragma(database, 'temp_store')).toBe(2); // MEMORY
    }
  });

  it('opens with foreign keys off only when the migration wrapper asks for it', async () => {
    const path = await databaseFile();

    const migrating = open({ path, foreignKeys: false });
    expect(pragma(migrating, 'foreign_keys')).toBe(0);
    // Everything else stays as it is for every other connection.
    expect(pragma(migrating, 'journal_mode')).toBe('wal');
    expect(pragma(migrating, 'synchronous')).toBe(2);
    expect(pragma(migrating, 'busy_timeout')).toBe(5000);
    expect(pragma(migrating, 'temp_store')).toBe(2);

    expect(pragma(open({ path }), 'foreign_keys')).toBe(1);
  });

  it('takes the busy timeout from the options so a test can contend without waiting five seconds', async () => {
    const database = open({ path: await databaseFile(), busyTimeoutMs: 25 });
    expect(pragma(database, 'busy_timeout')).toBe(25);
  });

  it('opens a read-only connection that has the same settings and cannot write (verify-audit)', async () => {
    const path = await databaseFile();
    const writer = open({ path });
    writer.sqlite.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY)');

    const reader = open({ path, readonly: true });
    expect(reader.sqlite.readonly).toBe(true);
    expect(pragma(reader, 'foreign_keys')).toBe(1);
    expect(pragma(reader, 'busy_timeout')).toBe(5000);
    expect(pragma(reader, 'synchronous')).toBe(2);
    expect(pragma(reader, 'temp_store')).toBe(2);
    expect(reader.sqlite.prepare('SELECT count(*) AS n FROM probe').get()).toEqual({ n: 0 });
    const failure = classifyStorageError(
      errorOf(() => reader.sqlite.prepare('INSERT INTO probe DEFAULT VALUES').run()),
    );
    expect(failure).toEqual({ kind: 'unavailable', code: 'SQLITE_READONLY' });
  });

  it('refuses a read-only open of a database that does not exist instead of creating it', async () => {
    const path = await databaseFile();
    const failure = classifyStorageError(errorOf(() => openDatabase({ path, readonly: true })));
    expect(failure?.kind).toBe('unavailable');
  });

  it('has the JSON functions the audit_log CHECK needs (data-model 4.3)', async () => {
    const database = open({ path: await databaseFile() });
    expect(database.sqlite.prepare("SELECT json_valid('{}') AS valid").get()).toEqual({ valid: 1 });
    expect(database.sqlite.prepare("SELECT json_valid('{') AS valid").get()).toEqual({ valid: 0 });
  });

  it('does not create the data directory: that is the storage probe', async () => {
    const dir = await createTempDataDir();
    const path = join(dir.path, 'missing', DATABASE_FILE_NAME);
    const failure = classifyStorageError(errorOf(() => openDatabase({ path })));
    expect(failure).toEqual({ kind: 'unavailable', code: 'SQLITE_CANTOPEN' });
  });

  it('reports a path that is a directory as a storage failure', async () => {
    const dir = await createTempDataDir();
    const path = join(dir.path, DATABASE_FILE_NAME);
    await mkdir(path);
    const failure = classifyStorageError(errorOf(() => openDatabase({ path })));
    expect(failure).toEqual({ kind: 'unavailable', code: 'SQLITE_CANTOPEN' });
  });

  it('reports a file that is not a database as corruption and does not keep it open', async () => {
    const dir = await createTempDataDir();
    const path = join(dir.path, DATABASE_FILE_NAME);
    await writeFile(path, 'this is not a database, however long it is. '.repeat(40));
    const failure = classifyStorageError(errorOf(() => openDatabase({ path })));
    expect(failure).toEqual({ kind: 'corrupt', code: 'SQLITE_NOTADB' });
  });
});

// ---------------------------------------------------------------------------------------------
// schema.ts is data-model section 4
// ---------------------------------------------------------------------------------------------

/** The members of a Drizzle column this test reads (`getTableConfig` types its columns with `any`). */
interface ColumnShape {
  readonly name: string;
  readonly primary: boolean;
  readonly notNull: boolean;
  readonly default: unknown;
  getSQLType(): string;
}

/** `name type pk|not null|null [default x] [-> table.column on delete rule]` for one column. */
function describeColumn(table: SQLiteTable, column: ColumnShape): string {
  const parts: string[] = [column.name, column.getSQLType()];
  parts.push(column.primary ? 'pk' : column.notNull ? 'not null' : 'null');
  if (column.default !== undefined) parts.push(`default ${JSON.stringify(column.default)}`);
  for (const foreignKey of getTableConfig(table).foreignKeys) {
    const reference = foreignKey.reference();
    const [from] = reference.columns;
    const [to] = reference.foreignColumns;
    if (from?.name !== column.name || to === undefined) continue;
    const target = getTableConfig(reference.foreignTable).name;
    parts.push(`-> ${target}.${to.name} on delete ${foreignKey.onDelete ?? 'none'}`);
  }
  return parts.join(' ');
}

const RESTRICT_TO_ASSET = '-> branding_asset.sha256 on delete restrict';

const EXPECTED_TABLES = {
  branding: {
    columns: [
      'id integer pk',
      'revision integer not null',
      'org_name text not null',
      'accent text not null',
      `logo_light text null ${RESTRICT_TO_ASSET}`,
      `logo_dark text null ${RESTRICT_TO_ASSET}`,
      `logo_compact text null ${RESTRICT_TO_ASSET}`,
      'logo_compact_derived integer not null default 0',
      `icon_favicon32 text not null ${RESTRICT_TO_ASSET}`,
      `icon_apple180 text not null ${RESTRICT_TO_ASSET}`,
      `icon_pwa192 text not null ${RESTRICT_TO_ASSET}`,
      `icon_pwa512 text not null ${RESTRICT_TO_ASSET}`,
      `icon_maskable512 text not null ${RESTRICT_TO_ASSET}`,
      'updated_at text not null',
      'updated_by_kind text not null',
      'updated_by_id text not null',
    ],
    checks: [
      'branding_accent_shape',
      'branding_logo_compact_derived_flag',
      'branding_logo_compact_derived_needs_logo',
      'branding_org_name_bytes',
      'branding_revision_positive',
      'branding_single_row',
      'branding_updated_at_shape',
    ],
    indexes: [],
  },
  branding_asset: {
    columns: [
      'sha256 text pk',
      'bytes integer not null',
      'width integer not null',
      'height integer not null',
      'luminance real null',
      'created_at text not null',
      'unreferenced_at text null',
    ],
    checks: [
      'branding_asset_bytes_range',
      'branding_asset_created_at_shape',
      'branding_asset_height_range',
      'branding_asset_luminance_range',
      'branding_asset_sha256_shape',
      'branding_asset_unreferenced_at_shape',
      'branding_asset_width_range',
    ],
    indexes: ['branding_asset_unreferenced_idx'],
  },
  audit_log: {
    columns: [
      'seq integer pk',
      'ts text not null',
      'actor_kind text not null',
      'actor_id text not null',
      'action text not null',
      'target_type text null',
      'target_id text null',
      'outcome text not null',
      'reason_code text null',
      'client_ip text null',
      'request_id text null',
      'detail text not null default "{}"',
      'prev_hash blob not null',
      'hash blob not null',
    ],
    checks: [
      'audit_log_detail_json',
      'audit_log_hash_sizes',
      'audit_log_outcome_set',
      'audit_log_ts_shape',
    ],
    indexes: ['audit_log_hash_uq'],
  },
} as const;

describe('schema.ts declares exactly the tables of data-model section 4 (FR-A-066)', () => {
  const tables: SQLiteTable[] = [];
  for (const value of Object.values(schemaModule)) {
    if (is(value, SQLiteTable)) tables.push(value);
  }

  it('declares branding, branding_asset and audit_log and nothing else', () => {
    expect(tables.map((table) => getTableConfig(table).name).sort()).toEqual([
      'audit_log',
      'branding',
      'branding_asset',
    ]);
    // The migration bookkeeping belongs to the Drizzle migrator, not to the schema (data-model 1).
    expect(tables.map((table) => getTableConfig(table).name)).not.toContain('__drizzle_migrations');
  });

  it('exports the three tables under the names the services use', () => {
    expect(getTableConfig(branding).name).toBe('branding');
    expect(getTableConfig(brandingAsset).name).toBe('branding_asset');
    expect(getTableConfig(auditLog).name).toBe('audit_log');
  });

  it.each(Object.entries(EXPECTED_TABLES))(
    '%s: columns, nullability, defaults and foreign keys',
    (name, expected) => {
      const table = tables.find((candidate) => getTableConfig(candidate).name === name);
      if (table === undefined) throw new Error(`${name} is not declared`);
      const config = getTableConfig(table);
      expect(config.columns.map((column) => describeColumn(table, column))).toEqual([
        ...expected.columns,
      ]);
    },
  );

  it.each(Object.entries(EXPECTED_TABLES))('%s: the named CHECKs and indexes', (name, expected) => {
    const table = tables.find((candidate) => getTableConfig(candidate).name === name);
    if (table === undefined) throw new Error(`${name} is not declared`);
    const config = getTableConfig(table);
    expect(config.checks.map((check) => check.name).sort()).toEqual([...expected.checks]);
    expect(config.indexes.map((index) => index.config.name).sort()).toEqual([...expected.indexes]);
  });

  it('keeps the audit hash index unique and the unreferenced index partial', () => {
    const [hashIndex] = getTableConfig(auditLog).indexes;
    expect(hashIndex?.config.unique).toBe(true);
    const [unreferenced] = getTableConfig(brandingAsset).indexes;
    expect(unreferenced?.config.unique).toBe(false);
    // Data-model 4.2: the partial form is preferred when the helper supports it, and it does.
    expect(unreferenced?.config.where).toBeDefined();
  });

  it('gives branding no ON DELETE action other than RESTRICT (PR-14)', () => {
    const actions = getTableConfig(branding).foreignKeys.map((foreignKey) => foreignKey.onDelete);
    expect(actions).toHaveLength(8);
    expect(new Set(actions)).toEqual(new Set(['restrict']));
  });

  it('gives audit_log no foreign key: an entry must survive whatever it refers to', () => {
    expect(getTableConfig(auditLog).foreignKeys).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// withTransaction
// ---------------------------------------------------------------------------------------------

describe('withTransaction (BEGIN IMMEDIATE)', () => {
  async function pair(): Promise<{ first: AppDatabase; second: AppDatabase }> {
    const path = await databaseFile();
    const first = open({ path });
    first.sqlite.exec('CREATE TABLE note (id INTEGER PRIMARY KEY, text TEXT NOT NULL)');
    // The second connection gives up after 20 ms: contention is the thing under test.
    const second = open({ path, busyTimeoutMs: 20 });
    return { first, second };
  }

  function count(database: AppDatabase): number {
    const row = database.sqlite.prepare('SELECT count(*) AS n FROM note').get() as { n: number };
    return row.n;
  }

  it('takes the write lock before the callback writes anything', async () => {
    const { first, second } = await pair();

    withTransaction(first, () => {
      // Nothing was written yet. A deferred transaction would not hold the lock, so this write
      // would succeed; only BEGIN IMMEDIATE makes the other writer wait and fail.
      expect(first.sqlite.inTransaction).toBe(true);
      const failure = classifyStorageError(
        errorOf(() =>
          second.sqlite
            .prepare("INSERT INTO note (text) VALUES ('from the other connection')")
            .run(),
        ),
      );
      expect(failure).toEqual({ kind: 'busy', code: 'SQLITE_BUSY' });
    });

    expect(first.sqlite.inTransaction).toBe(false);
    expect(count(first)).toBe(0);
  });

  it('commits what the callback did and returns its value', async () => {
    const { first, second } = await pair();

    const id = withTransaction(first, (tx) => {
      const result = tx.sqlite.prepare("INSERT INTO note (text) VALUES ('kept')").run();
      return Number(result.lastInsertRowid);
    });

    expect(id).toBe(1);
    expect(count(second)).toBe(1);
  });

  it('rolls everything back when the callback throws, and throws the same error', async () => {
    const { first, second } = await pair();
    const failure = new Error('stop here');

    const thrown = errorOf(() =>
      withTransaction(first, (tx) => {
        tx.sqlite.prepare("INSERT INTO note (text) VALUES ('one')").run();
        tx.sqlite.prepare("INSERT INTO note (text) VALUES ('two')").run();
        throw failure;
      }),
    );

    expect(thrown).toBe(failure);
    expect(first.sqlite.inTransaction).toBe(false);
    expect(count(first)).toBe(0);
    expect(count(second)).toBe(0);
    // The lock is gone with the rollback: the other connection can write at once.
    second.sqlite.prepare("INSERT INTO note (text) VALUES ('free')").run();
    expect(count(second)).toBe(1);
  });

  it('rolls back on a constraint violation as well (the ORM and the raw connection share the transaction)', async () => {
    const { first } = await pair();

    const thrown = errorOf(() => {
      withTransaction(first, (tx) => {
        tx.sqlite.prepare("INSERT INTO note (text) VALUES ('before')").run();
        tx.sqlite.prepare('INSERT INTO note (text) VALUES (NULL)').run();
      });
    });

    expect(thrown).toBeInstanceOf(Error);
    expect(count(first)).toBe(0);
  });

  it('nests as a savepoint: an inner failure that is caught keeps the outer work', async () => {
    const { first } = await pair();

    withTransaction(first, (outer) => {
      outer.sqlite.prepare("INSERT INTO note (text) VALUES ('outer')").run();
      const inner = errorOf(() =>
        withTransaction(outer, (tx) => {
          tx.sqlite.prepare("INSERT INTO note (text) VALUES ('inner')").run();
          throw new Error('inner failed');
        }),
      );
      expect(inner).toBeInstanceOf(Error);
    });

    expect(first.sqlite.prepare('SELECT text FROM note').all()).toEqual([{ text: 'outer' }]);
  });

  it('refuses a callback that returns a promise and rolls back: a transaction is synchronous', async () => {
    const { first } = await pair();

    const thrown = errorOf(() =>
      withTransaction(first, (tx) => {
        tx.sqlite.prepare("INSERT INTO note (text) VALUES ('lost')").run();
        return Promise.resolve(1);
      }),
    );

    expect(thrown).toBeInstanceOf(TypeError);
    expect(first.sqlite.inTransaction).toBe(false);
    expect(count(first)).toBe(0);
  });

  it('hands the callback a transaction handle that is only valid inside it', async () => {
    const { first } = await pair();
    const handles: Tx[] = [];

    withTransaction(first, (tx) => {
      assertInTransaction(tx);
      handles.push(tx);
    });

    const [kept] = handles;
    expect(kept).toBeDefined();
    expect(() => {
      assertInTransaction(kept!);
    }).toThrow(/withTransaction/);
    // A handle that merely looks like one is not one.
    expect(() => {
      assertInTransaction({ sqlite: first.sqlite, orm: first.orm } as unknown as Tx);
    }).toThrow(/withTransaction/);
  });

  describe('afterCommit', () => {
    it('runs the callbacks after the outermost commit, in order, with the data already visible', async () => {
      const { first, second } = await pair();
      const seen: string[] = [];

      withTransaction(first, (tx) => {
        tx.sqlite.prepare("INSERT INTO note (text) VALUES ('kept')").run();
        tx.afterCommit(() => {
          seen.push(`first: ${String(count(second))} row(s) visible to another connection`);
        });
        tx.afterCommit(() => {
          seen.push('second');
        });
        // Nothing has run while the transaction is still open.
        expect(seen).toEqual([]);
      });

      expect(seen).toEqual(['first: 1 row(s) visible to another connection', 'second']);
    });

    it('discards them when the transaction rolls back', async () => {
      const { first } = await pair();
      const seen: string[] = [];

      errorOf(() =>
        withTransaction(first, (tx) => {
          tx.afterCommit(() => {
            seen.push('must not run');
          });
          throw new Error('rolled back');
        }),
      );

      expect(seen).toEqual([]);
    });

    it('releases the callbacks of a savepoint to the transaction around it, and drops them with it', async () => {
      const { first } = await pair();
      const seen: string[] = [];

      withTransaction(first, (outer) => {
        outer.afterCommit(() => seen.push('outer'));
        withTransaction(outer, (inner) => {
          inner.afterCommit(() => seen.push('inner'));
        });
        expect(seen).toEqual([]);
      });
      expect(seen).toEqual(['outer', 'inner']);

      seen.length = 0;
      withTransaction(first, (outer) => {
        errorOf(() =>
          withTransaction(outer, (inner) => {
            inner.afterCommit(() => seen.push('failed savepoint'));
            throw new Error('inner failed');
          }),
        );
        outer.afterCommit(() => seen.push('outer survives'));
      });
      expect(seen).toEqual(['outer survives']);

      // A savepoint two levels down is dropped with the one in the middle, not run early.
      seen.length = 0;
      withTransaction(first, (outer) => {
        errorOf(() =>
          withTransaction(outer, (middle) => {
            withTransaction(middle, (inner) => {
              inner.afterCommit(() => seen.push('inner of a failed middle'));
            });
            throw new Error('middle failed after inner succeeded');
          }),
        );
      });
      expect(seen).toEqual([]);
    });

    it('ignores a callback that throws: the change is committed and the others still run', async () => {
      const { first } = await pair();
      const seen: string[] = [];

      withTransaction(first, (tx) => {
        tx.sqlite.prepare("INSERT INTO note (text) VALUES ('kept')").run();
        tx.afterCommit(() => {
          throw new Error('the log pipe is broken');
        });
        tx.afterCommit(() => seen.push('still runs'));
      });

      expect(count(first)).toBe(1);
      expect(seen).toEqual(['still runs']);
    });
  });

  it('refuses to start inside a transaction that withTransaction did not begin', async () => {
    const { first } = await pair();
    first.sqlite.exec('BEGIN');
    const thrown = errorOf(() => withTransaction(first, () => 1));
    first.sqlite.exec('ROLLBACK');
    expect((thrown as Error).message).toMatch(/did not start/);
  });

  it('lets the ORM run inside the same transaction', async () => {
    const path = await databaseFile();
    const database = open({ path });
    database.sqlite.exec('CREATE TABLE note (id INTEGER PRIMARY KEY, text TEXT NOT NULL)');

    const inside = withTransaction(database, (tx) => {
      tx.sqlite.prepare("INSERT INTO note (text) VALUES ('via sqlite')").run();
      return tx.orm.$client.inTransaction;
    });

    expect(inside).toBe(true);
    expect(count(database)).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// SQLite failures map to problems (FR-A-065)
// ---------------------------------------------------------------------------------------------

describe('storage failures map through db/errors.ts (FR-A-065)', () => {
  function app(routes: (app: Hono<AppEnv>) => void): { app: Hono<AppEnv>; failures: string[] } {
    const failures: string[] = [];
    const config = loadConfigOrThrow({});
    const hono = new Hono<AppEnv>();
    hono.use(requestContext({ config }));
    hono.onError(
      createErrorHandler({
        log: { error: () => undefined, warn: () => undefined },
        onStorageFailure: (failure) => failures.push(failure.kind),
      }),
    );
    routes(hono);
    return { app: hono, failures };
  }

  async function problemOf(
    handler: Hono<AppEnv>,
    path: string,
  ): Promise<{ status: number; code: unknown; retryAfter: string | null }> {
    const response = await handler.request(path);
    const body = (await response.json()) as { code?: unknown };
    return {
      status: response.status,
      code: body.code,
      retryAfter: response.headers.get('Retry-After'),
    };
  }

  it('answers a write to a read-only database with 503 storage_unavailable', async () => {
    const path = await databaseFile();
    open({ path }).sqlite.exec('CREATE TABLE note (id INTEGER PRIMARY KEY)');
    const reader = open({ path, readonly: true });
    const { app: hono } = app((routes) => {
      routes.get('/write', () => {
        withTransaction(reader, (tx) => {
          tx.sqlite.prepare('INSERT INTO note DEFAULT VALUES').run();
        });
        return new Response('written');
      });
    });

    expect(await problemOf(hono, '/write')).toMatchObject({
      status: 503,
      code: 'storage_unavailable',
    });
  });

  it('answers a full disk with 503 storage_unavailable', async () => {
    const database = open({ path: await databaseFile() });
    database.sqlite.exec('CREATE TABLE note (id INTEGER PRIMARY KEY, body BLOB)');
    const pages = database.sqlite.pragma('page_count', { simple: true }) as number;
    database.sqlite.pragma(`max_page_count = ${String(pages + 2)}`);
    const { app: hono } = app((routes) => {
      routes.get('/fill', () => {
        withTransaction(database, (tx) => {
          tx.sqlite.prepare('INSERT INTO note (body) VALUES (zeroblob(1000000))').run();
        });
        return new Response('filled');
      });
    });

    expect(await problemOf(hono, '/fill')).toMatchObject({
      status: 503,
      code: 'storage_unavailable',
    });
    // The failed transaction left nothing behind.
    expect(database.sqlite.prepare('SELECT count(*) AS n FROM note').get()).toEqual({ n: 0 });
  });

  it('answers an I/O error injected into a statement with 503 storage_unavailable', async () => {
    const database = open({ path: await databaseFile() });
    database.sqlite.function('inject_io_error', () => {
      throw Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR_WRITE' });
    });
    const { app: hono } = app((routes) => {
      routes.get('/io', () => {
        withTransaction(database, (tx) => {
          tx.sqlite.prepare('SELECT inject_io_error()').get();
        });
        return new Response('fine');
      });
    });

    expect(await problemOf(hono, '/io')).toMatchObject({
      status: 503,
      code: 'storage_unavailable',
    });
    expect(database.sqlite.inTransaction).toBe(false);
  });

  it('answers contention for the write lock with 503 storage_busy and Retry-After: 1', async () => {
    const path = await databaseFile();
    const holder = open({ path });
    const waiting = open({ path, busyTimeoutMs: 20 });
    const { app: hono, failures } = app((routes) => {
      routes.get('/busy', () => {
        withTransaction(waiting, () => undefined);
        return new Response('not reached');
      });
    });

    // Another writer holds the lock while the request is handled (taken by hand: the holder's
    // transaction must stay open across the await, which `withTransaction` refuses by design).
    holder.sqlite.prepare('BEGIN IMMEDIATE').run();
    let response: Response;
    try {
      response = await hono.request('/busy');
    } finally {
      holder.sqlite.prepare('ROLLBACK').run();
    }
    const body = (await response.json()) as { code?: unknown };
    expect(response.status).toBe(503);
    expect(body.code).toBe('storage_busy');
    expect(response.headers.get('Retry-After')).toBe('1');
    expect(failures).toEqual(['busy']);
  });

  it('classifies two connections that contend for the write lock as busy', async () => {
    const path = await databaseFile();
    const holder = open({ path });
    const waiting = open({ path, busyTimeoutMs: 20 });

    const failure = withTransaction(holder, () =>
      classifyStorageError(
        errorOf(() => {
          withTransaction(waiting, () => undefined);
        }),
      ),
    );

    expect(failure).toEqual({ kind: 'busy', code: 'SQLITE_BUSY' });
    // After the holder is done the other connection gets the lock.
    expect(withTransaction(waiting, () => 'got the lock')).toBe('got the lock');
  });

  it('tells readiness about a corrupt file through the same handler', async () => {
    const dir = await createTempDataDir();
    const path = join(dir.path, DATABASE_FILE_NAME);
    await writeFile(path, 'definitely not a database. '.repeat(60));
    const { app: hono, failures } = app((routes) => {
      routes.get('/open', () => {
        openDatabase({ path });
        return new Response('opened');
      });
    });

    expect(await problemOf(hono, '/open')).toMatchObject({
      status: 503,
      code: 'storage_unavailable',
    });
    expect(failures).toEqual(['corrupt']);
  });

  it('leaves an error that is not a storage failure to the generic 500', async () => {
    const database = open({ path: await databaseFile() });
    const { app: hono } = app((routes) => {
      routes.get('/bug', () => {
        database.sqlite.prepare('SELECT * FROM table_that_does_not_exist').get();
        return new Response('unreachable');
      });
    });

    expect(await problemOf(hono, '/bug')).toMatchObject({ status: 500, code: 'internal_error' });
  });
});

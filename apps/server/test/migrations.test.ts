// T-A-036 (part 1): FR-A-061 files, FR-A-062, FR-A-066 and PD-05, about the migration and the
// snapshot that ships with it.
//
// What is proven here:
//   - the journal is well formed (`when` strictly increases, tags are `NNNN_slug` in sequence),
//     because the stock migrator skips a migration whose `when` is older than the newest applied one
//     without saying so (probe P13)
//   - `schema-snapshots/migrations.json` lists tag, SHA-256 and schema version of every shipped
//     migration and equals the files, and the snapshot of every version regenerates byte for byte
//     from the migrated database
//   - `drizzle-kit generate` into a clean copy of `drizzle/` produces nothing: the TypeScript schema
//     and the migrations agree (the drift check)
//   - every CHECK of data-model section 4 rejects a violating insert, by name, and the three audit
//     triggers abort an UPDATE, a DELETE and a chain-link violation
//
// Part 2 (T-A-037, at the end of this file) is about the runner that applies the migrations: the
// checksum re-verification, the newer-schema refusal, the pre-migration backup, the foreign-key
// handling and the single transaction. Its fixtures are migration folders written by the test.
//
// Negative fixtures (tasks.md section 0.3): every check of `scripts/check-schema.ts` is run on a copy
// of the real files that has been broken in exactly one way, and must fail with a message that ends
// in the command to run.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { expectGuardFails } from '@m365portal/shared/testing';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import {
  assertSchemaCurrent,
  checkDrift,
  checkSchema,
  checkReleasedEntries,
  GENERATE_COMMAND,
  SNAPSHOT_COMMAND,
} from '../scripts/check-schema.js';
import {
  buildManifest,
  buildSnapshots,
  defaultPaths,
  journalProblems,
  migrateScratchDatabase,
  PACKAGE_DIR,
  readJournal,
  renderManifest,
  snapshotFileName,
  type SchemaPaths,
} from '../scripts/schema-snapshot.js';
import { listBackups } from '../src/db/backup.js';
import {
  appliedMigrations,
  inspectMigrations,
  migrateEmptyDatabase,
  MigrationError,
  runMigrations,
  shippedMigrations,
  type AppliedMigration,
  type ShippedMigration,
} from '../src/db/migrate.js';
import { DATABASE_FILE_NAME, openDatabase, type SqliteConnection } from '../src/db/open.js';
import { createTempDataDir } from './helpers/temp-data-dir.js';
import { unwritableDataDir } from './helpers/unwritable-data-dir.js';

const PATHS = defaultPaths();
const MANIGEST_NAME = 'migrations.json';

// ---------------------------------------------------------------------------------------------
// The shipped files
// ---------------------------------------------------------------------------------------------

describe('the journal (FR-A-061, probe P13)', () => {
  const journal = readJournal(PATHS.migrationsFolder);

  it('has at least the first migration', () => {
    expect(journal.entries.length).toBeGreaterThanOrEqual(1);
    expect(journal.entries[0]?.tag).toMatch(/^0000_[a-z0-9_]+$/);
  });

  it('numbers the entries from 0 without a gap and names them NNNN_slug in the same order', () => {
    journal.entries.forEach((entry, position) => {
      expect(entry.idx).toBe(position);
      expect(entry.tag).toMatch(/^\d{4}_[a-z0-9_]+$/);
      expect(Number(entry.tag.slice(0, 4))).toBe(position);
    });
  });

  it('has strictly increasing `when` values: an older one would be skipped silently', () => {
    journal.entries.forEach((entry, position) => {
      expect(Number.isSafeInteger(entry.when)).toBe(true);
      const previous = journal.entries[position - 1];
      if (previous !== undefined) expect(entry.when).toBeGreaterThan(previous.when);
    });
  });

  it('has a SQL file and a drizzle-kit snapshot for every entry and no SQL file that is not journaled', () => {
    const sqlFiles = readdirSync(PATHS.migrationsFolder)
      .filter((name) => name.endsWith('.sql'))
      .sort();
    expect(sqlFiles).toEqual(journal.entries.map((entry) => `${entry.tag}.sql`));
    const metaFiles = readdirSync(join(PATHS.migrationsFolder, 'meta')).sort();
    expect(metaFiles).toEqual(
      [
        '_journal.json',
        ...journal.entries.map((entry) => `${entry.tag.slice(0, 4)}_snapshot.json`),
      ].sort(),
    );
  });

  it('reports no problem for the shipped journal', () => {
    expect(journalProblems(PATHS.migrationsFolder)).toEqual([]);
  });

  describe('negative fixtures: a journal that would skip or confuse a migration', () => {
    function withJournal(change: (entries: Record<string, unknown>[]) => void): string {
      const folder = copyOfMigrations();
      const journalFile = join(folder, 'meta', '_journal.json');
      const parsed = JSON.parse(readFileSync(journalFile, 'utf8')) as {
        entries: Record<string, unknown>[];
      };
      change(parsed.entries);
      writeFileSync(journalFile, JSON.stringify(parsed, null, 2));
      return folder;
    }

    function guard(folder: string): void {
      const problems = journalProblems(folder);
      if (problems.length > 0) throw new Error(problems.join('; '));
    }

    function duplicateFirstEntry(entries: Record<string, unknown>[]): void {
      const [first] = entries;
      if (first === undefined) throw new Error('the journal is empty');
      entries.push({ ...first, idx: 1, tag: '0001_second' });
    }

    it('fails when `when` does not increase', () => {
      const folder = withJournal(duplicateFirstEntry); // same `when` as the first entry
      cpSync(
        join(folder, `${readJournal(folder).entries[0]?.tag ?? ''}.sql`),
        join(folder, '0001_second.sql'),
      );
      expectGuardFails(guard, folder, { name: 'journal', reason: /when/ });
    });

    it('fails when a tag is out of sequence', () => {
      const folder = withJournal((entries) => {
        const [first] = entries;
        if (first !== undefined) first.tag = '0003_init';
      });
      expectGuardFails(guard, folder, { name: 'journal', reason: /tag/ });
    });

    it('fails when a tag is not NNNN_slug', () => {
      const folder = withJournal((entries) => {
        const [first] = entries;
        if (first !== undefined) first.tag = 'init';
      });
      expectGuardFails(guard, folder, { name: 'journal', reason: /tag/ });
    });

    it('fails when a SQL file is not in the journal (it would never run)', () => {
      const folder = copyOfMigrations();
      writeFileSync(join(folder, '0001_orphan.sql'), 'SELECT 1;');
      expectGuardFails(guard, folder, { name: 'journal', reason: /0001_orphan\.sql/ });
    });

    it('fails when a journaled SQL file is missing', () => {
      const folder = copyOfMigrations();
      rmSync(join(folder, `${readJournal(folder).entries[0]?.tag ?? ''}.sql`));
      expectGuardFails(guard, folder, { name: 'journal', reason: /missing/ });
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Snapshots and the manifest
// ---------------------------------------------------------------------------------------------

describe('the manifest and the snapshots (FR-A-062, PD-05)', () => {
  const manifestText = (): string =>
    readFileSync(join(PATHS.snapshotsFolder, MANIGEST_NAME), 'utf8');

  it('lists tag, SHA-256 and schema version of every shipped migration and equals the files', () => {
    const built = buildManifest(PATHS.migrationsFolder);
    const journal = readJournal(PATHS.migrationsFolder);
    expect(built).toHaveLength(journal.entries.length);
    built.forEach((entry, position) => {
      expect(entry.tag).toBe(journal.entries[position]?.tag);
      expect(entry.schemaVersion).toBe(position);
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
    });
    expect(manifestText()).toBe(renderManifest(built));
    expect(JSON.parse(manifestText())).toEqual({ migrations: built });
  });

  it('hashes the file bytes the migrator hashes: the SHA-256 of the whole SQL file', async () => {
    const { createHash } = await import('node:crypto');
    const [first] = buildManifest(PATHS.migrationsFolder);
    if (first === undefined) throw new Error('no migration');
    const bytes = readFileSync(join(PATHS.migrationsFolder, `${first.tag}.sql`));
    expect(first.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it('commits a snapshot per schema version, with the header, named NNNN-slug.sql', () => {
    for (const entry of buildManifest(PATHS.migrationsFolder)) {
      const name = snapshotFileName(entry);
      expect(name).toMatch(/^\d{4}-[a-z0-9_]+\.sql$/);
      const text = readFileSync(join(PATHS.snapshotsFolder, name), 'utf8');
      const lines = text.split('\n');
      expect(lines[0]).toBe(`-- schema-version: ${String(entry.schemaVersion)}`);
      expect(lines[1]).toBe(`-- last-migration: ${entry.tag}`);
      expect(lines[2]).toBe('-- generated by apps/server/scripts/schema-snapshot.ts; do not edit');
    }
  });

  it('regenerates every snapshot byte-identically from the migrated database', () => {
    const regenerated = buildSnapshots(PATHS.migrationsFolder);
    expect([...regenerated.keys()].sort()).toEqual(
      readdirSync(PATHS.snapshotsFolder)
        .filter((name) => name.endsWith('.sql'))
        .sort(),
    );
    for (const [name, text] of regenerated) {
      expect(readFileSync(join(PATHS.snapshotsFolder, name), 'utf8')).toBe(text);
    }
  });

  it('lists tables, then indexes, then triggers, each sorted by name, without sqlite_% or the bookkeeping table', () => {
    const [text] = buildSnapshots(PATHS.migrationsFolder).values();
    if (text === undefined) throw new Error('no snapshot');
    type Kind = 'table' | 'index' | 'trigger';
    const kindOf = (keyword: string | undefined): Kind =>
      keyword === 'TABLE' ? 'table' : keyword === 'TRIGGER' ? 'trigger' : 'index';
    const objects = [
      ...text.matchAll(/^CREATE (TABLE|UNIQUE INDEX|INDEX|TRIGGER) [`"]?(\w+)[`"]?/gm),
    ].map((match) => ({ kind: kindOf(match[1]), name: match[2] ?? '' }));
    const order: Record<Kind, number> = { table: 0, index: 1, trigger: 2 };
    const sorted = [...objects].sort(
      (a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name),
    );
    expect(objects).toEqual(sorted);
    expect(objects.filter((o) => o.kind === 'table').map((o) => o.name)).toEqual([
      'audit_log',
      'branding',
      'branding_asset',
    ]);
    expect(text).not.toMatch(/sqlite_/);
    expect(text).not.toMatch(/__drizzle_migrations/);
  });

  it('accepts the committed files as current', () => {
    expect(() => {
      assertSchemaCurrent(PATHS);
    }).not.toThrow();
  });

  describe('negative fixtures: the check must fail on every way the files can drift apart', () => {
    function copyOfFiles(): SchemaPaths {
      const root = mkdtempSync(join(tmpdir(), 'm365portal-schema-'));
      onTestFinished(() => {
        rmSync(root, { recursive: true, force: true });
      });
      cpSync(PATHS.migrationsFolder, join(root, 'drizzle'), { recursive: true });
      cpSync(PATHS.snapshotsFolder, join(root, 'schema-snapshots'), { recursive: true });
      return {
        migrationsFolder: join(root, 'drizzle'),
        snapshotsFolder: join(root, 'schema-snapshots'),
      };
    }

    const firstSnapshotName = (): string => {
      const [entry] = buildManifest(PATHS.migrationsFolder);
      if (entry === undefined) throw new Error('no migration');
      return snapshotFileName(entry);
    };

    it('passes on an untouched copy (the fixtures break only what they claim)', () => {
      expect(() => {
        assertSchemaCurrent(copyOfFiles());
      }).not.toThrow();
    });

    it('fails when the snapshot of a version is missing', () => {
      const paths = copyOfFiles();
      rmSync(join(paths.snapshotsFolder, firstSnapshotName()));
      expectGuardFails(assertSchemaCurrent, paths, {
        name: 'schema check',
        reason: new RegExp(`${firstSnapshotName().replace('.', '\\.')}.*missing`, 's'),
      });
    });

    it('fails when the snapshot differs by a single byte', () => {
      const paths = copyOfFiles();
      const file = join(paths.snapshotsFolder, firstSnapshotName());
      writeFileSync(file, `${readFileSync(file, 'utf8')} `);
      expectGuardFails(assertSchemaCurrent, paths, { name: 'schema check', reason: /differs/ });
    });

    it('fails when a snapshot file has no migration', () => {
      const paths = copyOfFiles();
      writeFileSync(join(paths.snapshotsFolder, '0007-ghost.sql'), '-- schema-version: 7\n');
      expectGuardFails(assertSchemaCurrent, paths, {
        name: 'schema check',
        reason: /0007-ghost\.sql/,
      });
    });

    it('fails when the manifest is missing', () => {
      const paths = copyOfFiles();
      rmSync(join(paths.snapshotsFolder, MANIGEST_NAME));
      expectGuardFails(assertSchemaCurrent, paths, {
        name: 'schema check',
        reason: /migrations\.json/,
      });
    });

    it('fails when the manifest holds another SHA-256 than the file (an edited migration)', () => {
      const paths = copyOfFiles();
      const file = join(
        paths.migrationsFolder,
        `${readJournal(paths.migrationsFolder).entries[0]?.tag ?? ''}.sql`,
      );
      writeFileSync(file, `${readFileSync(file, 'utf8')}\n-- edited after release\n`);
      expectGuardFails(assertSchemaCurrent, paths, {
        name: 'schema check',
        reason: /sha256|SHA-256/i,
      });
    });

    it('fails when the manifest lists a migration that does not exist, or lacks one that does', () => {
      const paths = copyOfFiles();
      const file = join(paths.snapshotsFolder, MANIGEST_NAME);
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { migrations: unknown[] };
      parsed.migrations.push({ tag: '0001_ghost', sha256: 'a'.repeat(64), schemaVersion: 1 });
      writeFileSync(file, JSON.stringify(parsed, null, 2));
      expectGuardFails(assertSchemaCurrent, paths, { name: 'schema check', reason: /0001_ghost/ });

      const emptied = copyOfFiles();
      writeFileSync(
        join(emptied.snapshotsFolder, MANIGEST_NAME),
        JSON.stringify({ migrations: [] }),
      );
      expectGuardFails(assertSchemaCurrent, emptied, {
        name: 'schema check',
        reason: /migrations\.json/,
      });
    });

    it('ends every failure with the exact command to run', () => {
      const paths = copyOfFiles();
      rmSync(join(paths.snapshotsFolder, firstSnapshotName()));
      expectGuardFails(assertSchemaCurrent, paths, {
        name: 'schema check',
        reason: new RegExp(`Run: ${SNAPSHOT_COMMAND.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
      });
      expect(SNAPSHOT_COMMAND).toBe('pnpm schema:snapshot');
    });
  });

  describe('released entries stay as they were (data-model 8.1, item 2; the CI check compares with the base ref)', () => {
    const released = [
      { tag: '0000_init', sha256: 'a'.repeat(64), schemaVersion: 0 },
      { tag: '0001_next', sha256: 'b'.repeat(64), schemaVersion: 1 },
    ];

    it('accepts an appended migration', () => {
      expect(
        checkReleasedEntries(released, [
          ...released,
          { tag: '0002_more', sha256: 'c'.repeat(64), schemaVersion: 2 },
        ]),
      ).toEqual([]);
    });

    it('accepts identical manifests', () => {
      expect(checkReleasedEntries(released, released)).toEqual([]);
    });

    it('refuses a released entry whose hash changed', () => {
      const edited = [{ ...released[0]!, sha256: 'f'.repeat(64) }, released[1]!];
      expect(checkReleasedEntries(released, edited).join('\n')).toMatch(/0000_init/);
    });

    it('refuses a released entry that was removed or renamed', () => {
      expect(checkReleasedEntries(released, [released[0]!]).join('\n')).toMatch(/0001_next/);
      const renamed = [released[0]!, { ...released[1]!, tag: '0001_renamed' }];
      expect(checkReleasedEntries(released, renamed).join('\n')).toMatch(/0001_next/);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// The drift check: drizzle-kit generate into a clean copy produces nothing
// ---------------------------------------------------------------------------------------------

describe('the drift check (FR-A-062, quality step "Schema drift check")', () => {
  it('finds no change between src/db/schema.ts and the migrations', () => {
    const result = checkDrift({ packageDir: PACKAGE_DIR });
    expect(result.problems).toEqual([]);
  }, 90_000);

  it('does not touch the real drizzle folder', () => {
    const before = readdirSync(PATHS.migrationsFolder).sort();
    checkDrift({ packageDir: PACKAGE_DIR });
    expect(readdirSync(PATHS.migrationsFolder).sort()).toEqual(before);
  }, 90_000);

  describe('negative fixture: a schema change without a migration', () => {
    it('is found, and the message ends with the generate command', () => {
      const dir = mkdtempSync(join(tmpdir(), 'm365portal-drift-'));
      onTestFinished(() => {
        rmSync(dir, { recursive: true, force: true });
      });
      const source = readFileSync(join(PACKAGE_DIR, 'src', 'db', 'schema.ts'), 'utf8');
      const changed = source.replace(
        "    updatedById: text('updated_by_id').notNull(),",
        "    updatedById: text('updated_by_id').notNull(),\n    drift: text('drift'),",
      );
      expect(changed).not.toBe(source);
      const schemaFile = join(dir, 'schema.ts');
      writeFileSync(schemaFile, changed);

      const result = checkDrift({ packageDir: PACKAGE_DIR, schemaFile });
      expect(result.problems.join('\n')).toMatch(/drift|migration/i);
      expect(result.fix).toBe(GENERATE_COMMAND);
      expect(GENERATE_COMMAND).toMatch(/drizzle-kit generate --name/);
    }, 90_000);
  });
});

// ---------------------------------------------------------------------------------------------
// The scripts, as a developer or CI runs them
// ---------------------------------------------------------------------------------------------

describe('pnpm schema:snapshot and pnpm schema:check', () => {
  const tsx = join(PACKAGE_DIR, 'node_modules', '.bin', 'tsx');

  it('schema:check exits 0 on the committed files', () => {
    const run = spawnSync(tsx, ['scripts/check-schema.ts'], {
      cwd: PACKAGE_DIR,
      encoding: 'utf8',
      timeout: 90_000,
    });
    expect(run.status, run.stdout + run.stderr).toBe(0);
  }, 100_000);

  it('schema:check --drift-only runs the drift check alone, and --no-drift everything but that', () => {
    const driftOnly = spawnSync(tsx, ['scripts/check-schema.ts', '--drift-only'], {
      cwd: PACKAGE_DIR,
      encoding: 'utf8',
      timeout: 90_000,
    });
    expect(driftOnly.status, driftOnly.stdout + driftOnly.stderr).toBe(0);

    // With the snapshots gone the snapshot check fails and the drift check, run alone, does not care.
    const root = mkdtempSync(join(tmpdir(), 'm365portal-schema-cli-'));
    onTestFinished(() => {
      rmSync(root, { recursive: true, force: true });
    });
    cpSync(PATHS.migrationsFolder, join(root, 'drizzle'), { recursive: true });
    const result = checkSchema({ packageDir: root, drift: false, snapshots: false });
    expect(result.problems).toEqual([]);
    expect(checkSchema({ packageDir: root, drift: false }).problems.length).toBeGreaterThan(0);
  }, 100_000);

  it('schema:check exits 1 and ends with the command when a snapshot is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'm365portal-schema-cli-'));
    onTestFinished(() => {
      rmSync(root, { recursive: true, force: true });
    });
    cpSync(PATHS.migrationsFolder, join(root, 'drizzle'), { recursive: true });
    cpSync(PATHS.snapshotsFolder, join(root, 'schema-snapshots'), { recursive: true });
    for (const name of readdirSync(join(root, 'schema-snapshots'))) {
      if (name.endsWith('.sql')) rmSync(join(root, 'schema-snapshots', name));
    }
    const run = spawnSync(tsx, ['scripts/check-schema.ts', '--package-dir', root, '--no-drift'], {
      cwd: PACKAGE_DIR,
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(run.status).toBe(1);
    expect((run.stdout + run.stderr).trimEnd().endsWith(`Run: ${SNAPSHOT_COMMAND}`)).toBe(true);
  }, 70_000);

  it('schema:snapshot writes the manifest and the snapshots and a second run changes nothing', () => {
    const root = mkdtempSync(join(tmpdir(), 'm365portal-schema-cli-'));
    onTestFinished(() => {
      rmSync(root, { recursive: true, force: true });
    });
    cpSync(PATHS.migrationsFolder, join(root, 'drizzle'), { recursive: true });
    const run = (): ReturnType<typeof spawnSync> =>
      spawnSync(tsx, ['scripts/schema-snapshot.ts', '--package-dir', root], {
        cwd: PACKAGE_DIR,
        encoding: 'utf8',
        timeout: 60_000,
      });

    expect(run().status).toBe(0);
    const files = readdirSync(join(root, 'schema-snapshots')).sort();
    expect(files).toContain(MANIGEST_NAME);
    const first = new Map(
      files.map((name) => [name, readFileSync(join(root, 'schema-snapshots', name), 'utf8')]),
    );
    expect(run().status).toBe(0);
    for (const [name, text] of first) {
      expect(readFileSync(join(root, 'schema-snapshots', name), 'utf8')).toBe(text);
    }
    // And what it wrote is what is committed.
    for (const [name, text] of first) {
      expect(readFileSync(join(PATHS.snapshotsFolder, name), 'utf8')).toBe(text);
    }
  }, 70_000);
});

// ---------------------------------------------------------------------------------------------
// CHECK constraints and triggers of the first migration (data-model sections 4 and 7.1)
// ---------------------------------------------------------------------------------------------

const TS = '2026-10-10T12:00:00.000Z';
const SHA = 'a'.repeat(64);
const ZERO = Buffer.alloc(32);

type Row = Record<string, string | number | Buffer | null>;

function insert(db: SqliteConnection, table: string, row: Row): void {
  const columns = Object.keys(row);
  const placeholders = columns.map((column) => `@${column}`).join(', ');
  db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`).run(row);
}

function assetRow(over: Row = {}): Row {
  return {
    sha256: SHA,
    bytes: 1000,
    width: 512,
    height: 512,
    luminance: 0.5,
    created_at: TS,
    unreferenced_at: null,
    ...over,
  };
}

function brandingRow(over: Row = {}): Row {
  return {
    id: 1,
    revision: 1,
    org_name: 'M365Portal',
    accent: '#2563eb',
    logo_light: null,
    logo_dark: null,
    logo_compact: null,
    icon_favicon32: SHA,
    icon_apple180: SHA,
    icon_pwa192: SHA,
    icon_pwa512: SHA,
    icon_maskable512: SHA,
    updated_at: TS,
    updated_by_kind: 'system',
    updated_by_id: 'system',
    ...over,
  };
}

function auditRow(over: Row = {}): Row {
  return {
    seq: 1,
    ts: TS,
    actor_kind: 'system',
    actor_id: 'system',
    action: 'branding.init',
    target_type: 'branding',
    target_id: '1',
    outcome: 'success',
    reason_code: null,
    client_ip: null,
    request_id: null,
    detail: '{}',
    prev_hash: ZERO,
    hash: Buffer.alloc(32, 1),
    ...over,
  };
}

interface SqliteFailure {
  code: string;
  message: string;
}

function failureOf(action: () => void): SqliteFailure {
  try {
    action();
  } catch (error) {
    const { code, message } = error as { code?: unknown; message?: unknown };
    return { code: String(code), message: String(message) };
  }
  throw new Error('the statement was accepted, but the database should have refused it');
}

describe('the first migration enforces data-model section 4', () => {
  let db: SqliteConnection;

  beforeAll(() => {
    db = new Database(':memory:');
    migrateScratchDatabase(db, PATHS.migrationsFolder);
    db.pragma('foreign_keys = ON');
  });

  afterAll(() => {
    db.close();
  });

  /** Run `action` and undo everything it did, so every case starts from the empty tables. */
  function isolated<T>(action: () => T): T {
    db.exec('SAVEPOINT isolated');
    try {
      return action();
    } finally {
      db.exec('ROLLBACK TO isolated');
      db.exec('RELEASE isolated');
    }
  }

  function checkFailure(table: string, row: Row, check: string, chainTrigger = true): void {
    isolated(() => {
      if (table === 'branding') insert(db, 'branding_asset', assetRow());
      // The chain trigger runs before the CHECKs and refuses every previous hash that is not the
      // head's 32-byte hash, so the CHECK on its size can only be reached without the trigger.
      if (!chainTrigger) db.exec('DROP TRIGGER audit_log_chain_link');
      const failure = failureOf(() => {
        insert(db, table, row);
      });
      expect(failure.code).toBe('SQLITE_CONSTRAINT_CHECK');
      expect(failure.message).toContain(check);
    });
  }

  function accepted(table: string, row: Row): void {
    isolated(() => {
      if (table === 'branding') insert(db, 'branding_asset', assetRow());
      insert(db, table, row);
    });
  }

  describe('branding_asset', () => {
    const cases: readonly [string, Row, string][] = [
      [
        'a hash of 63 characters',
        assetRow({ sha256: 'a'.repeat(63) }),
        'branding_asset_sha256_shape',
      ],
      [
        'a hash of 65 characters',
        assetRow({ sha256: 'a'.repeat(65) }),
        'branding_asset_sha256_shape',
      ],
      ['an upper-case hash', assetRow({ sha256: 'A'.repeat(64) }), 'branding_asset_sha256_shape'],
      ['a non-hex hash', assetRow({ sha256: `${'a'.repeat(63)}g` }), 'branding_asset_sha256_shape'],
      ['0 bytes', assetRow({ bytes: 0 }), 'branding_asset_bytes_range'],
      ['2 MiB plus one byte', assetRow({ bytes: 2_097_153 }), 'branding_asset_bytes_range'],
      ['width 0', assetRow({ width: 0 }), 'branding_asset_width_range'],
      ['width 1025', assetRow({ width: 1025 }), 'branding_asset_width_range'],
      ['height 0', assetRow({ height: 0 }), 'branding_asset_height_range'],
      ['height 1025', assetRow({ height: 1025 }), 'branding_asset_height_range'],
      ['negative luminance', assetRow({ luminance: -0.01 }), 'branding_asset_luminance_range'],
      ['luminance above 1', assetRow({ luminance: 1.01 }), 'branding_asset_luminance_range'],
      [
        'a creation time without milliseconds',
        assetRow({ created_at: '2026-10-10T12:00:00Z' }),
        'branding_asset_created_at_shape',
      ],
      [
        'a creation time with a space',
        assetRow({ created_at: '2026-10-10 12:00:00.000Z' }),
        'branding_asset_created_at_shape',
      ],
      [
        'a creation time without the Z',
        assetRow({ created_at: '2026-10-10T12:00:00.000' }),
        'branding_asset_created_at_shape',
      ],
      [
        'an unreferenced time with an offset',
        assetRow({ unreferenced_at: '2026-10-10T12:00:00.000+02:00' }),
        'branding_asset_unreferenced_at_shape',
      ],
    ];

    it.each(cases)('refuses %s', (_label, row, check) => {
      checkFailure('branding_asset', row, check);
    });

    it('accepts the limits themselves and a missing luminance', () => {
      accepted('branding_asset', assetRow({ bytes: 1, width: 1, height: 1, luminance: 0 }));
      accepted(
        'branding_asset',
        assetRow({ bytes: 2_097_152, width: 1024, height: 1024, luminance: 1 }),
      );
      accepted('branding_asset', assetRow({ luminance: null, unreferenced_at: TS }));
    });
  });

  describe('branding', () => {
    const cases: readonly [string, Row, string][] = [
      ['an id other than 1', brandingRow({ id: 2 }), 'branding_single_row'],
      ['revision 0', brandingRow({ revision: 0 }), 'branding_revision_positive'],
      ['an empty name', brandingRow({ org_name: '' }), 'branding_org_name_bytes'],
      [
        'a name of 257 bytes',
        brandingRow({ org_name: 'a'.repeat(257) }),
        'branding_org_name_bytes',
      ],
      [
        'a name of 258 bytes in 129 characters',
        brandingRow({ org_name: 'é'.repeat(129) }),
        'branding_org_name_bytes',
      ],
      ['an upper-case accent', brandingRow({ accent: '#AABBCC' }), 'branding_accent_shape'],
      ['a colour name', brandingRow({ accent: 'red' }), 'branding_accent_shape'],
      ['a short accent', brandingRow({ accent: '#abc' }), 'branding_accent_shape'],
      [
        'an accent with trailing text',
        brandingRow({ accent: '#aabbcc ' }),
        'branding_accent_shape',
      ],
      ['an accent with alpha', brandingRow({ accent: '#aabbccdd' }), 'branding_accent_shape'],
      [
        'a derived flag of 2',
        brandingRow({ logo_compact_derived: 2 }),
        'branding_logo_compact_derived_flag',
      ],
      [
        'a derived compact logo that is absent',
        brandingRow({ logo_compact_derived: 1, logo_compact: null }),
        'branding_logo_compact_derived_needs_logo',
      ],
      [
        'an update time without milliseconds',
        brandingRow({ updated_at: '2026-10-10T12:00:00Z' }),
        'branding_updated_at_shape',
      ],
    ];

    it.each(cases)('refuses %s', (_label, row, check) => {
      checkFailure('branding', row, check);
    });

    it('accepts a name of 256 bytes however it is spelled, and a derived compact logo that exists', () => {
      accepted('branding', brandingRow({ org_name: 'a'.repeat(256) }));
      accepted('branding', brandingRow({ org_name: 'é'.repeat(128) }));
      accepted('branding', brandingRow({ org_name: 'x' }));
      accepted('branding', brandingRow({ logo_compact: SHA, logo_compact_derived: 1 }));
    });

    it('defaults the derived flag to 0', () => {
      isolated(() => {
        insert(db, 'branding_asset', assetRow());
        insert(db, 'branding', brandingRow());
        expect(db.prepare('SELECT logo_compact_derived AS flag FROM branding').get()).toEqual({
          flag: 0,
        });
      });
    });

    it('refuses to delete an asset the branding refers to (ON DELETE RESTRICT, PR-14)', () => {
      isolated(() => {
        insert(db, 'branding_asset', assetRow());
        insert(db, 'branding', brandingRow());
        const failure = failureOf(() => db.prepare('DELETE FROM branding_asset').run());
        // SQLite implements RESTRICT as an immediate action and reports it as a trigger-style
        // constraint failure; the message is the foreign key one either way.
        expect(failure.code).toMatch(/^SQLITE_CONSTRAINT_(TRIGGER|FOREIGNKEY)$/);
        expect(failure.message).toBe('FOREIGN KEY constraint failed');
        expect(db.prepare('SELECT count(*) AS n FROM branding_asset').get()).toEqual({ n: 1 });
      });
    });

    it('refuses a reference to an asset that does not exist', () => {
      isolated(() => {
        const failure = failureOf(() => {
          insert(db, 'branding', brandingRow());
        });
        expect(failure.code).toBe('SQLITE_CONSTRAINT_FOREIGNKEY');
      });
    });
  });

  describe('audit_log', () => {
    const detailOf = (bytes: number): string => `{"k":"${'x'.repeat(bytes - 8)}"}`;

    const cases: readonly [string, Row, string][] = [
      [
        'a time without milliseconds',
        auditRow({ ts: '2026-10-10T12:00:00Z' }),
        'audit_log_ts_shape',
      ],
      ['an outcome outside the closed set', auditRow({ outcome: 'ok' }), 'audit_log_outcome_set'],
      ['an upper-case outcome', auditRow({ outcome: 'SUCCESS' }), 'audit_log_outcome_set'],
      ['detail that is not JSON', auditRow({ detail: '{' }), 'audit_log_detail_json'],
      ['detail of 4097 bytes', auditRow({ detail: detailOf(4097) }), 'audit_log_detail_json'],
      ['a hash of 33 bytes', auditRow({ hash: Buffer.alloc(33, 1) }), 'audit_log_hash_sizes'],
    ];

    it.each(cases)('refuses %s', (_label, row, check) => {
      checkFailure('audit_log', row, check);
    });

    it('refuses a previous hash of 31 bytes: by the chain trigger, and by the CHECK without it', () => {
      const row = auditRow({ prev_hash: Buffer.alloc(31) });
      isolated(() => {
        const failure = failureOf(() => {
          insert(db, 'audit_log', row);
        });
        expect(failure.code).toBe('SQLITE_CONSTRAINT_TRIGGER');
      });
      checkFailure('audit_log', row, 'audit_log_hash_sizes', false);
    });

    it('accepts detail of exactly 4096 bytes and every value of the closed outcome set', () => {
      accepted('audit_log', auditRow({ detail: detailOf(4096) }));
      for (const outcome of ['success', 'denied', 'rejected', 'error']) {
        accepted('audit_log', auditRow({ outcome }));
      }
    });

    it('does not close the sets later phases extend: any actor kind, action, target type and reason code', () => {
      accepted(
        'audit_log',
        auditRow({
          actor_kind: 'break_glass',
          action: 'rbac.role.create',
          target_type: 'role',
          reason_code: 'anything_new',
        }),
      );
    });

    it('defaults detail to an empty object', () => {
      isolated(() => {
        const row = auditRow();
        delete row.detail;
        insert(db, 'audit_log', row);
        expect(db.prepare('SELECT detail FROM audit_log').get()).toEqual({ detail: '{}' });
      });
    });

    it('refuses a second row with the same hash (a unique index, defence in depth)', () => {
      isolated(() => {
        insert(db, 'audit_log', auditRow());
        const failure = failureOf(() => {
          insert(
            db,
            'audit_log',
            auditRow({ seq: 2, prev_hash: Buffer.alloc(32, 1), hash: Buffer.alloc(32, 1) }),
          );
        });
        expect(failure.code).toBe('SQLITE_CONSTRAINT_UNIQUE');
      });
    });
  });

  describe('the three audit triggers (data-model 7.1)', () => {
    const FIRST_HASH = Buffer.alloc(32, 1);
    const SECOND_HASH = Buffer.alloc(32, 2);

    function chainOfTwo(): void {
      insert(db, 'audit_log', auditRow());
      insert(db, 'audit_log', auditRow({ seq: 2, prev_hash: FIRST_HASH, hash: SECOND_HASH }));
    }

    it('accepts a chain that continues: 1, 2, 3 with each previous hash linking', () => {
      isolated(() => {
        chainOfTwo();
        insert(
          db,
          'audit_log',
          auditRow({ seq: 3, prev_hash: SECOND_HASH, hash: Buffer.alloc(32, 3) }),
        );
        expect(db.prepare('SELECT count(*) AS n FROM audit_log').get()).toEqual({ n: 3 });
      });
    });

    it('aborts an UPDATE of any column', () => {
      isolated(() => {
        chainOfTwo();
        for (const statement of [
          "UPDATE audit_log SET detail = '{}' WHERE seq = 1",
          "UPDATE audit_log SET actor_id = 'x' WHERE seq = 2",
          'UPDATE audit_log SET hash = zeroblob(32)',
          'UPDATE audit_log SET seq = seq + 10',
          'UPDATE OR REPLACE audit_log SET ts = ts',
        ]) {
          const failure = failureOf(() => db.prepare(statement).run());
          expect(failure.code, statement).toBe('SQLITE_CONSTRAINT_TRIGGER');
          expect(failure.message).toContain('audit_log is append-only');
        }
      });
    });

    it('aborts a DELETE, of one row or of all', () => {
      isolated(() => {
        chainOfTwo();
        for (const statement of ['DELETE FROM audit_log WHERE seq = 2', 'DELETE FROM audit_log']) {
          const failure = failureOf(() => db.prepare(statement).run());
          expect(failure.code, statement).toBe('SQLITE_CONSTRAINT_TRIGGER');
          expect(failure.message).toContain('audit_log is append-only');
        }
        expect(db.prepare('SELECT count(*) AS n FROM audit_log').get()).toEqual({ n: 2 });
      });
    });

    const brokenLinks: readonly [string, () => Row][] = [
      ['a first entry that is not seq 1', () => auditRow({ seq: 2 })],
      [
        'a first entry with a previous hash that is not 32 zero bytes',
        () => auditRow({ prev_hash: Buffer.alloc(32, 9) }),
      ],
    ];

    it.each(brokenLinks)('refuses %s', (_label, row) => {
      isolated(() => {
        const failure = failureOf(() => {
          insert(db, 'audit_log', row());
        });
        expect(failure.code).toBe('SQLITE_CONSTRAINT_TRIGGER');
        expect(failure.message).toContain('audit_log chain link violated');
      });
    });

    it('refuses a gap, a repeated seq, seq 0 and a wrong previous hash', () => {
      isolated(() => {
        chainOfTwo();
        const attempts: Row[] = [
          auditRow({ seq: 4, prev_hash: SECOND_HASH, hash: Buffer.alloc(32, 4) }),
          auditRow({ seq: 2, prev_hash: FIRST_HASH, hash: Buffer.alloc(32, 5) }),
          auditRow({ seq: 0, prev_hash: SECOND_HASH, hash: Buffer.alloc(32, 6) }),
          auditRow({ seq: 3, prev_hash: FIRST_HASH, hash: Buffer.alloc(32, 7) }),
          auditRow({ seq: 3, prev_hash: ZERO, hash: Buffer.alloc(32, 8) }),
        ];
        for (const attempt of attempts) {
          const failure = failureOf(() => {
            insert(db, 'audit_log', attempt);
          });
          expect(failure.code, JSON.stringify(attempt.seq)).toBe('SQLITE_CONSTRAINT_TRIGGER');
          expect(failure.message).toContain('audit_log chain link violated');
        }
        expect(db.prepare('SELECT count(*) AS n FROM audit_log').get()).toEqual({ n: 2 });
      });
    });

    it('refuses INSERT OR REPLACE onto an existing seq', () => {
      isolated(() => {
        chainOfTwo();
        const failure = failureOf(() => {
          db.prepare(
            'INSERT OR REPLACE INTO audit_log (seq, ts, actor_kind, actor_id, action, outcome, prev_hash, hash) VALUES (1, ?, ?, ?, ?, ?, ?, ?)',
          ).run(TS, 'system', 'forged', 'branding.init', 'success', ZERO, Buffer.alloc(32, 9));
        });
        expect(failure.code).toBe('SQLITE_CONSTRAINT_TRIGGER');
        expect(db.prepare('SELECT actor_id AS actor FROM audit_log WHERE seq = 1').get()).toEqual({
          actor: 'system',
        });
      });
    });

    it('lives in the migration as three triggers named as the data model names them', () => {
      const names = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
        .all() as { name: string }[];
      expect(names.map((row) => row.name)).toEqual([
        'audit_log_chain_link',
        'audit_log_no_delete',
        'audit_log_no_update',
      ]);
    });
  });
});

// =============================================================================================
// Part 2 (T-A-037): the runner (FR-A-061, FR-A-064, FR-A-012 migration part; PD-06; V-05; A-03)
// =============================================================================================

interface SyntheticMigration {
  readonly tag: string;
  readonly when: number;
  readonly statements: readonly string[];
}

const BASE_WHEN = 1_700_000_000_000;

/** Migration number `n` with a `when` that increases with `n`. */
function step(n: number, statements: readonly string[]): SyntheticMigration {
  return {
    tag: `${String(n).padStart(4, '0')}_step${String(n)}`,
    when: BASE_WHEN + n * 1000,
    statements,
  };
}

/** Write a migrations folder (SQL files and `meta/_journal.json`) the way drizzle-kit lays it out. */
function writeFolder(migrations: readonly SyntheticMigration[]): string {
  const root = mkdtempSync(join(tmpdir(), 'm365portal-synthetic-'));
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const folder = join(root, 'drizzle');
  mkdirSync(join(folder, 'meta'), { recursive: true });
  migrations.forEach((migration) => {
    writeFileSync(
      join(folder, `${migration.tag}.sql`),
      migration.statements.join('\n--> statement-breakpoint\n'),
    );
  });
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'sqlite',
      entries: migrations.map((migration, idx) => ({
        idx,
        version: '6',
        when: migration.when,
        tag: migration.tag,
        breakpoints: true,
      })),
    }),
  );
  return folder;
}

const NOTE_TABLE = 'CREATE TABLE note (id integer PRIMARY KEY NOT NULL, text text NOT NULL)';
const EXTRA_TABLE = 'CREATE TABLE extra (id integer PRIMARY KEY NOT NULL)';

interface Volume {
  readonly dataDir: string;
  readonly path: string;
  readonly backupsDir: string;
}

async function volume(): Promise<Volume> {
  const dir = await createTempDataDir();
  return {
    dataDir: dir.path,
    path: join(dir.path, DATABASE_FILE_NAME),
    backupsDir: join(dir.path, 'backups'),
  };
}

/** A connection that the runner is handed, closed when the test ends. */
function connect(path: string): SqliteConnection {
  const database = openDatabase({ path });
  onTestFinished(() => {
    if (database.sqlite.open) database.close();
  });
  return database.sqlite;
}

function rowsOf(db: SqliteConnection): AppliedMigration[] {
  return appliedMigrations(db);
}

async function refusalOf(promise: Promise<unknown>): Promise<MigrationError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof MigrationError) return error;
    throw error;
  }
  throw new Error('the runner should have refused');
}

describe('the runner applies the shipped migrations (FR-A-061)', () => {
  it('applies 0000 to an empty database and records its hash and created_at', async () => {
    const { path, backupsDir } = await volume();
    const db = connect(path);
    const [first] = shippedMigrations(PATHS.migrationsFolder);
    if (first === undefined) throw new Error('no migration is shipped');

    const result = await runMigrations(db, {
      migrationsFolder: PATHS.migrationsFolder,
      backupsDir,
    });

    expect(result).toMatchObject({
      applied: [first.tag],
      schemaVersionBefore: null,
      schemaVersion: 0,
      backupFile: null,
    });
    const rows = rowsOf(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ hash: first.hash, createdAt: first.createdAt });
    // The hash is the SHA-256 of the whole file, the value the stock migrator records.
    expect(first.hash).toBe(
      createHash('sha256')
        .update(readFileSync(join(PATHS.migrationsFolder, `${first.tag}.sql`)))
        .digest('hex'),
    );
    expect(
      db
        .prepare(
          "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'audit_log'",
        )
        .get(),
    ).toEqual({ n: 1 });
  });

  it('applies nothing on the second start: same rows, no backup, no new file', async () => {
    const { path, backupsDir } = await volume();
    const db = connect(path);
    const options = { migrationsFolder: PATHS.migrationsFolder, backupsDir };
    await runMigrations(db, options);
    const before = rowsOf(db);

    const again = await runMigrations(db, options);

    expect(again).toMatchObject({
      applied: [],
      backupFile: null,
      schemaVersionBefore: 0,
      schemaVersion: 0,
    });
    expect(rowsOf(db)).toEqual(before);
    expect(existsSync(backupsDir)).toBe(false);
  });

  it('turns foreign keys back on, also when it was handed a connection that opened with them off', async () => {
    const { path, backupsDir } = await volume();
    const migrating = openDatabase({ path, foreignKeys: false });
    onTestFinished(() => {
      migrating.close();
    });

    await runMigrations(migrating.sqlite, { migrationsFolder: PATHS.migrationsFolder, backupsDir });

    expect(migrating.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(migrating.sqlite.pragma('foreign_key_check')).toEqual([]);
  });

  it('logs the outcome as counts and tags, never a path or a statement', async () => {
    const { path, backupsDir } = await volume();
    const lines: { fields: Record<string, unknown>; message: string }[] = [];
    await runMigrations(connect(path), {
      migrationsFolder: PATHS.migrationsFolder,
      backupsDir,
      log: {
        info: (fields, message) => lines.push({ fields: { ...fields }, message }),
      },
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]?.message).toBe('migrations_applied');
    expect(lines[0]?.fields).toMatchObject({
      event: 'migrations_applied',
      schemaVersion: 0,
      applied: 1,
    });
    expect(JSON.stringify(lines)).not.toContain(path);
    expect(JSON.stringify(lines)).not.toMatch(/CREATE TABLE/i);
  });
});

describe('the runner re-verifies what the stock migrator does not (V-05, PD-06)', () => {
  /** A database at the shipped version, ready for a refusal test. Returns its file. */
  async function migratedFile(): Promise<{ path: string; backupsDir: string }> {
    const { path, backupsDir } = await volume();
    const db = openDatabase({ path });
    await runMigrations(db.sqlite, { migrationsFolder: PATHS.migrationsFolder, backupsDir });
    db.close(); // checkpoints the WAL: the main file now holds everything
    return { path, backupsDir };
  }

  it('refuses an edited migration file with migration_checksum_mismatch', async () => {
    const { path, backupsDir } = await migratedFile();
    const edited = copyOfMigrations();
    const file = join(edited, `${readJournal(edited).entries[0]?.tag ?? ''}.sql`);
    writeFileSync(file, `${readFileSync(file, 'utf8')}\n-- edited after it was applied\n`);
    const db = connect(path);
    const before = rowsOf(db);

    const error = await refusalOf(runMigrations(db, { migrationsFolder: edited, backupsDir }));

    expect(error.code).toBe('migration_checksum_mismatch');
    expect(error.exitCode).not.toBe(0);
    expect(error.message).toContain('0000_init');
    expect(error.message).not.toMatch(/CREATE|SELECT|INSERT/);
    expect(rowsOf(db)).toEqual(before);
    expect(existsSync(backupsDir)).toBe(false);
  });

  it('accepts the same database with the migration file unedited (the fixture breaks only the file)', async () => {
    const { path, backupsDir } = await migratedFile();
    const result = await runMigrations(connect(path), {
      migrationsFolder: PATHS.migrationsFolder,
      backupsDir,
    });
    expect(result.applied).toEqual([]);
  });

  it('refuses a journal `when` that moved later as a checksum mismatch: created_at is compared', async () => {
    const { path, backupsDir } = await migratedFile();
    const edited = copyOfMigrations();
    shiftFirstWhen(edited, 5);

    const error = await refusalOf(
      runMigrations(connect(path), { migrationsFolder: edited, backupsDir }),
    );

    expect(error.code).toBe('migration_checksum_mismatch');
  });

  it('reads a journal `when` that moved earlier as a newer database: the applied row is newer than every shipped one', async () => {
    const { path, backupsDir } = await migratedFile();
    const edited = copyOfMigrations();
    shiftFirstWhen(edited, -5);

    const error = await refusalOf(
      runMigrations(connect(path), { migrationsFolder: edited, backupsDir }),
    );

    expect(error.code).toBe('schema_newer_than_app');
  });

  describe('a database from a newer schema', () => {
    async function withExtraRow(): Promise<{ path: string; backupsDir: string }> {
      const volumeFiles = await migratedFile();
      const db = openDatabase({ path: volumeFiles.path });
      db.sqlite
        .prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
        .run('f'.repeat(64), Date.now() + 86_400_000);
      db.close();
      return volumeFiles;
    }

    it('is refused with schema_newer_than_app when it has more applied rows than shipped files, and the file stays byte-identical', async () => {
      const { path, backupsDir } = await withExtraRow();
      const before = readFileSync(path);

      const db = openDatabase({ path });
      const error = await refusalOf(
        runMigrations(db.sqlite, { migrationsFolder: PATHS.migrationsFolder, backupsDir }),
      );
      db.close();

      expect(error.code).toBe('schema_newer_than_app');
      expect(error.exitCode).not.toBe(0);
      expect(readFileSync(path).equals(before)).toBe(true);
      expect(existsSync(`${path}-wal`)).toBe(false);
      expect(existsSync(backupsDir)).toBe(false);
    });

    it('is refused when the newest applied created_at is newer than every shipped `when`', async () => {
      const { path, backupsDir } = await migratedFile();
      const writer = openDatabase({ path });
      writer.sqlite
        .prepare('UPDATE __drizzle_migrations SET created_at = ?')
        .run(Date.now() + 86_400_000);
      writer.close();
      const before = readFileSync(path);

      const db = openDatabase({ path });
      const error = await refusalOf(
        runMigrations(db.sqlite, { migrationsFolder: PATHS.migrationsFolder, backupsDir }),
      );
      db.close();

      expect(error.code).toBe('schema_newer_than_app');
      expect(readFileSync(path).equals(before)).toBe(true);
    });

    it('wins over a checksum mismatch: a newer database is not an edited one', async () => {
      const { path, backupsDir } = await withExtraRow();
      const edited = copyOfMigrations();
      const file = join(edited, `${readJournal(edited).entries[0]?.tag ?? ''}.sql`);
      writeFileSync(file, `${readFileSync(file, 'utf8')}\n-- edited\n`);

      const error = await refusalOf(
        runMigrations(connect(path), { migrationsFolder: edited, backupsDir }),
      );

      expect(error.code).toBe('schema_newer_than_app');
    });
  });

  it('refuses a pending migration that the stock migrator would skip silently (probe P13)', async () => {
    const { path, backupsDir } = await volume();
    const db = connect(path);
    await runMigrations(db, {
      migrationsFolder: writeFolder([step(0, [NOTE_TABLE])]),
      backupsDir,
    });
    // Migration 1 was added on a branch with an older `when` than the one already applied.
    const older = { ...step(1, [EXTRA_TABLE]), when: BASE_WHEN - 1 };

    const error = await refusalOf(
      runMigrations(db, {
        migrationsFolder: writeFolder([step(0, [NOTE_TABLE]), older]),
        backupsDir,
      }),
    );

    expect(error.code).toBe('migration_journal_invalid');
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'extra'").get()).toBeUndefined();
    expect(existsSync(backupsDir)).toBe(false);
  });

  describe('inspectMigrations (the read-only part, for readiness)', () => {
    const shipped: ShippedMigration[] = [
      { tag: '0000_a', hash: 'h0', createdAt: 100 },
      { tag: '0001_b', hash: 'h1', createdAt: 200 },
    ];
    const applied = (...rows: [string, number][]): AppliedMigration[] =>
      rows.map(([hash, createdAt], id) => ({ id: id + 1, hash, createdAt }));

    it.each<[string, AppliedMigration[], string, number | null]>([
      ['nothing applied', [], 'pending', null],
      ['one applied', applied(['h0', 100]), 'pending', 0],
      ['everything applied', applied(['h0', 100], ['h1', 200]), 'current', 1],
      ['an edited hash', applied(['changed', 100]), 'migration_checksum_mismatch', 0],
      ['a changed created_at', applied(['h0', 99]), 'migration_checksum_mismatch', 0],
      [
        'more rows than files',
        applied(['h0', 100], ['h1', 200], ['h2', 300]),
        'schema_newer_than_app',
        2,
      ],
      ['a newer created_at', applied(['h0', 100], ['h1', 999]), 'schema_newer_than_app', 1],
    ])('%s', (_label, rows, status, schemaVersion) => {
      expect(inspectMigrations(rows, shipped)).toMatchObject({ status, schemaVersion });
    });

    it('lists the pending migrations and nothing else', () => {
      expect(inspectMigrations(applied(['h0', 100]), shipped).pending).toEqual([shipped[1]]);
      expect(inspectMigrations(applied(['h0', 100], ['h1', 200]), shipped).pending).toEqual([]);
    });
  });
});

describe('the pre-migration backup (FR-A-064)', () => {
  it('is written to backups/pre-migrate-<from>-<to>.sqlite, only when migrations are pending on a database with applied rows', async () => {
    const { path, backupsDir } = await volume();
    const db = connect(path);

    // First install: nothing to protect, so no backup and not even the directory.
    const first = await runMigrations(db, {
      migrationsFolder: writeFolder([step(0, [NOTE_TABLE])]),
      backupsDir,
    });
    expect(first.backupFile).toBeNull();
    expect(existsSync(backupsDir)).toBe(false);

    db.prepare("INSERT INTO note (text) VALUES ('before the upgrade')").run();

    const second = await runMigrations(db, {
      migrationsFolder: writeFolder([step(0, [NOTE_TABLE]), step(1, [EXTRA_TABLE])]),
      backupsDir,
    });

    expect(second.backupFile).toBe('pre-migrate-0000-0001.sqlite');
    expect(second).toMatchObject({
      applied: ['0001_step1'],
      schemaVersionBefore: 0,
      schemaVersion: 1,
    });
    expect(readdirSync(backupsDir)).toEqual(['pre-migrate-0000-0001.sqlite']);

    // The copy is a consistent database as it was BEFORE the pending migrations.
    const backup = openDatabase({
      path: join(backupsDir, 'pre-migrate-0000-0001.sqlite'),
      readonly: true,
    });
    onTestFinished(() => {
      backup.close();
    });
    expect(backup.sqlite.prepare('SELECT text FROM note').all()).toEqual([
      { text: 'before the upgrade' },
    ]);
    expect(
      backup.sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'extra'").get(),
    ).toBeUndefined();
    expect(appliedMigrations(backup.sqlite)).toHaveLength(1);
    // And the live database has moved on.
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'extra'").get()).toEqual({
      name: 'extra',
    });
    expect(appliedMigrations(db)).toHaveLength(2);
  });

  it('takes no backup when nothing is pending', async () => {
    const { path, backupsDir } = await volume();
    const db = connect(path);
    const folder = writeFolder([step(0, [NOTE_TABLE])]);
    await runMigrations(db, { migrationsFolder: folder, backupsDir });

    await runMigrations(db, { migrationsFolder: folder, backupsDir });

    expect(existsSync(backupsDir)).toBe(false);
  });

  it('keeps only the newest 3', async () => {
    const { path, backupsDir } = await volume();
    const db = connect(path);
    const migrations = [step(0, [NOTE_TABLE])];
    for (let n = 1; n <= 5; n += 1) {
      migrations.push(
        step(n, [`CREATE TABLE extra${String(n)} (id integer PRIMARY KEY NOT NULL)`]),
      );
    }

    await runMigrations(db, { migrationsFolder: writeFolder(migrations.slice(0, 1)), backupsDir });
    for (let upTo = 2; upTo <= migrations.length; upTo += 1) {
      await runMigrations(db, {
        migrationsFolder: writeFolder(migrations.slice(0, upTo)),
        backupsDir,
      });
    }

    // Five upgrades took five backups; the three newest are left.
    expect(readdirSync(backupsDir).sort()).toEqual([
      'pre-migrate-0002-0003.sqlite',
      'pre-migrate-0003-0004.sqlite',
      'pre-migrate-0004-0005.sqlite',
    ]);
    expect(listBackups(backupsDir).map((backup) => backup.name)).toEqual([
      'pre-migrate-0002-0003.sqlite',
      'pre-migrate-0003-0004.sqlite',
      'pre-migrate-0004-0005.sqlite',
    ]);
  });

  it('orders backups by version, not by name: 0009-0010 is newer than 0008-0009', async () => {
    const { backupsDir } = await volume();
    mkdirSync(backupsDir);
    for (const name of [
      'pre-migrate-0008-0009.sqlite',
      'pre-migrate-0009-0010.sqlite',
      'pre-migrate-0010-0011.sqlite',
    ]) {
      writeFileSync(join(backupsDir, name), '');
    }
    expect(listBackups(backupsDir).map((backup) => backup.name)).toEqual([
      'pre-migrate-0008-0009.sqlite',
      'pre-migrate-0009-0010.sqlite',
      'pre-migrate-0010-0011.sqlite',
    ]);
  });

  it('leaves files it did not write alone', async () => {
    const { path, backupsDir } = await volume();
    const db = connect(path);
    await runMigrations(db, { migrationsFolder: writeFolder([step(0, [NOTE_TABLE])]), backupsDir });
    mkdirSync(backupsDir);
    writeFileSync(join(backupsDir, 'notes.txt'), 'kept');
    writeFileSync(join(backupsDir, 'pre-migrate-0001-0002.sqlite.bak'), 'kept');

    await runMigrations(db, {
      migrationsFolder: writeFolder([step(0, [NOTE_TABLE]), step(1, [EXTRA_TABLE])]),
      backupsDir,
    });

    expect(readdirSync(backupsDir).sort()).toEqual([
      'notes.txt',
      'pre-migrate-0000-0001.sqlite',
      'pre-migrate-0001-0002.sqlite.bak',
    ]);
  });

  it('refuses to migrate when the backup cannot be written, and the database stays untouched', async () => {
    const { path } = await volume();
    const blocked = await unwritableDataDir();
    const db = connect(path);
    await runMigrations(db, {
      migrationsFolder: writeFolder([step(0, [NOTE_TABLE])]),
      backupsDir: join(blocked.path, 'backups'),
    });
    const before = rowsOf(db);

    const error = await refusalOf(
      runMigrations(db, {
        migrationsFolder: writeFolder([step(0, [NOTE_TABLE]), step(1, [EXTRA_TABLE])]),
        backupsDir: join(blocked.path, 'backups'),
      }),
    );

    expect(error.code).toBe('migration_backup_failed');
    expect(rowsOf(db)).toEqual(before);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'extra'").get()).toBeUndefined();
  });
});

describe('foreign keys and transactions (probe P12, V-05)', () => {
  const PARENT = 'CREATE TABLE parent (id integer PRIMARY KEY NOT NULL, name text NOT NULL)';
  const CHILD =
    'CREATE TABLE child (id integer PRIMARY KEY NOT NULL, parent_id integer NOT NULL, FOREIGN KEY (parent_id) REFERENCES parent(id) ON DELETE CASCADE)';
  /** What drizzle-kit writes to add a UNIQUE: build the table again, copy, drop, rename. */
  const REBUILD_PARENT = [
    'PRAGMA foreign_keys=OFF',
    'CREATE TABLE __new_parent (id integer PRIMARY KEY NOT NULL, name text NOT NULL UNIQUE)',
    'INSERT INTO __new_parent (id, name) SELECT id, name FROM parent',
    'DROP TABLE parent',
    'ALTER TABLE __new_parent RENAME TO parent',
    'PRAGMA foreign_keys=ON',
  ];

  function seed(db: SqliteConnection): void {
    db.exec("INSERT INTO parent (id, name) VALUES (1, 'a')");
    db.exec('INSERT INTO child (id, parent_id) VALUES (1, 1), (2, 1)');
  }

  it('control: a table rebuild inside a transaction with foreign keys ON cascade-deletes the children', async () => {
    const { path } = await volume();
    const db = connect(path);
    db.exec(`${PARENT}; ${CHILD};`);
    seed(db);

    // Exactly what the stock migrator does: one transaction, on a connection with foreign keys on.
    // The PRAGMA inside it is a no-op.
    db.exec(`BEGIN; ${REBUILD_PARENT.join('; ')}; COMMIT;`);

    expect(db.prepare('SELECT count(*) AS n FROM child').get()).toEqual({ n: 0 });
  });

  it('keeps the children of a table-rebuild migration: the runner migrates with foreign keys off', async () => {
    const { path, backupsDir } = await volume();
    const db = connect(path); // foreign keys ON, as every other connection
    await runMigrations(db, {
      migrationsFolder: writeFolder([step(0, [PARENT, CHILD])]),
      backupsDir,
    });
    seed(db);

    const result = await runMigrations(db, {
      migrationsFolder: writeFolder([step(0, [PARENT, CHILD]), step(1, REBUILD_PARENT)]),
      backupsDir,
    });

    expect(result.applied).toEqual(['0001_step1']);
    expect(db.prepare('SELECT id FROM child ORDER BY id').all()).toEqual([{ id: 1 }, { id: 2 }]);
    expect(db.prepare('SELECT name FROM parent').all()).toEqual([{ name: 'a' }]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    // The rebuilt table has its UNIQUE: the migration did what it said.
    expect(() => db.prepare("INSERT INTO parent (id, name) VALUES (2, 'a')").run()).toThrow(
      /UNIQUE/,
    );
  });

  it('fails when foreign_key_check is not empty afterwards, and leaves foreign keys on', async () => {
    const { path, backupsDir } = await volume();
    const db = connect(path);
    await runMigrations(db, {
      migrationsFolder: writeFolder([step(0, [PARENT, CHILD])]),
      backupsDir,
    });

    const error = await refusalOf(
      runMigrations(db, {
        migrationsFolder: writeFolder([
          step(0, [PARENT, CHILD]),
          step(1, ['INSERT INTO child (id, parent_id) VALUES (99, 12345)']),
        ]),
        backupsDir,
      }),
    );

    expect(error.code).toBe('migration_foreign_key_check_failed');
    expect(error.message).toContain('child');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('runs all pending migrations in one transaction: a failing second migration rolls back the first', async () => {
    const { path, backupsDir } = await volume();
    const db = connect(path);
    await runMigrations(db, { migrationsFolder: writeFolder([step(0, [NOTE_TABLE])]), backupsDir });
    const before = rowsOf(db);

    const error = await refusalOf(
      runMigrations(db, {
        migrationsFolder: writeFolder([
          step(0, [NOTE_TABLE]),
          step(1, [EXTRA_TABLE]),
          step(2, ['CREATE TABLE broken (this is not valid sql)']),
        ]),
        backupsDir,
      }),
    );

    expect(error.code).toBe('migration_failed');
    expect(error.exitCode).not.toBe(0);
    expect(error.cause).toBeInstanceOf(Error);
    // Neither the failed migration nor the one before it left anything behind.
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name IN ('extra', 'broken')").all(),
    ).toEqual([]);
    expect(rowsOf(db)).toEqual(before);
    expect(db.inTransaction).toBe(false);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    // The error message is fixed text: the statement and the database's own message stay in `cause`.
    expect(error.message).not.toMatch(/broken|valid sql/);
    // The backup taken before the attempt is there.
    expect(readdirSync(backupsDir)).toEqual(['pre-migrate-0000-0002.sqlite']);
  });

  it('re-reads the recorded rows afterwards and refuses a migration that rewrote the bookkeeping', async () => {
    const { path, backupsDir } = await volume();
    const db = connect(path);
    await runMigrations(db, { migrationsFolder: writeFolder([step(0, [NOTE_TABLE])]), backupsDir });

    const error = await refusalOf(
      runMigrations(db, {
        migrationsFolder: writeFolder([
          step(0, [NOTE_TABLE]),
          step(1, ["UPDATE __drizzle_migrations SET hash = 'tampered'"]),
        ]),
        backupsDir,
      }),
    );

    expect(error.code).toBe('migration_verification_failed');
    expect(error.exitCode).not.toBe(0);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('applies several pending migrations at once and records one row each', async () => {
    const { path, backupsDir } = await volume();
    const db = connect(path);
    const result = await runMigrations(db, {
      migrationsFolder: writeFolder([step(0, [NOTE_TABLE]), step(1, [EXTRA_TABLE])]),
      backupsDir,
    });

    expect(result.applied).toEqual(['0000_step0', '0001_step1']);
    expect(rowsOf(db).map((row) => row.createdAt)).toEqual([BASE_WHEN, BASE_WHEN + 1000]);
  });
});

describe('migrateEmptyDatabase (tooling: snapshots, parity, fixtures)', () => {
  it('builds the shipped schema in a scratch database', () => {
    const db = new Database(':memory:');
    migrateEmptyDatabase(db, PATHS.migrationsFolder);
    expect(appliedMigrations(db)).toHaveLength(1);
    expect(
      db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger'").get(),
    ).toEqual({ n: 3 });
    db.close();
  });

  it('refuses a database that already has applied migrations: only runMigrations may upgrade one', async () => {
    const { path, backupsDir } = await volume();
    const db = connect(path);
    await runMigrations(db, { migrationsFolder: writeFolder([step(0, [NOTE_TABLE])]), backupsDir });

    expect(() => {
      migrateEmptyDatabase(db, writeFolder([step(0, [NOTE_TABLE]), step(1, [EXTRA_TABLE])]));
    }).toThrow(MigrationError);
    expect(appliedMigrations(db)).toHaveLength(1);
  });
});

describe('the wrapper is the only code that calls the Drizzle migrator (PD-06)', () => {
  const SERVER_SOURCES = ['src', 'scripts'];
  const MIGRATOR_USE = /drizzle-orm\/(?:better-sqlite3\/)?migrator|readMigrationFiles/;

  function filesUsingTheMigrator(files: ReadonlyMap<string, string>): string[] {
    return [...files]
      .filter(([, text]) => MIGRATOR_USE.test(text))
      .map(([name]) => name)
      .sort();
  }

  function sourceFiles(): Map<string, string> {
    const found = new Map<string, string>();
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) visit(path);
        else if (/\.(?:ts|mts|cts|js|mjs|cjs)$/.test(entry.name)) {
          found.set(relative(PACKAGE_DIR, path), readFileSync(path, 'utf8'));
        }
      }
    };
    for (const directory of SERVER_SOURCES) visit(join(PACKAGE_DIR, directory));
    return found;
  }

  function guard(files: ReadonlyMap<string, string>): void {
    const offenders = filesUsingTheMigrator(files).filter(
      (name) => name !== join('src', 'db', 'migrate.ts'),
    );
    if (offenders.length > 0)
      throw new Error(`the Drizzle migrator is used by ${offenders.join(', ')}`);
  }

  it('finds the migrator in src/db/migrate.ts and nowhere else in src or scripts', () => {
    const files = sourceFiles();
    expect(filesUsingTheMigrator(files)).toEqual([join('src', 'db', 'migrate.ts')]);
    expect(() => {
      guard(files);
    }).not.toThrow();
  });

  it('fails when another file imports it (negative fixture)', () => {
    const fixture = new Map<string, string>([
      [
        join('src', 'db', 'migrate.ts'),
        "import { migrate } from 'drizzle-orm/better-sqlite3/migrator';",
      ],
      [
        join('src', 'branding', 'init.ts'),
        "import { migrate } from 'drizzle-orm/better-sqlite3/migrator';",
      ],
    ]);
    expectGuardFails(guard, fixture, { name: 'single migrator', reason: /branding\/init\.ts/ });

    const reader = new Map<string, string>([
      [join('scripts', 'tool.ts'), "import { readMigrationFiles } from 'drizzle-orm/migrator';"],
    ]);
    expectGuardFails(guard, reader, { name: 'single migrator', reason: /scripts\/tool\.ts/ });
  });
});

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function copyOfMigrations(): string {
  const root = mkdtempSync(join(tmpdir(), 'm365portal-migrations-'));
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const folder = join(root, 'drizzle');
  cpSync(PATHS.migrationsFolder, folder, { recursive: true });
  return folder;
}

function shiftFirstWhen(folder: string, milliseconds: number): void {
  const journalPath = join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { when: number }[] };
  const [entry] = journal.entries;
  if (entry === undefined) throw new Error('no entry');
  entry.when += milliseconds;
  writeFileSync(journalPath, JSON.stringify(journal));
}

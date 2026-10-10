// T-A-038: FR-A-063 and FR-A-066 (snapshot content), baseline section 2.
//
// A migration is only ever exercised by an upgrade, so a green suite and a working fresh install
// prove nothing about it. This harness opens a database at schema version N, built from the
// COMMITTED snapshot of N (not from the migrations), gives it the rows an older version of the
// application would have left, runs the real start-up wrapper, and then asks what an upgrade can get
// silently wrong:
//
//   1. the structure equals a database built from the committed snapshot of the target version:
//      tables, columns (name, type, NOT NULL, default, primary key), foreign keys, indexes and the
//      text of the triggers
//   2. `PRAGMA foreign_key_check` is empty
//   3. every seeded row of every table is still there, with the same values (the child rows that a
//      table rebuild deletes under foreign_keys = ON: probe P12)
//   4. the audit hash chain still verifies
//   5. a backup of version N was taken first
//
// The harness walks every older snapshot N against the next one and against the newest, so a second
// real schema version is covered the day its snapshot is committed, and it REFUSES to run a version
// that has no seed (a new version without seed rows would test nothing). Phase A has one real schema
// version, so there is no real pair yet: the harness is proven on the synthetic fixtures of
// `fixtures/migrations-synthetic/`, and the content of the committed snapshot of version 0 is
// asserted directly (FR-A-066).
//
// Negative fixtures (tasks.md section 0.3, baseline section 2: "a guard nobody has seen fail is an
// assumption with a green tick next to it"):
//   - `drifting-pair`: the migration says `DEFAULT 1`, the snapshot of the target says `DEFAULT 0`,
//     which is what a fresh install would have. This is the failure that only appears on other
//     people's devices, and the harness must fail on it.
//   - `table-rebuild-pair` run by a runner that migrates the way the stock migrator does (one
//     transaction, foreign keys on) loses the pets; the harness must fail on that too.
//   - runners that damage an otherwise good upgrade in one way each: a dropped trigger, a lost row,
//     a rewritten audit entry.
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
import { join } from 'node:path';
import { expectGuardFails } from '@m365portal/shared/testing';
import Database from 'better-sqlite3';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
  buildSnapshots,
  copyMigrationsUpTo,
  defaultPaths,
  snapshotFileName,
} from '../scripts/schema-snapshot.js';
import { backupFileName } from '../src/db/backup.js';
import {
  appliedMigrations,
  runMigrations,
  shippedMigrations,
  type MigrateOptions,
} from '../src/db/migrate.js';
import type { SqliteConnection } from '../src/db/open.js';
import { seedSyntheticVersion0 } from './fixtures/migrations-synthetic/seeds.js';
import { appendReference, verifyChainReference } from './helpers/audit-reference.js';
import {
  assertSchemasAgree,
  describeSchema,
  SchemaMismatchError,
} from './helpers/schema-compare.js';

const REAL = defaultPaths();
const SYNTHETIC = join(import.meta.dirname, 'fixtures', 'migrations-synthetic');

// ---------------------------------------------------------------------------------------------
// What a fixture is
// ---------------------------------------------------------------------------------------------

type Seed = (db: SqliteConnection) => void;

interface Fixture {
  readonly name: string;
  readonly migrationsFolder: string;
  readonly snapshotsFolder: string;
  /** Rows for a database AT that schema version, by version. */
  readonly seeds: Readonly<Record<number, Seed>>;
}

type Runner = (db: SqliteConnection, options: MigrateOptions) => Promise<unknown>;

function syntheticFixture(pair: string): Fixture {
  return {
    name: pair,
    migrationsFolder: join(SYNTHETIC, pair, 'drizzle'),
    snapshotsFolder: join(SYNTHETIC, pair, 'schema-snapshots'),
    seeds: { 0: seedSyntheticVersion0 },
  };
}

/**
 * The rows of schema version 0 of the real database: both kinds of asset, a branding row that
 * refers to them (the child rows), and an audit chain with non-ASCII and spaced detail.
 */
function seedRealVersion0(db: SqliteConnection): void {
  const asset = db.prepare(
    `INSERT INTO branding_asset (sha256, bytes, width, height, luminance, created_at, unreferenced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const hashA = 'a'.repeat(64);
  const hashB = 'b'.repeat(64);
  asset.run(hashA, 4096, 512, 512, 0.4, '2026-10-10T12:00:00.000Z', null);
  asset.run(hashB, 2048, 128, 128, null, '2026-10-10T12:05:00.000Z', '2026-10-10T12:05:00.000Z');

  db.prepare(
    `INSERT INTO branding (id, revision, org_name, accent, logo_light, logo_dark, logo_compact,
       logo_compact_derived, icon_favicon32, icon_apple180, icon_pwa192, icon_pwa512,
       icon_maskable512, updated_at, updated_by_kind, updated_by_id)
     VALUES (1, 3, ?, '#2563eb', ?, ?, ?, 1, ?, ?, ?, ?, ?, '2026-10-10T12:10:00.000Z', 'preview', 'preview')`,
  ).run('Réunion — 日本', hashA, hashA, hashA, hashA, hashA, hashA, hashA, hashA);

  appendReference(db, {
    ts: '2026-10-10T12:00:00.000Z',
    actorKind: 'system',
    actorId: 'system',
    action: 'branding.init',
    targetType: 'branding',
    targetId: '1',
    outcome: 'success',
    detail: '{"revision":1}',
  });
  appendReference(db, {
    ts: '2026-10-10T12:05:00.000Z',
    actorKind: 'anonymous',
    actorId: 'anonymous',
    action: 'branding.apply',
    targetType: 'branding',
    targetId: '1',
    outcome: 'denied',
    reasonCode: 'permission_denied',
    clientIp: '2001:db8::1',
    requestId: 'req-0000-0002',
    detail: '{"permission":"settings:branding","method":"PUT"}',
  });
  appendReference(db, {
    ts: '2026-10-10T12:10:00.000Z',
    actorKind: 'preview',
    actorId: 'preview',
    action: 'branding.apply',
    targetType: 'branding',
    targetId: '1',
    outcome: 'success',
    detail: '{"orgNameOld": "M365Portal", "orgNameNew": "Réunion — 日本"}',
  });
}

/** Seeds for the real schema, by the version they populate. A new real version needs the one before it. */
const REAL_SEEDS: Readonly<Record<number, Seed>> = { 0: seedRealVersion0 };

const REAL_FIXTURE: Fixture = {
  name: 'real',
  migrationsFolder: REAL.migrationsFolder,
  snapshotsFolder: REAL.snapshotsFolder,
  seeds: REAL_SEEDS,
};

// ---------------------------------------------------------------------------------------------
// Which pairs to run
// ---------------------------------------------------------------------------------------------

/** The schema versions that have a committed snapshot, ascending. */
function snapshotVersions(snapshotsFolder: string): number[] {
  return readdirSync(snapshotsFolder)
    .map((name) => /^(\d{4})-.+\.sql$/.exec(name)?.[1])
    .filter((digits): digits is string => digits !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
}

/** Every older version N against the next one and against the newest: `[from, to]`. */
function upgradePairsOf(versions: readonly number[]): [number, number][] {
  const newest = versions.at(-1);
  if (newest === undefined) return [];
  const pairs: [number, number][] = [];
  for (const from of versions) {
    if (from === newest) continue;
    pairs.push([from, from + 1]);
    if (from + 1 !== newest) pairs.push([from, newest]);
  }
  return pairs;
}

// ---------------------------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------------------------

class UpgradeFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpgradeFailure';
  }
}

function snapshotText(fixture: Fixture, version: number): string {
  const prefix = String(version).padStart(4, '0');
  const name = readdirSync(fixture.snapshotsFolder).find((file) => file.startsWith(`${prefix}-`));
  if (name === undefined) {
    throw new UpgradeFailure(`no committed snapshot for schema version ${String(version)}`);
  }
  return readFileSync(join(fixture.snapshotsFolder, name), 'utf8');
}

/** Row values the way they are compared: a blob as hex, everything else as it is. */
function normalise(value: unknown): unknown {
  return Buffer.isBuffer(value) ? `hex:${value.toString('hex')}` : value;
}

/** `table` to its rows (as JSON, in rowid order), reading only the columns of `shape`. */
function dumpRows(
  db: SqliteConnection,
  shape: Readonly<Record<string, readonly string[]>>,
): Record<string, string[]> {
  const dump: Record<string, string[]> = {};
  for (const [table, columns] of Object.entries(shape)) {
    const select = `SELECT ${columns.map((column) => `"${column}"`).join(', ')} FROM "${table}" ORDER BY rowid`;
    let rows: Record<string, unknown>[];
    try {
      rows = db.prepare(select).all() as Record<string, unknown>[];
    } catch {
      throw new UpgradeFailure(`table ${table} or one of its columns is gone after the upgrade`);
    }
    dump[table] = rows.map((row) =>
      JSON.stringify(Object.fromEntries(Object.entries(row).map(([k, v]) => [k, normalise(v)]))),
    );
  }
  return dump;
}

function createBookkeeping(
  db: SqliteConnection,
  rows: readonly { hash: string; createdAt: number }[],
): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)',
  );
  const insert = db.prepare(
    'INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES (?, ?)',
  );
  for (const row of rows) insert.run(row.hash, row.createdAt);
}

interface UpgradeInput {
  readonly fixture: Fixture;
  readonly from: number;
  readonly to: number;
  readonly runner?: Runner;
}

/**
 * Upgrade a database from `from` to `to` and throw an `UpgradeFailure` (or a `SchemaMismatchError`)
 * if anything an upgrade can get wrong is wrong.
 */
async function assertUpgradeWorks(input: UpgradeInput): Promise<void> {
  const { fixture, from, to } = input;
  const runner: Runner = input.runner ?? runMigrations;
  const work = mkdtempSync(join(tmpdir(), 'm365portal-upgrade-'));
  const targetFolder = copyMigrationsUpTo(fixture.migrationsFolder, to);
  onTestFinished(() => {
    rmSync(work, { recursive: true, force: true });
    rmSync(targetFolder, { recursive: true, force: true });
  });

  // A database at version N, from the committed snapshot of N.
  const upgraded = new Database(join(work, 'upgrade.sqlite'));
  upgraded.pragma('journal_mode = WAL');
  upgraded.pragma('foreign_keys = ON');
  upgraded.exec(snapshotText(fixture, from));
  const shipped = shippedMigrations(targetFolder);
  createBookkeeping(upgraded, shipped.slice(0, from + 1));

  const seed = fixture.seeds[from];
  if (seed === undefined) {
    throw new UpgradeFailure(
      `no seed for schema version ${String(from)}: add rows for every table of that version to the seeds, an upgrade of an empty database proves nothing`,
    );
  }
  seed(upgraded);

  const before = describeSchema(upgraded);
  const empty = Object.keys(before.tables).filter(
    (table) =>
      (upgraded.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number }).n === 0,
  );
  if (empty.length > 0) {
    throw new UpgradeFailure(
      `the seed leaves no rows in ${empty.join(', ')}: every table needs rows`,
    );
  }
  const shape = Object.fromEntries(
    Object.entries(before.tables).map(([table, description]) => [
      table,
      description.columns.map((column) => column.name),
    ]),
  );
  const rowsBefore = dumpRows(upgraded, shape);

  // The real start-up wrapper.
  const backupsDir = join(work, 'backups');
  try {
    await runner(upgraded, { migrationsFolder: targetFolder, backupsDir });

    // The same schema as a database that was built from the snapshot of the target version.
    const expected = new Database(':memory:');
    try {
      expected.exec(snapshotText(fixture, to));
      assertSchemasAgree(upgraded, expected, { triggers: true });
    } finally {
      expected.close();
    }

    const violations = upgraded.pragma('foreign_key_check') as { table: string }[];
    if (violations.length > 0) {
      throw new UpgradeFailure(`foreign_key_check reports ${String(violations.length)} violations`);
    }

    const rowsAfter = dumpRows(upgraded, shape);
    for (const table of Object.keys(shape)) {
      const was = rowsBefore[table] ?? [];
      const is = rowsAfter[table] ?? [];
      if (JSON.stringify(was) !== JSON.stringify(is)) {
        throw new UpgradeFailure(
          `rows of ${table} changed in the upgrade: ${String(was.length)} before, ${String(is.length)} after`,
        );
      }
    }

    if ('audit_log' in before.tables) {
      const verdict = verifyChainReference(upgraded);
      if (!verdict.ok) {
        throw new UpgradeFailure(`the audit chain is broken at seq ${String(verdict.firstBadSeq)}`);
      }
    }

    if (appliedMigrations(upgraded).length !== to + 1) {
      throw new UpgradeFailure('the migrations are not all recorded');
    }
    if (runner === runMigrations && !existsSync(join(backupsDir, backupFileName(from, to)))) {
      throw new UpgradeFailure(
        `no backup ${backupFileName(from, to)} was taken before the upgrade`,
      );
    }
  } finally {
    upgraded.close();
  }
}

// ---------------------------------------------------------------------------------------------
// The committed snapshot of schema version 0 (FR-A-066)
// ---------------------------------------------------------------------------------------------

describe('the committed snapshot of schema version 0 (FR-A-066)', () => {
  const objects = (type: string): string[] => {
    const db = new Database(':memory:');
    try {
      db.exec(snapshotText(REAL_FIXTURE, 0));
      return (
        db
          .prepare(
            'SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE ? ORDER BY name',
          )
          .all(type, 'sqlite_%') as { name: string }[]
      ).map((row) => row.name);
    } finally {
      db.close();
    }
  };

  it('contains exactly the tables branding, branding_asset and audit_log', () => {
    expect(objects('table')).toEqual(['audit_log', 'branding', 'branding_asset']);
  });

  it('contains their indexes', () => {
    expect(objects('index')).toEqual(['audit_log_hash_uq', 'branding_asset_unreferenced_idx']);
  });

  it('contains the three audit triggers', () => {
    expect(objects('trigger')).toEqual([
      'audit_log_chain_link',
      'audit_log_no_delete',
      'audit_log_no_update',
    ]);
  });

  it('is the snapshot the migrations produce, with the header of the snapshot rule', () => {
    const [name, text] = [...buildSnapshots(REAL.migrationsFolder)][0] ?? [];
    expect(name).toBe(snapshotFileName({ tag: '0000_init' }));
    expect(snapshotText(REAL_FIXTURE, 0)).toBe(text);
    expect(snapshotText(REAL_FIXTURE, 0).split('\n').slice(0, 3)).toEqual([
      '-- schema-version: 0',
      '-- last-migration: 0000_init',
      '-- generated by apps/server/scripts/schema-snapshot.ts; do not edit',
    ]);
  });

  it('contains no bookkeeping table and no sqlite_ object', () => {
    expect(snapshotText(REAL_FIXTURE, 0)).not.toMatch(/__drizzle_migrations|sqlite_/);
  });
});

// ---------------------------------------------------------------------------------------------
// The loop over the real snapshots
// ---------------------------------------------------------------------------------------------

describe('the harness loops over every pair of committed snapshots (done when)', () => {
  const versions = snapshotVersions(REAL.snapshotsFolder);
  const pairs = upgradePairsOf(versions);

  it('pairs every older version with the next one and with the newest', () => {
    expect(upgradePairsOf([])).toEqual([]);
    expect(upgradePairsOf([0])).toEqual([]);
    expect(upgradePairsOf([0, 1])).toEqual([[0, 1]]);
    expect(upgradePairsOf([0, 1, 2])).toEqual([
      [0, 1],
      [0, 2],
      [1, 2],
    ]);
    expect(upgradePairsOf([0, 1, 2, 3])).toEqual([
      [0, 1],
      [0, 3],
      [1, 2],
      [1, 3],
      [2, 3],
    ]);
  });

  it('knows the real versions: Phase A ships one, so there is no real pair yet', () => {
    expect(versions).toEqual([...versions.keys()]);
    // n versions: n - 1 consecutive pairs, and n - 2 more that go to the newest.
    expect(pairs).toHaveLength(Math.max(0, versions.length - 1) + Math.max(0, versions.length - 2));
  });

  it('has a seed for every real version except the newest, so a new version cannot go untested', () => {
    const needed = versions.slice(0, -1);
    expect(Object.keys(REAL_SEEDS).map(Number)).toEqual(expect.arrayContaining(needed));
  });

  it('the seed of version 0 satisfies the real snapshot: every table gets rows and the chain verifies', () => {
    const db = new Database(':memory:');
    try {
      db.pragma('foreign_keys = ON');
      db.exec(snapshotText(REAL_FIXTURE, 0));
      seedRealVersion0(db);
      for (const table of ['audit_log', 'branding', 'branding_asset']) {
        const { n } = db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number };
        expect(n, table).toBeGreaterThan(0);
      }
      expect(verifyChainReference(db)).toMatchObject({ ok: true, checked: 3 });
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it.each(pairs)('upgrades real schema version %i to %i', async (from, to) => {
    await assertUpgradeWorks({ fixture: REAL_FIXTURE, from, to });
  });

  it('upgrades the real schema from version 0 to a rehearsal version 1: the real seed, the real wrapper', async () => {
    // The day the first real version 1 is committed this is what runs for it; until then a version 1
    // that only adds a column (and a snapshot generated from it) shows that the seed of version 0
    // survives the real wrapper and the harness end to end.
    const root = mkdtempSync(join(tmpdir(), 'm365portal-rehearsal-'));
    onTestFinished(() => {
      rmSync(root, { recursive: true, force: true });
    });
    const migrationsFolder = join(root, 'drizzle');
    cpSync(REAL.migrationsFolder, migrationsFolder, { recursive: true });
    writeFileSync(
      join(migrationsFolder, '0001_rehearsal.sql'),
      "ALTER TABLE `branding` ADD `tagline` text DEFAULT '' NOT NULL;\n",
    );
    const journalPath = join(migrationsFolder, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[];
    };
    const [first] = journal.entries;
    if (first === undefined) throw new Error('no migration');
    journal.entries.push({
      idx: 1,
      version: first.version,
      when: first.when + 1000,
      tag: '0001_rehearsal',
      breakpoints: true,
    });
    writeFileSync(journalPath, JSON.stringify(journal));
    const snapshotsFolder = join(root, 'schema-snapshots');
    mkdirSync(snapshotsFolder);
    for (const [name, text] of buildSnapshots(migrationsFolder)) {
      writeFileSync(join(snapshotsFolder, name), text);
    }

    await assertUpgradeWorks({
      fixture: { name: 'real-rehearsal', migrationsFolder, snapshotsFolder, seeds: REAL_SEEDS },
      from: 0,
      to: 1,
    });
  });
});

// ---------------------------------------------------------------------------------------------
// The harness on the synthetic fixtures
// ---------------------------------------------------------------------------------------------

describe('the harness on the synthetic fixtures (FR-A-063)', () => {
  it('upgrades a plain version pair: a new column with a default and an index', async () => {
    await assertUpgradeWorks({ fixture: syntheticFixture('version-pair'), from: 0, to: 1 });
  });

  it('upgrades a table-rebuild pair and keeps the child rows (probe P12)', async () => {
    await assertUpgradeWorks({ fixture: syntheticFixture('table-rebuild-pair'), from: 0, to: 1 });
  });

  it('has snapshots in the good fixtures that are exactly what their migrations produce', () => {
    for (const pair of ['version-pair', 'table-rebuild-pair']) {
      const fixture = syntheticFixture(pair);
      for (const [name, text] of buildSnapshots(fixture.migrationsFolder)) {
        expect(readFileSync(join(fixture.snapshotsFolder, name), 'utf8'), `${pair}/${name}`).toBe(
          text,
        );
      }
    }
  });

  it('has a drifting fixture that differs from its migrations in exactly one default', () => {
    const fixture = syntheticFixture('drifting-pair');
    const generated = [...buildSnapshots(fixture.migrationsFolder)];
    const [, version0] = generated[0] ?? [];
    const [name1, version1] = generated[1] ?? [];
    expect(readFileSync(join(fixture.snapshotsFolder, '0000-base.sql'), 'utf8')).toBe(version0);
    const committed = readFileSync(join(fixture.snapshotsFolder, name1 ?? ''), 'utf8');
    expect(committed).not.toBe(version1);
    expect(committed.replace('DEFAULT 0 NOT NULL', 'DEFAULT 1 NOT NULL')).toBe(version1);
  });

  describe('negative fixtures: the harness must fail', () => {
    it('on the drifting pair: SQL says DEFAULT 1, the snapshot of the target says DEFAULT 0', async () => {
      await expectGuardFails(
        assertUpgradeWorks,
        { fixture: syntheticFixture('drifting-pair'), from: 0, to: 1 },
        {
          name: 'upgrade harness',
          reason: /owner\.rank default: '?1'? against '?0'?/,
        },
      );
      await expect(
        assertUpgradeWorks({ fixture: syntheticFixture('drifting-pair'), from: 0, to: 1 }),
      ).rejects.toBeInstanceOf(SchemaMismatchError);
    });

    /**
     * A runner that migrates the way the stock migrator does: foreign keys as the connection has
     * them (on), everything in one transaction, no wrapper. It is the thing the wrapper replaces.
     */
    const stockLikeRunner: Runner = (db, { migrationsFolder }) => {
      const applied = appliedMigrations(db).length;
      db.exec('BEGIN');
      for (const migration of shippedMigrations(migrationsFolder).slice(applied)) {
        const sql = readFileSync(join(migrationsFolder, `${migration.tag}.sql`), 'utf8');
        for (const statement of sql.split('--> statement-breakpoint')) db.exec(statement);
        db.prepare('INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES (?, ?)').run(
          migration.hash,
          migration.createdAt,
        );
      }
      db.exec('COMMIT');
      return Promise.resolve();
    };

    it('on the table-rebuild pair when the migrations run with foreign keys on: the pets are deleted (probe P12)', async () => {
      await expectGuardFails(
        assertUpgradeWorks,
        {
          fixture: syntheticFixture('table-rebuild-pair'),
          from: 0,
          to: 1,
          runner: stockLikeRunner,
        },
        {
          name: 'upgrade harness',
          reason: /rows of pet changed in the upgrade: 3 before, 0 after/,
        },
      );
    });

    it('passes the plain pair through the stock-like runner (the control breaks only the foreign keys)', async () => {
      await assertUpgradeWorks({
        fixture: syntheticFixture('version-pair'),
        from: 0,
        to: 1,
        runner: stockLikeRunner,
      });
    });

    /** The real wrapper, and then one thing goes wrong that the wrapper cannot see. */
    const thenDamage =
      (damage: (db: SqliteConnection) => void): Runner =>
      async (db, options) => {
        await runMigrations(db, options);
        damage(db);
      };

    it('when a trigger is missing after the upgrade', async () => {
      await expectGuardFails(
        assertUpgradeWorks,
        {
          fixture: syntheticFixture('version-pair'),
          from: 0,
          to: 1,
          runner: thenDamage((db) => {
            db.exec('DROP TRIGGER audit_log_no_delete');
          }),
        },
        { name: 'upgrade harness', reason: /trigger audit_log_no_delete exists only/ },
      );
    });

    it('when a seeded row is lost', async () => {
      await expectGuardFails(
        assertUpgradeWorks,
        {
          fixture: syntheticFixture('version-pair'),
          from: 0,
          to: 1,
          runner: thenDamage((db) => {
            db.exec('DELETE FROM pet WHERE id = 3');
          }),
        },
        {
          name: 'upgrade harness',
          reason: /rows of pet changed in the upgrade: 3 before, 2 after/,
        },
      );
    });

    it('when a seeded value changes', async () => {
      await expectGuardFails(
        assertUpgradeWorks,
        {
          fixture: syntheticFixture('version-pair'),
          from: 0,
          to: 1,
          runner: thenDamage((db) => {
            db.exec("UPDATE owner SET name = 'mallory' WHERE id = 1");
          }),
        },
        { name: 'upgrade harness', reason: /rows of owner changed/ },
      );
    });

    it('when the audit chain does not verify (a row whose hash is not the hash of its content)', async () => {
      await expectGuardFails(
        assertUpgradeWorks,
        {
          fixture: {
            ...syntheticFixture('version-pair'),
            seeds: {
              0: (db) => {
                seedSyntheticVersion0(db);
                const head = db
                  .prepare('SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1')
                  .get() as {
                  seq: number;
                  hash: Buffer;
                };
                // The triggers check seq and prev_hash only; a wrong hash gets past them.
                db.prepare(
                  `INSERT INTO audit_log (seq, ts, actor_kind, actor_id, action, outcome, prev_hash, hash)
                   VALUES (?, '2026-10-10T12:00:03.000Z', 'system', 'system', 'owner.forged', 'success', ?, ?)`,
                ).run(head.seq + 1, head.hash, Buffer.alloc(32, 7));
              },
            },
          },
          from: 0,
          to: 1,
        },
        { name: 'upgrade harness', reason: /the audit chain is broken at seq 4/ },
      );
    });

    it('when an upgrade rewrites an audit entry', async () => {
      await expectGuardFails(
        assertUpgradeWorks,
        {
          fixture: syntheticFixture('version-pair'),
          from: 0,
          to: 1,
          runner: thenDamage((db) => {
            // The triggers are dropped and put back, as someone with file access could.
            const triggers = db
              .prepare(
                "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'audit_log_no_update'",
              )
              .all() as { sql: string }[];
            db.exec('DROP TRIGGER audit_log_no_update');
            db.exec("UPDATE audit_log SET actor_id = 'mallory' WHERE seq = 2");
            for (const trigger of triggers) db.exec(trigger.sql);
          }),
        },
        { name: 'upgrade harness', reason: /rows of audit_log changed/ },
      );
    });

    it('when a foreign key is violated afterwards', async () => {
      await expectGuardFails(
        assertUpgradeWorks,
        {
          fixture: syntheticFixture('version-pair'),
          from: 0,
          to: 1,
          runner: thenDamage((db) => {
            db.pragma('foreign_keys = OFF');
            db.exec("INSERT INTO pet (id, owner_id, name) VALUES (99, 12345, 'orphan')");
          }),
        },
        { name: 'upgrade harness', reason: /foreign_key_check reports 1 violations/ },
      );
    });

    it('when the upgrade is a no-op against a target that needs one (a runner that migrates nothing)', async () => {
      await expectGuardFails(
        assertUpgradeWorks,
        {
          fixture: syntheticFixture('version-pair'),
          from: 0,
          to: 1,
          runner: () => Promise.resolve(),
        },
        { name: 'upgrade harness', reason: /owner\.label exists only/ },
      );
    });

    it('when there is no seed for the version (an empty database proves nothing)', async () => {
      await expectGuardFails(
        assertUpgradeWorks,
        { fixture: { ...syntheticFixture('version-pair'), seeds: {} }, from: 0, to: 1 },
        { name: 'upgrade harness', reason: /no seed for schema version 0/ },
      );
    });

    it('when the seed leaves a table empty', async () => {
      await expectGuardFails(
        assertUpgradeWorks,
        {
          fixture: {
            ...syntheticFixture('version-pair'),
            seeds: {
              0: (db) => {
                seedSyntheticVersion0(db);
                // Not possible through the triggers for audit_log, so empty the plain child table.
                db.exec('DELETE FROM pet');
              },
            },
          },
          from: 0,
          to: 1,
        },
        { name: 'upgrade harness', reason: /no rows in pet|leaves no rows in pet/ },
      );
    });

    it('when the snapshot of a version is missing', async () => {
      await expectGuardFails(
        assertUpgradeWorks,
        {
          fixture: {
            ...syntheticFixture('version-pair'),
            snapshotsFolder: join(SYNTHETIC, 'nowhere'),
          },
          from: 0,
          to: 1,
        },
        { name: 'upgrade harness', reason: /ENOENT|no committed snapshot/ },
      );
    });
  });
});

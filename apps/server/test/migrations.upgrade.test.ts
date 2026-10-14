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
// version, so there was no real pair: the harness is proven on the synthetic fixtures of
// `fixtures/migrations-synthetic/`, and the content of the committed snapshot of version 0 is
// asserted directly (FR-A-066). Phase B adds the first real pair, 0000 to 0001 (T-B-012, FR-B-701),
// with its own describe block below: the database of an installed Phase A, upgraded by the real
// wrapper, with the facts that pair has to keep (Phase A objects byte for byte, files, the audit
// chain, the backup) and the facts it adds (built-in roles, the epoch, 29 triggers).
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
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILTIN_ROLES, TEMPLATES } from '@m365portal/shared/rbac/roles';
import { expectGuardFails } from '@m365portal/shared/testing';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import {
  buildSnapshots,
  copyMigrationsUpTo,
  defaultPaths,
  snapshotFileName,
} from '../scripts/schema-snapshot.js';
import { verifyChain } from '../src/audit/chain.js';
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
  /**
   * Tables a migration INTO a version seeds with new rows (by target version): the rows that were there stay
   * as they were and the new ones come after them. Every other table must be unchanged.
   */
  readonly appends?: Readonly<Record<number, readonly string[]>>;
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
  // Phase A installs wrote these too: more `preview` rows, and denials with the Phase A reason.
  appendReference(db, {
    ts: '2026-10-10T12:15:00.000Z',
    actorKind: 'preview',
    actorId: 'preview',
    action: 'branding.upload',
    targetType: 'branding_asset',
    targetId: 'a'.repeat(64),
    outcome: 'success',
    detail: '{"slot":"logoLight"}',
  });
  appendReference(db, {
    ts: '2026-10-10T12:20:00.000Z',
    actorKind: 'anonymous',
    actorId: 'anonymous',
    action: 'branding.reset',
    targetType: 'branding',
    targetId: '1',
    outcome: 'denied',
    reasonCode: 'permission_denied',
    clientIp: '203.0.113.7',
    requestId: 'req-0000-0003',
    detail: '{"permission":"settings:branding","method":"POST"}',
  });
  appendReference(db, {
    ts: '2026-10-10T12:25:00.000Z',
    actorKind: 'preview',
    actorId: 'preview',
    action: 'branding.apply',
    targetType: 'branding',
    targetId: '1',
    outcome: 'success',
    detail: '{"orgNameOld": "Réunion — 日本", "orgNameNew": "M365Portal"}',
  });
}

const SEED_NOW = '2026-10-11T09:00:00.000Z';
const seedGuid = (n: number): string =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

/**
 * The rows of schema version 1 (migration 0001_phase_b): everything of version 0, and a row in every table of
 * Phase B, the seeded roles included (a snapshot holds the DDL only, so the seeds of 0001 are run here, with
 * the two triggers that protect the built-in roles taken out for the moment and put back as they were).
 */
function seedRealVersion1(db: SqliteConnection): void {
  seedRealVersion0(db);

  const guarded = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name IN ('rbac_role_builtin_no_insert_flag', 'rbac_role_permission_builtin_no_insert')",
    )
    .all() as { sql: string }[];
  db.exec(
    'DROP TRIGGER `rbac_role_builtin_no_insert_flag`; DROP TRIGGER `rbac_role_permission_builtin_no_insert`;',
  );
  const migration = readFileSync(join(REAL.migrationsFolder, '0001_phase_b.sql'), 'utf8');
  for (const statement of migration.split('--> statement-breakpoint')) {
    const text = statement
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
      .trim();
    if (/^INSERT INTO `rbac_(epoch|role|role_permission|role_template)`/.test(text)) db.exec(text);
  }
  for (const trigger of guarded) db.exec(trigger.sql);

  db.prepare(
    'INSERT INTO secret (id, purpose, key_id, blob, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(
    seedGuid(20),
    'certificate_key',
    'c743d54d05bd4d72',
    Buffer.concat([Buffer.from([1]), Buffer.alloc(40, 7)]),
    SEED_NOW,
  );
  db.prepare(
    `INSERT INTO certificate (id, secret_id, thumbprint_sha1, thumbprint_sha256, subject, not_before, not_after, public_der, state, created_at)
     VALUES (?, ?, ?, ?, 'CN=M365Portal 00000000', ?, '2027-10-10T12:00:00.000Z', ?, 'active', ?)`,
  ).run(
    seedGuid(21),
    seedGuid(20),
    'a'.repeat(40),
    'b'.repeat(64),
    SEED_NOW,
    Buffer.alloc(300, 9),
    SEED_NOW,
  );
  db.prepare(
    `INSERT INTO tenant_connection (id, tenant_id, tenant_name, certificate_id, updated_at) VALUES (1, ?, 'Contoso', ?, ?)`,
  ).run(seedGuid(1), seedGuid(21), SEED_NOW);
  db.prepare(
    "INSERT INTO setup_state (id, state, mode, install_id, updated_at) VALUES (1, 'unconfigured', 'automatic', ?, ?)",
  ).run('a'.repeat(32), SEED_NOW);
  db.prepare(
    "INSERT INTO setup_step (step, sub_action, status, updated_at) VALUES ('connect', 'device_code', 'succeeded', ?)",
  ).run(SEED_NOW);
  db.prepare(
    "INSERT INTO setup_log (seq, ts, step, level, message_key, params) VALUES (1, ?, 'connect', 'info', 'setup.log.x', '{\"n\":1}')",
  ).run(SEED_NOW);
  db.prepare(
    "INSERT INTO setup_object (kind, tenant_object_id, name, origin, created_at) VALUES ('application', ?, 'M365Portal', 'created', ?)",
  ).run(seedGuid(22), SEED_NOW);
  db.prepare(
    'INSERT INTO runner_lease (id, holder, heartbeat_at, expires_at) VALUES (1, ?, ?, ?)',
  ).run('holder-1', SEED_NOW, '2026-10-11T09:01:00.000Z');
  db.prepare(
    'INSERT INTO app_user (tid, oid, upn_label, name_label, first_seen_at, last_signin_at, groups_resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    seedGuid(1),
    seedGuid(30),
    'olivia@contoso.test',
    'Olivia Owner',
    SEED_NOW,
    SEED_NOW,
    SEED_NOW,
  );
  db.prepare(
    `INSERT INTO session (id_hash, kind, tid, oid, created_at, last_seen_at, absolute_expires_at, authenticated_at)
     VALUES (?, 'user', ?, ?, ?, ?, '2026-10-11T17:00:00.000Z', ?)`,
  ).run('a'.repeat(64), seedGuid(1), seedGuid(30), SEED_NOW, SEED_NOW, SEED_NOW);
  const assignment = db.prepare(
    `INSERT INTO rbac_assignment (id, principal_type, principal_id, role_id, scope_hash, expires_at, source, created_at, created_by)
     VALUES (?, ?, ?, (SELECT id FROM rbac_role WHERE key = ?), ?, NULL, ?, ?, 'setup')`,
  );
  assignment.run(seedGuid(40), 'user', seedGuid(30), 'owner', '0'.repeat(64), 'wizard', SEED_NOW);
  assignment.run(seedGuid(41), 'group', seedGuid(31), 'helpdesk', '1'.repeat(64), 'api', SEED_NOW);
  db.prepare(
    "INSERT INTO rbac_assignment_scope (assignment_id, position, target, match_by, attr, value) VALUES (?, 0, 'group', 'id', '', ?)",
  ).run(seedGuid(41), seedGuid(32));
  db.prepare(
    'INSERT INTO rbac_group_member_cache (user_oid, group_id, resolved_at) VALUES (?, ?, ?)',
  ).run(seedGuid(30), seedGuid(31), SEED_NOW);
  // The seeds above ran through the epoch triggers; 0001 itself left the epoch at 0.
  db.exec('UPDATE `rbac_epoch` SET `epoch` = 0 WHERE `id` = 1');
}

/** Seeds for the real schema, by the version they populate. A new real version needs the one before it. */
const REAL_SEEDS: Readonly<Record<number, Seed>> = { 0: seedRealVersion0, 1: seedRealVersion1 };

const REAL_FIXTURE: Fixture = {
  name: 'real',
  migrationsFolder: REAL.migrationsFolder,
  snapshotsFolder: REAL.snapshotsFolder,
  seeds: REAL_SEEDS,
  // Migration 0002 adds the sixth built-in role and its permissions (ADR-0183).
  appends: { 2: ['rbac_role', 'rbac_role_permission'] },
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
      if (fixture.appends?.[to]?.includes(table) === true) {
        const kept = is.slice(0, was.length);
        if (JSON.stringify(was) !== JSON.stringify(kept) || is.length <= was.length) {
          throw new UpgradeFailure(
            `rows of ${table} were not kept and extended in the upgrade: ${String(was.length)} before, ${String(is.length)} after`,
          );
        }
        continue;
      }
      if (JSON.stringify(was) !== JSON.stringify(is)) {
        throw new UpgradeFailure(
          `rows of ${table} changed in the upgrade: ${String(was.length)} before, ${String(is.length)} after`,
        );
      }
    }

    if ('audit_log' in before.tables) {
      // The verifier the image ships (`verify-audit`), and the independent reference beside it.
      for (const verdict of [verifyChain(upgraded), verifyChainReference(upgraded)]) {
        if (!verdict.ok) {
          throw new UpgradeFailure(
            `the audit chain is broken at seq ${String(verdict.firstBadSeq)}`,
          );
        }
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

  it('knows the real versions: schema version 0 is Phase A, version 1 is migration 0001_phase_b', () => {
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
      expect(verifyChainReference(db)).toMatchObject({ ok: true, checked: 6 });
      expect(verifyChain(db)).toEqual({ ok: true, checked: 6, triggersMissing: [] });
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it.each(pairs)('upgrades real schema version %i to %i', async (from, to) => {
    await assertUpgradeWorks({ fixture: REAL_FIXTURE, from, to });
  });

  it('upgrades the real schema from version 0 to a rehearsal version 2: the real seed, the real wrapper', async () => {
    // The day the next real version is committed this is what runs for it; until then a version 2
    // that only adds a column (and a snapshot generated from it) shows that the seed of version 0
    // survives the real wrapper and the harness end to end, on top of the real 0001.
    const root = mkdtempSync(join(tmpdir(), 'm365portal-rehearsal-'));
    onTestFinished(() => {
      rmSync(root, { recursive: true, force: true });
    });
    const migrationsFolder = join(root, 'drizzle');
    cpSync(REAL.migrationsFolder, migrationsFolder, { recursive: true });
    writeFileSync(
      join(migrationsFolder, '0002_rehearsal.sql'),
      "ALTER TABLE `branding` ADD `tagline` text DEFAULT '' NOT NULL;\n",
    );
    const journalPath = join(migrationsFolder, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[];
    };
    const last = journal.entries[journal.entries.length - 1];
    if (last === undefined) throw new Error('no migration');
    journal.entries.push({
      idx: journal.entries.length,
      version: last.version,
      when: last.when + 1000,
      tag: '0002_rehearsal',
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
      to: 2,
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

// ---------------------------------------------------------------------------------------------
// The first real pair: Phase A (schema version 0) to migration 0001_phase_b (T-B-012, FR-B-701)
// ---------------------------------------------------------------------------------------------

/** The Phase A objects of `sqlite_master`, as stored text: tables, indexes and the three triggers. */
function phaseAObjectsOf(db: SqliteConnection): Record<string, string | null> {
  const rows = db
    .prepare(
      `SELECT type, name, sql FROM sqlite_master
       WHERE name IN ('branding', 'branding_asset', 'audit_log', 'audit_log_hash_uq',
                      'branding_asset_unreferenced_idx', 'audit_log_no_update', 'audit_log_no_delete',
                      'audit_log_chain_link')
       ORDER BY type, name`,
    )
    .all() as { type: string; name: string; sql: string | null }[];
  return Object.fromEntries(rows.map((row) => [`${row.type} ${row.name}`, row.sql]));
}

/** Throws unless the Phase A objects are byte for byte what they were (data-model 4 item 5). */
function assertPhaseAObjectsIdentical(
  before: Record<string, string | null>,
  after: Record<string, string | null>,
): void {
  expect(Object.keys(before)).toHaveLength(8);
  const problems: string[] = [];
  for (const key of Object.keys(before)) {
    if (after[key] === undefined) problems.push(`${key} is gone`);
    else if (after[key] !== before[key]) problems.push(`${key} was rewritten`);
  }
  if (problems.length > 0) throw new Error(`Phase A objects changed: ${problems.join('; ')}`);
}

interface BuiltinRows {
  readonly roles: readonly string[];
  readonly permissions: Readonly<Record<string, readonly string[]>>;
}

/** The role rows of a migrated database, in the shape of `BUILTIN_ROLES` (qualifier `''` is `full`). */
function builtinRowsOf(db: SqliteConnection): BuiltinRows {
  const roles = (
    db.prepare('SELECT key FROM rbac_role WHERE builtin = 1 ORDER BY id').all() as { key: string }[]
  ).map((row) => row.key);
  const permissions: Record<string, string[]> = {};
  for (const row of db
    .prepare(
      `SELECT r.key AS role, p.permission, p.qualifier FROM rbac_role_permission p
       JOIN rbac_role r ON r.id = p.role_id ORDER BY r.id, p.rowid`,
    )
    .all() as { role: string; permission: string; qualifier: string }[]) {
    (permissions[row.role] ??= []).push(
      `${row.permission}${row.qualifier === '' ? '' : `:${row.qualifier}`}`,
    );
  }
  return { roles, permissions };
}

/** Throws unless the seeded rows are the constant `BUILTIN_ROLES` (I-B1). */
function assertBuiltinRolesMatch(rows: BuiltinRows, expected: typeof BUILTIN_ROLES): void {
  expect(rows.roles).toEqual(expected.map((role) => role.key));
  for (const role of expected) {
    const wanted = role.permissions.map(
      (entry) => `${entry.permission}${entry.qualifier === 'full' ? '' : `:${entry.qualifier}`}`,
    );
    expect([...(rows.permissions[role.key] ?? [])].sort(), role.key).toEqual([...wanted].sort());
  }
}

describe('the real upgrade 0000 to 0001_phase_b (FR-B-701, SC-B-012, EB-29)', () => {
  const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
  const LOGO = Buffer.from('not really a png, but the bytes the name is the hash of: logo');
  const ICON = Buffer.from('not really a png, but the bytes the name is the hash of: icon');
  const LOGO_HASH = sha256(LOGO);
  const ICON_HASH = sha256(ICON);

  let work = '';
  let db: SqliteConnection;
  let objectsBefore: Record<string, string | null> = {};
  let rowsBefore: Record<string, string[]> = {};
  let backupsDir = '';
  let migrationsFolder = '';
  let firstResult: { readonly applied: readonly string[] } | undefined;
  let secondResult: { readonly applied: readonly string[] } | undefined;

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'm365portal-upgrade-0001-'));
    // Exactly the pair this block is about: migrations 0000 and 0001, whatever has been added since.
    migrationsFolder = copyMigrationsUpTo(REAL.migrationsFolder, 1);
    backupsDir = join(work, 'backups');

    // The files of an installed Phase A: logos named by the hash of their content.
    mkdirSync(join(work, 'branding'));
    writeFileSync(join(work, 'branding', `${LOGO_HASH}.png`), LOGO);
    writeFileSync(join(work, 'branding', `${ICON_HASH}.png`), ICON);

    db = new Database(join(work, 'm365portal.sqlite'));
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(snapshotText(REAL_FIXTURE, 0));
    createBookkeeping(db, shippedMigrations(copyMigrationsUpTo(migrationsFolder, 0)));

    // A branding row with the assets it references, one staged asset, and the audit chain (6 entries,
    // `preview` actor rows and a denial with the Phase A reason `permission_denied`).
    const asset = db.prepare(
      `INSERT INTO branding_asset (sha256, bytes, width, height, luminance, created_at, unreferenced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    asset.run(LOGO_HASH, LOGO.length, 512, 512, 0.4, '2026-10-10T12:00:00.000Z', null);
    asset.run(ICON_HASH, ICON.length, 192, 192, null, '2026-10-10T12:01:00.000Z', null);
    asset.run(
      'c'.repeat(64),
      1024,
      128,
      128,
      null,
      '2026-10-10T12:05:00.000Z',
      '2026-10-10T12:05:00.000Z',
    );
    db.prepare(
      `INSERT INTO branding (id, revision, org_name, accent, logo_light, logo_dark, logo_compact,
         logo_compact_derived, icon_favicon32, icon_apple180, icon_pwa192, icon_pwa512,
         icon_maskable512, updated_at, updated_by_kind, updated_by_id)
       VALUES (1, 3, ?, '#2563eb', ?, ?, ?, 1, ?, ?, ?, ?, ?, '2026-10-10T12:10:00.000Z', 'preview', 'preview')`,
    ).run(
      'Réunion — 日本',
      LOGO_HASH,
      LOGO_HASH,
      LOGO_HASH,
      ICON_HASH,
      ICON_HASH,
      ICON_HASH,
      ICON_HASH,
      ICON_HASH,
    );
    seedAuditChain(db);

    objectsBefore = phaseAObjectsOf(db);
    rowsBefore = dumpRows(db, {
      branding: [
        'id',
        'revision',
        'org_name',
        'accent',
        'logo_light',
        'icon_pwa512',
        'updated_by_kind',
      ],
      branding_asset: ['sha256', 'bytes', 'width', 'height', 'created_at', 'unreferenced_at'],
      audit_log: [
        'seq',
        'ts',
        'actor_kind',
        'actor_id',
        'action',
        'outcome',
        'reason_code',
        'detail',
        'hash',
      ],
    });
    expect(verifyChain(db)).toMatchObject({ ok: true, checked: 6 });

    // The real start-up wrapper, twice.
    firstResult = await runMigrations(db, { migrationsFolder, backupsDir });
    secondResult = await runMigrations(db, { migrationsFolder, backupsDir });
  }, 60_000);

  afterAll(() => {
    if (db.open) db.close();
    rmSync(work, { recursive: true, force: true });
    rmSync(migrationsFolder, { recursive: true, force: true });
  });

  function seedAuditChain(target: SqliteConnection): void {
    // The first three entries of the real seed, then three more (preview rows, a denial).
    const entries: Parameters<typeof appendReference>[1][] = [
      {
        ts: '2026-10-10T12:00:00.000Z',
        actorKind: 'system',
        actorId: 'system',
        action: 'branding.init',
        targetType: 'branding',
        targetId: '1',
        outcome: 'success',
        detail: '{"revision":1}',
      },
      {
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
      },
      {
        ts: '2026-10-10T12:10:00.000Z',
        actorKind: 'preview',
        actorId: 'preview',
        action: 'branding.apply',
        targetType: 'branding',
        targetId: '1',
        outcome: 'success',
        detail: '{"orgNameOld": "M365Portal", "orgNameNew": "Réunion — 日本"}',
      },
      {
        ts: '2026-10-10T12:15:00.000Z',
        actorKind: 'preview',
        actorId: 'preview',
        action: 'branding.upload',
        targetType: 'branding_asset',
        targetId: LOGO_HASH,
        outcome: 'success',
        detail: '{"slot":"logoLight"}',
      },
      {
        ts: '2026-10-10T12:20:00.000Z',
        actorKind: 'anonymous',
        actorId: 'anonymous',
        action: 'branding.reset',
        targetType: 'branding',
        targetId: '1',
        outcome: 'denied',
        reasonCode: 'permission_denied',
        clientIp: '203.0.113.7',
        requestId: 'req-0000-0003',
        detail: '{"permission":"settings:branding","method":"POST"}',
      },
      {
        ts: '2026-10-10T12:25:00.000Z',
        actorKind: 'preview',
        actorId: 'preview',
        action: 'branding.apply',
        targetType: 'branding',
        targetId: '1',
        outcome: 'success',
        detail: '{"orgNameOld": "Réunion — 日本", "orgNameNew": "M365Portal"}',
      },
    ];
    for (const entry of entries) appendReference(target, entry);
  }

  it('applies exactly 0001_phase_b, takes the backup of the Phase A database and applies nothing on a second start', () => {
    expect(firstResult?.applied).toEqual(['0001_phase_b']);
    expect(secondResult?.applied).toEqual([]);
    expect(appliedMigrations(db)).toHaveLength(2);
  });

  it('has tables, columns, indexes, foreign keys and trigger SQL of a database built from snapshot 1', () => {
    const expected = new Database(':memory:');
    try {
      expected.exec(snapshotText(REAL_FIXTURE, 1));
      expect(() => {
        assertSchemasAgree(db, expected, { triggers: true });
      }).not.toThrow();
    } finally {
      expected.close();
    }
  });

  it('has an empty foreign_key_check', () => {
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('keeps the branding row and its assets, and the files still hash to their names', () => {
    const rowsAfter = dumpRows(db, {
      branding: [
        'id',
        'revision',
        'org_name',
        'accent',
        'logo_light',
        'icon_pwa512',
        'updated_by_kind',
      ],
      branding_asset: ['sha256', 'bytes', 'width', 'height', 'created_at', 'unreferenced_at'],
      audit_log: [
        'seq',
        'ts',
        'actor_kind',
        'actor_id',
        'action',
        'outcome',
        'reason_code',
        'detail',
        'hash',
      ],
    });
    expect(rowsAfter).toEqual(rowsBefore);
    expect(rowsAfter.branding_asset).toHaveLength(3);
    for (const hash of [LOGO_HASH, ICON_HASH]) {
      const file = readFileSync(join(work, 'branding', `${hash}.png`));
      expect(sha256(file)).toBe(hash);
    }
  });

  it('leaves the text of the Phase A objects in sqlite_master byte for byte as it was', () => {
    expect(() => {
      assertPhaseAObjectsIdentical(objectsBefore, phaseAObjectsOf(db));
    }).not.toThrow();
  });

  it('verifies the old chain (preview rows and the permission_denied denial included) and extends it with setup.unlock', () => {
    expect(verifyChain(db)).toMatchObject({ ok: true, checked: 6 });
    expect(verifyChainReference(db)).toMatchObject({ ok: true, checked: 6 });
    appendReference(db, {
      ts: '2026-10-10T13:00:00.000Z',
      actorKind: 'setup',
      actorId: 'setup',
      action: 'setup.unlock',
      targetType: 'setup',
      targetId: '',
      outcome: 'success',
      detail: '{"lockScope":"client"}',
    });
    expect(verifyChain(db)).toMatchObject({ ok: true, checked: 7 });
    expect(verifyChainReference(db)).toMatchObject({ ok: true, checked: 7 });
    const kinds = db
      .prepare('SELECT DISTINCT actor_kind FROM audit_log ORDER BY actor_kind')
      .all() as { actor_kind: string }[];
    expect(kinds.map((row) => row.actor_kind)).toEqual(['anonymous', 'preview', 'setup', 'system']);
    expect(
      db
        .prepare("SELECT count(*) AS n FROM audit_log WHERE reason_code = 'permission_denied'")
        .get(),
    ).toEqual({ n: 2 });
  });

  it('left backups/pre-migrate-0000-0001.sqlite, a database of Phase A that opens', () => {
    const backup = join(backupsDir, 'pre-migrate-0000-0001.sqlite');
    expect(existsSync(backup)).toBe(true);
    const copy = new Database(backup, { readonly: true });
    try {
      const tables = (
        copy.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
          name: string;
        }[]
      ).map((row) => row.name);
      expect(tables).toContain('audit_log');
      expect(tables).not.toContain('rbac_role');
      expect(copy.prepare('SELECT count(*) AS n FROM audit_log').get()).toEqual({ n: 6 });
    } finally {
      copy.close();
    }
  });

  it('seeds the built-in roles equal to BUILTIN_ROLES, the template board, and rbac_epoch (1, 0)', () => {
    expect(() => {
      // Migration 0001 seeded the first five; the sixth comes with 0002 (tested below).
      assertBuiltinRolesMatch(builtinRowsOf(db), BUILTIN_ROLES.slice(0, 5));
    }).not.toThrow();
    const template = db
      .prepare("SELECT permissions, scope_target FROM rbac_role_template WHERE key = 'board'")
      .get() as {
      permissions: string;
      scope_target: string;
    };
    expect(template.scope_target).toBe(TEMPLATES[0]?.scopeTarget);
    expect(
      (JSON.parse(template.permissions) as { permission: string; qualifier?: string }[]).map(
        (entry) =>
          `${entry.permission}${entry.qualifier === undefined ? '' : `:${entry.qualifier}`}`,
      ),
    ).toEqual(
      (TEMPLATES[0]?.permissions ?? []).map(
        (entry) => `${entry.permission}${entry.qualifier === 'full' ? '' : `:${entry.qualifier}`}`,
      ),
    );
    expect(db.prepare('SELECT id, epoch FROM rbac_epoch').all()).toEqual([{ id: 1, epoch: 0 }]);
  });

  it('has the 29 triggers of Phase B next to the 3 of Phase A', () => {
    expect(
      db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger'").get(),
    ).toEqual({ n: 32 });
  });

  it('keeps the synthetic drifting fixture failing: the harness still catches a default that differs', async () => {
    await expectGuardFails(
      async () => {
        await assertUpgradeWorks({ fixture: syntheticFixture('drifting-pair'), from: 0, to: 1 });
      },
      undefined,
      { name: 'drifting-pair harness', reason: /default/ },
    );
  });

  describe('negative fixtures: the guards of this block must fail', () => {
    it('fails when a Phase A object is rewritten or gone', () => {
      const rewritten = {
        ...objectsBefore,
        'table branding': `${objectsBefore['table branding'] ?? ''} `,
      };
      expectGuardFails(
        () => {
          assertPhaseAObjectsIdentical(objectsBefore, rewritten);
        },
        undefined,
        { name: 'phase A objects', reason: 'table branding was rewritten' },
      );
      const without = Object.fromEntries(
        Object.entries(objectsBefore).filter(([key]) => key !== 'trigger audit_log_chain_link'),
      );
      expectGuardFails(
        () => {
          assertPhaseAObjectsIdentical(objectsBefore, without);
        },
        undefined,
        { name: 'phase A objects', reason: 'trigger audit_log_chain_link is gone' },
      );
    });

    it('fails when one permission of a built-in role differs from the constant', () => {
      const rows = builtinRowsOf(db);
      const changed: BuiltinRows = {
        roles: rows.roles,
        permissions: {
          ...rows.permissions,
          reader: (rows.permissions.reader ?? []).filter(
            (permission) => permission !== 'contacts:read',
          ),
        },
      };
      expectGuardFails(
        () => {
          assertBuiltinRolesMatch(changed, BUILTIN_ROLES.slice(0, 5));
        },
        undefined,
        { name: 'built-in roles', reason: /reader/ },
      );
    });

    it('fails on a database whose chain was broken by hand', () => {
      const copy = new Database(':memory:');
      try {
        copy.exec(snapshotText(REAL_FIXTURE, 0));
        seedAuditChain(copy);
        copy.exec('DROP TRIGGER audit_log_no_update');
        copy.exec("UPDATE audit_log SET detail = '{}' WHERE seq = 3");
        expect(verifyChain(copy).ok).toBe(false);
      } finally {
        copy.close();
      }
    });
  });
});

// ---------------------------------------------------------------------------------------------
// The real upgrade 0001 to 0002_dl_editor_role (FR-B-501, ADR-0183)
// ---------------------------------------------------------------------------------------------

describe('the real upgrade 0001 to 0002_dl_editor_role (FR-B-501, ADR-0183)', () => {
  let work = '';
  let db: SqliteConnection;
  let folder = '';
  let rowsBefore: Record<string, string[]> = {};
  let firstResult: { readonly applied: readonly string[] } | undefined;
  let secondResult: { readonly applied: readonly string[] } | undefined;

  const ASSIGNMENT_SHAPE = {
    rbac_assignment: ['id', 'principal_type', 'principal_id', 'role_id', 'scope_hash', 'source'],
    rbac_assignment_scope: ['assignment_id', 'position', 'target', 'match_by', 'value'],
    rbac_epoch: ['id', 'epoch'],
    rbac_role_template: ['key', 'permissions', 'scope_target'],
    app_user: ['tid', 'oid', 'upn_label'],
    session: ['id_hash', 'kind', 'oid'],
  } as const;

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'm365portal-upgrade-0002-'));
    folder = copyMigrationsUpTo(REAL.migrationsFolder, 2);
    db = new Database(join(work, 'm365portal.sqlite'));
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(snapshotText(REAL_FIXTURE, 1));
    createBookkeeping(db, shippedMigrations(copyMigrationsUpTo(REAL.migrationsFolder, 1)));
    seedRealVersion1(db);
    rowsBefore = dumpRows(db, ASSIGNMENT_SHAPE);
    firstResult = await runMigrations(db, {
      migrationsFolder: folder,
      backupsDir: join(work, 'backups'),
    });
    secondResult = await runMigrations(db, {
      migrationsFolder: folder,
      backupsDir: join(work, 'backups'),
    });
  }, 60_000);

  afterAll(() => {
    if (db.open) db.close();
    rmSync(work, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
  });

  it('applies exactly 0002_dl_editor_role, takes a backup first and applies nothing on a second start', () => {
    expect(firstResult?.applied).toEqual(['0002_dl_editor_role']);
    expect(secondResult?.applied).toEqual([]);
    expect(appliedMigrations(db)).toHaveLength(3);
    expect(existsSync(join(work, 'backups', backupFileName(1, 2)))).toBe(true);
  });

  it('has the schema of a database built from snapshot 2 and an empty foreign_key_check', () => {
    const expected = new Database(':memory:');
    try {
      expected.exec(snapshotText(REAL_FIXTURE, 2));
      expect(() => {
        assertSchemasAgree(db, expected, { triggers: true });
      }).not.toThrow();
    } finally {
      expected.close();
    }
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('seeds six built-in roles equal to BUILTIN_ROLES, the sixth being dl_editor with its seven permissions', () => {
    assertBuiltinRolesMatch(builtinRowsOf(db), BUILTIN_ROLES);
    const sixth = builtinRowsOf(db).permissions.dl_editor ?? [];
    expect([...sixth].sort()).toEqual(
      [
        'contacts:create',
        'contacts:delete',
        'contacts:read',
        'contacts:update',
        'distributionlists:members:write',
        'distributionlists:read',
        'users:read',
      ].sort(),
    );
    expect(
      db
        .prepare("SELECT builtin, assignable, created_at FROM rbac_role WHERE key = 'dl_editor'")
        .get(),
    ).toEqual({ builtin: 1, assignable: 1, created_at: '2026-01-01T00:00:00.000Z' });
  });

  it('keeps the assignments, the template, the epoch (0), the users and the sessions as they were', () => {
    expect(dumpRows(db, ASSIGNMENT_SHAPE)).toEqual(rowsBefore);
    expect(db.prepare('SELECT epoch FROM rbac_epoch').get()).toEqual({ epoch: 0 });
  });

  it('keeps the protection of the built-in roles, now at six: a seventh cannot be added, a permission cannot be added to dl_editor', () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO rbac_role (key, builtin, assignable, created_at) VALUES ('seventh', 1, 1, '2026-01-01T00:00:00.000Z')",
        )
        .run(),
    ).toThrow(/built-in roles are immutable/);
    expect(() =>
      db
        .prepare(
          "INSERT INTO rbac_role_permission (role_id, permission, qualifier) VALUES ((SELECT id FROM rbac_role WHERE key = 'dl_editor'), 'audit:read', '')",
        )
        .run(),
    ).toThrow(/permissions of built-in roles are immutable/);
    expect(() => db.prepare("DELETE FROM rbac_role WHERE key = 'dl_editor'").run()).toThrow(
      /built-in roles are immutable/,
    );
  });

  it('has the same 32 triggers as before: two were dropped and recreated, none added or lost', () => {
    expect(
      db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger'").get(),
    ).toEqual({ n: 32 });
  });
});

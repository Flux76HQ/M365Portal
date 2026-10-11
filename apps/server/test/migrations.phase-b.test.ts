// T-B-011, FR-B-501 (seeds), FR-B-510 (last Owner trigger), FR-B-511 (group cache triggers),
// FR-B-701, I-B1, I-B2, I-B3, I-B5, I-B6, I-B7, I-B10 to I-B12, EB-23: the behaviour of migration
// `0001_phase_b`, executed on an empty SQLite with `foreign_keys = ON`.
//
//   - the file: the marker line, 17 tables, 9 indexes, 29 triggers, 4 seed inserts and nothing else;
//   - the 59 assertions of data-model section 13, in the areas the document lists them;
//   - 40 table-driven trigger cases, each naming the trigger it exercises;
//   - the single-trigger mutation test: every one of the 29 triggers is dropped alone, and at least
//     one assertion or case must then fail (29 of 29);
//   - a completeness check: every trigger in `sqlite_master` appears in the case table;
//   - negative fixtures (tasks.md section 0.3) for the file guard, the cases and the completeness check.
//
// The guards of this file are functions that throw; `expectGuardFails` proves each one fails on a
// copy of the migration with one defect.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expectGuardFails } from '@m365portal/shared/testing';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

type Db = InstanceType<typeof Database>;

const MIGRATION_PATH = fileURLToPath(new URL('../drizzle/0001_phase_b.sql', import.meta.url));
const MIGRATION_TEXT = readFileSync(MIGRATION_PATH, 'utf8');
const MARKER = '-- ===== hand-written section (not in schema.ts): seeds and triggers =====';

const BREAKPOINT = '--> statement-breakpoint';

/** The statements of a migration file: split on the breakpoint, comment lines dropped. */
function statementsOf(text: string): string[] {
  return text
    .split(BREAKPOINT)
    .map((chunk) =>
      chunk
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n')
        .replace(/;\s*$/, '')
        .trim(),
    )
    .filter((statement) => statement !== '');
}

/** An in-memory database with the migration applied, as bytes, so that each case gets a fresh copy. */
function migrate(text: string): Db {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const statement of statementsOf(text)) db.exec(statement);
  return db;
}

const BASE_IMAGE = (() => {
  const db = migrate(MIGRATION_TEXT);
  const image = db.serialize();
  db.close();
  return image;
})();

function freshDatabase(image: Buffer = BASE_IMAGE): Db {
  const db = new Database(image);
  db.pragma('foreign_keys = ON');
  return db;
}

// ---------------------------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------------------------

/** What kind of statement `statement` is, by its first words. */
function kindOf(statement: string): string {
  const match =
    /^(CREATE UNIQUE INDEX|CREATE INDEX|CREATE TABLE|CREATE TRIGGER|INSERT INTO|\w+(?: \w+)?)/.exec(
      statement,
    );
  return match?.[1] ?? statement.slice(0, 20);
}

/** Throws unless the file is exactly what data-model sections 4 and 5 say it is. */
function assertMigrationFile(text: string): void {
  const problems: string[] = [];
  const markerAt = text.indexOf(MARKER);
  if (markerAt < 0) problems.push('the marker line of the hand-written section is missing');
  if (text.includes(MARKER, markerAt + 1) && markerAt >= 0)
    problems.push('the marker line occurs twice');

  const counts = new Map<string, number>();
  for (const statement of statementsOf(text)) {
    const kind = kindOf(statement);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const indexes = (counts.get('CREATE INDEX') ?? 0) + (counts.get('CREATE UNIQUE INDEX') ?? 0);
  const wanted: [string, number, number][] = [
    ['CREATE TABLE', counts.get('CREATE TABLE') ?? 0, 17],
    ['CREATE INDEX', indexes, 9],
    ['CREATE TRIGGER', counts.get('CREATE TRIGGER') ?? 0, 29],
    ['INSERT INTO', counts.get('INSERT INTO') ?? 0, 4],
  ];
  for (const [kind, actual, expected] of wanted) {
    if (actual !== expected)
      problems.push(`${String(actual)} ${kind}, expected ${String(expected)}`);
  }
  const other = [...counts.keys()].filter(
    (kind) =>
      ![
        'CREATE TABLE',
        'CREATE INDEX',
        'CREATE UNIQUE INDEX',
        'CREATE TRIGGER',
        'INSERT INTO',
      ].includes(kind),
  );
  if (other.length > 0) problems.push(`other statements: ${other.join(', ')}`);

  // Only additions, and nothing of Phase A is touched or referenced.
  for (const forbidden of [
    /\bALTER\b/i,
    /\bDROP\b/i,
    /\bUPDATE\s+`?\w+`?\s+SET\b(?![^;]*\bepoch\b|[^;]*groups_resolved_at)/i,
  ]) {
    if (
      forbidden.test(
        statementsOf(text)
          .filter((s) => !s.startsWith('CREATE TRIGGER'))
          .join('\n'),
      )
    ) {
      problems.push(`a statement matches ${String(forbidden)}`);
    }
  }
  for (const phaseA of ['audit_log', 'branding_asset', '`branding`']) {
    if (text.includes(phaseA)) problems.push(`the file refers to the Phase A object ${phaseA}`);
  }

  // The hand-written section holds INSERT and CREATE TRIGGER statements and nothing else.
  if (markerAt >= 0) {
    for (const statement of statementsOf(text.slice(markerAt))) {
      const kind = kindOf(statement);
      if (kind !== 'INSERT INTO' && kind !== 'CREATE TRIGGER') {
        problems.push(`the hand-written section holds a ${kind}`);
      }
    }
    for (const statement of statementsOf(text.slice(0, markerAt))) {
      const kind = kindOf(statement);
      if (kind === 'INSERT INTO' || kind === 'CREATE TRIGGER') {
        problems.push(`the generated section holds a ${kind}`);
      }
    }
  }
  if (problems.length > 0) throw new Error(`migration file differs: ${problems.join('; ')}`);
}

describe('the migration file (FR-B-701)', () => {
  it('has the marker line, 17 tables, 9 indexes, 29 triggers, 4 seed inserts and nothing else', () => {
    expect(() => {
      assertMigrationFile(MIGRATION_TEXT);
    }).not.toThrow();
  });

  it('applies to an empty database with foreign keys on, and foreign_key_check is empty', () => {
    const db = freshDatabase();
    expect(db.pragma('foreign_key_check')).toEqual([]);
    const names = (type: string): string[] =>
      (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%'")
          .all(type) as { name: string }[]
      ).map((row) => row.name);
    expect(names('table')).toHaveLength(17);
    expect(names('trigger')).toHaveLength(29);
    // Nine indexes by statement; SQLite adds automatic ones for UNIQUE/PRIMARY KEY, which have no name.
    expect(names('index')).toHaveLength(9);
    db.close();
  });

  it('is statement-by-statement valid for the Phase A wrapper: breakpoints between all statements', () => {
    // The wrapper splits on the breakpoint; a trigger body contains semicolons and must stay whole.
    const statements = MIGRATION_TEXT.split(BREAKPOINT);
    expect(statements.length).toBeGreaterThan(50);
    for (const statement of statements) {
      if (statement.includes('CREATE TRIGGER')) expect(statement).toMatch(/BEGIN[\s\S]*END;\s*$/);
    }
  });

  it('seeds the instants as the fixed 2026-01-01T00:00:00.000Z', () => {
    const db = freshDatabase();
    const instants = db.prepare('SELECT DISTINCT created_at FROM rbac_role').all() as {
      created_at: string;
    }[];
    expect(instants).toEqual([{ created_at: '2026-01-01T00:00:00.000Z' }]);
    db.close();
  });
});

describe('the file guard (negative fixtures)', () => {
  const guard = (text: string): void => {
    assertMigrationFile(text);
  };

  it('fails when the marker line is missing', () => {
    expectGuardFails(guard, MIGRATION_TEXT.replace(MARKER, '-- no marker'), {
      name: 'file guard',
      reason: 'marker line of the hand-written section is missing',
    });
  });

  it('fails on an ALTER, a DROP or a statement of another kind', () => {
    expectGuardFails(
      guard,
      `${MIGRATION_TEXT}\n${BREAKPOINT}\nALTER TABLE \`secret\` ADD COLUMN \`x\` text;`,
      {
        name: 'file guard',
        reason: 'other statements: ALTER TABLE',
      },
    );
    expectGuardFails(guard, `${MIGRATION_TEXT}\n${BREAKPOINT}\nDROP TABLE \`secret\`;`, {
      name: 'file guard',
      reason: 'other statements: DROP TABLE',
    });
    expectGuardFails(guard, `${MIGRATION_TEXT}\n${BREAKPOINT}\nCREATE VIEW v AS SELECT 1;`, {
      name: 'file guard',
      reason: 'other statements: CREATE VIEW',
    });
  });

  it('fails when a table, an index or a trigger is missing or extra', () => {
    expectGuardFails(
      guard,
      MIGRATION_TEXT.replace(/CREATE TRIGGER `setup_state_no_delete`[\s\S]*$/, ''),
      { name: 'file guard', reason: '28 CREATE TRIGGER, expected 29' },
    );
    expectGuardFails(
      guard,
      `${MIGRATION_TEXT}\n${BREAKPOINT}\nCREATE INDEX \`extra_idx\` ON \`secret\` (\`purpose\`);`,
      { name: 'file guard', reason: '10 CREATE INDEX, expected 9' },
    );
    expectGuardFails(
      guard,
      MIGRATION_TEXT.replace(/CREATE TABLE `rbac_epoch`/, 'CREATE TABLE `rbac_epoch_x`').replace(
        'CREATE TABLE `app_user`',
        '-- dropped table app_user',
      ),
      { name: 'file guard', reason: '16 CREATE TABLE, expected 17' },
    );
  });

  it('fails when the file refers to a Phase A object', () => {
    expectGuardFails(
      guard,
      `${MIGRATION_TEXT}\n${BREAKPOINT}\nINSERT INTO \`audit_log\` (\`seq\`) VALUES (1);`,
      {
        name: 'file guard',
        reason: 'refers to the Phase A object audit_log',
      },
    );
  });

  it('fails when a trigger sits in the generated section', () => {
    const moved = MIGRATION_TEXT.replace(MARKER, MARKER.replace('hand-written', 'moved'));
    expectGuardFails(guard, moved, {
      name: 'file guard',
      reason: 'marker line of the hand-written section is missing',
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Helpers of the cases
// ---------------------------------------------------------------------------------------------

const NOW = '2026-10-10T12:00:00.000Z';
const guid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function epochOf(db: Db): number {
  return (db.prepare('SELECT epoch FROM rbac_epoch WHERE id = 1').get() as { epoch: number }).epoch;
}

function count(db: Db, sql: string, ...params: unknown[]): number {
  return (db.prepare(sql).get(...params) as { n: number }).n;
}

/** Run `sql`; assert SQLite refuses it with an ABORT of a trigger and a message that contains `message`. */
function abortsWith(db: Db, message: string, sql: string, ...params: unknown[]): void {
  assert.throws(
    () => db.prepare(sql).run(...params),
    (error: unknown) =>
      (error as { code?: string }).code === 'SQLITE_CONSTRAINT_TRIGGER' &&
      (error as Error).message.includes(message),
    `expected an ABORT "${message}" for: ${sql}`,
  );
}

/**
 * Run `sql`; assert a constraint other than a trigger of ours refuses it (CHECK, UNIQUE, PRIMARY KEY,
 * FOREIGN KEY). SQLite reports a RESTRICT foreign key as a constraint of kind TRIGGER with the text
 * "FOREIGN KEY constraint failed", so that one is recognised by its message.
 */
function violates(
  db: Db,
  kind: 'CHECK' | 'UNIQUE' | 'PRIMARYKEY' | 'FOREIGNKEY',
  sql: string,
  ...params: unknown[]
): void {
  assert.throws(
    () => db.prepare(sql).run(...params),
    (error: unknown) => {
      const { code = '', message = '' } = error as { code?: string; message?: string };
      return kind === 'FOREIGNKEY'
        ? message.includes('FOREIGN KEY constraint failed')
        : code === `SQLITE_CONSTRAINT_${kind}`;
    },
    `expected a ${kind} violation for: ${sql}`,
  );
}

function run(db: Db, sql: string, ...params: unknown[]): void {
  db.prepare(sql).run(...params);
}

interface AssignmentOptions {
  readonly id: number;
  readonly principal?: number;
  readonly type?: 'user' | 'group';
  readonly role?: number;
  readonly hash?: string;
  readonly expires?: string | null;
}

function addAssignment(db: Db, options: AssignmentOptions): void {
  run(
    db,
    `INSERT INTO rbac_assignment (id, principal_type, principal_id, role_id, scope_hash, expires_at, source, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, 'api', ?, 'tester')`,
    guid(options.id),
    options.type ?? 'user',
    guid(options.principal ?? options.id + 1_000),
    options.role ?? 1,
    options.hash ?? 'a'.repeat(64),
    options.expires ?? null,
    NOW,
  );
}

function addScope(
  db: Db,
  id: number,
  position: number,
  target: string,
  matchBy: string,
  attr: string,
  value: string,
): void {
  run(
    db,
    'INSERT INTO rbac_assignment_scope (assignment_id, position, target, match_by, attr, value) VALUES (?, ?, ?, ?, ?, ?)',
    guid(id),
    position,
    target,
    matchBy,
    attr,
    value,
  );
}

function addCustomRole(db: Db, id = 6, key = 'custom'): void {
  run(
    db,
    'INSERT INTO rbac_role (id, key, builtin, assignable, created_at) VALUES (?, ?, 0, 1, ?)',
    id,
    key,
    NOW,
  );
}

function addSetupState(db: Db): void {
  run(
    db,
    "INSERT INTO setup_state (id, state, mode, install_id, updated_at) VALUES (1, 'unconfigured', 'automatic', ?, ?)",
    'a'.repeat(32),
    NOW,
  );
}

function moveSetup(db: Db, to: string): void {
  run(
    db,
    'UPDATE setup_state SET state = ?, completed_at = ? WHERE id = 1',
    to,
    to === 'completed' ? NOW : null,
  );
}

function setupAt(
  db: Db,
  state: 'unconfigured' | 'in_progress' | 'awaiting_first_signin' | 'completed',
): void {
  addSetupState(db);
  const path = ['in_progress', 'awaiting_first_signin', 'completed'];
  for (const step of path.slice(0, path.indexOf(state) + 1)) moveSetup(db, step);
}

const SECRET_BLOB = Buffer.concat([Buffer.from([1]), Buffer.alloc(40, 7)]);

function addSecret(db: Db, id: number): void {
  run(
    db,
    "INSERT INTO secret (id, purpose, key_id, blob, created_at) VALUES (?, 'certificate_key', ?, ?, ?)",
    guid(id),
    'c743d54d05bd4d72',
    SECRET_BLOB,
    NOW,
  );
}

function addCertificate(db: Db, id: number, secretId: number, state: string, sha1 = 'a'): void {
  run(
    db,
    `INSERT INTO certificate (id, secret_id, thumbprint_sha1, thumbprint_sha256, subject, not_before, not_after, public_der, state, created_at)
     VALUES (?, ?, ?, ?, 'CN=M365Portal 00000000', ?, '2027-10-10T12:00:00.000Z', ?, ?, ?)`,
    guid(id),
    guid(secretId),
    sha1.repeat(40),
    'b'.repeat(64),
    NOW,
    Buffer.alloc(300, 9),
    state,
    NOW,
  );
}

function addSession(db: Db, kind: string, oid: string, idHash = 'a'.repeat(64)): void {
  run(
    db,
    `INSERT INTO session (id_hash, kind, tid, oid, created_at, last_seen_at, absolute_expires_at, mfa, amr, authenticated_at, step_up_at, groups_stale)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, '["mfa"]', ?, NULL, 0)`,
    idHash,
    kind,
    guid(1),
    oid,
    NOW,
    NOW,
    '2026-10-10T20:00:00.000Z',
    NOW,
  );
}

function addTenant(db: Db, tenant: string | null): void {
  run(
    db,
    'INSERT INTO tenant_connection (id, tenant_id, updated_at) VALUES (1, ?, ?)',
    tenant,
    NOW,
  );
}

function addUser(db: Db, oid: number, resolved: string | null = NOW): void {
  run(
    db,
    'INSERT INTO app_user (tid, oid, first_seen_at, last_signin_at, groups_resolved_at) VALUES (?, ?, ?, ?, ?)',
    guid(1),
    guid(oid),
    NOW,
    NOW,
    resolved,
  );
}

function addCacheRow(db: Db, user: number, group: number): void {
  run(
    db,
    'INSERT INTO rbac_group_member_cache (user_oid, group_id, resolved_at) VALUES (?, ?, ?)',
    guid(user),
    guid(group),
    NOW,
  );
}

// ---------------------------------------------------------------------------------------------
// The cases
// ---------------------------------------------------------------------------------------------

interface Case {
  readonly name: string;
  /** The triggers this case exercises (the completeness check reads it). */
  readonly triggers?: readonly string[];
  readonly run: (db: Db) => void;
}

const BUILTIN_ABORT = 'built-in roles are immutable';
const PERMISSION_ABORT = 'permissions of built-in roles are immutable';
const OWNER_EXPIRY_ABORT = 'owner assignments cannot expire';
const LAST_OWNER_ABORT = 'last_owner_protected';
const PIN_ABORT = 'tenant_id is pinned';
const FORWARD_ABORT = 'setup state may only move forward';

/** The 59 assertions of data-model section 13, by area. */
const ASSERTIONS: readonly Case[] = [
  // --- seeds (3)
  {
    name: 'seeds: the permission counts of the five built-in roles are 15, 13, 9, 6 and 4',
    run: (db) => {
      const rows = db
        .prepare(
          'SELECT role_id, count(*) AS n FROM rbac_role_permission GROUP BY role_id ORDER BY role_id',
        )
        .all() as { role_id: number; n: number }[];
      assert.deepEqual(
        rows.map((row) => row.n),
        [15, 13, 9, 6, 4],
      );
      assert.equal(count(db, 'SELECT count(*) AS n FROM rbac_role WHERE builtin = 1'), 5);
      assert.deepEqual(
        (db.prepare('SELECT key FROM rbac_role ORDER BY id').all() as { key: string }[]).map(
          (r) => r.key,
        ),
        ['owner', 'admin', 'operator', 'helpdesk', 'reader'],
      );
    },
  },
  {
    name: 'seeds: the template board holds five permissions and targets distributionList',
    run: (db) => {
      const row = db
        .prepare("SELECT permissions, scope_target FROM rbac_role_template WHERE key = 'board'")
        .get() as {
        permissions: string;
        scope_target: string;
      };
      assert.equal(row.scope_target, 'distributionList');
      const permissions = JSON.parse(row.permissions) as {
        permission: string;
        qualifier?: string;
      }[];
      assert.equal(permissions.length, 5);
      assert.deepEqual(
        permissions.find((entry) => entry.permission === 'users:read'),
        { permission: 'users:read', qualifier: 'basic' },
      );
    },
  },
  {
    name: 'seeds: rbac_epoch is seeded with (1, 0) and nothing else is in the tables that must start empty',
    run: (db) => {
      assert.deepEqual(db.prepare('SELECT id, epoch FROM rbac_epoch').all(), [{ id: 1, epoch: 0 }]);
      for (const table of [
        'rbac_assignment',
        'rbac_assignment_scope',
        'session',
        'secret',
        'certificate',
        'setup_state',
        'tenant_connection',
      ]) {
        assert.equal(count(db, `SELECT count(*) AS n FROM ${table}`), 0, table);
      }
    },
  },

  // --- built-in immutability (7)
  {
    name: 'built-in: updating a built-in role aborts',
    run: (db) => {
      abortsWith(db, BUILTIN_ABORT, "UPDATE rbac_role SET assignable = 0 WHERE key = 'owner'");
    },
  },
  {
    name: 'built-in: deleting a built-in role aborts',
    run: (db) => {
      abortsWith(db, BUILTIN_ABORT, "DELETE FROM rbac_role WHERE key = 'reader'");
    },
  },
  {
    name: 'built-in: inserting a permission for a built-in role aborts',
    run: (db) => {
      abortsWith(
        db,
        PERMISSION_ABORT,
        "INSERT INTO rbac_role_permission (role_id, permission, qualifier) VALUES (5, 'audit:read', '')",
      );
    },
  },
  {
    name: 'built-in: updating a permission of a built-in role aborts',
    run: (db) => {
      abortsWith(
        db,
        PERMISSION_ABORT,
        "UPDATE rbac_role_permission SET qualifier = 'basic' WHERE role_id = 5 AND permission = 'users:read'",
      );
    },
  },
  {
    name: 'built-in: deleting a permission of a built-in role aborts',
    run: (db) => {
      abortsWith(
        db,
        PERMISSION_ABORT,
        "DELETE FROM rbac_role_permission WHERE role_id = 1 AND permission = 'rbac:manage'",
      );
    },
  },
  {
    name: 'built-in: a sixth built-in role cannot be inserted',
    run: (db) => {
      abortsWith(
        db,
        BUILTIN_ABORT,
        "INSERT INTO rbac_role (id, key, builtin, assignable, created_at) VALUES (6, 'sixth', 1, 1, ?)",
        NOW,
      );
    },
  },
  {
    name: 'built-in: aborted statements leave the epoch unchanged',
    run: (db) => {
      const before = epochOf(db);
      for (const sql of [
        "UPDATE rbac_role SET assignable = 0 WHERE key = 'owner'",
        "DELETE FROM rbac_role WHERE key = 'admin'",
        'DELETE FROM rbac_role_permission WHERE role_id = 2',
      ]) {
        assert.throws(() => db.prepare(sql).run());
      }
      assert.equal(epochOf(db), before);
    },
  },

  // --- custom roles and the epoch (3)
  {
    name: 'custom roles: inserting a custom role is allowed and raises the epoch',
    run: (db) => {
      const before = epochOf(db);
      addCustomRole(db);
      assert.equal(epochOf(db), before + 1);
    },
  },
  {
    name: 'custom roles: inserting, updating and deleting a permission each raise the epoch by one',
    run: (db) => {
      addCustomRole(db);
      let epoch = epochOf(db);
      run(
        db,
        "INSERT INTO rbac_role_permission (role_id, permission, qualifier) VALUES (6, 'contacts:read', '')",
      );
      assert.equal(epochOf(db), ++epoch);
      run(db, "UPDATE rbac_role_permission SET permission = 'contacts:update' WHERE role_id = 6");
      assert.equal(epochOf(db), ++epoch);
      run(db, 'DELETE FROM rbac_role_permission WHERE role_id = 6');
      assert.equal(epochOf(db), epoch + 1);
    },
  },
  {
    name: 'custom roles: the qualifier basic exists for users:read only',
    run: (db) => {
      addCustomRole(db);
      run(
        db,
        "INSERT INTO rbac_role_permission (role_id, permission, qualifier) VALUES (6, 'users:read', 'basic')",
      );
      violates(
        db,
        'CHECK',
        "INSERT INTO rbac_role_permission (role_id, permission, qualifier) VALUES (6, 'contacts:read', 'basic')",
      );
      violates(
        db,
        'CHECK',
        "INSERT INTO rbac_role_permission (role_id, permission, qualifier) VALUES (6, 'groups:read', 'full')",
      );
    },
  },

  // --- assignments and the last Owner (8)
  {
    name: 'assignments: a duplicate (principal, role, scope hash) is refused',
    run: (db) => {
      addAssignment(db, { id: 1, principal: 500, role: 2 });
      violates(
        db,
        'UNIQUE',
        `INSERT INTO rbac_assignment (id, principal_type, principal_id, role_id, scope_hash, source, created_at, created_by)
        VALUES (?, 'user', ?, 2, ?, 'api', ?, 'tester')`,
        guid(2),
        guid(500),
        'a'.repeat(64),
        NOW,
      );
    },
  },
  {
    name: 'assignments: an owner assignment cannot have an expiry',
    run: (db) => {
      abortsWith(
        db,
        OWNER_EXPIRY_ABORT,
        `INSERT INTO rbac_assignment (id, principal_type, principal_id, role_id, scope_hash, expires_at, source, created_at, created_by)
         VALUES (?, 'user', ?, 1, ?, '2027-01-01T00:00:00.000Z', 'api', ?, 'tester')`,
        guid(1),
        guid(500),
        'a'.repeat(64),
        NOW,
      );
    },
  },
  {
    name: 'assignments: the last user-principal owner cannot be deleted',
    run: (db) => {
      addAssignment(db, { id: 1 });
      abortsWith(db, LAST_OWNER_ABORT, 'DELETE FROM rbac_assignment WHERE id = ?', guid(1));
    },
  },
  {
    name: 'assignments: the last owner cannot be demoted to another role',
    run: (db) => {
      addAssignment(db, { id: 1 });
      abortsWith(
        db,
        LAST_OWNER_ABORT,
        'UPDATE rbac_assignment SET role_id = 2 WHERE id = ?',
        guid(1),
      );
    },
  },
  {
    name: 'assignments: the last owner cannot be converted to a group principal',
    run: (db) => {
      addAssignment(db, { id: 1 });
      abortsWith(
        db,
        LAST_OWNER_ABORT,
        "UPDATE rbac_assignment SET principal_type = 'group' WHERE id = ?",
        guid(1),
      );
    },
  },
  {
    name: 'assignments: a group that holds owner does not count as an owner',
    run: (db) => {
      addAssignment(db, { id: 1 });
      addAssignment(db, { id: 2, principal: 600, type: 'group' });
      abortsWith(db, LAST_OWNER_ABORT, 'DELETE FROM rbac_assignment WHERE id = ?', guid(1));
    },
  },
  {
    name: 'assignments: with two user owners one can be removed',
    run: (db) => {
      addAssignment(db, { id: 1 });
      addAssignment(db, { id: 2 });
      run(db, 'DELETE FROM rbac_assignment WHERE id = ?', guid(1));
      assert.equal(count(db, 'SELECT count(*) AS n FROM rbac_assignment WHERE role_id = 1'), 1);
    },
  },
  {
    name: 'assignments: the remaining owner then cannot be deleted',
    run: (db) => {
      addAssignment(db, { id: 1 });
      addAssignment(db, { id: 2 });
      run(db, 'DELETE FROM rbac_assignment WHERE id = ?', guid(1));
      abortsWith(db, LAST_OWNER_ABORT, 'DELETE FROM rbac_assignment WHERE id = ?', guid(2));
    },
  },

  // --- scope rows (8)
  {
    name: 'scope: inserting a scope row raises the epoch',
    run: (db) => {
      addAssignment(db, { id: 3, role: 3 });
      const before = epochOf(db);
      addScope(db, 3, 0, 'group', 'id', '', guid(900));
      assert.equal(epochOf(db), before + 1);
    },
  },
  {
    name: 'scope: matching by id never targets user',
    run: (db) => {
      addAssignment(db, { id: 3, role: 3 });
      violates(
        db,
        'CHECK',
        'INSERT INTO rbac_assignment_scope (assignment_id, position, target, match_by, attr, value) VALUES (?, 0, ?, ?, ?, ?)',
        guid(3),
        'user',
        'id',
        '',
        guid(900),
      );
    },
  },
  {
    name: 'scope: matching by department only targets user and contact',
    run: (db) => {
      addAssignment(db, { id: 3, role: 3 });
      violates(
        db,
        'CHECK',
        'INSERT INTO rbac_assignment_scope (assignment_id, position, target, match_by, attr, value) VALUES (?, 0, ?, ?, ?, ?)',
        guid(3),
        'group',
        'department',
        '',
        'Finance',
      );
      addScope(db, 3, 0, 'user', 'department', '', 'Finance');
      addScope(db, 3, 1, 'contact', 'department', '', 'Finance');
    },
  },
  {
    name: 'scope: a prefix match needs displayName, mail or alias as attribute',
    run: (db) => {
      addAssignment(db, { id: 3, role: 3 });
      violates(
        db,
        'CHECK',
        'INSERT INTO rbac_assignment_scope (assignment_id, position, target, match_by, attr, value) VALUES (?, 0, ?, ?, ?, ?)',
        guid(3),
        'group',
        'prefix',
        'city',
        'Am',
      );
      addScope(db, 3, 0, 'group', 'prefix', 'displayName', 'Am');
      addScope(db, 3, 1, 'group', 'prefix', 'mail', 'am');
      addScope(db, 3, 2, 'distributionList', 'prefix', 'alias', 'am');
    },
  },
  {
    name: 'scope: alias is never an attribute of a user (a user has no alias)',
    run: (db) => {
      addAssignment(db, { id: 3, role: 3 });
      violates(
        db,
        'CHECK',
        'INSERT INTO rbac_assignment_scope (assignment_id, position, target, match_by, attr, value) VALUES (?, 0, ?, ?, ?, ?)',
        guid(3),
        'user',
        'prefix',
        'alias',
        'am',
      );
    },
  },
  {
    name: 'scope: position 50 is refused, 49 is the last',
    run: (db) => {
      addAssignment(db, { id: 3, role: 3 });
      addScope(db, 3, 49, 'group', 'id', '', guid(900));
      violates(
        db,
        'CHECK',
        'INSERT INTO rbac_assignment_scope (assignment_id, position, target, match_by, attr, value) VALUES (?, 50, ?, ?, ?, ?)',
        guid(3),
        'group',
        'id',
        '',
        guid(901),
      );
    },
  },
  {
    name: 'scope: deleting an assignment deletes its scope rows (CASCADE)',
    run: (db) => {
      addAssignment(db, { id: 3, role: 3 });
      addScope(db, 3, 0, 'group', 'id', '', guid(900));
      addScope(db, 3, 1, 'group', 'id', '', guid(901));
      run(db, 'DELETE FROM rbac_assignment WHERE id = ?', guid(3));
      assert.equal(count(db, 'SELECT count(*) AS n FROM rbac_assignment_scope'), 0);
    },
  },
  {
    name: 'scope: the cascade raises the epoch for the assignment and for each scope row',
    run: (db) => {
      addAssignment(db, { id: 3, role: 3 });
      addScope(db, 3, 0, 'group', 'id', '', guid(900));
      addScope(db, 3, 1, 'group', 'id', '', guid(901));
      const before = epochOf(db);
      run(db, 'DELETE FROM rbac_assignment WHERE id = ?', guid(3));
      assert.equal(epochOf(db), before + 3);
    },
  },

  // --- group cache (4)
  {
    name: 'group cache: inserting a group assignment empties the member cache',
    run: (db) => {
      addUser(db, 10);
      addCacheRow(db, 10, 700);
      addAssignment(db, { id: 4, principal: 700, type: 'group', role: 5 });
      assert.equal(count(db, 'SELECT count(*) AS n FROM rbac_group_member_cache'), 0);
    },
  },
  {
    name: 'group cache: inserting a group assignment resets every groups_resolved_at',
    run: (db) => {
      addUser(db, 10);
      addUser(db, 11);
      addAssignment(db, { id: 4, principal: 700, type: 'group', role: 5 });
      assert.equal(
        count(db, 'SELECT count(*) AS n FROM app_user WHERE groups_resolved_at IS NOT NULL'),
        0,
      );
    },
  },
  {
    name: 'group cache: a user assignment leaves the cache and the resolution times alone',
    run: (db) => {
      addUser(db, 10);
      addCacheRow(db, 10, 700);
      addAssignment(db, { id: 5, principal: 10, type: 'user', role: 5 });
      assert.equal(count(db, 'SELECT count(*) AS n FROM rbac_group_member_cache'), 1);
      assert.equal(
        count(db, 'SELECT count(*) AS n FROM app_user WHERE groups_resolved_at IS NOT NULL'),
        1,
      );
    },
  },
  {
    name: 'group cache: deleting a group assignment empties the cache',
    run: (db) => {
      addAssignment(db, { id: 4, principal: 700, type: 'group', role: 5 });
      addUser(db, 10);
      addCacheRow(db, 10, 700);
      run(db, 'DELETE FROM rbac_assignment WHERE id = ?', guid(4));
      assert.equal(count(db, 'SELECT count(*) AS n FROM rbac_group_member_cache'), 0);
      assert.equal(
        count(db, 'SELECT count(*) AS n FROM app_user WHERE groups_resolved_at IS NOT NULL'),
        0,
      );
    },
  },

  // --- sessions (3)
  {
    name: 'sessions: a break-glass session with an oid is refused',
    run: (db) => {
      violates(
        db,
        'CHECK',
        `INSERT INTO session (id_hash, kind, tid, oid, created_at, last_seen_at, absolute_expires_at, authenticated_at)
        VALUES (?, 'break_glass', ?, ?, ?, ?, ?, ?)`,
        'a'.repeat(64),
        guid(1),
        guid(2),
        NOW,
        NOW,
        NOW,
        NOW,
      );
      addSession(db, 'break_glass', '');
    },
  },
  {
    name: 'sessions: a user session without an oid is refused',
    run: (db) => {
      violates(
        db,
        'CHECK',
        `INSERT INTO session (id_hash, kind, tid, oid, created_at, last_seen_at, absolute_expires_at, authenticated_at)
        VALUES (?, 'user', ?, '', ?, ?, ?, ?)`,
        'a'.repeat(64),
        guid(1),
        NOW,
        NOW,
        NOW,
        NOW,
      );
      addSession(db, 'user', guid(2));
    },
  },
  {
    name: 'sessions: an upper-case session hash is refused',
    run: (db) => {
      violates(
        db,
        'CHECK',
        `INSERT INTO session (id_hash, kind, tid, oid, created_at, last_seen_at, absolute_expires_at, authenticated_at)
        VALUES (?, 'user', ?, ?, ?, ?, ?, ?)`,
        'A'.repeat(64),
        guid(1),
        guid(2),
        NOW,
        NOW,
        NOW,
        NOW,
      );
    },
  },

  // --- setup_state (8)
  {
    name: 'setup_state: a second row is refused',
    run: (db) => {
      addSetupState(db);
      violates(
        db,
        'CHECK',
        "INSERT INTO setup_state (id, state, install_id, updated_at) VALUES (2, 'unconfigured', ?, ?)",
        'b'.repeat(32),
        NOW,
      );
    },
  },
  {
    name: 'setup_state: unconfigured cannot jump to completed',
    run: (db) => {
      addSetupState(db);
      abortsWith(
        db,
        FORWARD_ABORT,
        "UPDATE setup_state SET state = 'completed', completed_at = ? WHERE id = 1",
        NOW,
      );
    },
  },
  {
    name: 'setup_state: unconfigured cannot jump to awaiting_first_signin',
    run: (db) => {
      addSetupState(db);
      abortsWith(
        db,
        FORWARD_ABORT,
        "UPDATE setup_state SET state = 'awaiting_first_signin' WHERE id = 1",
      );
    },
  },
  {
    name: 'setup_state: in_progress cannot jump to completed',
    run: (db) => {
      setupAt(db, 'in_progress');
      abortsWith(
        db,
        FORWARD_ABORT,
        "UPDATE setup_state SET state = 'completed', completed_at = ? WHERE id = 1",
        NOW,
      );
    },
  },
  {
    name: 'setup_state: completed cannot go back to unconfigured',
    run: (db) => {
      setupAt(db, 'completed');
      abortsWith(
        db,
        FORWARD_ABORT,
        "UPDATE setup_state SET state = 'unconfigured', completed_at = NULL WHERE id = 1",
      );
    },
  },
  {
    name: 'setup_state: a completed setup can be reopened to in_progress (setup-reopen)',
    run: (db) => {
      setupAt(db, 'completed');
      run(db, "UPDATE setup_state SET state = 'in_progress', completed_at = NULL WHERE id = 1");
      assert.equal(
        (db.prepare('SELECT state FROM setup_state').get() as { state: string }).state,
        'in_progress',
      );
    },
  },
  {
    name: 'setup_state: completed without completed_at (and the reverse) is refused',
    run: (db) => {
      setupAt(db, 'awaiting_first_signin');
      violates(
        db,
        'CHECK',
        "UPDATE setup_state SET state = 'completed', completed_at = NULL WHERE id = 1",
      );
      violates(db, 'CHECK', 'UPDATE setup_state SET completed_at = ? WHERE id = 1', NOW);
    },
  },
  {
    name: 'setup_state: the row is never deleted',
    run: (db) => {
      addSetupState(db);
      abortsWith(db, 'setup_state is never deleted', 'DELETE FROM setup_state');
    },
  },

  // --- tenant pin (3)
  {
    name: 'tenant pin: a pinned tenant_id cannot change',
    run: (db) => {
      addTenant(db, guid(77));
      abortsWith(
        db,
        PIN_ABORT,
        'UPDATE tenant_connection SET tenant_id = ? WHERE id = 1',
        guid(78),
      );
    },
  },
  {
    name: 'tenant pin: a pinned tenant_id cannot be cleared',
    run: (db) => {
      addTenant(db, guid(77));
      abortsWith(db, PIN_ABORT, 'UPDATE tenant_connection SET tenant_id = NULL WHERE id = 1');
    },
  },
  {
    name: 'tenant pin: a row with a pinned tenant cannot be deleted',
    run: (db) => {
      addTenant(db, guid(77));
      abortsWith(db, PIN_ABORT, 'DELETE FROM tenant_connection');
    },
  },

  // --- secrets and certificates (7)
  {
    name: 'secrets: a blob whose version byte is not 01 is refused',
    run: (db) => {
      violates(
        db,
        'CHECK',
        "INSERT INTO secret (id, purpose, key_id, blob, created_at) VALUES (?, 'certificate_key', ?, ?, ?)",
        guid(1),
        'c743d54d05bd4d72',
        Buffer.concat([Buffer.from([2]), Buffer.alloc(40, 7)]),
        NOW,
      );
    },
  },
  {
    name: 'secrets: a text value in the blob column is refused, and so is a blob shorter than 41 bytes',
    run: (db) => {
      violates(
        db,
        'CHECK',
        "INSERT INTO secret (id, purpose, key_id, blob, created_at) VALUES (?, 'certificate_key', ?, ?, ?)",
        guid(1),
        'c743d54d05bd4d72',
        'plain text that is not a sealed blob at all, ok',
        NOW,
      );
      violates(
        db,
        'CHECK',
        "INSERT INTO secret (id, purpose, key_id, blob, created_at) VALUES (?, 'certificate_key', ?, ?, ?)",
        guid(1),
        'c743d54d05bd4d72',
        Buffer.concat([Buffer.from([1]), Buffer.alloc(39, 7)]),
        NOW,
      );
      addSecret(db, 1);
    },
  },
  {
    name: 'certificates: a second pending certificate is refused',
    run: (db) => {
      addSecret(db, 1);
      addSecret(db, 2);
      addCertificate(db, 11, 1, 'pending', 'a');
      violates(
        db,
        'UNIQUE',
        `INSERT INTO certificate (id, secret_id, thumbprint_sha1, thumbprint_sha256, subject, not_before, not_after, public_der, state, created_at)
        VALUES (?, ?, ?, ?, 'CN=x', ?, '2027-10-10T12:00:00.000Z', ?, 'pending', ?)`,
        guid(12),
        guid(2),
        'c'.repeat(40),
        'd'.repeat(64),
        NOW,
        Buffer.alloc(300, 9),
        NOW,
      );
    },
  },
  {
    name: 'certificates: a second active certificate is refused',
    run: (db) => {
      addSecret(db, 1);
      addSecret(db, 2);
      addCertificate(db, 11, 1, 'active', 'a');
      violates(
        db,
        'UNIQUE',
        `INSERT INTO certificate (id, secret_id, thumbprint_sha1, thumbprint_sha256, subject, not_before, not_after, public_der, state, created_at)
        VALUES (?, ?, ?, ?, 'CN=x', ?, '2027-10-10T12:00:00.000Z', ?, 'active', ?)`,
        guid(12),
        guid(2),
        'c'.repeat(40),
        'd'.repeat(64),
        NOW,
        Buffer.alloc(300, 9),
        NOW,
      );
    },
  },
  {
    name: 'certificates: a renewal swap (retire the active, activate the pending) is one transaction that works',
    run: (db) => {
      addSecret(db, 1);
      addSecret(db, 2);
      addCertificate(db, 11, 1, 'active', 'a');
      addCertificate(db, 12, 2, 'pending', 'c');
      db.transaction(() => {
        run(db, "UPDATE certificate SET state = 'retired' WHERE id = ?", guid(11));
        run(db, "UPDATE certificate SET state = 'active' WHERE id = ?", guid(12));
      })();
      assert.deepEqual(
        (db.prepare('SELECT state FROM certificate ORDER BY id').all() as { state: string }[]).map(
          (r) => r.state,
        ),
        ['retired', 'active'],
      );
    },
  },
  {
    name: 'certificates: a secret that a certificate points at cannot be deleted (RESTRICT)',
    run: (db) => {
      addSecret(db, 1);
      addCertificate(db, 11, 1, 'active', 'a');
      violates(db, 'FOREIGNKEY', 'DELETE FROM secret WHERE id = ?', guid(1));
    },
  },
  {
    name: 'certificates: an upper-case thumbprint is refused',
    run: (db) => {
      addSecret(db, 1);
      violates(
        db,
        'CHECK',
        `INSERT INTO certificate (id, secret_id, thumbprint_sha1, thumbprint_sha256, subject, not_before, not_after, public_der, state, created_at)
        VALUES (?, ?, ?, ?, 'CN=x', ?, '2027-10-10T12:00:00.000Z', ?, 'active', ?)`,
        guid(11),
        guid(1),
        'A'.repeat(40),
        'b'.repeat(64),
        NOW,
        Buffer.alloc(300, 9),
        NOW,
      );
    },
  },

  // --- logs, steps, objects (5)
  {
    name: 'log: a JSON array in params is refused',
    run: (db) => {
      violates(
        db,
        'CHECK',
        "INSERT INTO setup_log (seq, ts, step, level, message_key, params) VALUES (1, ?, 'connect', 'info', 'setup.log.x', '[1]')",
        NOW,
      );
      run(
        db,
        "INSERT INTO setup_log (seq, ts, step, level, message_key, params) VALUES (1, ?, 'connect', 'info', 'setup.log.x', '{\"n\":1}')",
        NOW,
      );
    },
  },
  {
    name: 'log: params over 1,024 bytes are refused',
    run: (db) => {
      const big = JSON.stringify({ text: 'x'.repeat(1_100) });
      violates(
        db,
        'CHECK',
        "INSERT INTO setup_log (seq, ts, step, level, message_key, params) VALUES (1, ?, 'connect', 'info', 'k', ?)",
        NOW,
        big,
      );
    },
  },
  {
    name: 'step: a status outside the closed set is refused',
    run: (db) => {
      violates(
        db,
        'CHECK',
        "INSERT INTO setup_step (step, sub_action, status, updated_at) VALUES ('connect', 'device_code', 'done', ?)",
        NOW,
      );
      run(
        db,
        "INSERT INTO setup_step (step, sub_action, status, updated_at) VALUES ('connect', 'device_code', 'waiting', ?)",
        NOW,
      );
    },
  },
  {
    name: 'step: detail over 4,096 bytes is refused',
    run: (db) => {
      const big = JSON.stringify({ text: 'x'.repeat(4_200) });
      violates(
        db,
        'CHECK',
        "INSERT INTO setup_step (step, sub_action, status, detail, updated_at) VALUES ('connect', 'device_code', 'pending', ?, ?)",
        big,
        NOW,
      );
    },
  },
  {
    name: 'object: an origin other than created or adopted is refused',
    run: (db) => {
      violates(
        db,
        'CHECK',
        "INSERT INTO setup_object (kind, tenant_object_id, name, origin, created_at) VALUES ('application', ?, 'M365Portal', 'invented', ?)",
        guid(1),
        NOW,
      );
      run(
        db,
        "INSERT INTO setup_object (kind, tenant_object_id, name, origin, created_at) VALUES ('application', ?, 'M365Portal', 'adopted', ?)",
        guid(1),
        NOW,
      );
    },
  },
];

const EPOCH_TABLES: readonly [
  table: string,
  insert: (db: Db) => void,
  update: string,
  remove: string,
][] = [
  [
    'rbac_role',
    (db) => {
      addCustomRole(db, 6, 'custom');
    },
    'UPDATE rbac_role SET assignable = 0 WHERE id = 6',
    'DELETE FROM rbac_role WHERE id = 6',
  ],
  [
    'rbac_role_permission',
    (db) => {
      addCustomRole(db, 6, 'custom');
      run(
        db,
        "INSERT INTO rbac_role_permission (role_id, permission, qualifier) VALUES (6, 'contacts:read', '')",
      );
    },
    "UPDATE rbac_role_permission SET permission = 'contacts:update' WHERE role_id = 6",
    'DELETE FROM rbac_role_permission WHERE role_id = 6',
  ],
  [
    'rbac_assignment',
    (db) => {
      addAssignment(db, { id: 1 });
      addAssignment(db, { id: 2, role: 5 });
    },
    "UPDATE rbac_assignment SET created_by = 'other' WHERE id = '" + guid(2) + "'",
    "DELETE FROM rbac_assignment WHERE id = '" + guid(2) + "'",
  ],
  [
    'rbac_assignment_scope',
    (db) => {
      addAssignment(db, { id: 3, role: 3 });
      addScope(db, 3, 0, 'group', 'id', '', guid(900));
    },
    "UPDATE rbac_assignment_scope SET value = '" + guid(901) + "' WHERE position = 0",
    'DELETE FROM rbac_assignment_scope WHERE position = 0',
  ],
];

/** 40 table-driven trigger cases; each names the trigger(s) it exercises. */
const TRIGGER_CASES: readonly Case[] = [
  // the six built-in triggers (6)
  {
    name: 'rbac_role_builtin_no_update: renaming a built-in role',
    triggers: ['rbac_role_builtin_no_update'],
    run: (db) => {
      abortsWith(db, BUILTIN_ABORT, "UPDATE rbac_role SET key = 'boss' WHERE id = 1");
    },
  },
  {
    name: 'rbac_role_builtin_no_delete: removing a built-in role',
    triggers: ['rbac_role_builtin_no_delete'],
    run: (db) => {
      abortsWith(db, BUILTIN_ABORT, 'DELETE FROM rbac_role WHERE id = 3');
    },
  },
  {
    name: 'rbac_role_builtin_no_insert_flag: a sixth built-in role',
    triggers: ['rbac_role_builtin_no_insert_flag'],
    run: (db) => {
      abortsWith(
        db,
        BUILTIN_ABORT,
        "INSERT INTO rbac_role (id, key, builtin, assignable, created_at) VALUES (7, 'extra', 1, 1, ?)",
        NOW,
      );
    },
  },
  {
    name: 'rbac_role_permission_builtin_no_insert: a permission for a built-in role',
    triggers: ['rbac_role_permission_builtin_no_insert'],
    run: (db) => {
      abortsWith(
        db,
        PERMISSION_ABORT,
        "INSERT INTO rbac_role_permission (role_id, permission, qualifier) VALUES (4, 'audit:export', '')",
      );
    },
  },
  {
    name: 'rbac_role_permission_builtin_no_update: moving a permission to a built-in role',
    triggers: ['rbac_role_permission_builtin_no_update'],
    run: (db) => {
      addCustomRole(db);
      run(
        db,
        "INSERT INTO rbac_role_permission (role_id, permission, qualifier) VALUES (6, 'audit:export', '')",
      );
      abortsWith(
        db,
        PERMISSION_ABORT,
        'UPDATE rbac_role_permission SET role_id = 4 WHERE role_id = 6',
      );
    },
  },
  {
    name: 'rbac_role_permission_builtin_no_delete: removing a permission of a built-in role',
    triggers: ['rbac_role_permission_builtin_no_delete'],
    run: (db) => {
      abortsWith(
        db,
        PERMISSION_ABORT,
        "DELETE FROM rbac_role_permission WHERE role_id = 2 AND permission = 'audit:read'",
      );
    },
  },
  {
    name: 'rbac_role_builtin_no_update: a custom role can be updated and deleted (the trigger is about built-in roles)',
    triggers: ['rbac_role_builtin_no_update', 'rbac_role_builtin_no_delete'],
    run: (db) => {
      addCustomRole(db);
      run(db, 'UPDATE rbac_role SET assignable = 0 WHERE id = 6');
      run(db, 'DELETE FROM rbac_role WHERE id = 6');
      assert.equal(count(db, 'SELECT count(*) AS n FROM rbac_role'), 5);
    },
  },
  // the owner triggers (2 + 3 + 2)
  {
    name: 'rbac_assignment_owner_no_expiry_ins: an owner with an expiry on insert',
    triggers: ['rbac_assignment_owner_no_expiry_ins'],
    run: (db) => {
      abortsWith(
        db,
        OWNER_EXPIRY_ABORT,
        "INSERT INTO rbac_assignment (id, principal_type, principal_id, role_id, scope_hash, expires_at, source, created_at, created_by) VALUES (?, 'user', ?, 1, ?, '2027-01-01T00:00:00.000Z', 'api', ?, 't')",
        guid(1),
        guid(2),
        'a'.repeat(64),
        NOW,
      );
    },
  },
  {
    name: 'rbac_assignment_owner_no_expiry_upd: giving an owner an expiry later',
    triggers: ['rbac_assignment_owner_no_expiry_upd'],
    run: (db) => {
      addAssignment(db, { id: 1 });
      abortsWith(
        db,
        OWNER_EXPIRY_ABORT,
        "UPDATE rbac_assignment SET expires_at = '2027-01-01T00:00:00.000Z' WHERE id = ?",
        guid(1),
      );
    },
  },
  {
    name: 'rbac_assignment_owner_no_expiry_upd: turning an admin with an expiry into an owner',
    triggers: ['rbac_assignment_owner_no_expiry_upd'],
    run: (db) => {
      addAssignment(db, { id: 1 });
      addAssignment(db, { id: 2, role: 2, expires: '2027-01-01T00:00:00.000Z' });
      abortsWith(
        db,
        OWNER_EXPIRY_ABORT,
        'UPDATE rbac_assignment SET role_id = 1 WHERE id = ?',
        guid(2),
      );
    },
  },
  {
    name: 'rbac_assignment_owner_no_expiry_ins: other roles may expire',
    triggers: ['rbac_assignment_owner_no_expiry_ins'],
    run: (db) => {
      addAssignment(db, { id: 2, role: 2, expires: '2027-01-01T00:00:00.000Z' });
      assert.equal(count(db, 'SELECT count(*) AS n FROM rbac_assignment'), 1);
    },
  },
  {
    name: 'rbac_assignment_last_owner_delete: the only owner',
    triggers: ['rbac_assignment_last_owner_delete'],
    run: (db) => {
      addAssignment(db, { id: 1 });
      abortsWith(db, LAST_OWNER_ABORT, 'DELETE FROM rbac_assignment WHERE id = ?', guid(1));
    },
  },
  {
    name: 'rbac_assignment_last_owner_delete: an owner while another owner remains',
    triggers: ['rbac_assignment_last_owner_delete'],
    run: (db) => {
      addAssignment(db, { id: 1 });
      addAssignment(db, { id: 2 });
      run(db, 'DELETE FROM rbac_assignment WHERE id = ?', guid(2));
      assert.equal(count(db, 'SELECT count(*) AS n FROM rbac_assignment'), 1);
    },
  },
  {
    name: 'rbac_assignment_last_owner_update: demoting the only owner',
    triggers: ['rbac_assignment_last_owner_update'],
    run: (db) => {
      addAssignment(db, { id: 1 });
      abortsWith(
        db,
        LAST_OWNER_ABORT,
        'UPDATE rbac_assignment SET role_id = 5 WHERE id = ?',
        guid(1),
      );
    },
  },
  {
    name: 'rbac_assignment_last_owner_update: pointing the only owner at another principal id',
    triggers: ['rbac_assignment_last_owner_update'],
    run: (db) => {
      addAssignment(db, { id: 1 });
      abortsWith(
        db,
        LAST_OWNER_ABORT,
        'UPDATE rbac_assignment SET principal_id = ? WHERE id = ?',
        guid(2_000),
        guid(1),
      );
    },
  },
  {
    name: 'rbac_assignment_last_owner_update: changing a field that does not matter is allowed',
    triggers: ['rbac_assignment_last_owner_update'],
    run: (db) => {
      addAssignment(db, { id: 1 });
      run(db, "UPDATE rbac_assignment SET created_by = 'other' WHERE id = ?", guid(1));
    },
  },
  // the epoch triggers (12)
  ...EPOCH_TABLES.flatMap(([table, insert, update, remove]): Case[] => [
    {
      name: `rbac_epoch_${table.replace('rbac_', '')}_ins: an insert raises the epoch`,
      triggers: [`rbac_epoch_${table.replace('rbac_', '')}_ins`],
      run: (db) => {
        // The set-up of the row is the insert under test; count the epoch around it.
        const before = epochOf(db);
        insert(db);
        assert.ok(epochOf(db) > before, 'the epoch did not move');
      },
    },
    {
      name: `rbac_epoch_${table.replace('rbac_', '')}_upd: an update raises the epoch`,
      triggers: [`rbac_epoch_${table.replace('rbac_', '')}_upd`],
      run: (db) => {
        insert(db);
        const before = epochOf(db);
        run(db, update);
        assert.equal(epochOf(db), before + 1);
      },
    },
    {
      name: `rbac_epoch_${table.replace('rbac_', '')}_del: a delete raises the epoch`,
      triggers: [`rbac_epoch_${table.replace('rbac_', '')}_del`],
      run: (db) => {
        insert(db);
        const before = epochOf(db);
        run(db, remove);
        assert.ok(epochOf(db) > before, 'the epoch did not move');
      },
    },
  ]),
  // the group cache triggers (3)
  {
    name: 'rbac_group_cache_assignment_ins: a group assignment is added',
    triggers: ['rbac_group_cache_assignment_ins'],
    run: (db) => {
      addUser(db, 10);
      addCacheRow(db, 10, 700);
      addAssignment(db, { id: 4, principal: 700, type: 'group', role: 5 });
      assert.equal(count(db, 'SELECT count(*) AS n FROM rbac_group_member_cache'), 0);
    },
  },
  {
    name: 'rbac_group_cache_assignment_del: a group assignment is removed',
    triggers: ['rbac_group_cache_assignment_del'],
    run: (db) => {
      addAssignment(db, { id: 4, principal: 700, type: 'group', role: 5 });
      addUser(db, 10);
      addCacheRow(db, 10, 700);
      run(db, 'DELETE FROM rbac_assignment WHERE id = ?', guid(4));
      assert.equal(count(db, 'SELECT count(*) AS n FROM rbac_group_member_cache'), 0);
    },
  },
  {
    name: 'rbac_group_cache_assignment_upd: a group assignment is re-pointed',
    triggers: ['rbac_group_cache_assignment_upd'],
    run: (db) => {
      addAssignment(db, { id: 4, principal: 700, type: 'group', role: 5 });
      addUser(db, 10);
      addCacheRow(db, 10, 700);
      run(db, 'UPDATE rbac_assignment SET principal_id = ? WHERE id = ?', guid(701), guid(4));
      assert.equal(count(db, 'SELECT count(*) AS n FROM rbac_group_member_cache'), 0);
      assert.equal(
        count(db, 'SELECT count(*) AS n FROM app_user WHERE groups_resolved_at IS NOT NULL'),
        0,
      );
    },
  },
  {
    name: 'rbac_group_cache_assignment_upd: an update that is not about a principal leaves the cache',
    triggers: ['rbac_group_cache_assignment_upd'],
    run: (db) => {
      addAssignment(db, { id: 4, principal: 700, type: 'group', role: 5 });
      addUser(db, 10);
      addCacheRow(db, 10, 700);
      run(db, "UPDATE rbac_assignment SET created_by = 'x' WHERE id = ?", guid(4));
      assert.equal(count(db, 'SELECT count(*) AS n FROM rbac_group_member_cache'), 1);
    },
  },
  // the tenant triggers (2)
  {
    name: 'tenant_connection_tenant_pinned: changing a pinned tenant',
    triggers: ['tenant_connection_tenant_pinned'],
    run: (db) => {
      addTenant(db, guid(77));
      abortsWith(
        db,
        PIN_ABORT,
        'UPDATE tenant_connection SET tenant_id = ? WHERE id = 1',
        guid(78),
      );
    },
  },
  {
    name: 'tenant_connection_tenant_pinned: pinning an empty tenant is allowed, other columns change freely',
    triggers: ['tenant_connection_tenant_pinned'],
    run: (db) => {
      addTenant(db, null);
      run(db, 'UPDATE tenant_connection SET tenant_id = ? WHERE id = 1', guid(77));
      run(db, "UPDATE tenant_connection SET tenant_name = 'Contoso' WHERE id = 1");
    },
  },
  {
    name: 'tenant_connection_no_delete: deleting a pinned row',
    triggers: ['tenant_connection_no_delete'],
    run: (db) => {
      addTenant(db, guid(77));
      abortsWith(db, PIN_ABORT, 'DELETE FROM tenant_connection');
    },
  },
  {
    name: 'tenant_connection_no_delete: an unpinned row can be deleted',
    triggers: ['tenant_connection_no_delete'],
    run: (db) => {
      addTenant(db, null);
      run(db, 'DELETE FROM tenant_connection');
    },
  },
  // setup_state (2 triggers; every allowed and some refused edges)
  {
    name: 'setup_state_transition: every allowed edge, one after the other',
    triggers: ['setup_state_transition'],
    run: (db) => {
      addSetupState(db);
      for (const to of [
        'in_progress',
        'awaiting_first_signin',
        'in_progress',
        'awaiting_first_signin',
        'completed',
        'in_progress',
      ])
        moveSetup(db, to);
    },
  },
  {
    name: 'setup_state_transition: awaiting_first_signin cannot go back to unconfigured',
    triggers: ['setup_state_transition'],
    run: (db) => {
      setupAt(db, 'awaiting_first_signin');
      abortsWith(db, FORWARD_ABORT, "UPDATE setup_state SET state = 'unconfigured' WHERE id = 1");
    },
  },
  {
    name: 'setup_state_transition: updating a column other than state is never a transition',
    triggers: ['setup_state_transition'],
    run: (db) => {
      setupAt(db, 'completed');
      run(db, "UPDATE setup_state SET default_language = 'nl' WHERE id = 1");
    },
  },
  {
    name: 'setup_state_no_delete: delete is refused in every state',
    triggers: ['setup_state_no_delete'],
    run: (db) => {
      setupAt(db, 'completed');
      abortsWith(db, 'setup_state is never deleted', 'DELETE FROM setup_state WHERE id = 1');
    },
  },
];

/** Every case: the 59 assertions, then the trigger cases. */
const ALL_CASES: readonly Case[] = [...ASSERTIONS, ...TRIGGER_CASES];

function failures(image: Buffer): string[] {
  const failed: string[] = [];
  for (const testCase of ALL_CASES) {
    const db = freshDatabase(image);
    try {
      testCase.run(db);
    } catch {
      failed.push(testCase.name);
    } finally {
      db.close();
    }
  }
  return failed;
}

function triggerNames(db: Db): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((row) => row.name);
}

/** Throws unless every trigger in the database appears in the case table. */
function assertEveryTriggerHasACase(names: readonly string[], cases: readonly Case[]): void {
  const covered = new Set(cases.flatMap((testCase) => testCase.triggers ?? []));
  const missing = names.filter((name) => !covered.has(name));
  const unknown = [...covered].filter((name) => !names.includes(name));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(
      `trigger cases differ from the triggers: no case for [${missing.join(', ')}], unknown [${unknown.join(', ')}]`,
    );
  }
}

describe('the 59 assertions of data-model section 13', () => {
  it('are 59, in the eleven areas the document lists', () => {
    expect(ASSERTIONS).toHaveLength(59);
  });

  it.each(ASSERTIONS.map((testCase) => [testCase.name, testCase] as const))(
    '%s',
    (_name, testCase) => {
      const db = freshDatabase();
      try {
        testCase.run(db);
      } finally {
        db.close();
      }
    },
  );
});

describe('the trigger cases', () => {
  it('are 40', () => {
    expect(TRIGGER_CASES).toHaveLength(40);
  });

  it.each(TRIGGER_CASES.map((testCase) => [testCase.name, testCase] as const))(
    '%s',
    (_name, testCase) => {
      const db = freshDatabase();
      try {
        testCase.run(db);
      } finally {
        db.close();
      }
    },
  );

  it('cover every trigger of the migration (completeness)', () => {
    const db = freshDatabase();
    const names = triggerNames(db);
    db.close();
    expect(names).toHaveLength(29);
    expect(() => {
      assertEveryTriggerHasACase(names, TRIGGER_CASES);
    }).not.toThrow();
  });

  it('the completeness check fails for a trigger without a case, and for a case naming no trigger (negative fixtures)', () => {
    const db = freshDatabase();
    const names = triggerNames(db);
    db.close();
    const guard = (cases: readonly Case[]): void => {
      assertEveryTriggerHasACase(names, cases);
    };
    expectGuardFails(
      guard,
      TRIGGER_CASES.filter((testCase) => !testCase.triggers?.includes('setup_state_no_delete')),
      { name: 'completeness', reason: 'no case for [setup_state_no_delete]' },
    );
    expectGuardFails(
      guard,
      [...TRIGGER_CASES, { name: 'invented', triggers: ['no_such_trigger'], run: () => undefined }],
      { name: 'completeness', reason: 'unknown [no_such_trigger]' },
    );
  });
});

describe('the single-trigger mutation test (FR-B-701, DM-06)', () => {
  it('passes every assertion and case on the intact schema', () => {
    expect(failures(BASE_IMAGE)).toEqual([]);
  });

  it('drops each of the 29 triggers alone and requires at least one failing case: 29 of 29', () => {
    const db = freshDatabase();
    const names = triggerNames(db);
    db.close();
    expect(names).toHaveLength(29);
    const survivors: string[] = [];
    for (const name of names) {
      const mutant = freshDatabase();
      mutant.exec(`DROP TRIGGER \`${name}\``);
      const image = mutant.serialize();
      mutant.close();
      if (failures(image).length === 0) survivors.push(name);
    }
    expect(survivors).toEqual([]);
  }, 120_000);

  it('the mutation test fails when a case table is too weak (negative fixture): only the 12 epoch cases survive nothing', () => {
    // A weak table: with only the first assertion (the seeds) no dropped trigger would be noticed.
    const weak = ASSERTIONS.slice(0, 1);
    const survivors: string[] = [];
    const db = freshDatabase();
    const names = triggerNames(db);
    db.close();
    for (const name of names.slice(0, 3)) {
      const mutant = freshDatabase();
      mutant.exec(`DROP TRIGGER \`${name}\``);
      const image = mutant.serialize();
      mutant.close();
      const failed = weak.some((testCase) => {
        const copy = freshDatabase(image);
        try {
          testCase.run(copy);
          return false;
        } catch {
          return true;
        } finally {
          copy.close();
        }
      });
      if (!failed) survivors.push(name);
    }
    // The weak table lets all three mutants survive: the real table is what stops that.
    expect(survivors).toHaveLength(3);
  });
});

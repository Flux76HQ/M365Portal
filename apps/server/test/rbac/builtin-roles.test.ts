// T-B-238, FR-B-501, FR-B-503, I-B1, EB-29 (part): the built-in roles in the database are the
// constant `BUILTIN_ROLES`, no statement can change them, a custom role stays editable, and the
// start-up check refuses a database where a row differs.
import { PERMISSIONS } from '@m365portal/shared/permissions';
import { BUILTIN_ROLES } from '@m365portal/shared/rbac/roles';
import { expectGuardFails } from '@m365portal/shared/testing';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { withTransaction, type AppDatabase } from '../../src/db/index.js';
import { BuiltinRolesMismatchError, assertBuiltinRoles } from '../../src/rbac/builtin-check.js';
import {
  deleteRole,
  findRoleByKey,
  insertRole,
  listRoles,
  readEpoch,
  replaceRoleGrants,
} from '../../src/rbac/repository.js';
import { createMigratedDatabase } from '../helpers/rbac-db.js';

const NOW = '2026-10-11T12:00:00.000Z';

describe('the seeded roles are BUILTIN_ROLES (I-B1)', () => {
  it('has the six roles, in order, with the 54 permission rows of the matrix', async () => {
    const db = await createMigratedDatabase();
    const roles = listRoles(db).filter((role) => role.builtin);
    expect(roles.map((role) => role.key)).toEqual(BUILTIN_ROLES.map((role) => role.key));
    expect(roles.map((role) => role.grants.length)).toEqual([15, 13, 9, 6, 4, 7]);
    expect(roles.reduce((sum, role) => sum + role.grants.length, 0)).toBe(54);
    for (const [index, definition] of BUILTIN_ROLES.entries()) {
      const stored = roles[index];
      expect(stored?.assignable).toBe(true);
      expect(stored?.grants).toEqual(definition.permissions);
    }
  });

  it('lists the permissions of a role in catalogue order', async () => {
    const db = await createMigratedDatabase();
    const owner = findRoleByKey(db, 'owner');
    expect(owner?.grants.map((entry) => entry.permission)).toEqual([...PERMISSIONS]);
  });
});

/** Every statement that must be refused for a built-in role, with the rows it names. */
const FORBIDDEN: readonly { readonly name: string; readonly sql: string }[] = [
  {
    name: 'update a built-in role',
    sql: "UPDATE rbac_role SET assignable = 0 WHERE key = 'admin'",
  },
  { name: 'rename a built-in role', sql: "UPDATE rbac_role SET key = 'boss' WHERE key = 'owner'" },
  { name: 'delete a built-in role', sql: "DELETE FROM rbac_role WHERE key = 'reader'" },
  {
    name: 'insert a seventh built-in role',
    sql: "INSERT INTO rbac_role (key, builtin, assignable, created_at) VALUES ('seventh', 1, 1, '2026-10-11T12:00:00.000Z')",
  },
  {
    name: 'insert a permission into a built-in role',
    sql: "INSERT INTO rbac_role_permission (role_id, permission, qualifier) VALUES (5, 'audit:read', '')",
  },
  {
    name: 'update a permission of a built-in role',
    sql: "UPDATE rbac_role_permission SET qualifier = 'basic' WHERE role_id = 5 AND permission = 'users:read'",
  },
  {
    name: 'delete a permission of a built-in role',
    sql: "DELETE FROM rbac_role_permission WHERE role_id = 1 AND permission = 'rbac:manage'",
  },
  {
    name: 'move a custom permission into a built-in role',
    sql: 'UPDATE rbac_role_permission SET role_id = 1 WHERE role_id = 99',
  },
];

/** Throws unless every forbidden statement is refused with the immutability message. */
function assertBuiltinRolesImmutable(sqlite: Database.Database): void {
  // A custom role (id 99) for the statement that tries to move a permission into a built-in role.
  sqlite.exec(
    "INSERT INTO rbac_role (id, key, builtin, assignable, created_at) VALUES (99, 'custom99', 0, 1, '2026-10-11T12:00:00.000Z');" +
      "INSERT INTO rbac_role_permission (role_id, permission, qualifier) VALUES (99, 'audit:read', '')",
  );
  for (const { name, sql } of FORBIDDEN) {
    let refused = false;
    try {
      sqlite.exec(sql);
    } catch (error) {
      refused = (error as Error).message.includes('immutable');
    }
    if (!refused) throw new Error(`"${name}" was not refused: a built-in role can be changed`);
  }
}

describe('a built-in role cannot be changed by any statement (FR-B-501)', () => {
  it('refuses every statement of the table with the immutability message', async () => {
    const db = await createMigratedDatabase();
    expect(() => {
      assertBuiltinRolesImmutable(db.sqlite);
    }).not.toThrow();
  });

  it('negative fixture: a database built without the triggers is detected', async () => {
    const db = await createMigratedDatabase();
    const triggers = db.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%builtin%'")
      .all() as { name: string }[];
    expect(triggers.length).toBeGreaterThanOrEqual(6);
    for (const { name } of triggers) db.sqlite.exec(`DROP TRIGGER \`${name}\``);
    expectGuardFails(assertBuiltinRolesImmutable, db.sqlite, { reason: 'was not refused' });
  });

  it('leaves the epoch alone when a statement is refused', async () => {
    const db = await createMigratedDatabase();
    const before = readEpoch(db);
    expect(() => {
      db.sqlite.exec("DELETE FROM rbac_role WHERE key = 'owner'");
    }).toThrow(/immutable/);
    expect(readEpoch(db)).toBe(before);
  });
});

describe('a custom role stays editable (FR-B-501)', () => {
  it('is created, changed and deleted through the repository, each change bumping the epoch', async () => {
    const db = await createMigratedDatabase();
    const start = readEpoch(db);
    const role = withTransaction(db, (tx) =>
      insertRole(tx, {
        key: 'helper',
        createdAt: NOW,
        grants: [{ permission: 'users:read', qualifier: 'basic' }],
      }),
    );
    expect(role).toMatchObject({ key: 'helper', builtin: false, assignable: true });
    expect(findRoleByKey(db, 'helper')?.grants).toEqual([
      { permission: 'users:read', qualifier: 'basic' },
    ]);
    expect(readEpoch(db)).toBeGreaterThan(start);

    withTransaction(db, (tx) => {
      replaceRoleGrants(tx, role.id, [
        { permission: 'users:read', qualifier: 'full' },
        { permission: 'groups:read', qualifier: 'full' },
      ]);
    });
    expect(findRoleByKey(db, 'helper')?.grants.map((entry) => entry.permission)).toEqual([
      'users:read',
      'groups:read',
    ]);

    withTransaction(db, (tx) => {
      deleteRole(tx, role.id);
    });
    expect(findRoleByKey(db, 'helper')).toBeUndefined();
    expect(() => {
      assertBuiltinRoles(db);
    }).not.toThrow();
  });

  it('refuses the repository functions on a built-in role', async () => {
    const db = await createMigratedDatabase();
    const owner = findRoleByKey(db, 'owner');
    expect(() => {
      withTransaction(db, (tx) => {
        replaceRoleGrants(tx, owner?.id ?? 0, []);
      });
    }).toThrow(/immutable/);
    expect(() => {
      withTransaction(db, (tx) => {
        deleteRole(tx, owner?.id ?? 0);
      });
    }).toThrow(/immutable/);
  });
});

describe('the start-up check refuses a database where a row differs (EB-29)', () => {
  /** Each tamper bypasses the triggers the way a restored backup or a hand edit would. */
  const TAMPERS: readonly {
    readonly name: string;
    readonly sql: string;
    readonly part: 'roles' | 'permissions' | 'template';
  }[] = [
    {
      name: 'a missing permission row',
      sql: "DELETE FROM rbac_role_permission WHERE role_id = 3 AND permission = 'contacts:delete'",
      part: 'permissions',
    },
    {
      name: 'an extra permission row',
      sql: "INSERT INTO rbac_role_permission (role_id, permission, qualifier) VALUES (5, 'rbac:manage', '')",
      part: 'permissions',
    },
    {
      name: 'a changed qualifier',
      sql: "UPDATE rbac_role_permission SET qualifier = 'basic' WHERE role_id = 4 AND permission = 'users:read'",
      part: 'permissions',
    },
    {
      name: 'a role that is not assignable',
      sql: "UPDATE rbac_role SET assignable = 0 WHERE key = 'admin'",
      part: 'roles',
    },
    {
      name: 'a missing role',
      sql: "DELETE FROM rbac_role WHERE key = 'helpdesk'",
      part: 'roles',
    },
    {
      name: 'a role that lost its built-in flag',
      sql: "UPDATE rbac_role SET builtin = 0 WHERE key = 'reader'",
      part: 'roles',
    },
    {
      name: 'a changed template',
      sql: "UPDATE rbac_role_template SET scope_target = 'group' WHERE key = 'board'",
      part: 'template',
    },
  ];

  async function tampered(sql: string): Promise<AppDatabase> {
    const db = await createMigratedDatabase();
    for (const { name } of db.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%builtin%'")
      .all() as { name: string }[]) {
      db.sqlite.exec(`DROP TRIGGER \`${name}\``);
    }
    db.sqlite.exec(sql);
    return db;
  }

  it('passes for the seeded database', async () => {
    const db = await createMigratedDatabase();
    expect(() => {
      assertBuiltinRoles(db);
    }).not.toThrow();
  });

  it.each(TAMPERS)('names the part for $name', async ({ sql, part }) => {
    const db = await tampered(sql);
    try {
      assertBuiltinRoles(db);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(BuiltinRolesMismatchError);
      expect((error as BuiltinRolesMismatchError).code).toBe('builtin_roles_mismatch');
      expect((error as BuiltinRolesMismatchError).part).toBe(part);
    }
  });

  it.each(TAMPERS)('negative fixture: the check fails on purpose for $name', async ({ sql }) => {
    expectGuardFails(assertBuiltinRoles, await tampered(sql), {
      reason: 'differ from the shipped',
    });
  });

  it('does not put a value of the database in the message', async () => {
    const db = await tampered(
      "INSERT INTO rbac_role_permission (role_id, permission, qualifier) VALUES (5, 'canary:value', '')",
    );
    try {
      assertBuiltinRoles(db);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain('canary:value');
    }
  });
});

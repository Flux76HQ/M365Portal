// T-B-231, FR-B-501 (constant), FR-B-502, FR-B-503, I-B1, CB8: the six built-in roles and the
// template *Bestuur* are ONE constant, and that constant equals the matrix of spec 6.9.4.
// The matrix is written out again below as the second, independent statement (it is not derived from
// the constant), in the notation of the spec table: `x` = held, `basic` = the qualifier, empty = not held.
// `docs/permissions.md` is compared with the constant by `T-B-420`; the database by `T-B-238`.
import { describe, expect, expectTypeOf, it } from 'vitest';
import { PERMISSIONS, type Permission } from '../src/permissions.js';
import {
  BUILTIN_ROLES,
  BUILTIN_ROLE_KEYS,
  TEMPLATES,
  type BuiltinRoleKey,
  type RoleDefinition,
  type RoleTemplate,
} from '../src/rbac/roles.js';
import type { Qualifier } from '../src/rbac/resources.js';
import { expectGuardFails } from '../src/testing/index.js';

type Cell = '' | 'x' | 'basic';
// permission, owner, admin, operator, helpdesk, reader, dl_editor, board (template)
const MATRIX: readonly (readonly [Permission, Cell, Cell, Cell, Cell, Cell, Cell, Cell])[] = [
  ['users:read', 'x', 'x', 'x', 'x', 'x', 'x', 'basic'],
  ['groups:read', 'x', 'x', 'x', 'x', 'x', '', ''],
  ['groups:members:write', 'x', 'x', 'x', 'x', '', '', ''],
  ['distributionlists:read', 'x', 'x', 'x', 'x', 'x', 'x', 'x'],
  ['distributionlists:members:write', 'x', 'x', 'x', 'x', '', 'x', 'x'],
  ['distributionlists:export', 'x', 'x', '', '', '', '', ''],
  ['contacts:read', 'x', 'x', 'x', 'x', 'x', 'x', 'x'],
  ['contacts:create', 'x', 'x', 'x', '', '', 'x', 'x'],
  ['contacts:update', 'x', 'x', 'x', '', '', 'x', ''],
  ['contacts:delete', 'x', 'x', 'x', '', '', 'x', ''],
  ['audit:read', 'x', 'x', '', '', '', '', ''],
  ['audit:export', 'x', 'x', '', '', '', '', ''],
  ['settings:branding', 'x', 'x', '', '', '', '', ''],
  ['settings:connection', 'x', '', '', '', '', '', ''],
  ['rbac:manage', 'x', '', '', '', '', '', ''],
];
const ROLE_COLUMNS = ['owner', 'admin', 'operator', 'helpdesk', 'reader', 'dl_editor'] as const;
const COUNTS = { owner: 15, admin: 13, operator: 9, helpdesk: 6, reader: 4, dl_editor: 7 } as const;

interface RoleLike {
  readonly key: string;
  readonly permissions: readonly { readonly permission: string; readonly qualifier: string }[];
}

/** The matrix guard: throws unless the roles equal the spec table, role by role and cell by cell. */
function assertMatrix(roles: readonly RoleLike[]): void {
  const problems: string[] = [];
  if (roles.map((r) => r.key).join() !== ROLE_COLUMNS.join())
    problems.push(`role keys are ${roles.map((r) => r.key).join()}`);
  ROLE_COLUMNS.forEach((key, column) => {
    const role = roles.find((r) => r.key === key);
    if (role === undefined) return;
    for (const row of MATRIX) {
      const permission = row[0];
      const cell = row[column + 1] as Cell;
      const held = role.permissions.filter((p) => p.permission === permission);
      if (cell === '' && held.length > 0) problems.push(`${key} must not hold ${permission}`);
      if (cell === 'x' && (held.length !== 1 || held[0]?.qualifier !== 'full'))
        problems.push(`${key} must hold ${permission} in full, once`);
    }
    for (const { permission } of role.permissions)
      if (!PERMISSIONS.includes(permission as Permission))
        problems.push(`${key} holds ${permission}, which is not a permission`);
    if (role.permissions.length !== COUNTS[key])
      problems.push(
        `${key} holds ${String(role.permissions.length)}, expected ${String(COUNTS[key])}`,
      );
  });
  if (problems.length > 0) throw new Error(`not the matrix of spec 6.9.4: ${problems.join('; ')}`);
}

const roleOf = (key: BuiltinRoleKey): RoleDefinition => {
  const role = BUILTIN_ROLES.find((r) => r.key === key);
  if (role === undefined) throw new Error(`no role ${key}`);
  return role;
};
const held = (key: BuiltinRoleKey): Permission[] =>
  roleOf(key).permissions.map((p) => p.permission);

describe('BUILTIN_ROLES equals the matrix of spec 6.9.4', () => {
  it('passes the matrix guard', () => {
    expect(() => {
      assertMatrix(BUILTIN_ROLES);
    }).not.toThrow();
  });

  it('holds the six roles in the order of the spec, with English keys', () => {
    expect(BUILTIN_ROLES.map((r) => r.key)).toEqual([...ROLE_COLUMNS]);
    expect([...BUILTIN_ROLE_KEYS]).toEqual([...ROLE_COLUMNS]);
    for (const role of BUILTIN_ROLES) {
      expect(role.builtin).toBe(true);
      expect(role.assignable).toBe(true);
      expect(role.key).toMatch(/^[a-z][a-z0-9_]{1,31}$/);
    }
  });

  it.each(ROLE_COLUMNS)('%s holds exactly its column of the table, every qualifier full', (key) => {
    const column = ROLE_COLUMNS.indexOf(key) + 1;
    const expected = MATRIX.filter((row) => row[column] === 'x').map((row) => row[0]);
    expect(held(key)).toEqual(expected);
    expect(held(key)).toHaveLength(COUNTS[key]);
    for (const { qualifier } of roleOf(key).permissions) expect(qualifier).toBe('full');
  });

  it('has 54 role-permission rows in total and no permission twice in a role', () => {
    expect(BUILTIN_ROLES.reduce((sum, r) => sum + r.permissions.length, 0)).toBe(54);
    for (const role of BUILTIN_ROLES)
      expect(new Set(held(role.key)).size, role.key).toBe(role.permissions.length);
  });

  it('lists each role in catalogue order', () => {
    for (const role of BUILTIN_ROLES) {
      const order = held(role.key).map((p) => PERMISSIONS.indexOf(p));
      expect(order, role.key).toEqual([...order].sort((a, b) => a - b));
    }
  });
});

describe('the properties of FR-B-502', () => {
  it('Eigenaar (owner) holds all 15', () => {
    expect(new Set(held('owner'))).toEqual(new Set(PERMISSIONS));
  });

  it('Beheerder (admin) lacks exactly rbac:manage and settings:connection', () => {
    expect(PERMISSIONS.filter((p) => !held('admin').includes(p))).toEqual([
      'settings:connection',
      'rbac:manage',
    ]);
  });

  it('Operator has no settings, audit, rbac:manage and no export', () => {
    for (const p of held('operator')) {
      expect(p).not.toMatch(/^(settings|audit):/);
      expect(p).not.toBe('rbac:manage');
      expect(p).not.toMatch(/export/);
    }
    expect(held('operator')).toHaveLength(9);
  });

  it('Helpdesk adds only the two member-write permissions to Lezer', () => {
    const extra = held('helpdesk').filter((p) => !held('reader').includes(p));
    expect(extra).toEqual(
      ['groups:members:write', 'distributionlists:members:write'].sort(byCatalogue),
    );
    expect(held('reader').every((p) => held('helpdesk').includes(p))).toBe(true);
  });

  it('Lezer (reader) holds no write, create, update, delete, export, settings, audit or rbac permission', () => {
    expect(held('reader')).toEqual([
      'users:read',
      'groups:read',
      'distributionlists:read',
      'contacts:read',
    ]);
    for (const p of held('reader')) {
      expect(p).not.toMatch(/:(write|create|update|delete)$/);
      expect(p).not.toMatch(/export/);
      expect(p).not.toMatch(/^(settings|audit|rbac):/);
    }
  });

  it('every smaller role is inside the larger one (reader < helpdesk < operator < admin < owner)', () => {
    const chain: BuiltinRoleKey[] = ['reader', 'helpdesk', 'operator', 'admin', 'owner'];
    chain.slice(1).forEach((largerKey, index) => {
      const smallerKey = chain[index] ?? 'reader';
      const larger = held(largerKey);
      expect(
        held(smallerKey).every((p) => larger.includes(p)),
        `${smallerKey} in ${largerKey}`,
      ).toBe(true);
    });
  });
});

function byCatalogue(a: string, b: string): number {
  return PERMISSIONS.indexOf(a as Permission) - PERMISSIONS.indexOf(b as Permission);
}

describe('the template Bestuur (board)', () => {
  const board = TEMPLATES.find((t) => t.key === 'board');

  it('is the only template and is not assignable', () => {
    expect(TEMPLATES.map((t) => t.key)).toEqual(['board']);
    expect(board?.assignable).toBe(false);
  });

  it('holds the five permissions of the board column, users:read with the qualifier basic', () => {
    const expected = MATRIX.filter((row) => row[7] !== '').map((row) => ({
      permission: row[0],
      qualifier: row[7] === 'basic' ? 'basic' : 'full',
    }));
    expect(expected).toHaveLength(5);
    expect(board?.permissions).toHaveLength(5);
    const norm = (list: readonly { permission: string; qualifier: string }[] | undefined) =>
      [...(list ?? [])].sort((a, b) => a.permission.localeCompare(b.permission));
    expect(norm(board?.permissions)).toEqual(norm(expected));
    expect(board?.permissions.filter((p) => p.qualifier === 'basic')).toEqual([
      { permission: 'users:read', qualifier: 'basic' },
    ]);
  });

  it('suggests the scope target distributionList', () => {
    expect(board?.scopeTarget).toBe('distributionList');
  });

  it('is not a role: its key is not a built-in role key', () => {
    expect(BUILTIN_ROLES.some((r) => r.key === board?.key)).toBe(false);
  });
});

describe('the constants are frozen all the way down', () => {
  it('cannot be changed at runtime', () => {
    expect(Object.isFrozen(BUILTIN_ROLES)).toBe(true);
    expect(Object.isFrozen(BUILTIN_ROLE_KEYS)).toBe(true);
    expect(Object.isFrozen(TEMPLATES)).toBe(true);
    for (const role of BUILTIN_ROLES) {
      expect(Object.isFrozen(role), role.key).toBe(true);
      expect(Object.isFrozen(role.permissions), role.key).toBe(true);
      for (const entry of role.permissions) expect(Object.isFrozen(entry)).toBe(true);
    }
    for (const template of TEMPLATES) {
      expect(Object.isFrozen(template)).toBe(true);
      expect(Object.isFrozen(template.permissions)).toBe(true);
      for (const entry of template.permissions) expect(Object.isFrozen(entry)).toBe(true);
    }
    expect(() => {
      (roleOf('reader').permissions as unknown as unknown[]).push({
        permission: 'rbac:manage',
        qualifier: 'full',
      });
    }).toThrow(TypeError);
    expect(held('reader')).toHaveLength(4);
  });
});

describe('types', () => {
  it('has the shapes the server and the web rely on', () => {
    expectTypeOf<BuiltinRoleKey>().toEqualTypeOf<
      'owner' | 'admin' | 'operator' | 'helpdesk' | 'reader' | 'dl_editor'
    >();
    expectTypeOf<RoleDefinition['permissions'][number]>().toEqualTypeOf<{
      readonly permission: Permission;
      readonly qualifier: Qualifier;
    }>();
    expectTypeOf<RoleTemplate['scopeTarget']>().toEqualTypeOf<
      'user' | 'group' | 'distributionList' | 'contact' | null
    >();
  });
});

describe('negative fixtures: one changed permission in the constant fails the table', () => {
  const clone = (): { key: string; permissions: { permission: string; qualifier: string }[] }[] =>
    BUILTIN_ROLES.map((r) => ({
      key: r.key,
      permissions: r.permissions.map((p) => ({ ...p })),
    }));
  const reason = 'not the matrix of spec 6.9.4';

  it('fails when a permission is added to Lezer', () => {
    const roles = clone();
    roles[4]?.permissions.push({ permission: 'contacts:create', qualifier: 'full' });
    expectGuardFails(assertMatrix, roles, {
      reason: `${reason}: reader must not hold contacts:create`,
    });
  });

  it('fails when a permission is taken from Beheerder', () => {
    const roles = clone();
    roles[1] = { key: 'admin', permissions: roles[1]?.permissions.slice(1) ?? [] };
    expectGuardFails(assertMatrix, roles, { reason: 'admin must hold users:read in full' });
  });

  it('fails when Beheerder gets rbac:manage', () => {
    const roles = clone();
    roles[1]?.permissions.push({ permission: 'rbac:manage', qualifier: 'full' });
    expectGuardFails(assertMatrix, roles, { reason: 'admin must not hold rbac:manage' });
  });

  it('fails when a qualifier changes', () => {
    const roles = clone();
    const first = roles[0]?.permissions[0];
    if (first !== undefined) first.qualifier = 'basic';
    expectGuardFails(assertMatrix, roles, { reason: 'owner must hold users:read in full' });
  });

  it('fails when a permission is swapped for another of the same count', () => {
    const roles = clone();
    const reader = roles[4];
    if (reader !== undefined)
      reader.permissions = reader.permissions.map((p) =>
        p.permission === 'contacts:read' ? { permission: 'contacts:delete', qualifier: 'full' } : p,
      );
    expectGuardFails(assertMatrix, roles, { reason: 'reader must not hold contacts:delete' });
  });

  it('fails when a role is missing or the order changes', () => {
    expectGuardFails(assertMatrix, clone().slice(0, 4), { reason: 'role keys are' });
    expectGuardFails(assertMatrix, clone().reverse(), { reason: 'role keys are' });
  });

  it('fails for a name that is not a permission', () => {
    const roles = clone();
    roles[0]?.permissions.push({ permission: 'users:write', qualifier: 'full' });
    expectGuardFails(assertMatrix, roles, { reason: 'users:write, which is not a permission' });
  });
});

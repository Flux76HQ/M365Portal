// T-A-020, contract C1, FR-A-030 (TA-02): the permission catalogue is one typed list of exactly the
// fifteen permissions of brief section 2a. This file asserts the list; `server/docs-contract.test.ts`
// asserts that `docs/permissions.md` names the same fifteen.
import { describe, expect, expectTypeOf, it } from 'vitest';
import { expectGuardFails } from '../src/testing/index.js';
import {
  PERMISSIONS,
  PERMISSION_RESOURCE,
  PermissionSchema,
  hasAnyPermission,
  type Permission,
} from '../src/permissions.js';
import type { ResourceType } from '../src/rbac/resources.js';

// Written out here on purpose: the test is the second, independent statement of the brief's list.
// `single-implementation.test.ts` only scans code outside the test folders for a second copy.
const BRIEF_2A = [
  'users:read',
  'groups:read',
  'groups:members:write',
  'distributionlists:read',
  'distributionlists:members:write',
  'distributionlists:export',
  'contacts:read',
  'contacts:create',
  'contacts:update',
  'contacts:delete',
  'audit:read',
  'audit:export',
  'settings:branding',
  'settings:connection',
  'rbac:manage',
] as const;

/** The guard behind the catalogue rule: throws unless `list` is exactly the brief's list, in order. */
function assertBriefCatalogue(list: readonly string[]): void {
  const problems: string[] = [];
  for (const name of BRIEF_2A) if (!list.includes(name)) problems.push(`${name} is missing`);
  for (const name of list)
    if (!(BRIEF_2A as readonly string[]).includes(name))
      problems.push(`${name} is not in the brief`);
  if (new Set(list).size !== list.length) problems.push('an entry is listed twice');
  if (problems.length === 0 && list.join() !== BRIEF_2A.join()) problems.push('the order differs');
  if (problems.length > 0) throw new Error(`not the catalogue of brief 2a: ${problems.join('; ')}`);
}

describe('PERMISSIONS: the catalogue of brief section 2a', () => {
  it('passes the catalogue guard, which fails on every deviation (negative fixtures)', () => {
    expect(() => {
      assertBriefCatalogue(PERMISSIONS);
    }).not.toThrow();

    const reason = 'not the catalogue of brief 2a';
    expectGuardFails(assertBriefCatalogue, [...BRIEF_2A, 'users:write'], { reason });
    expectGuardFails(assertBriefCatalogue, BRIEF_2A.slice(0, 14), { reason });
    expectGuardFails(assertBriefCatalogue, [...BRIEF_2A, 'rbac:manage'], { reason });
    expectGuardFails(assertBriefCatalogue, [...BRIEF_2A].reverse(), {
      reason: 'the order differs',
    });
    expectGuardFails(
      assertBriefCatalogue,
      BRIEF_2A.map((name) => name.toUpperCase()),
      { reason },
    );
  });

  it('holds exactly the fifteen permissions of the brief, in the brief order', () => {
    expect([...PERMISSIONS]).toEqual([...BRIEF_2A]);
    expect(PERMISSIONS).toHaveLength(15);
  });

  it('has no duplicates', () => {
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
  });

  it('spells every entry as resource:action or resource:sub-resource:action in lower case', () => {
    for (const permission of PERMISSIONS) {
      expect(permission, permission).toMatch(/^[a-z]+(:[a-z]+){1,2}$/);
    }
  });

  it('is frozen: the list cannot be changed at runtime', () => {
    expect(Object.isFrozen(PERMISSIONS)).toBe(true);
    expect(() => {
      (PERMISSIONS as unknown as string[]).push('users:write');
    }).toThrow(TypeError);
    expect(PERMISSIONS).toHaveLength(15);
  });
});

describe('Permission type', () => {
  it('is the union of the list entries', () => {
    expectTypeOf<Permission>().toEqualTypeOf<(typeof BRIEF_2A)[number]>();
    expectTypeOf(PERMISSIONS).toExtend<readonly Permission[]>();
    expectTypeOf<(typeof PERMISSIONS)['length']>().toEqualTypeOf<15>();
    expectTypeOf<'users:read'>().toExtend<Permission>();
    expectTypeOf<'users:write'>().not.toExtend<Permission>();
    expectTypeOf<string>().not.toExtend<Permission>();
  });
});

describe('PermissionSchema', () => {
  it.each(BRIEF_2A)('accepts %s', (permission) => {
    expect(PermissionSchema.safeParse(permission)).toEqual({ success: true, data: permission });
  });

  it.each([
    ['a permission that is not in the catalogue', 'users:write'],
    ['the wildcard', '*'],
    ['the empty string', ''],
    ['upper case', 'USERS:READ'],
    ['mixed case', 'Users:Read'],
    ['a trailing space', 'users:read '],
    ['a leading space', ' users:read'],
    ['a prefix of a permission', 'users'],
    ['a permission with a suffix', 'users:read:all'],
    ['a dotted spelling', 'users.read'],
    ['a number', 42],
    ['null', null],
    ['undefined', undefined],
    ['an array', ['users:read']],
    ['an object', { name: 'users:read' }],
  ])('rejects %s', (_label, value) => {
    expect(PermissionSchema.safeParse(value).success).toBe(false);
  });

  it('carries an OpenAPI component id', () => {
    expect(PermissionSchema.meta()?.id).toBe('Permission');
  });
});

describe('hasAnyPermission', () => {
  const [usersRead, groupsRead, , , , , contactsRead] = PERMISSIONS;
  const everything = new Set<Permission>(PERMISSIONS);

  it('is false for the empty held set, whatever is asked (deny by default)', () => {
    expect(hasAnyPermission(new Set<Permission>(), [usersRead])).toBe(false);
    expect(hasAnyPermission(new Set<Permission>(), [...PERMISSIONS])).toBe(false);
    expect(hasAnyPermission([], [usersRead])).toBe(false);
  });

  it('is false when nothing is asked: "any of nothing" cannot be satisfied', () => {
    expect(hasAnyPermission(new Set<Permission>(), [])).toBe(false);
    expect(hasAnyPermission(everything, [])).toBe(false);
    expect(hasAnyPermission([usersRead], [])).toBe(false);
  });

  it('is true when one asked permission is held', () => {
    expect(hasAnyPermission(new Set([usersRead]), [usersRead])).toBe(true);
    expect(hasAnyPermission(new Set([usersRead, groupsRead]), [groupsRead])).toBe(true);
  });

  it('is true when only one of several asked permissions is held, wherever it is in the list', () => {
    expect(hasAnyPermission(new Set([contactsRead]), [usersRead, groupsRead, contactsRead])).toBe(
      true,
    );
    expect(hasAnyPermission(new Set([contactsRead]), [contactsRead, usersRead, groupsRead])).toBe(
      true,
    );
  });

  it('is false when none of the asked permissions is held', () => {
    expect(hasAnyPermission(new Set([usersRead]), [groupsRead])).toBe(false);
    expect(hasAnyPermission(new Set([usersRead, groupsRead]), [contactsRead])).toBe(false);
  });

  it('does not treat a related permission as a held one (read is not write)', () => {
    expect(hasAnyPermission(new Set<Permission>(['groups:read']), ['groups:members:write'])).toBe(
      false,
    );
    expect(hasAnyPermission(new Set<Permission>(['groups:members:write']), ['groups:read'])).toBe(
      false,
    );
  });

  it('holds for every permission when the whole catalogue is held', () => {
    for (const permission of PERMISSIONS) {
      expect(hasAnyPermission(everything, [permission]), permission).toBe(true);
    }
  });

  it('accepts the held permissions as a Set or as an array (the actor and the /me response)', () => {
    expect(hasAnyPermission([usersRead, groupsRead], [groupsRead])).toBe(true);
    expect(hasAnyPermission([usersRead, groupsRead], [contactsRead])).toBe(false);
    expect(hasAnyPermission(new Set([usersRead, groupsRead]), [groupsRead])).toBe(true);
  });

  it('does not change its arguments', () => {
    const held = new Set<Permission>([usersRead]);
    const asked: Permission[] = [groupsRead, usersRead];
    hasAnyPermission(held, asked);
    expect([...held]).toEqual([usersRead]);
    expect(asked).toEqual([groupsRead, usersRead]);
  });
});

// T-B-230, XB6, CB8: the resource type of every permission, next to the catalogue. Written out again
// here on purpose (spec 6.5.1): the test is the second statement of the map.
const EXPECTED_RESOURCE: Readonly<Record<Permission, ResourceType | null>> = {
  'users:read': 'user',
  'groups:read': 'group',
  'groups:members:write': 'group',
  'distributionlists:read': 'distributionList',
  'distributionlists:members:write': 'distributionList',
  'distributionlists:export': 'distributionList',
  'contacts:read': 'contact',
  'contacts:create': 'contact',
  'contacts:update': 'contact',
  'contacts:delete': 'contact',
  'audit:read': null,
  'audit:export': null,
  'settings:branding': null,
  'settings:connection': null,
  'rbac:manage': null,
};

describe('PERMISSION_RESOURCE (T-B-230, XB6)', () => {
  it('leaves the fifteen entries of the catalogue unchanged and in order', () => {
    expect([...PERMISSIONS]).toEqual([...BRIEF_2A]);
    expect(Object.keys(PERMISSION_RESOURCE)).toEqual([...BRIEF_2A]);
  });

  it.each(BRIEF_2A)(
    'maps %s to its resource type, or to none for a global-only permission',
    (p) => {
      expect(PERMISSION_RESOURCE[p]).toBe(EXPECTED_RESOURCE[p]);
    },
  );

  it('puts every permission in exactly one class: resource-bound or global-only', () => {
    const bound = PERMISSIONS.filter((p) => PERMISSION_RESOURCE[p] !== null);
    const globalOnly = PERMISSIONS.filter((p) => PERMISSION_RESOURCE[p] === null);
    expect(bound).toHaveLength(10);
    expect(globalOnly).toEqual([
      'audit:read',
      'audit:export',
      'settings:branding',
      'settings:connection',
      'rbac:manage',
    ]);
    expect(bound.length + globalOnly.length).toBe(PERMISSIONS.length);
    for (const p of PERMISSIONS)
      expect([...bound, ...globalOnly].filter((q) => q === p)).toHaveLength(1);
  });

  it('is frozen, so the map cannot be changed at runtime', () => {
    expect(Object.isFrozen(PERMISSION_RESOURCE)).toBe(true);
    expect(() => {
      (PERMISSION_RESOURCE as unknown as Record<string, string>)['users:read'] = 'group';
    }).toThrow(TypeError);
    expect(PERMISSION_RESOURCE['users:read']).toBe('user');
  });

  it('is typed for every permission, with a resource type or null', () => {
    expectTypeOf(PERMISSION_RESOURCE).toEqualTypeOf<
      Readonly<Record<Permission, ResourceType | null>>
    >();
  });
});

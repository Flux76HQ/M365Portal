// T-B-233, FR-B-504, FR-B-515 (pure half), B-11, SB-13, EB-38, SC-B-006: effective permissions are ONE
// pure function. The matrix 15 permissions x 5 roles x {unscoped, scoped in, scoped out, expired,
// group-derived} is checked against a table written out here; a seeded property test (RBAC_PROPERTY_SEED,
// at least 20,000 cases) compares the function with a second formulation of spec 6.5.2 that works per
// resource instead of per grant; and three deliberately broken copies must fail that property.
import { describe, expect, expectTypeOf, it } from 'vitest';
import { PERMISSIONS, PERMISSION_RESOURCE, type Permission } from '../src/permissions.js';
import {
  GROUP_FORBIDDEN_PERMISSIONS,
  computeGrants,
  earliestExpiry,
  isAssignmentActive,
  type Grant,
  type GrantAssignment,
} from '../src/rbac/effective.js';
import { BUILTIN_ROLES, type BuiltinRoleKey, type RolePermission } from '../src/rbac/roles.js';
import {
  isGlobalOnly,
  type Qualifier,
  type ResourceAttrs,
  type ResourceType,
} from '../src/rbac/resources.js';
import { canonicalScopeKey, matchScope, scopeItemKey, type ScopeItem } from '../src/rbac/scope.js';
import { strongestQualifier } from '../src/rbac/qualifier.js';
import { expectGuardFails } from '../src/testing/index.js';

const NOW = new Date('2026-10-11T12:00:00.000Z');
const at = (offsetMs: number): string => new Date(NOW.getTime() + offsetMs).toISOString();
const GUID_1 = '8e0c2b8e-0000-4000-8000-000000000001';
const GUID_2 = '8e0c2b8e-0000-4000-8000-000000000002';
const GUID_3 = '8e0c2b8e-0000-4000-8000-000000000003';

const prefix = (
  target: ResourceType,
  attr: 'displayName' | 'alias' | 'mail',
  value: string,
): ScopeItem => ({ target, match: { by: 'prefix', attr, value } });
const department = (target: ResourceType, value: string): ScopeItem => ({
  target,
  match: { by: 'department', value },
});
const byId = (target: ResourceType, id: string): ScopeItem => ({ target, match: { by: 'id', id } });

// The matrix of spec 6.9.4, written out once more as plain lists (not derived from BUILTIN_ROLES).
const ROLE_HOLDS: Readonly<Record<BuiltinRoleKey, readonly Permission[]>> = {
  owner: [...PERMISSIONS],
  admin: PERMISSIONS.filter((p) => p !== 'rbac:manage' && p !== 'settings:connection'),
  operator: [
    'users:read',
    'groups:read',
    'groups:members:write',
    'distributionlists:read',
    'distributionlists:members:write',
    'contacts:read',
    'contacts:create',
    'contacts:update',
    'contacts:delete',
  ],
  helpdesk: [
    'users:read',
    'groups:read',
    'groups:members:write',
    'distributionlists:read',
    'distributionlists:members:write',
    'contacts:read',
  ],
  reader: ['users:read', 'groups:read', 'distributionlists:read', 'contacts:read'],
};
const ROLE_KEYS = Object.keys(ROLE_HOLDS) as BuiltinRoleKey[];
const GROUP_FORBIDDEN: readonly Permission[] = ['rbac:manage', 'settings:connection'];

function roleOf(key: BuiltinRoleKey): readonly RolePermission[] {
  const role = BUILTIN_ROLES.find((r) => r.key === key);
  if (role === undefined) throw new Error(`no role ${key}`);
  return role.permissions;
}

function assignment(
  over: Partial<GrantAssignment> & { permissions: readonly RolePermission[] },
): GrantAssignment {
  return { principalType: 'user', scope: [], expiresAt: null, ...over };
}

const grantFor = (
  grants: readonly Grant[],
  p: Permission,
  q: Qualifier = 'full',
): Grant | undefined => grants.find((g) => g.permission === p && g.qualifier === q);

/** A scope item of the right target type for a permission, and a resource it matches and one it does not. */
function scopeFor(p: Permission): {
  item: ScopeItem;
  inside: ResourceAttrs;
  outside: ResourceAttrs;
} {
  const type = PERMISSION_RESOURCE[p];
  if (type === null) throw new Error(`${p} is global-only`);
  return {
    item: prefix(type === 'user' ? 'user' : type, 'displayName', 'Sales'),
    inside: { type, id: GUID_1, displayName: 'Sales Europe' },
    outside: { type, id: GUID_2, displayName: 'HR' },
  };
}

// ---------------------------------------------------------------------------------------------
describe('GROUP_FORBIDDEN_PERMISSIONS (FR-B-515)', () => {
  it('is rbac:manage and settings:connection, frozen', () => {
    expect([...GROUP_FORBIDDEN_PERMISSIONS]).toEqual(GROUP_FORBIDDEN);
    expect(Object.isFrozen(GROUP_FORBIDDEN_PERMISSIONS)).toBe(true);
  });
});

describe('the matrix 15 permissions x 5 roles x 5 situations', () => {
  const cases = ROLE_KEYS.flatMap((role) => PERMISSIONS.map((p) => [role, p] as const));

  it.each(cases)('%s / %s', (role, p) => {
    const holds = ROLE_HOLDS[role].includes(p);
    const permissions = roleOf(role);

    // 1. unscoped
    const unscoped = computeGrants([assignment({ permissions })], NOW);
    expect(grantFor(unscoped, p) !== undefined, `unscoped`).toBe(holds);
    if (holds)
      expect(grantFor(unscoped, p)).toEqual({ permission: p, qualifier: 'full', scope: 'all' });

    // 2. scoped in: a scope of the permission's own type restricts it; a global-only permission is not granted
    if (!isGlobalOnly(p)) {
      const { item, inside, outside } = scopeFor(p);
      const scoped = computeGrants([assignment({ permissions, scope: [item] })], NOW);
      const grant = grantFor(scoped, p);
      expect(grant !== undefined, 'scoped').toBe(holds);
      if (grant !== undefined) {
        expect(grant.scope).toEqual([item]);
        const items = grant.scope === 'all' ? [] : grant.scope;
        expect(
          items.some((i) => matchScope(i, inside)),
          'scoped in',
        ).toBe(true);
        // 3. scoped out
        expect(
          items.some((i) => matchScope(i, outside)),
          'scoped out',
        ).toBe(false);
      }
    } else {
      const scoped = computeGrants(
        [assignment({ permissions, scope: [prefix('group', 'displayName', 'Sales')] })],
        NOW,
      );
      expect(
        grantFor(scoped, p),
        'a scoped assignment never grants a global-only permission',
      ).toBeUndefined();
    }

    // 4. expired
    const expired = computeGrants([assignment({ permissions, expiresAt: at(-1) })], NOW);
    expect(grantFor(expired, p), 'expired').toBeUndefined();
    const live = computeGrants([assignment({ permissions, expiresAt: at(1) })], NOW);
    expect(grantFor(live, p) !== undefined, 'not yet expired').toBe(holds);

    // 5. group-derived
    const viaGroup = computeGrants([assignment({ permissions, principalType: 'group' })], NOW);
    expect(grantFor(viaGroup, p) !== undefined, 'group-derived').toBe(
      holds && !GROUP_FORBIDDEN.includes(p),
    );
  });

  it('gives the owner role via a group 13 of its 15 permissions, never rbac:manage or settings:connection', () => {
    const viaGroup = computeGrants(
      [assignment({ permissions: roleOf('owner'), principalType: 'group' })],
      NOW,
    );
    expect(viaGroup.map((g) => g.permission)).toEqual(
      PERMISSIONS.filter((p) => !GROUP_FORBIDDEN.includes(p)),
    );
  });
});

// ---------------------------------------------------------------------------------------------
describe('computeGrants: the rules of spec 6.5.2', () => {
  const helpdesk = roleOf('helpdesk');
  const reader = roleOf('reader');

  it('returns no grants for no assignments', () => {
    expect(computeGrants([], NOW)).toEqual([]);
  });

  it('keeps an assignment only while its expiry is empty or later than now (the exact instant is expired)', () => {
    const p = [{ permission: 'users:read', qualifier: 'full' } as const];
    const grants = (expiresAt: string | null): number =>
      computeGrants([assignment({ permissions: p, expiresAt })], NOW).length;
    expect(grants(null)).toBe(1);
    expect(grants(at(1))).toBe(1);
    expect(grants(at(0))).toBe(0);
    expect(grants(at(-1))).toBe(0);
    expect(grants(at(-86_400_000))).toBe(0);
  });

  it('treats an expiry it cannot read as expired (fail closed)', () => {
    const p = [{ permission: 'users:read', qualifier: 'full' } as const];
    for (const expiresAt of ['', 'tomorrow', 'NaN', '2026-13-45T99:99:99.000Z', ' ']) {
      expect(computeGrants([assignment({ permissions: p, expiresAt })], NOW), expiresAt).toEqual(
        [],
      );
    }
  });

  it('restricts only the resource types a scope names (a helpdesk scoped to a group still reads all users)', () => {
    const scope = [prefix('group', 'displayName', 'Sales')];
    const grants = computeGrants([assignment({ permissions: helpdesk, scope })], NOW);
    expect(grantFor(grants, 'users:read')?.scope).toBe('all');
    expect(grantFor(grants, 'contacts:read')?.scope).toBe('all');
    expect(grantFor(grants, 'distributionlists:read')?.scope).toBe('all');
    expect(grantFor(grants, 'groups:read')?.scope).toEqual(scope);
    expect(grantFor(grants, 'groups:members:write')?.scope).toEqual(scope);
  });

  it('applies a scope of two types to each type separately', () => {
    const scope = [prefix('group', 'displayName', 'Sales'), department('contact', 'Finance')];
    const grants = computeGrants([assignment({ permissions: roleOf('operator'), scope })], NOW);
    expect(grantFor(grants, 'groups:read')?.scope).toEqual([scope[0]]);
    expect(grantFor(grants, 'contacts:update')?.scope).toEqual([scope[1]]);
    expect(grantFor(grants, 'users:read')?.scope).toBe('all');
    expect(grantFor(grants, 'distributionlists:read')?.scope).toBe('all');
  });

  it('merges the grants of several assignments per (permission, qualifier): ALL absorbs, items are united', () => {
    const a = assignment({ permissions: reader, scope: [prefix('group', 'displayName', 'Sales')] });
    const b = assignment({ permissions: reader, scope: [prefix('group', 'displayName', 'HR')] });
    const merged = computeGrants([a, b], NOW);
    expect(grantFor(merged, 'groups:read')?.scope).toEqual([
      prefix('group', 'displayName', 'HR'),
      prefix('group', 'displayName', 'Sales'),
    ]);
    const unscoped = assignment({ permissions: reader });
    expect(grantFor(computeGrants([a, unscoped, b], NOW), 'groups:read')?.scope).toBe('all');
    expect(grantFor(computeGrants([unscoped, a], NOW), 'groups:read')?.scope).toBe('all');
  });

  it('de-duplicates items, whatever the spelling, and sorts them canonically', () => {
    const a = assignment({ permissions: reader, scope: [prefix('group', 'displayName', 'Sales')] });
    const b = assignment({ permissions: reader, scope: [prefix('group', 'displayName', 'SALES')] });
    const c = assignment({
      permissions: reader,
      scope: [byId('group', GUID_2), byId('group', GUID_1)],
    });
    const grants = computeGrants([c, b, a], NOW);
    const scope = grantFor(grants, 'groups:read')?.scope;
    expect(scope).toHaveLength(3);
    expect(scope === 'all' ? [] : scope?.map(scopeItemKey)).toEqual(
      [...(scope === 'all' ? [] : (scope ?? []))].map(scopeItemKey).sort(),
    );
    expect(canonicalScopeKey(scope === 'all' ? [] : (scope ?? []))).toBe(
      canonicalScopeKey([...(scope === 'all' ? [] : (scope ?? []))].reverse()),
    );
  });

  it('keeps the same spelling of an item whatever the order of the assignments', () => {
    const a = assignment({ permissions: reader, scope: [prefix('group', 'displayName', 'Sales')] });
    const b = assignment({ permissions: reader, scope: [prefix('group', 'displayName', 'SALES')] });
    expect(computeGrants([a, b], NOW)).toEqual(computeGrants([b, a], NOW));
  });

  it('keeps basic and full apart (SB-13): a scoped full grant must not hand full to the rest', () => {
    const fullInDepartment = assignment({
      permissions: [{ permission: 'users:read', qualifier: 'full' }],
      scope: [department('user', 'Sales')],
    });
    const basicEverywhere = assignment({
      permissions: [{ permission: 'users:read', qualifier: 'basic' }],
    });
    const grants = computeGrants([basicEverywhere, fullInDepartment], NOW);
    expect(grants).toEqual([
      { permission: 'users:read', qualifier: 'full', scope: [department('user', 'Sales')] },
      { permission: 'users:read', qualifier: 'basic', scope: 'all' },
    ]);
  });

  it('keeps a basic grant when a full grant of the same permission exists elsewhere', () => {
    const grants = computeGrants(
      [
        assignment({ permissions: [{ permission: 'users:read', qualifier: 'full' }] }),
        assignment({ permissions: [{ permission: 'users:read', qualifier: 'basic' }] }),
      ],
      NOW,
    );
    expect(grants.map((g) => g.qualifier)).toEqual(['full', 'basic']);
  });

  it('never grants a global-only permission from a scoped assignment, whatever the scope names', () => {
    for (const scope of [
      [prefix('group', 'displayName', 'x')],
      [department('user', 'x')],
      [byId('contact', GUID_3), prefix('user', 'mail', 'a')],
    ]) {
      const grants = computeGrants([assignment({ permissions: roleOf('owner'), scope })], NOW);
      expect(grants.filter((g) => isGlobalOnly(g.permission))).toEqual([]);
    }
  });

  it('gives a global-only permission only as ALL, from an unscoped assignment', () => {
    const scoped = assignment({ permissions: roleOf('owner'), scope: [department('user', 'x')] });
    const unscoped = assignment({ permissions: roleOf('admin') });
    const grants = computeGrants([scoped, unscoped], NOW);
    for (const g of grants.filter((x) => isGlobalOnly(x.permission))) expect(g.scope).toBe('all');
    expect(grantFor(grants, 'audit:read')?.scope).toBe('all');
    expect(grantFor(grants, 'rbac:manage')).toBeUndefined();
  });

  it('lets a user-assigned owner keep rbac:manage next to a group-derived admin (the group only adds)', () => {
    const grants = computeGrants(
      [
        assignment({ permissions: roleOf('owner') }),
        assignment({ permissions: roleOf('admin'), principalType: 'group' }),
      ],
      NOW,
    );
    expect(grantFor(grants, 'rbac:manage')?.scope).toBe('all');
  });

  it('ignores a group-derived owner row written around the API (FR-B-515): neither forbidden permission is granted', () => {
    const grants = computeGrants(
      [assignment({ permissions: roleOf('owner'), principalType: 'group' })],
      NOW,
    );
    expect(grantFor(grants, 'rbac:manage')).toBeUndefined();
    expect(grantFor(grants, 'settings:connection')).toBeUndefined();
    expect(grants).toHaveLength(13);
  });

  it('ignores a custom role that holds a forbidden permission when it comes through a group', () => {
    const custom: RolePermission[] = [
      { permission: 'rbac:manage', qualifier: 'full' },
      { permission: 'settings:connection', qualifier: 'full' },
      { permission: 'audit:read', qualifier: 'full' },
    ];
    const grants = computeGrants(
      [assignment({ permissions: custom, principalType: 'group' })],
      NOW,
    );
    expect(grants.map((g) => g.permission)).toEqual(['audit:read']);
  });

  it('skips what cannot be a grant: an unknown permission, an unknown qualifier, basic outside users:read', () => {
    const odd = [
      { permission: 'users:write', qualifier: 'full' },
      { permission: 'groups:read', qualifier: 'basic' },
      { permission: 'contacts:read', qualifier: 'FULL' },
      { permission: 'constructor', qualifier: 'full' },
      { permission: 'users:read', qualifier: 'full' },
    ] as unknown as RolePermission[];
    expect(computeGrants([assignment({ permissions: odd })], NOW)).toEqual([
      { permission: 'users:read', qualifier: 'full', scope: 'all' },
    ]);
  });

  it('skips an assignment with a principal type it does not know', () => {
    const odd = assignment({ permissions: reader, principalType: 'service' as 'user' });
    expect(computeGrants([odd], NOW)).toEqual([]);
  });

  it('lists the grants in catalogue order, full before basic, and is independent of the input order', () => {
    const list = [
      assignment({ permissions: roleOf('helpdesk') }),
      assignment({ permissions: [{ permission: 'users:read', qualifier: 'basic' }] }),
      assignment({ permissions: roleOf('admin'), scope: [prefix('contact', 'mail', 'a')] }),
    ];
    const forward = computeGrants(list, NOW);
    expect(computeGrants([...list].reverse(), NOW)).toEqual(forward);
    const order = forward.map(
      (g) => PERMISSIONS.indexOf(g.permission) * 2 + (g.qualifier === 'full' ? 0 : 1),
    );
    expect(order).toEqual([...order].sort((x, y) => x - y));
  });

  it('does not change its arguments and returns frozen grants', () => {
    const list = [assignment({ permissions: reader, scope: [department('user', 'x')] })];
    const before = JSON.stringify(list);
    const grants = computeGrants(list, NOW);
    expect(JSON.stringify(list)).toBe(before);
    expect(Object.isFrozen(grants)).toBe(true);
    for (const g of grants) expect(Object.isFrozen(g)).toBe(true);
  });

  it('is deterministic', () => {
    const list = [
      assignment({ permissions: roleOf('operator'), scope: [prefix('group', 'mail', 'a')] }),
    ];
    expect(computeGrants(list, NOW)).toEqual(computeGrants(list, NOW));
  });
});

describe('isAssignmentActive and earliestExpiry (the memo of FR-B-511 uses the same rule)', () => {
  it('agrees with computeGrants about the instant of expiry', () => {
    expect(isAssignmentActive(null, NOW)).toBe(true);
    expect(isAssignmentActive(at(1), NOW)).toBe(true);
    expect(isAssignmentActive(at(0), NOW)).toBe(false);
    expect(isAssignmentActive(at(-1), NOW)).toBe(false);
    expect(isAssignmentActive('garbage', NOW)).toBe(false);
  });

  it('returns the earliest expiry among the active assignments, or null', () => {
    const p = [{ permission: 'users:read', qualifier: 'full' } as const];
    const list = [
      assignment({ permissions: p, expiresAt: at(5000) }),
      assignment({ permissions: p, expiresAt: at(2000) }),
      assignment({ permissions: p, expiresAt: at(-10) }),
      assignment({ permissions: p }),
    ];
    expect(earliestExpiry(list, NOW)).toBe(at(2000));
    expect(earliestExpiry([assignment({ permissions: p })], NOW)).toBeNull();
    expect(earliestExpiry([], NOW)).toBeNull();
    expect(earliestExpiry([assignment({ permissions: p, expiresAt: at(-10) })], NOW)).toBeNull();
  });
});

describe('types', () => {
  it('Grant and GrantAssignment have the shapes the server and the web rely on', () => {
    expectTypeOf<Grant['scope']>().toEqualTypeOf<'all' | readonly ScopeItem[]>();
    expectTypeOf<Grant['qualifier']>().toEqualTypeOf<Qualifier>();
    expectTypeOf<GrantAssignment['principalType']>().toEqualTypeOf<'user' | 'group'>();
    expectTypeOf(computeGrants).returns.toEqualTypeOf<readonly Grant[]>();
  });
});

// ---------------------------------------------------------------------------------------------
// The property test (seeded; the seed is printed with every failure).
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = Number(process.env.RBAC_PROPERTY_SEED ?? 20261011);
const CASES = Math.max(20_000, Number(process.env.RBAC_PROPERTY_CASES ?? 20_000));

type Compute = (assignments: readonly GrantAssignment[], now: Date) => readonly Grant[];

const TYPES: readonly ResourceType[] = ['user', 'group', 'distributionList', 'contact'];
const IDS = [GUID_1, GUID_2, GUID_3];
const PREFIXES = [
  'a',
  'ab',
  'abc',
  'B',
  '\u{3a3}',
  '\u{39f}\u{394}\u{39f}\u{3a3}',
  '\u{3bf}\u{3b4}\u{3bf}\u{3c2}',
];
const DEPARTMENTS = ['x', 'X', 'y'];

/** The independent second formulation of spec 6.5.2: per resource instead of per grant. */
function allowedBySpec(
  assignments: readonly GrantAssignment[],
  now: Date,
  p: Permission,
  resource: ResourceAttrs | undefined,
): Qualifier | null {
  const found: Qualifier[] = [];
  for (const a of assignments) {
    const expires = a.expiresAt === null ? Infinity : Date.parse(a.expiresAt);
    if (!(expires > now.getTime())) continue;
    if (a.principalType === 'group' && GROUP_FORBIDDEN.includes(p)) continue;
    for (const rp of a.permissions) {
      if (rp.permission !== p) continue;
      if (PERMISSION_RESOURCE[p] === null) {
        if (resource === undefined && a.scope.length === 0) found.push(rp.qualifier);
      } else if (resource !== undefined) {
        const own = a.scope.filter((item) => item.target === PERMISSION_RESOURCE[p]);
        if (own.length === 0 || own.some((item) => matchScope(item, resource)))
          found.push(rp.qualifier);
      }
    }
  }
  return strongestQualifier(found);
}

/** What the computed grants allow for the same question. */
function allowedByGrants(
  grants: readonly Grant[],
  p: Permission,
  resource: ResourceAttrs | undefined,
): Qualifier | null {
  const found: Qualifier[] = [];
  for (const g of grants) {
    if (g.permission !== p) continue;
    if (resource === undefined) {
      if (g.scope === 'all') found.push(g.qualifier);
    } else if (g.scope === 'all' || g.scope.some((item) => matchScope(item, resource))) {
      found.push(g.qualifier);
    }
  }
  return strongestQualifier(found);
}

interface Stats {
  grants: number;
  scopedGrants: number;
  groupDerived: number;
  expired: number;
  basicAndFull: number;
}

function propertyRun(
  compute: Compute,
  cases: number,
  seed: number,
): { failures: string[]; stats: Stats } {
  const stats: Stats = { grants: 0, scopedGrants: 0, groupDerived: 0, expired: 0, basicAndFull: 0 };
  const random = mulberry32(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
  const failures: string[] = [];

  const randomItem = (): ScopeItem => {
    const target = pick(TYPES);
    const kinds: ScopeItem[] = [
      prefix(
        target,
        pick(
          target === 'user'
            ? (['displayName', 'mail'] as const)
            : (['displayName', 'alias', 'mail'] as const),
        ),
        pick(PREFIXES),
      ),
    ];
    if (target !== 'user') kinds.push(byId(target, pick(IDS)));
    if (target === 'user' || target === 'contact')
      kinds.push(department(target, pick(DEPARTMENTS)));
    return pick(kinds);
  };
  const randomRole = (): RolePermission[] => {
    if (random() < 0.4) return [...roleOf(pick(ROLE_KEYS))];
    const chosen = PERMISSIONS.filter(() => random() < 0.3);
    const list: RolePermission[] = chosen.map((permission) => ({ permission, qualifier: 'full' }));
    if (random() < 0.4) {
      const at = list.findIndex((rp) => rp.permission === 'users:read');
      if (at >= 0) list[at] = { permission: 'users:read', qualifier: 'basic' };
      else list.push({ permission: 'users:read', qualifier: 'basic' });
    }
    return list;
  };
  const randomAssignment = (): GrantAssignment => {
    const scope = Array.from(
      { length: random() < 0.5 ? 0 : 1 + Math.floor(random() * 3) },
      randomItem,
    );
    return {
      principalType: random() < 0.4 ? 'group' : 'user',
      permissions: randomRole(),
      scope,
      expiresAt: pick([null, null, at(-1), at(0), at(1), at(86_400_000)]),
    };
  };
  /** A resource that one of the items matches, or a random one. */
  const probeFor = (
    p: Permission,
    assignments: readonly GrantAssignment[],
  ): ResourceAttrs | undefined => {
    const type = PERMISSION_RESOURCE[p];
    if (type === null) return undefined;
    const items = assignments.flatMap((a) => a.scope).filter((i) => i.target === type);
    const base: { -readonly [K in keyof ResourceAttrs]: ResourceAttrs[K] } = { type };
    const item = items.length > 0 && random() < 0.8 ? pick(items) : undefined;
    if (item?.match.by === 'id')
      base.id = random() < 0.5 ? item.match.id : item.match.id.toUpperCase();
    else if (item?.match.by === 'prefix') {
      const extra = pick(['', 'z', ' Europe', '\u{3a3}\u{3a3}']);
      const text = random() < 0.5 ? item.match.value : item.match.value.toUpperCase();
      base[item.match.attr] = `${text}${extra}`;
    } else if (item?.match.by === 'department')
      base.department = random() < 0.5 ? item.match.value : item.match.value.toUpperCase();
    else {
      base.id = pick(IDS);
      base.displayName = pick(PREFIXES);
      base.department = pick(DEPARTMENTS);
    }
    return base;
  };

  for (let n = 0; n < cases && failures.length < 5; n += 1) {
    const assignments = Array.from({ length: 1 + Math.floor(random() * 4) }, randomAssignment);
    const grants = compute(assignments, NOW);
    stats.grants += grants.length;
    stats.scopedGrants += grants.filter((g) => g.scope !== 'all').length;
    stats.groupDerived += assignments.filter((a) => a.principalType === 'group').length;
    stats.expired += assignments.filter((a) => !isAssignmentActive(a.expiresAt, NOW)).length;
    if (
      grants.some((g) => g.qualifier === 'basic') &&
      grants.some((g) => g.permission === 'users:read' && g.qualifier === 'full')
    )
      stats.basicAndFull += 1;

    // structure: ordered, no (permission, qualifier) twice, global-only only as ALL
    const seen = new Set<string>();
    for (const g of grants) {
      const key = `${g.permission}/${g.qualifier}`;
      if (seen.has(key)) failures.push(`#${String(n)} ${key} appears twice`);
      seen.add(key);
      if (isGlobalOnly(g.permission) && g.scope !== 'all')
        failures.push(`#${String(n)} ${g.permission} is not ALL`);
      if (g.scope !== 'all' && g.scope.length === 0)
        failures.push(`#${String(n)} ${key} has an empty scope`);
    }

    // semantics: for every permission and a few probes, the grants allow what the spec allows
    for (const p of PERMISSIONS) {
      const probes = isGlobalOnly(p)
        ? [undefined]
        : [probeFor(p, assignments), probeFor(p, assignments)];
      for (const resource of probes) {
        const spec = allowedBySpec(assignments, NOW, p, resource);
        const got = allowedByGrants(grants, p, resource);
        if (spec !== got)
          failures.push(
            `#${String(n)} ${p} on ${JSON.stringify(resource)}: spec ${String(spec)}, grants ${String(got)}; assignments ${JSON.stringify(assignments)}`,
          );
      }
    }
  }
  return { failures, stats };
}

const propertyFailures = (compute: Compute, cases: number, seed: number): string[] =>
  propertyRun(compute, cases, seed).failures;

describe('property: computeGrants equals the spec, resource by resource', () => {
  it(`${String(CASES)} seeded cases (seed ${String(SEED)})`, () => {
    const started = performance.now();
    const failures = propertyFailures(computeGrants, CASES, SEED);
    expect(failures, `seed ${String(SEED)}`).toEqual([]);
    // Measured, not gated (the 20 s budget of GB5 is for both property tests together).
    process.stdout.write(
      `rbac-effective property: ${String(CASES)} cases in ${String(Math.round(performance.now() - started))} ms, seed ${String(SEED)}\n`,
    );
  });

  describe('deliberately broken copies fail it (negative fixtures)', () => {
    const noExpiry: Compute = (assignments, now) =>
      computeGrants(
        assignments.map((a) => ({ ...a, expiresAt: null })),
        now,
      );
    const noGroupRule: Compute = (assignments, now) =>
      computeGrants(
        assignments.map((a) => ({ ...a, principalType: 'user' as const })),
        now,
      );
    const scopedGlobalOnly: Compute = (assignments, now) => {
      const real = computeGrants(assignments, now);
      const extra = computeGrants(
        assignments.map((a) => ({ ...a, scope: [] })),
        now,
      ).filter((g) => isGlobalOnly(g.permission));
      const have = new Set(real.map((g) => `${g.permission}/${g.qualifier}`));
      return [...real, ...extra.filter((g) => !have.has(`${g.permission}/${g.qualifier}`))];
    };
    const fullAbsorbsBasic: Compute = (assignments, now) => {
      const real = computeGrants(assignments, now);
      return real.filter(
        (g) =>
          !(
            g.qualifier === 'basic' &&
            real.some((o) => o.permission === g.permission && o.qualifier === 'full')
          ),
      );
    };
    const scopeIgnored: Compute = (assignments, now) =>
      computeGrants(
        assignments.map((a) => ({ ...a, scope: [] })),
        now,
      );

    it.each([
      ['ignores expiry', noExpiry],
      ['ignores the group rule of FR-B-515', noGroupRule],
      ['lets a scoped assignment grant a global-only permission', scopedGlobalOnly],
      ['lets full absorb basic', fullAbsorbsBasic],
      ['ignores scopes', scopeIgnored],
    ])('a copy that %s', (_label, broken) => {
      const failures = propertyFailures(broken, 3_000, SEED);
      expect(failures.length).toBeGreaterThan(0);
      expectGuardFails(
        () => {
          const found = propertyFailures(broken, 3_000, SEED);
          if (found.length > 0)
            throw new Error(`computeGrants differs from the spec: ${found[0] ?? ''}`);
        },
        undefined,
        { reason: 'computeGrants differs from the spec' },
      );
    });
  });

  it('is not vacuous: the generator reaches grants, scopes, group rows, expired rows and both qualifiers', () => {
    const { stats } = propertyRun(computeGrants, 2_000, SEED);
    expect(stats.grants).toBeGreaterThan(2_000);
    expect(stats.scopedGrants).toBeGreaterThan(200);
    expect(stats.groupDerived).toBeGreaterThan(500);
    expect(stats.expired).toBeGreaterThan(500);
    expect(stats.basicAndFull).toBeGreaterThan(5);
  });
});

describe('performance (measured, not gated)', () => {
  it('computes 100 assignments, 20 of them through groups', () => {
    const roles = ROLE_KEYS.map(roleOf);
    const list: GrantAssignment[] = Array.from({ length: 100 }, (_, i) => ({
      principalType: i < 20 ? 'group' : 'user',
      permissions: roles[i % roles.length] ?? [],
      scope: i % 3 === 0 ? [prefix('group', 'displayName', `team-${String(i)}`)] : [],
      expiresAt: i % 7 === 0 ? at(86_400_000) : null,
    }));
    computeGrants(list, NOW);
    const runs = 200;
    const started = performance.now();
    for (let i = 0; i < runs; i += 1) computeGrants(list, NOW);
    const perCall = (performance.now() - started) / runs;
    process.stdout.write(
      `computeGrants(100 assignments, 20 via groups): ${perCall.toFixed(3)} ms per call (budget 2 ms)\n`,
    );
    expect(perCall).toBeGreaterThan(0);
  });
});

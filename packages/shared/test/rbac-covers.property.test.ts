// T-B-234, FR-B-509 (pure half), SC-B-006: `covers`, `scopesCover` and `canGrantCore`, and the
// anti-escalation property: if `canGrantCore` holds, every resource the target's grants allow for a
// permission is a resource the actor is allowed on for that permission, with at least that qualifier.
//
// The property is seeded (RBAC_PROPERTY_SEED), prints the seed with every failure and runs at least
// 20,000 cases (RBAC_PROPERTY_CASES may only raise the count). The generator includes Greek final-sigma
// and case-fold strings and decomposed accents, because those are where a prefix test goes wrong.
// A deliberately broken `covers` (any two prefix items cover) must fail the property.
import { describe, expect, it } from 'vitest';
import { PERMISSIONS, PERMISSION_RESOURCE, type Permission } from '../src/permissions.js';
import { canGrantCore, covers, scopesCover } from '../src/rbac/covers.js';
import { computeGrants, type Grant, type GrantScope } from '../src/rbac/effective.js';
import { qualifierAtLeast, strongestQualifier } from '../src/rbac/qualifier.js';
import { type Qualifier, type ResourceAttrs, type ResourceType } from '../src/rbac/resources.js';
import { BUILTIN_ROLES, type RolePermission } from '../src/rbac/roles.js';
import { fold, matchScope, type ScopeItem } from '../src/rbac/scope.js';
import { expectGuardFails } from '../src/testing/index.js';

const NOW = new Date('2026-10-11T12:00:00.000Z');
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
const grant = (permission: Permission, qualifier: Qualifier, scope: GrantScope): Grant => ({
  permission,
  qualifier,
  scope,
});
const role = (...entries: [Permission, Qualifier?][]): RolePermission[] =>
  entries.map(([permission, qualifier]) => ({ permission, qualifier: qualifier ?? 'full' }));

// ---------------------------------------------------------------------------------------------
describe('covers(a, b): does the actor item a cover the target item b?', () => {
  it('holds for equal items', () => {
    for (const item of [
      byId('group', GUID_1),
      prefix('group', 'displayName', 'Sales'),
      department('contact', 'Finance'),
    ])
      expect(covers(item, { ...item })).toBe(true);
  });

  it('holds for equal items in another spelling of the text (case, Unicode form, GUID case)', () => {
    expect(covers(byId('group', GUID_1), byId('group', GUID_1.toUpperCase()))).toBe(true);
    expect(covers(department('user', 'Sales'), department('user', 'SALES'))).toBe(true);
    expect(covers(department('user', 'Ren\u{e9}'), department('user', 'Rene\u{301}'))).toBe(true);
  });

  it('holds for two prefix items on the same target and attribute when the target value starts with the actor value', () => {
    expect(
      covers(prefix('group', 'displayName', 'Sa'), prefix('group', 'displayName', 'Sales')),
    ).toBe(true);
    expect(
      covers(prefix('group', 'displayName', 'sa'), prefix('group', 'displayName', 'SALES')),
    ).toBe(true);
    expect(
      covers(prefix('group', 'displayName', 'Sales'), prefix('group', 'displayName', 'Sales')),
    ).toBe(true);
    // the Greek final sigma: the actor typed the word, the target continues it
    expect(
      covers(
        prefix('group', 'displayName', '\u{39f}\u{394}\u{39f}\u{3a3}'),
        prefix('group', 'displayName', '\u{3bf}\u{3b4}\u{3bf}\u{3c3}\u{3bf}\u{3c2}'),
      ),
    ).toBe(true);
    expect(
      covers(
        prefix('group', 'displayName', '\u{3bf}\u{3b4}\u{3bf}\u{3c2}'),
        prefix('group', 'displayName', '\u{39f}\u{394}\u{39f}\u{3a3}\u{39f}\u{3a3}'),
      ),
    ).toBe(true);
  });

  it('does not hold when the target value is shorter, different, or on another attribute or target', () => {
    expect(
      covers(prefix('group', 'displayName', 'Sales'), prefix('group', 'displayName', 'Sa')),
    ).toBe(false);
    expect(
      covers(prefix('group', 'displayName', 'Sales'), prefix('group', 'displayName', 'HR')),
    ).toBe(false);
    expect(covers(prefix('group', 'displayName', 'Sa'), prefix('group', 'mail', 'Sales'))).toBe(
      false,
    );
    expect(
      covers(prefix('group', 'displayName', 'Sa'), prefix('contact', 'displayName', 'Sales')),
    ).toBe(false);
    expect(
      covers(
        prefix('group', 'displayName', 'Sa'),
        prefix('distributionList', 'displayName', 'Sales'),
      ),
    ).toBe(false);
  });

  it('holds for equal department items only, never for a prefix of a department', () => {
    expect(covers(department('user', 'Sales'), department('user', 'sales'))).toBe(true);
    expect(covers(department('user', 'Sales'), department('user', 'Sales EU'))).toBe(false);
    expect(covers(department('user', 'Sales EU'), department('user', 'Sales'))).toBe(false);
    expect(covers(department('user', 'Sales'), department('contact', 'Sales'))).toBe(false);
  });

  it('covers an id item only by an equal id item: an actor with filter scopes never covers an id item', () => {
    expect(covers(byId('group', GUID_1), byId('group', GUID_1))).toBe(true);
    expect(covers(byId('group', GUID_1), byId('group', GUID_2))).toBe(false);
    expect(covers(prefix('group', 'displayName', 'a'), byId('group', GUID_1))).toBe(false);
    expect(covers(prefix('group', 'mail', 'a'), byId('group', GUID_1))).toBe(false);
    expect(covers(department('contact', 'x'), byId('contact', GUID_1))).toBe(false);
    expect(covers(byId('group', GUID_1), prefix('group', 'displayName', 'a'))).toBe(false);
    expect(covers(byId('group', GUID_1), byId('contact', GUID_1))).toBe(false);
  });

  it('never lets an empty value cover anything (fail closed)', () => {
    expect(
      covers(prefix('group', 'displayName', ''), prefix('group', 'displayName', 'Sales')),
    ).toBe(false);
    expect(covers(department('user', ''), department('user', 'Sales'))).toBe(false);
  });

  it('never throws on a malformed item', () => {
    for (const bad of [null, {}, { target: 'group' }, { target: 'group', match: {} }])
      expect(covers(bad as unknown as ScopeItem, prefix('group', 'displayName', 'a'))).toBe(false);
  });
});

describe('scopesCover(actor, target)', () => {
  const sales = prefix('group', 'displayName', 'Sales');
  const hr = prefix('group', 'displayName', 'HR');

  it('is true when the actor holds ALL, whatever the target', () => {
    expect(scopesCover('all', 'all')).toBe(true);
    expect(scopesCover('all', [sales])).toBe(true);
    expect(scopesCover('all', [])).toBe(true);
  });

  it('needs actor ALL for a target ALL', () => {
    expect(scopesCover([sales], 'all')).toBe(false);
    expect(scopesCover([], 'all')).toBe(false);
  });

  it('needs every target item to be covered by some actor item', () => {
    expect(scopesCover([sales, hr], [sales])).toBe(true);
    expect(scopesCover([sales, hr], [sales, hr])).toBe(true);
    expect(scopesCover([sales], [sales, hr])).toBe(false);
    expect(
      scopesCover(
        [prefix('group', 'displayName', 'S')],
        [sales, prefix('group', 'displayName', 'Support')],
      ),
    ).toBe(true);
    expect(scopesCover([], [sales])).toBe(false);
  });
});

describe('canGrantCore(actorGrants, role, targetScope)', () => {
  const all = (p: Permission, q: Qualifier = 'full'): Grant => grant(p, q, 'all');

  it('holds when the actor holds every permission of the role with ALL', () => {
    const actor =
      BUILTIN_ROLES.find((r) => r.key === 'owner')?.permissions.map((rp) => all(rp.permission)) ??
      [];
    for (const r of BUILTIN_ROLES) expect(canGrantCore(actor, r.permissions, []), r.key).toBe(true);
  });

  it('fails when the actor lacks one permission of the role', () => {
    const actor = PERMISSIONS.filter((p) => p !== 'contacts:delete').map((p) => all(p));
    const operator = BUILTIN_ROLES.find((r) => r.key === 'operator')?.permissions ?? [];
    expect(canGrantCore(actor, operator, [])).toBe(false);
    const helpdesk = BUILTIN_ROLES.find((r) => r.key === 'helpdesk')?.permissions ?? [];
    expect(canGrantCore(actor, helpdesk, [])).toBe(true);
  });

  it('needs a global-only permission to be granted unscoped, by an actor holding it with ALL', () => {
    const actor = [all('audit:read'), all('groups:read')];
    expect(canGrantCore(actor, role(['audit:read']), [])).toBe(true);
    expect(canGrantCore(actor, role(['audit:read']), [prefix('group', 'displayName', 'x')])).toBe(
      false,
    );
    expect(
      canGrantCore(actor, role(['audit:read'], ['groups:read']), [
        prefix('group', 'displayName', 'x'),
      ]),
    ).toBe(false);
    expect(
      canGrantCore(
        [grant('audit:read', 'full', [prefix('group', 'displayName', 'x')])],
        role(['audit:read']),
        [],
      ),
    ).toBe(false);
    expect(canGrantCore([], role(['rbac:manage']), [])).toBe(false);
  });

  it('lets full cover basic and not the reverse', () => {
    expect(canGrantCore([all('users:read', 'full')], role(['users:read', 'basic']), [])).toBe(true);
    expect(canGrantCore([all('users:read', 'full')], role(['users:read', 'full']), [])).toBe(true);
    expect(canGrantCore([all('users:read', 'basic')], role(['users:read', 'basic']), [])).toBe(
      true,
    );
    expect(canGrantCore([all('users:read', 'basic')], role(['users:read', 'full']), [])).toBe(
      false,
    );
  });

  it('unites the actor grants whose qualifier is at least the one asked', () => {
    const s = department('user', 'Sales');
    const h = department('user', 'HR');
    const actor = [grant('users:read', 'full', [s]), grant('users:read', 'basic', [h])];
    expect(canGrantCore(actor, role(['users:read', 'basic']), [s, h])).toBe(true);
    expect(canGrantCore(actor, role(['users:read', 'full']), [s, h])).toBe(false);
    expect(canGrantCore(actor, role(['users:read', 'full']), [s])).toBe(true);
  });

  it('compares scopes per resource type: only the items of the permission’s own type count', () => {
    const actor = [
      grant('groups:read', 'full', [prefix('group', 'displayName', 'S')]),
      all('contacts:read'),
    ];
    // an item for another type does not narrow the group permission, so the target is ALL for groups
    expect(canGrantCore(actor, role(['groups:read']), [department('contact', 'x')])).toBe(false);
    expect(canGrantCore(actor, role(['contacts:read']), [department('contact', 'x')])).toBe(true);
    expect(
      canGrantCore(actor, role(['groups:read']), [prefix('group', 'displayName', 'Sales')]),
    ).toBe(true);
    expect(canGrantCore(actor, role(['groups:read']), [])).toBe(false);
  });

  it('never lets an actor with filter scopes grant an id scope', () => {
    const actor = [grant('groups:read', 'full', [prefix('group', 'displayName', 'S')])];
    expect(canGrantCore(actor, role(['groups:read']), [byId('group', GUID_1)])).toBe(false);
    expect(canGrantCore([all('groups:read')], role(['groups:read']), [byId('group', GUID_1)])).toBe(
      true,
    );
    expect(
      canGrantCore([grant('groups:read', 'full', [byId('group', GUID_1)])], role(['groups:read']), [
        byId('group', GUID_1),
      ]),
    ).toBe(true);
  });

  it('holds for a role without permissions and fails for a role it cannot read (fail closed)', () => {
    expect(canGrantCore([], [], [])).toBe(true);
    expect(canGrantCore([all('users:read')], role(['users:write' as Permission]), [])).toBe(false);
    expect(
      canGrantCore(
        [all('users:read')],
        [{ permission: 'users:read', qualifier: 'FULL' as Qualifier }],
        [],
      ),
    ).toBe(false);
  });

  it('does not change its arguments', () => {
    const actor = [grant('groups:read', 'full', [prefix('group', 'displayName', 'S')])];
    const scope = [prefix('group', 'displayName', 'Sales')];
    const before = JSON.stringify([actor, scope]);
    canGrantCore(actor, role(['groups:read']), scope);
    expect(JSON.stringify([actor, scope])).toBe(before);
  });
});

// ---------------------------------------------------------------------------------------------
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

const TYPES: readonly ResourceType[] = ['user', 'group', 'distributionList', 'contact'];
const IDS = [GUID_1, GUID_2, GUID_3];
const LETTERS = [
  'a',
  'b',
  'A',
  'B',
  '\u{3a3}',
  '\u{3c3}',
  '\u{3c2}',
  '\u{39f}',
  '\u{3bf}',
  '\u{e9}',
  'e\u{301}',
  '\u{c9}',
  'E\u{301}',
  'ss',
  '\u{df}',
  ' ',
];
const DEPARTMENTS = ['x', 'X', 'xy', '\u{3a3}', '\u{3c2}'];

type CanGrant = (
  actor: readonly Grant[],
  roleEntries: readonly RolePermission[],
  targetScope: readonly ScopeItem[],
) => boolean;

/**
 * A second, independent statement of the algorithm of plan 11.2 with `covers` injected, so the same
 * property can be run against a deliberately broken `covers`. Also checked against `canGrantCore`.
 */
function referenceCanGrant(coversFn: (a: ScopeItem, b: ScopeItem) => boolean): CanGrant {
  return (actor, roleEntries, targetScope) => {
    for (const { permission, qualifier } of roleEntries) {
      const usable = actor.filter(
        (g) => g.permission === permission && (g.qualifier === 'full' || qualifier === 'basic'),
      );
      const type = PERMISSION_RESOURCE[permission];
      if (type === null) {
        if (targetScope.length > 0 || !usable.some((g) => g.scope === 'all')) return false;
        continue;
      }
      const targetItems = targetScope.filter((i) => i.target === type);
      if (usable.some((g) => g.scope === 'all')) continue;
      const actorItems = usable.flatMap((g) => (g.scope === 'all' ? [] : g.scope));
      if (targetItems.length === 0) return false;
      if (!targetItems.every((t) => actorItems.some((a) => coversFn(a, t)))) return false;
    }
    return true;
  };
}

/** The deliberately broken covers of the spec: any two prefix items cover each other. */
const brokenCovers = (a: ScopeItem, b: ScopeItem): boolean =>
  (a.match.by === 'prefix' && b.match.by === 'prefix' && a.target === b.target) || covers(a, b);

/** What grants allow on a resource, by matchScope alone (does not use covers). */
function allowedQualifier(
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
  cases: number;
  granted: number;
  refused: number;
  probes: number;
  differences: number;
}

function runProperty(
  canGrant: CanGrant,
  cases: number,
  seed: number,
): { failures: string[]; stats: Stats } {
  const random = mulberry32(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
  const stats: Stats = { cases: 0, granted: 0, refused: 0, probes: 0, differences: 0 };
  const failures: string[] = [];
  const reference = referenceCanGrant(covers);

  const text = (): string => {
    const length = 1 + Math.floor(random() * 3);
    let out = '';
    for (let i = 0; i < length; i += 1) out += pick(LETTERS);
    return out;
  };
  const attrsFor = (t: ResourceType): readonly ('displayName' | 'alias' | 'mail')[] =>
    t === 'user' ? ['displayName', 'mail'] : ['displayName', 'alias', 'mail'];
  const randomItem = (target: ResourceType): ScopeItem => {
    const kinds: ScopeItem[] = [prefix(target, pick(attrsFor(target)), text())];
    if (target !== 'user') kinds.push(byId(target, pick(IDS)));
    if (target === 'user' || target === 'contact')
      kinds.push(department(target, pick(DEPARTMENTS)));
    return pick(kinds);
  };
  /** A broader item: a shorter prefix, or the same item. */
  const widen = (item: ScopeItem): ScopeItem => {
    if (item.match.by !== 'prefix' || random() < 0.3) return item;
    // sometimes the wrong attribute: such an actor item must not cover the target item
    if (random() < 0.15)
      return { target: item.target, match: { ...item.match, attr: pick(attrsFor(item.target)) } };
    const chars = Array.from(item.match.value);
    const keep = Math.max(1, chars.length - 1 - Math.floor(random() * 2));
    return { target: item.target, match: { ...item.match, value: chars.slice(0, keep).join('') } };
  };
  const probesFor = (type: ResourceType, items: readonly ScopeItem[]): ResourceAttrs[] => {
    const out: ResourceAttrs[] = [];
    for (let i = 0; i < 6; i += 1) {
      const base: { -readonly [K in keyof ResourceAttrs]: ResourceAttrs[K] } = { type };
      const item = items.length > 0 && random() < 0.85 ? pick(items) : undefined;
      if (item?.match.by === 'id') base.id = random() < 0.5 ? item.match.id : pick(IDS);
      else if (item?.match.by === 'prefix') {
        const value = item.match.value;
        const variants = [
          value,
          value.toUpperCase(),
          value.normalize('NFD'),
          value + text(),
          Array.from(value).slice(0, -1).join(''),
          text() + value,
        ];
        base[item.match.attr] = pick(variants);
      } else if (item?.match.by === 'department') {
        base.department = pick([
          item.match.value,
          item.match.value.toUpperCase(),
          `${item.match.value}x`,
          pick(DEPARTMENTS),
        ]);
      } else {
        base.id = pick(IDS);
        base.displayName = text();
        base.department = pick(DEPARTMENTS);
      }
      out.push(base);
    }
    return out;
  };

  for (let n = 0; n < cases && failures.length < 5; n += 1) {
    stats.cases += 1;
    // the target: a role (random subset of permissions) and a scope
    const roleEntries: RolePermission[] = PERMISSIONS.filter(() => random() < 0.25).map(
      (permission) => ({
        permission,
        qualifier: permission === 'users:read' && random() < 0.5 ? 'basic' : 'full',
      }),
    );
    const targetScope = Array.from(
      { length: random() < 0.4 ? 0 : 1 + Math.floor(random() * 3) },
      () => randomItem(pick(TYPES)),
    );
    const targetGrants = computeGrants(
      [{ principalType: 'user', permissions: roleEntries, scope: targetScope, expiresAt: null }],
      NOW,
    );

    // the actor: often derived from the target (so the property is exercised), sometimes random
    const actor: Grant[] = [];
    if (random() < 0.7) {
      for (const g of targetGrants) {
        const how = random();
        if (how < 0.12) continue; // drop: a gap
        if (how < 0.3) actor.push(grant(g.permission, 'full', 'all'));
        else if (g.scope === 'all')
          actor.push(grant(g.permission, random() < 0.2 ? 'basic' : g.qualifier, 'all'));
        else
          actor.push(
            grant(g.permission, random() < 0.15 ? 'basic' : g.qualifier, g.scope.map(widen)),
          );
      }
    } else {
      for (const permission of PERMISSIONS) {
        if (random() < 0.5) continue;
        const type = PERMISSION_RESOURCE[permission];
        const qualifier: Qualifier =
          permission === 'users:read' && random() < 0.4 ? 'basic' : 'full';
        const scope: GrantScope =
          type === null || random() < 0.3
            ? 'all'
            : Array.from({ length: 1 + Math.floor(random() * 3) }, () => randomItem(type));
        actor.push(grant(permission, qualifier, scope));
      }
    }

    const result = canGrant(actor, roleEntries, targetScope);
    if (canGrant === canGrantCore && reference(actor, roleEntries, targetScope) !== result) {
      stats.differences += 1;
      failures.push(
        `#${String(n)} canGrantCore and the reference disagree: actor ${JSON.stringify(actor)}, role ${JSON.stringify(roleEntries)}, scope ${JSON.stringify(targetScope)}`,
      );
    }
    if (!result) {
      stats.refused += 1;
      continue;
    }
    stats.granted += 1;

    // the property: everything the target is allowed, the actor is allowed, with at least that qualifier
    for (const g of targetGrants) {
      const type = PERMISSION_RESOURCE[g.permission];
      const resources: (ResourceAttrs | undefined)[] =
        type === null
          ? [undefined]
          : probesFor(type, [
              ...(g.scope === 'all' ? [] : g.scope),
              ...actor.flatMap((a) =>
                a.permission === g.permission && a.scope !== 'all' ? a.scope : [],
              ),
            ]);
      for (const resource of resources) {
        const wanted = allowedQualifier(targetGrants, g.permission, resource);
        if (wanted === null) continue;
        stats.probes += 1;
        const has = allowedQualifier(actor, g.permission, resource);
        if (!qualifierAtLeast(has, wanted))
          failures.push(
            `#${String(n)} ${g.permission} on ${JSON.stringify(resource)}: the target gets ${wanted}, the actor ${String(has)}; actor ${JSON.stringify(actor)}, role ${JSON.stringify(roleEntries)}, scope ${JSON.stringify(targetScope)}`,
          );
      }
    }
  }
  return { failures, stats };
}

describe('property: canGrantCore implies the target rights are a subset of the actor rights', () => {
  it(`${String(CASES)} seeded cases (seed ${String(SEED)})`, () => {
    const started = performance.now();
    const { failures, stats } = runProperty(canGrantCore, CASES, SEED);
    expect(failures, `seed ${String(SEED)}`).toEqual([]);
    // not vacuous: many cases were granted, many refused, many resources probed
    expect(stats.granted, `seed ${String(SEED)}`).toBeGreaterThan(CASES / 20);
    expect(stats.refused, `seed ${String(SEED)}`).toBeGreaterThan(CASES / 20);
    expect(stats.probes, `seed ${String(SEED)}`).toBeGreaterThan(CASES);
    expect(stats.differences).toBe(0);
    process.stdout.write(
      `rbac-covers property: ${String(CASES)} cases (${String(stats.granted)} granted, ${String(stats.refused)} refused, ${String(stats.probes)} probes) in ${String(Math.round(performance.now() - started))} ms, seed ${String(SEED)}\n`,
    );
  });

  it('is deterministic under the printed seed', () => {
    const a = runProperty(canGrantCore, 500, SEED);
    const b = runProperty(canGrantCore, 500, SEED);
    expect(b.stats).toEqual(a.stats);
    const c = runProperty(canGrantCore, 500, SEED + 1);
    expect(c.stats).not.toEqual(a.stats);
  });

  it('holds for the reference statement of the algorithm with the real covers', () => {
    const { failures } = runProperty(referenceCanGrant(covers), 5_000, SEED);
    expect(failures).toEqual([]);
  });

  describe('negative fixtures', () => {
    it('a deliberately broken covers (any two prefix items cover) fails the property', () => {
      const { failures } = runProperty(referenceCanGrant(brokenCovers), 5_000, SEED);
      expect(failures.length).toBeGreaterThan(0);
      expectGuardFails(
        () => {
          const { failures: found } = runProperty(referenceCanGrant(brokenCovers), 5_000, SEED);
          if (found.length > 0) throw new Error(`anti-escalation violated: ${found[0] ?? ''}`);
        },
        undefined,
        { reason: 'anti-escalation violated' },
      );
    });

    it('a covers that lets a filter scope cover an id item fails the property', () => {
      const idCovered = (a: ScopeItem, b: ScopeItem): boolean =>
        covers(a, b) || (b.match.by === 'id' && a.target === b.target && a.match.by === 'prefix');
      expect(
        runProperty(referenceCanGrant(idCovered), 5_000, SEED).failures.length,
      ).toBeGreaterThan(0);
    });

    it('a covers that ignores case-folding on the final sigma fails the property', () => {
      const noFold = (a: ScopeItem, b: ScopeItem): boolean => {
        if (a.match.by === 'prefix' && b.match.by === 'prefix')
          return (
            a.target === b.target &&
            a.match.attr === b.match.attr &&
            b.match.value.toLowerCase().startsWith(a.match.value.toLowerCase())
          );
        return covers(a, b);
      };
      expect(runProperty(referenceCanGrant(noFold), 20_000, SEED).failures.length).toBeGreaterThan(
        0,
      );
    });

    it('a canGrant that ignores the qualifier fails the property', () => {
      const ignoreQualifier: CanGrant = (actor, roleEntries, scope) =>
        referenceCanGrant(covers)(
          actor.map((g) => ({ ...g, qualifier: 'full' as const })),
          roleEntries,
          scope,
        );
      expect(runProperty(ignoreQualifier, 5_000, SEED).failures.length).toBeGreaterThan(0);
    });
  });
});

describe('fold is what the property uses (sanity)', () => {
  it('maps the final sigma to sigma', () => {
    expect(fold('\u{3c2}')).toBe('\u{3c3}');
  });
});

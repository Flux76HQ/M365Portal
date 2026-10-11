// T-B-230, CB8: resource types, the global-only class and the attributes a scope can look at.
// `PERMISSION_RESOURCE` itself is asserted in permissions.test.ts (it sits beside the catalogue).
import { describe, expect, expectTypeOf, it } from 'vitest';
import { PERMISSIONS, PERMISSION_RESOURCE, type Permission } from '../src/permissions.js';
import {
  GLOBAL_ONLY_PERMISSIONS,
  QUALIFIERS,
  RESOURCE_TYPES,
  isGlobalOnly,
  type GlobalOnlyPermission,
  type Qualifier,
  type ResourceAttrs,
  type ResourcePermission,
  type ResourceType,
} from '../src/rbac/resources.js';

describe('RESOURCE_TYPES', () => {
  it('lists the four resource types of spec 6.5.1, frozen', () => {
    expect([...RESOURCE_TYPES]).toEqual(['user', 'group', 'distributionList', 'contact']);
    expect(Object.isFrozen(RESOURCE_TYPES)).toBe(true);
  });

  it('is the set of values PERMISSION_RESOURCE can take (no unused type, no unknown type)', () => {
    const used = new Set(PERMISSIONS.map((p) => PERMISSION_RESOURCE[p]).filter((t) => t !== null));
    expect([...used].sort()).toEqual([...RESOURCE_TYPES].sort());
  });
});

describe('QUALIFIERS', () => {
  it('are full and basic, frozen', () => {
    expect([...QUALIFIERS]).toEqual(['full', 'basic']);
    expect(Object.isFrozen(QUALIFIERS)).toBe(true);
    expectTypeOf<Qualifier>().toEqualTypeOf<'full' | 'basic'>();
  });
});

describe('isGlobalOnly', () => {
  const GLOBAL = [
    'audit:read',
    'audit:export',
    'settings:branding',
    'settings:connection',
    'rbac:manage',
  ];

  it.each(PERMISSIONS)('answers for %s', (permission) => {
    expect(isGlobalOnly(permission)).toBe(GLOBAL.includes(permission));
  });

  it('agrees with PERMISSION_RESOURCE for every permission', () => {
    for (const p of PERMISSIONS) expect(isGlobalOnly(p)).toBe(PERMISSION_RESOURCE[p] === null);
  });

  it('lists exactly the global-only permissions, frozen', () => {
    expect([...GLOBAL_ONLY_PERMISSIONS]).toEqual(GLOBAL);
    expect(Object.isFrozen(GLOBAL_ONLY_PERMISSIONS)).toBe(true);
  });

  it('is false for anything that is not a catalogue permission (deny by default does not hinge on it)', () => {
    // An unknown name is not "global-only": it is not a permission at all, and callers reject it first.
    expect(isGlobalOnly('users:write' as Permission)).toBe(false);
    expect(isGlobalOnly('' as Permission)).toBe(false);
    expect(isGlobalOnly('constructor' as Permission)).toBe(false);
    expect(isGlobalOnly('__proto__' as Permission)).toBe(false);
  });
});

describe('types', () => {
  it('ResourceType is the union of the four names', () => {
    expectTypeOf<ResourceType>().toEqualTypeOf<'user' | 'group' | 'distributionList' | 'contact'>();
  });

  it('splits Permission into the resource-bound and the global-only permissions', () => {
    expectTypeOf<GlobalOnlyPermission>().toEqualTypeOf<
      'audit:read' | 'audit:export' | 'settings:branding' | 'settings:connection' | 'rbac:manage'
    >();
    expectTypeOf<ResourcePermission | GlobalOnlyPermission>().toEqualTypeOf<Permission>();
    expectTypeOf<ResourcePermission & GlobalOnlyPermission>().toBeNever();
  });

  it('ResourceAttrs has a type and optional, nullable attributes', () => {
    expectTypeOf<ResourceAttrs['type']>().toEqualTypeOf<ResourceType>();
    expectTypeOf<ResourceAttrs['id']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<ResourceAttrs['displayName']>().toEqualTypeOf<string | null | undefined>();
    expectTypeOf<ResourceAttrs['alias']>().toEqualTypeOf<string | null | undefined>();
    expectTypeOf<ResourceAttrs['mail']>().toEqualTypeOf<string | null | undefined>();
    expectTypeOf<ResourceAttrs['department']>().toEqualTypeOf<string | null | undefined>();
    expectTypeOf<{ type: 'user' }>().toExtend<ResourceAttrs>();
    expectTypeOf<{ id: string }>().not.toExtend<ResourceAttrs>();
  });
});

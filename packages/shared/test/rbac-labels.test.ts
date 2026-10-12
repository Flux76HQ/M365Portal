// T-B-254, FR-B-716, FR-B-713, baseline section 10, AN-05: the words for roles, permissions, scopes,
// qualifiers, origins and principals come from ONE module. A role is shown by its catalogue key
// (`role.owner`), never by a name typed in code; a custom role is shown as typed; the same canonical
// item gives the same words whatever its spelling; and a list of assignments is grouped by role KEY
// (never by label), so the buckets add up to the whole list.
import { describe, expect, it } from 'vitest';
import { PERMISSIONS } from '../src/permissions.js';
import {
  ALL_LABEL_KEYS,
  groupByRole,
  originText,
  permissionLabelKey,
  principalLabel,
  qualifierLabelKey,
  resourceLabelKey,
  roleLabelKey,
  scopeItemText,
} from '../src/rbac/labels.js';
import { BUILTIN_ROLE_KEYS } from '../src/rbac/roles.js';
import { SCOPE_MATRIX, type ScopeItem } from '../src/rbac/scope.js';
import { expectGuardFails } from '../src/testing/index.js';

const GUID = '8E0C2B8E-0000-4000-8000-0000000000AA';

describe('roleLabelKey and permissionLabelKey', () => {
  it('give role.<key> for the five built-in keys', () => {
    for (const key of BUILTIN_ROLE_KEYS) {
      expect(roleLabelKey(key)).toEqual({ kind: 'message', key: `role.${key}` });
    }
  });

  it('return a custom role as typed, and never a key', () => {
    expect(roleLabelKey('treasurer')).toEqual({ kind: 'text', text: 'treasurer' });
    expect(roleLabelKey('role.owner')).toEqual({ kind: 'text', text: 'role.owner' });
    expect(roleLabelKey('')).toEqual({ kind: 'text', text: '' });
  });

  it('give permission.<permission> for the 15 permissions, and an unknown one as typed', () => {
    for (const permission of PERMISSIONS) {
      expect(permissionLabelKey(permission)).toEqual({
        kind: 'message',
        key: `permission.${permission}`,
      });
    }
    expect(permissionLabelKey('users:write')).toEqual({ kind: 'text', text: 'users:write' });
    expect(permissionLabelKey('constructor')).toEqual({ kind: 'text', text: 'constructor' });
  });
});

describe('qualifierLabelKey and resourceLabelKey', () => {
  it('name the two qualifiers and the four resource types', () => {
    expect(qualifierLabelKey('full')).toEqual({ kind: 'message', key: 'qualifier.full' });
    expect(qualifierLabelKey('basic')).toEqual({ kind: 'message', key: 'qualifier.basic' });
    expect(resourceLabelKey('distributionList')).toEqual({
      kind: 'message',
      key: 'resource.distributionList',
    });
  });
});

describe('scopeItemText', () => {
  const items: ScopeItem[] = [
    { target: 'user', match: { by: 'department', value: 'Finance' } },
    { target: 'user', match: { by: 'prefix', attr: 'displayName', value: 'Jan' } },
    { target: 'user', match: { by: 'prefix', attr: 'mail', value: 'jan@' } },
    { target: 'group', match: { by: 'id', id: GUID.toLowerCase() } },
    { target: 'group', match: { by: 'prefix', attr: 'alias', value: 'sales' } },
    { target: 'distributionList', match: { by: 'prefix', attr: 'displayName', value: 'Board' } },
    { target: 'contact', match: { by: 'department', value: 'Legal' } },
  ];

  it('gives one message key with parameters for every combination of the scope matrix', () => {
    const seen = new Set<string>();
    for (const [target, row] of Object.entries(SCOPE_MATRIX)) {
      const combos: ScopeItem[] = [
        ...(row.id ? [{ target, match: { by: 'id', id: GUID.toLowerCase() } }] : []),
        ...row.prefix.map((attr) => ({ target, match: { by: 'prefix', attr, value: 'x' } })),
        ...(row.department ? [{ target, match: { by: 'department', value: 'x' } }] : []),
      ] as ScopeItem[];
      for (const item of combos) {
        const text = scopeItemText(item);
        expect(text.kind).toBe('message');
        expect(ALL_LABEL_KEYS).toContain(text.key);
        expect(text.params.target).toBe(target);
        seen.add(text.key);
      }
    }
    expect([...seen].sort()).toEqual([
      'scope.department',
      'scope.id',
      'scope.prefix.alias',
      'scope.prefix.displayName',
      'scope.prefix.mail',
    ]);
  });

  it('carries the value or id as a parameter', () => {
    expect(scopeItemText(items[0]!)).toEqual({
      kind: 'message',
      key: 'scope.department',
      params: { target: 'user', value: 'Finance' },
    });
    expect(scopeItemText(items[3]!).params).toEqual({
      target: 'group',
      id: GUID.toLowerCase(),
    });
  });

  it('is the same for the same canonical item whatever its spelling', () => {
    const canonical = scopeItemText({
      target: 'group',
      match: { by: 'id', id: GUID.toLowerCase() },
    });
    expect(scopeItemText({ target: 'group', match: { by: 'id', id: GUID } })).toEqual(canonical);
    const accented = scopeItemText({
      target: 'user',
      match: { by: 'prefix', attr: 'displayName', value: 'Café' },
    });
    expect(
      scopeItemText({
        target: 'user',
        match: { by: 'prefix', attr: 'displayName', value: 'Café ' },
      }),
    ).toEqual(accented);
    expect(
      scopeItemText({ target: 'user', match: { by: 'department', value: '  Finance  ' } }),
    ).toEqual(scopeItemText(items[0]!));
  });

  it('says scope.invalid for an item the matrix does not allow, and never throws', () => {
    for (const bad of [
      { target: 'user', match: { by: 'prefix', attr: 'alias', value: 'x' } },
      { target: 'nobody', match: { by: 'department', value: 'x' } },
      null,
      42,
    ]) {
      expect(scopeItemText(bad as never)).toEqual({
        kind: 'message',
        key: 'scope.invalid',
        params: {},
      });
    }
  });

  it('negative: a function that prints the value as typed differs between two spellings', () => {
    const asTyped = (item: ScopeItem): string => JSON.stringify(item);
    const same = (a: ScopeItem, b: ScopeItem): void => {
      expect(asTyped(a)).toBe(asTyped(b));
    };
    expectGuardFails(() => {
      same(
        { target: 'group', match: { by: 'id', id: GUID } },
        { target: 'group', match: { by: 'id', id: GUID.toLowerCase() } },
      );
    }, undefined);
  });
});

describe('originText', () => {
  it('says direct, through a named group, or through a group whose name is unknown', () => {
    expect(originText({ type: 'direct' })).toEqual({
      kind: 'message',
      key: 'origin.direct',
      params: {},
    });
    expect(originText({ type: 'group', groupId: GUID, groupName: 'Sales' })).toEqual({
      kind: 'message',
      key: 'origin.group',
      params: { group: 'Sales' },
    });
    for (const groupName of [null, '', '   ']) {
      expect(originText({ type: 'group', groupId: GUID, groupName })).toEqual({
        kind: 'message',
        key: 'origin.groupUnnamed',
        params: {},
      });
    }
  });
});

describe('principalLabel', () => {
  it('is the display name, else the UPN, else the empty string', () => {
    expect(principalLabel({ displayName: 'Jan Smit', userPrincipalName: 'jan@x.example' })).toBe(
      'Jan Smit',
    );
    expect(principalLabel({ displayName: null, userPrincipalName: 'jan@x.example' })).toBe(
      'jan@x.example',
    );
    expect(principalLabel({ displayName: '  ', userPrincipalName: 'jan@x.example' })).toBe(
      'jan@x.example',
    );
    expect(principalLabel({ displayName: null, userPrincipalName: null })).toBe('');
    expect(principalLabel({})).toBe('');
  });
});

describe('groupByRole', () => {
  const assignments = [
    { id: '1', role: { key: 'owner' } },
    { id: '2', role: { key: 'Owner' } },
    { id: '3', role: { key: ' owner ' } },
    { id: '4', role: { key: 'reader' } },
    { id: '5', role: { key: 'treasurer' } },
    { id: '6', role: { key: 'treasurer' } },
  ];

  it('groups by role key, not by label: several spellings of one role are one bucket, and the total adds up', () => {
    const buckets = groupByRole(assignments);
    expect(buckets.map((bucket) => bucket.roleKey)).toEqual(['owner', 'reader', 'treasurer']);
    expect(buckets.map((bucket) => bucket.items.map((item) => item.id))).toEqual([
      ['1', '2', '3'],
      ['4'],
      ['5', '6'],
    ]);
    expect(buckets.reduce((sum, bucket) => sum + bucket.items.length, 0)).toBe(assignments.length);
  });

  it('negative: grouping by label text splits one role into several buckets', () => {
    const byLabel = new Map<string, number>();
    for (const assignment of assignments) {
      const label = assignment.role.key;
      byLabel.set(label, (byLabel.get(label) ?? 0) + 1);
    }
    const oneBucketPerRole = (): void => {
      expect(byLabel.size).toBe(groupByRole(assignments).length);
    };
    expectGuardFails(oneBucketPerRole, undefined);
  });
});

describe('ALL_LABEL_KEYS', () => {
  it('lists every key the functions can produce, once, for the catalogue check', () => {
    expect(new Set(ALL_LABEL_KEYS).size).toBe(ALL_LABEL_KEYS.length);
    for (const key of BUILTIN_ROLE_KEYS) expect(ALL_LABEL_KEYS).toContain(`role.${key}`);
    for (const permission of PERMISSIONS)
      expect(ALL_LABEL_KEYS).toContain(`permission.${permission}`);
    expect(ALL_LABEL_KEYS).toEqual(
      expect.arrayContaining([
        'qualifier.full',
        'qualifier.basic',
        'origin.direct',
        'scope.invalid',
      ]),
    );
  });
});

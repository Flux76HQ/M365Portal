// T-C-020, FR-C-307, PC-05, RC-05, EC-C9: the one function that turns a member, an owner or the manager
// into a row. A restricted row has no id, no name, no address; a basic grant shows three fields; a
// missing attribute never matches a scope item; and a handler that returns the raw row fails the guard.
import type { Grant } from '@m365portal/shared/rbac/effective';
import type { ScopeItem } from '@m365portal/shared/rbac/scope';
import {
  RestrictedRowSchema,
  DirectoryRowSchema,
  isRestrictedRow,
} from '@m365portal/shared/schemas/directory';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import {
  restrictedRow,
  toDirectoryRow,
  toDirectoryRows,
  type RowVisibility,
} from '../../src/directory/restricted-rows.js';
import { createPolicyContext } from '../../src/policy/index.js';
import type { DirectoryRef } from '../../src/ports/graph.js';
import { testActor } from '../helpers/test-actor.js';

const ID = '3f2c1a9e-0b5d-4c61-8a77-5d9a2b7c4e10';
const ID2 = '3f2c1a9e-0b5d-4c61-8a77-5d9a2b7c4e11';
const CANARY = {
  name: 'Canary Name',
  mail: 'canary.mail@contoso-fake.example',
  upn: 'canary.upn@contoso-fake.example',
};

const sales: ScopeItem = { target: 'user', match: { by: 'department', value: 'Sales' } };
const annPrefix: ScopeItem = {
  target: 'user',
  match: { by: 'prefix', attr: 'displayName', value: 'Canary' },
};
const groupPrefix: ScopeItem = {
  target: 'group',
  match: { by: 'prefix', attr: 'displayName', value: 'Team' },
};
const groupAlias: ScopeItem = {
  target: 'group',
  match: { by: 'prefix', attr: 'alias', value: 'team' },
};
const groupId: ScopeItem = { target: 'group', match: { by: 'id', id: ID } };

function visibility(grants: readonly Grant[]): RowVisibility {
  const ctx = createPolicyContext(testActor('user', { grants }));
  return { users: ctx.visibleScopes('users:read'), groups: ctx.visibleScopes('groups:read') };
}
const all: Grant[] = [
  { permission: 'users:read', qualifier: 'full', scope: 'all' },
  { permission: 'groups:read', qualifier: 'full', scope: 'all' },
];

const user: DirectoryRef = {
  id: ID,
  kind: 'user',
  displayName: CANARY.name,
  mail: CANARY.mail,
  userPrincipalName: CANARY.upn,
  department: 'Sales',
  mailNickname: 'canary',
};
const group: DirectoryRef = {
  id: ID,
  kind: 'group',
  displayName: 'Team Blue',
  mail: 'team@contoso-fake.example',
  userPrincipalName: null,
  department: null,
  mailNickname: 'teamblue',
};
const other: DirectoryRef = {
  id: ID2,
  kind: 'other',
  displayName: 'Laptop 1',
  mail: null,
  userPrincipalName: null,
  department: null,
  mailNickname: null,
};

describe('a restricted row carries no identifying data (FR-C-307)', () => {
  it('is exactly { kind, restricted: true }, valid on the wire, and the schema refuses an id on it', () => {
    for (const kind of ['user', 'group', 'other'] as const) {
      const row = restrictedRow(kind);
      expect(row).toEqual({ kind, restricted: true });
      expect(Object.keys(row).sort()).toEqual(['kind', 'restricted']);
      expect(RestrictedRowSchema.safeParse(row).success).toBe(true);
      expect(RestrictedRowSchema.safeParse({ ...row, id: null }).success).toBe(false);
      expect(RestrictedRowSchema.safeParse({ ...row, displayName: 'x' }).success).toBe(false);
    }
  });

  it('hides a user and a group from an actor without a matching scope, in the text of the whole answer', () => {
    const nothing = visibility([
      {
        permission: 'users:read',
        qualifier: 'full',
        scope: [{ target: 'user', match: { by: 'department', value: 'Finance' } }],
      },
      { permission: 'groups:read', qualifier: 'full', scope: [groupPrefix] },
    ]);
    const rows = toDirectoryRows(
      [user, { ...group, displayName: 'Other', mailNickname: 'other' }],
      nothing,
    );
    expect(rows).toEqual([restrictedRow('user'), restrictedRow('group')]);
    const text = JSON.stringify(rows);
    for (const secret of [ID, CANARY.name, CANARY.mail, CANARY.upn, 'Other', 'team@contoso']) {
      expect(text).not.toContain(secret);
    }
  });
});

describe('users (FR-C-307, FR-C-204)', () => {
  it('shows a user in full for a full grant on all, with the principal name', () => {
    expect(toDirectoryRow(user, visibility(all))).toEqual({
      kind: 'user',
      id: ID,
      displayName: CANARY.name,
      mail: CANARY.mail,
      userPrincipalName: CANARY.upn,
    });
  });

  it.each([
    ['a department', { permission: 'users:read', qualifier: 'full', scope: [sales] }],
    ['a name prefix', { permission: 'users:read', qualifier: 'full', scope: [annPrefix] }],
  ] as const)('shows a user in full when the scope is %s and matches', (_name, grant) => {
    const row = toDirectoryRow(user, visibility([grant]));
    expect(isRestrictedRow(row)).toBe(false);
    expect(row).toMatchObject({ id: ID, userPrincipalName: CANARY.upn });
  });

  it('shows a user through a basic grant as id, display name and mail only', () => {
    const row = toDirectoryRow(
      user,
      visibility([{ permission: 'users:read', qualifier: 'basic', scope: 'all' }]),
    );
    expect(row).toEqual({
      kind: 'user',
      id: ID,
      displayName: CANARY.name,
      mail: CANARY.mail,
      userPrincipalName: null,
    });
    expect(JSON.stringify(row)).not.toContain(CANARY.upn);
  });

  it('a full grant beats a basic one for the same user', () => {
    const row = toDirectoryRow(
      user,
      visibility([
        { permission: 'users:read', qualifier: 'full', scope: [sales] },
        { permission: 'users:read', qualifier: 'basic', scope: 'all' },
      ]),
    );
    expect(row).toMatchObject({ userPrincipalName: CANARY.upn });
  });

  it('restricts a user whose scope attribute Graph did not return (fail closed)', () => {
    const noDepartment = { ...user, department: null };
    const departmentScope = visibility([
      { permission: 'users:read', qualifier: 'full', scope: [sales] },
    ]);
    expect(toDirectoryRow(noDepartment, departmentScope)).toEqual(restrictedRow('user'));
    const limited = { ...user, displayName: null, mail: null, department: null };
    expect(
      toDirectoryRow(
        limited,
        visibility([{ permission: 'users:read', qualifier: 'full', scope: [annPrefix] }]),
      ),
    ).toEqual(restrictedRow('user'));
  });

  it('restricts every user for an actor with no users:read at all, and for a groups-only actor', () => {
    expect(
      toDirectoryRow(
        user,
        visibility([{ permission: 'groups:read', qualifier: 'full', scope: 'all' }]),
      ),
    ).toEqual(restrictedRow('user'));
  });
});

describe('groups (FR-C-307)', () => {
  it.each([
    ['all', 'all'],
    ['a name prefix', [groupPrefix]],
    ['an alias prefix', [groupAlias]],
    ['an id', [groupId]],
  ] as const)('shows a group in full for the scope %s', (_name, scope) => {
    const row = toDirectoryRow(
      group,
      visibility([{ permission: 'groups:read', qualifier: 'full', scope: scope }]),
    );
    expect(row).toEqual({
      kind: 'group',
      id: ID,
      displayName: 'Team Blue',
      mail: 'team@contoso-fake.example',
      userPrincipalName: null,
    });
  });

  it('restricts a group for an actor who reads users only, and when no groups capability was asked', () => {
    const usersOnly = visibility([{ permission: 'users:read', qualifier: 'full', scope: 'all' }]);
    expect(toDirectoryRow(group, usersOnly)).toEqual(restrictedRow('group'));
    expect(toDirectoryRow(group, { users: visibility(all).users })).toEqual(restrictedRow('group'));
  });
});

describe('other objects (EC-C9)', () => {
  it('shows kind and id, no name, to an actor who may see users or groups', () => {
    for (const grants of [
      [{ permission: 'users:read', qualifier: 'basic', scope: 'all' }],
      [{ permission: 'groups:read', qualifier: 'full', scope: [groupPrefix] }],
      all,
    ] as Grant[][]) {
      expect(toDirectoryRow(other, visibility(grants))).toEqual({
        kind: 'other',
        id: ID2,
        displayName: null,
        mail: null,
        userPrincipalName: null,
      });
    }
  });

  it('restricts it to an actor who may see neither', () => {
    expect(
      toDirectoryRow(
        other,
        visibility([{ permission: 'audit:read', qualifier: 'full', scope: 'all' }]),
      ),
    ).toEqual(restrictedRow('other'));
  });
});

describe('every result is a valid wire row', () => {
  it('parses with DirectoryRowSchema for each kind and each visibility', () => {
    const visibilities = [
      visibility(all),
      visibility([{ permission: 'users:read', qualifier: 'basic', scope: 'all' }]),
      visibility([{ permission: 'users:read', qualifier: 'full', scope: [sales] }]),
      visibility([]),
    ];
    for (const seen of visibilities) {
      for (const ref of [user, group, other]) {
        expect(DirectoryRowSchema.safeParse(toDirectoryRow(ref, seen)).success).toBe(true);
      }
    }
  });
});

describe('negative: a handler that returns the raw row fails (FR-C-307, RC-05)', () => {
  const seen = visibility([
    {
      permission: 'users:read',
      qualifier: 'full',
      scope: [{ target: 'user', match: { by: 'department', value: 'Finance' } }],
    },
  ]);

  /** The guard of the route tests: nothing the actor may not see is in the answer. */
  const noLeak = (rows: unknown): void => {
    const text = JSON.stringify(rows);
    for (const secret of [ID, CANARY.name, CANARY.mail, CANARY.upn]) {
      if (text.includes(secret)) throw new Error(`leaked ${secret.slice(0, 6)}`);
    }
  };

  it('passes the real function and fails a handler that maps the Graph row as it is', () => {
    expect(() => {
      noLeak(toDirectoryRows([user], seen));
    }).not.toThrow();
    const rawHandler = (refs: readonly DirectoryRef[]): unknown => refs.map((ref) => ({ ...ref }));
    expectGuardFails(
      (refs: readonly DirectoryRef[]) => {
        noLeak(rawHandler(refs));
      },
      [user],
      { reason: 'leaked' },
    );
    const nullObjectHandler = (refs: readonly DirectoryRef[]): unknown =>
      refs.map((ref) => ({ kind: ref.kind, restricted: true, displayName: ref.displayName }));
    expectGuardFails(
      (refs: readonly DirectoryRef[]) => {
        noLeak(nullObjectHandler(refs));
      },
      [user],
      { reason: 'leaked' },
    );
  });
});

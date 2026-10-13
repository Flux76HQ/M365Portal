// T-C-010, FR-C-104, FR-C-207: the Graph answers of Phase C are parsed by allow-lists (unknown
// properties dropped, strings cut at 256 bytes, absent is `null`), the `$select` lists never name a
// licence or sign-in property, and a members row gets its kind from `@odata.type`.
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import {
  FORBIDDEN_SELECT_PATTERN,
  GROUP_LIST_SELECT,
  GROUP_SELECT,
  GroupList,
  GroupRow,
  MAX_STRING_BYTES,
  REF_SELECT,
  RefList,
  RefRow,
  USER_LIST_SELECT,
  USER_SELECT,
  UserList,
  UserRow,
} from '../../../src/integrations/graph/schemas.js';

const ID = '3f2c1a9e-0b5d-4c61-8a77-5d9a2b7c4e10';

/** The guard: a `$select` list that names a licence or sign-in property is refused. */
function checkSelect(select: string): void {
  if (FORBIDDEN_SELECT_PATTERN.test(select)) throw new Error(`forbidden property in ${select}`);
  for (const name of select.split(',')) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) throw new Error(`not a property name: ${name}`);
  }
}

describe('the user row (FR-C-104)', () => {
  it('keeps the Phase C properties, drops the rest, and makes absent properties null', () => {
    const row = UserRow.parse({
      id: ID.toUpperCase(),
      displayName: 'Anna Jansen',
      mobilePhone: '+31 6 00000000',
      assignedLicenses: [{ skuId: 'x' }],
      signInActivity: { lastSignInDateTime: '2026-01-01T00:00:00Z' },
    });
    expect(row).toEqual({
      id: ID,
      displayName: 'Anna Jansen',
      userPrincipalName: null,
      mail: null,
      department: null,
      accountEnabled: null,
      givenName: null,
      surname: null,
      jobTitle: null,
      officeLocation: null,
      userType: null,
      onPremisesSyncEnabled: null,
      createdDateTime: null,
    });
    expect(Object.keys(row)).not.toContain('mobilePhone');
    expect(Object.keys(row)).not.toContain('assignedLicenses');
  });

  it('cuts strings at 256 bytes on a character boundary', () => {
    const row = UserRow.parse({
      id: ID,
      jobTitle: 'é'.repeat(300),
      officeLocation: 'x'.repeat(999),
    });
    expect(new TextEncoder().encode(row.jobTitle ?? '').length).toBeLessThanOrEqual(
      MAX_STRING_BYTES,
    );
    expect(row.jobTitle).toBe('é'.repeat(128));
    expect(row.officeLocation).toHaveLength(MAX_STRING_BYTES);
  });

  it('refuses an id that is not a GUID and a property of the wrong type', () => {
    expect(UserRow.safeParse({ id: 'not-a-guid' }).success).toBe(false);
    expect(UserRow.safeParse({ id: ID, accountEnabled: 'yes' }).success).toBe(false);
    expect(UserRow.safeParse({ id: ID, displayName: 5 }).success).toBe(false);
    expect(UserList.safeParse({ value: 'nope' }).success).toBe(false);
  });
});

describe('the group row (FR-C-104)', () => {
  it('adds visibility, description and createdDateTime, and keeps absent ones null', () => {
    const row = GroupRow.parse({
      id: ID,
      displayName: 'Finance',
      visibility: 'HiddenMembership',
      createdDateTime: '2021-08-02T10:30:06Z',
      classification: 'secret',
    });
    expect(row.visibility).toBe('HiddenMembership');
    expect(row.description).toBeNull();
    expect(row.createdDateTime).toBe('2021-08-02T10:30:06Z');
    expect(row.groupTypes).toBeNull();
    expect(Object.keys(row)).not.toContain('classification');
    expect(GroupList.parse({ value: [{ id: ID }] }).value).toHaveLength(1);
  });
});

describe('members, owners and the manager (FR-C-104, R-C-05)', () => {
  it.each([
    ['#microsoft.graph.user', 'user'],
    ['#microsoft.graph.group', 'group'],
    ['#microsoft.graph.device', 'other'],
    ['#microsoft.graph.servicePrincipal', 'other'],
    ['#microsoft.graph.orgContact', 'other'],
    [undefined, 'other'],
  ] as const)('maps %s to the kind %s', (odataType, kind) => {
    const row = RefRow.parse({ '@odata.type': odataType, id: ID });
    expect(row.kind).toBe(kind);
    expect(row.displayName).toBeNull();
    expect(row.mail).toBeNull();
    expect(row.userPrincipalName).toBeNull();
    expect(Object.keys(row)).not.toContain('@odata.type');
  });

  it('parses the limited information the service sends for an object type it may not read', () => {
    const list = RefList.parse({
      value: [
        { '@odata.type': '#microsoft.graph.device', id: ID, displayName: null, mail: null },
        { '@odata.type': '#microsoft.graph.user', id: ID, displayName: 'Bob', department: 'Sales' },
      ],
    });
    expect(list.value.map((row) => row.kind)).toEqual(['other', 'user']);
    expect(list.value[1]?.department).toBe('Sales');
  });
});

describe('the $select lists (FR-C-104, FR-C-207)', () => {
  const lists: Record<string, string> = {
    USER_SELECT,
    USER_LIST_SELECT,
    GROUP_SELECT,
    GROUP_LIST_SELECT,
    REF_SELECT,
  };

  it.each(Object.entries(lists))(
    '%s names plain properties and no licence or sign-in data',
    (_n, list) => {
      expect(() => {
        checkSelect(list);
      }).not.toThrow();
    },
  );

  it('selects department for the lists, because a scope item looks at it (plan 0, finding 4)', () => {
    expect(USER_LIST_SELECT.split(',')).toEqual(
      expect.arrayContaining(['id', 'displayName', 'userPrincipalName', 'mail', 'department']),
    );
    expect(GROUP_LIST_SELECT.split(',')).toContain('mailNickname');
  });

  it('negative: a $select with assignedLicenses, a licence word or sign-in data fails the guard', () => {
    for (const bad of [
      `${USER_SELECT},assignedLicenses`,
      'id,licenseDetails',
      'id,assignedPlans',
      'id,signInActivity',
    ]) {
      expectGuardFails(checkSelect, bad, { name: bad, reason: 'forbidden property' });
    }
  });
});

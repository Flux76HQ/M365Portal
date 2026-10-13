// T-C-021, FR-C-204, FR-C-303, FR-C-304, GC0 note: the mappers build the wire shapes: `basic` is
// projected on every path, the group kind comes from groupKindOf, createdDateTime gets milliseconds,
// and no wire user is built outside the mappers.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { groupKindOf } from '@m365portal/shared/directory/group-kind';
import {
  BasicUserSchema,
  GroupDetailSchema,
  GroupListItemSchema,
  UserDetailSchema,
  UserListItemSchema,
} from '@m365portal/shared/schemas/directory';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import {
  toBasicUser,
  toGroupDetail,
  toGroupListItem,
  toIsoMillis,
  toUserDetail,
  toUserListItem,
  userTypeOf,
  visibilityOf,
} from '../../src/directory/mappers.js';
import type { DirectoryGroup, DirectoryUser } from '../../src/ports/graph.js';

const ID = '3f2c1a9e-0b5d-4c61-8a77-5d9a2b7c4e10';

const user: DirectoryUser = {
  id: ID,
  displayName: 'Anna Jansen',
  userPrincipalName: 'anna@contoso-fake.example',
  mail: 'anna@contoso-fake.example',
  department: 'Sales',
  accountEnabled: true,
  givenName: 'Anna',
  surname: 'Jansen',
  jobTitle: 'Analyst',
  officeLocation: 'Utrecht',
  userType: 'Member',
  onPremisesSyncEnabled: false,
  createdDateTime: '2021-08-02T10:30:06Z',
};
const group: DirectoryGroup = {
  id: ID,
  displayName: 'Team',
  mail: 'team@contoso-fake.example',
  mailNickname: 'team',
  groupTypes: ['Unified'],
  membershipRule: 'user.department -eq "Sales"',
  onPremisesSyncEnabled: null,
  securityEnabled: false,
  mailEnabled: true,
  visibility: 'Private',
  description: 'The team',
  createdDateTime: '2022-03-01T00:00:00Z',
};

describe('users (FR-C-204)', () => {
  it('projects a basic grant to id, display name and mail on the list and on the detail', () => {
    const expected = { id: ID, displayName: 'Anna Jansen', mail: 'anna@contoso-fake.example' };
    expect(toUserListItem(user, 'basic')).toEqual(expected);
    expect(toUserDetail(user, 'basic', { state: 'none' })).toEqual(expected);
    expect(toBasicUser(user)).toEqual(expected);
    // A manager never reaches a basic detail, whatever the caller passes.
    const withManager = toUserDetail(user, 'basic', {
      state: 'present',
      user: { kind: 'user', id: ID, displayName: 'Boss', mail: null, userPrincipalName: null },
    });
    expect(JSON.stringify(withManager)).not.toContain('Boss');
    expect(Object.keys(withManager).sort()).toEqual(['displayName', 'id', 'mail']);
    expect(BasicUserSchema.safeParse(withManager).success).toBe(true);
  });

  it('gives the full list item and detail, valid on the wire, with no licence or phone field', () => {
    const item = toUserListItem(user, 'full');
    expect(item).toEqual({
      id: ID,
      displayName: 'Anna Jansen',
      userPrincipalName: 'anna@contoso-fake.example',
      mail: 'anna@contoso-fake.example',
      department: 'Sales',
      jobTitle: 'Analyst',
      accountEnabled: true,
      userType: 'member',
    });
    expect(UserListItemSchema.safeParse(item).success).toBe(true);
    const detail = toUserDetail(user, 'full', { state: 'unavailable' });
    expect(detail).toMatchObject({
      givenName: 'Anna',
      surname: 'Jansen',
      officeLocation: 'Utrecht',
      onPremisesSyncEnabled: false,
      manager: { state: 'unavailable' },
    });
    expect(UserDetailSchema.safeParse(detail).success).toBe(true);
    expect(JSON.stringify(detail)).not.toMatch(/licen|phone|address/i);
  });

  it("normalises Graph's timestamp to milliseconds and makes anything else null", () => {
    expect(toIsoMillis('2021-08-02T10:30:06Z')).toBe('2021-08-02T10:30:06.000Z');
    expect(toIsoMillis('2021-08-02T10:30:06.5Z')).toBe('2021-08-02T10:30:06.500Z');
    expect(toIsoMillis('2021-08-02T12:30:06+02:00')).toBe('2021-08-02T10:30:06.000Z');
    expect(toIsoMillis(null)).toBeNull();
    for (const bad of ['', 'yesterday', '2021-13-45T00:00:00Z', 'NaN']) {
      expect(toIsoMillis(bad), bad).toBeNull();
    }
    const detail = toUserDetail(user, 'full', { state: 'none' });
    expect('createdDateTime' in detail && detail.createdDateTime).toBe('2021-08-02T10:30:06.000Z');
    const broken = toUserDetail({ ...user, createdDateTime: 'garbage' }, 'full', { state: 'none' });
    expect('createdDateTime' in broken && broken.createdDateTime).toBeNull();
    expect(UserDetailSchema.safeParse(broken).success).toBe(true);
  });

  it('maps userType to member and guest in any case, and everything else to null (U72)', () => {
    expect(userTypeOf('Member')).toBe('member');
    expect(userTypeOf('GUEST')).toBe('guest');
    for (const other of [null, '', 'Other', 'Viral', 'member '] as const) {
      expect(userTypeOf(other), String(other)).toBeNull();
    }
  });

  it('keeps null as null: a user Graph returned little of is still a valid row', () => {
    const sparse: DirectoryUser = {
      id: ID,
      displayName: null,
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
    };
    expect(UserListItemSchema.safeParse(toUserListItem(sparse, 'full')).success).toBe(true);
    expect(
      UserDetailSchema.safeParse(toUserDetail(sparse, 'full', { state: 'none' })).success,
    ).toBe(true);
    expect(BasicUserSchema.safeParse(toUserListItem(sparse, 'basic')).success).toBe(true);
  });
});

describe('groups (FR-C-303, FR-C-304)', () => {
  it('derives the kind with groupKindOf only, and the membership type from groupTypes', () => {
    const cases: [Partial<DirectoryGroup>, string][] = [
      [{}, 'm365'],
      [{ groupTypes: [], mailEnabled: false, securityEnabled: true }, 'security'],
      [{ groupTypes: [], mailEnabled: true, securityEnabled: true }, 'mailsecurity'],
      [{ groupTypes: [], mailEnabled: true, securityEnabled: false }, 'distribution'],
      [{ groupTypes: null }, 'unknown'],
      [{ mailEnabled: null, groupTypes: [] }, 'unknown'],
    ];
    for (const [change, kind] of cases) {
      const candidate = { ...group, ...change };
      expect(toGroupListItem(candidate).kind, JSON.stringify(change)).toBe(kind);
      expect(toGroupListItem(candidate).kind).toBe(groupKindOf(candidate));
      expect(toGroupDetail(candidate).kind).toBe(kind);
    }
    expect(
      toGroupDetail({ ...group, groupTypes: ['Unified', 'DynamicMembership'] }).membershipType,
    ).toBe('dynamic');
    expect(toGroupDetail(group).membershipType).toBe('assigned');
    expect(toGroupDetail({ ...group, groupTypes: null }).membershipType).toBeNull();
  });

  it('gives the list item and the detail, valid on the wire, without the source properties or the rule', () => {
    const item = toGroupListItem(group);
    expect(item).toEqual({
      id: ID,
      displayName: 'Team',
      mail: 'team@contoso-fake.example',
      kind: 'm365',
      visibility: 'Private',
    });
    expect(GroupListItemSchema.safeParse(item).success).toBe(true);
    const detail = toGroupDetail(group);
    expect(detail).toEqual({
      id: ID,
      displayName: 'Team',
      description: 'The team',
      mail: 'team@contoso-fake.example',
      mailNickname: 'team',
      kind: 'm365',
      visibility: 'Private',
      membershipType: 'assigned',
      onPremisesSyncEnabled: null,
      createdDateTime: '2022-03-01T00:00:00.000Z',
    });
    expect(GroupDetailSchema.safeParse(detail).success).toBe(true);
    const text = JSON.stringify(detail);
    for (const absent of [
      'groupTypes',
      'mailEnabled',
      'securityEnabled',
      'membershipRule',
      'user.department',
    ]) {
      expect(text).not.toContain(absent);
    }
  });

  it('knows the three visibilities and nothing else', () => {
    for (const v of ['Private', 'Public', 'HiddenMembership'] as const)
      expect(visibilityOf(v)).toBe(v);
    for (const other of [null, 'private', 'Secret', ''] as const)
      expect(visibilityOf(other)).toBeNull();
  });
});

const SRC = fileURLToPath(new URL('../../src/directory', import.meta.url));

/** A wire user or group is an object literal with a display name: only the mappers and restricted-rows build one. */
function buildsWireObjects(files: Readonly<Record<string, string>>): string[] {
  return Object.entries(files)
    .filter(([path]) => path !== 'mappers.ts' && path !== 'restricted-rows.ts')
    .filter(
      ([, text]) =>
        /^\s*displayName\s*:/m.test(text) || /\bdisplayName\s*:\s*[a-z]+\.displayName\b/.test(text),
    )
    .map(([path]) => path);
}

describe('no wire user or group is built outside the mappers (FR-C-204)', () => {
  const files = Object.fromEntries(
    readdirSync(SRC, { recursive: true, encoding: 'utf8' })
      .filter((name) => name.endsWith('.ts'))
      .map((name) => [name.replaceAll('\\', '/'), readFileSync(join(SRC, name), 'utf8')]),
  );

  it('finds none in the directory module', () => {
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining(['mappers.ts', 'restricted-rows.ts']),
    );
    expect(buildsWireObjects(files)).toEqual([]);
    expect(relative(SRC, join(SRC, 'mappers.ts'))).toBe('mappers.ts');
  });

  it('negative: a service that builds a user row itself is found', () => {
    const scan = (text: string): void => {
      const found = buildsWireObjects({ 'users-service.ts': text });
      if (found.length > 0) throw new Error(`a wire object is built in ${found.join(', ')}`);
    };
    expectGuardFails(scan, 'return { id: u.id,\n  displayName: u.displayName, mail: u.mail };', {
      reason: 'a wire object is built',
    });
    expectGuardFails(scan, 'const row = {\n    displayName: user.displayName,\n};', {
      reason: 'a wire object is built',
    });
    expect(() => {
      scan('return toUserListItem(user, qualifier);');
    }).not.toThrow();
  });
});

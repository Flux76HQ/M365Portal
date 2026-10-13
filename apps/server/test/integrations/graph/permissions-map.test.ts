// T-B-072, FR-B-311, plan 8.8: every method of `GraphClient` states the Learn page and the
// application permissions it relies on, and each permission is one the wizard grants.
//
// The behavioural half (a token with exactly these permissions works, one without any of them gets
// 403) is in graph-client.contract.test.ts, for both implementations.
import { GRAPH_APP_ROLES } from '@m365portal/shared/setup/graph-roles';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import { HttpGraphClient } from '../../../src/integrations/graph/graph-client.js';
import {
  GRAPH_METHOD_PERMISSIONS,
  type GraphMethodPermissions,
} from '../../../src/integrations/graph/permissions-map.js';

/** The rule as a guard: it throws when a map breaks it. */
function checkMap(
  map: Readonly<Record<string, GraphMethodPermissions>>,
  methods: readonly string[],
): void {
  const granted = new Set<string>(GRAPH_APP_ROLES);
  for (const method of methods) {
    const row = map[method];
    if (row === undefined) throw new Error(`no row for ${method}`);
    if (
      !/^https:\/\/learn\.microsoft\.com\/graph\/api\/[a-z-]+\?view=graph-rest-1\.0$/.test(row.page)
    ) {
      throw new Error(`${method}: the page is not a Graph API page of Learn`);
    }
    if (row.permissions.length === 0) throw new Error(`${method}: no permission named`);
    for (const permission of row.permissions) {
      if (!granted.has(permission))
        throw new Error(`${method}: ${permission} is not in GRAPH_APP_ROLES`);
    }
  }
  for (const method of Object.keys(map)) {
    if (!methods.includes(method)) throw new Error(`${method} is not a method of the client`);
  }
}

/** The public methods of the client that belong to the port (everything but the helpers). */
const PORT_METHODS = [
  'getOrganization',
  'probeUsers',
  'getUser',
  'checkMemberGroups',
  'searchGroups',
  'getGroup',
  // Phase C (FR-C-101): the six reads of the users and groups pages.
  'listUsers',
  'getUserManager',
  'listUserGroups',
  'listGroups',
  'listGroupMembers',
  'listGroupOwners',
];

describe('permissions-map (T-B-072)', () => {
  it('has a row for every method of the port, and for nothing else', () => {
    checkMap(GRAPH_METHOD_PERMISSIONS, PORT_METHODS);
    const own = Object.getOwnPropertyNames(HttpGraphClient.prototype).filter(
      (name) => name !== 'constructor' && name !== 'clearCache',
    );
    expect([...own].sort()).toEqual([...PORT_METHODS].sort());
  });

  it('relies only on permissions the wizard grants, and on none of the forbidden ones', () => {
    const used = new Set(
      Object.values(GRAPH_METHOD_PERMISSIONS).flatMap((row) => [...row.permissions]),
    );
    for (const permission of used) expect(GRAPH_APP_ROLES).toContain(permission);
    for (const forbidden of [
      'RoleManagement.ReadWrite.Directory',
      'AppRoleAssignment.ReadWrite.All',
      'Application.ReadWrite.All',
      'Directory.Read.All',
    ]) {
      expect(used.has(forbidden as never)).toBe(false);
    }
  });

  it('names the Learn page of each call, and the UNVERIFIED items the group calls depend on', () => {
    for (const [method, row] of Object.entries(GRAPH_METHOD_PERMISSIONS)) {
      expect(row.page, method).toMatch(/^https:\/\/learn\.microsoft\.com\/graph\/api\//);
    }
    expect(GRAPH_METHOD_PERMISSIONS.getGroup.unverified).toContain('U36');
    expect(GRAPH_METHOD_PERMISSIONS.searchGroups.unverified).toEqual(
      expect.arrayContaining(['U36', 'U37']),
    );
    expect(GRAPH_METHOD_PERMISSIONS.checkMemberGroups.page).toContain(
      'directoryobject-checkmembergroups',
    );
    // The form the product does not use lists Directory.Read.All; the row must not.
    expect(GRAPH_METHOD_PERMISSIONS.checkMemberGroups.permissions).toEqual([
      'User.Read.All',
      'GroupMember.Read.All',
    ]);
  });

  it('has the six Phase C rows: the pages, the permissions, the UNVERIFIED items (FR-C-105)', () => {
    const rows = GRAPH_METHOD_PERMISSIONS;
    expect(rows.listUsers.permissions).toEqual(['User.Read.All']);
    expect(rows.getUserManager.permissions).toEqual(['User.Read.All']);
    expect(rows.getUserManager.unverified).toContain('U66');
    // transitiveMemberOf works with User.Read.All; memberOf would need Directory.Read.All (R-C-08).
    expect(rows.listUserGroups.permissions).toEqual(['User.Read.All']);
    expect(rows.listUserGroups.page).toContain('user-list-transitivememberof');
    expect(rows.listGroups.permissions).toEqual(['GroupMember.Read.All']);
    expect(rows.listGroupMembers.permissions).toEqual(['GroupMember.Read.All']);
    expect(rows.listGroupMembers.unverified).toEqual(expect.arrayContaining(['U67', 'U71']));
    expect(rows.listGroupOwners.permissions).toEqual(['GroupMember.Read.All']);
    expect(rows.listGroupOwners.unverified).toContain('U68');
  });

  it('uses no write role: GroupMember.ReadWrite.All is granted and appears in no row (FR-C-105, ODB-02)', () => {
    const used = Object.values(GRAPH_METHOD_PERMISSIONS).flatMap((row) => [...row.permissions]);
    expect(used).not.toContain('GroupMember.ReadWrite.All');
    for (const permission of used) expect(permission).not.toMatch(/ReadWrite|Write/);
    // The negative: a row that names the write role fails the same rule.
    const rule = (permissions: readonly string[]): void => {
      if (permissions.some((permission) => /ReadWrite|Write/.test(permission))) {
        throw new Error('a write role is used');
      }
    };
    expectGuardFails(rule, ['User.Read.All', 'GroupMember.ReadWrite.All'], {
      reason: 'a write role is used',
    });
  });

  it('negative: a map with a missing row, a foreign permission, an empty set or a wrong page fails the check', () => {
    const good = GRAPH_METHOD_PERMISSIONS as unknown as Record<string, GraphMethodPermissions>;
    const without = { ...good };
    delete without.getUser;
    expectGuardFails(
      () => {
        checkMap(without, PORT_METHODS);
      },
      undefined,
      { name: 'missing row', reason: 'no row for getUser' },
    );
    const foreign = {
      ...good,
      getUser: { ...good.getUser, permissions: ['Directory.Read.All'] },
    } as unknown as Record<string, GraphMethodPermissions>;
    expectGuardFails(
      () => {
        checkMap(foreign, PORT_METHODS);
      },
      undefined,
      { name: 'foreign permission', reason: 'not in GRAPH_APP_ROLES' },
    );
    const empty = { ...good, getUser: { ...good.getUser, permissions: [] } } as unknown as Record<
      string,
      GraphMethodPermissions
    >;
    expectGuardFails(
      () => {
        checkMap(empty, PORT_METHODS);
      },
      undefined,
      { name: 'empty set', reason: 'no permission named' },
    );
    const page = {
      ...good,
      getUser: { ...good.getUser, page: 'https://example.com/docs' },
    } as unknown as Record<string, GraphMethodPermissions>;
    expectGuardFails(
      () => {
        checkMap(page, PORT_METHODS);
      },
      undefined,
      { name: 'wrong page', reason: 'not a Graph API page' },
    );
    expectGuardFails(
      () => {
        checkMap(good, [...PORT_METHODS.slice(1)]);
      },
      undefined,
      { name: 'extra row', reason: 'is not a method of the client' },
    );
  });
});

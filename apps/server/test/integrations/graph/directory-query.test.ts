// T-C-012, FR-C-102, FR-C-202, FR-C-301, EC-C2: the directory queries as exact strings, for every
// enum value, with injection canaries and the length limit; and no other file builds a directory
// `$filter`.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIMITS } from '@m365portal/shared/limits';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import {
  assertSelect,
  groupsQuery,
  managerQuery,
  membersQuery,
  ownersQuery,
  userGroupsQuery,
  usersQuery,
} from '../../../src/integrations/graph/directory-query.js';
import { buildQuery } from '../../../src/integrations/http/url-guard.js';
import { GraphBadRequestError } from '../../../src/ports/errors.js';
import type { GroupListParams, UserListParams } from '../../../src/ports/graph.js';

const GROUP = '3f2c1a9e-0b5d-4c61-8a77-5d9a2b7c4e10';
const USER_SELECT_LIST =
  'id,displayName,userPrincipalName,mail,department,jobTitle,accountEnabled,userType';
const GROUP_SELECT_LIST =
  'id,displayName,mail,mailNickname,groupTypes,mailEnabled,securityEnabled,visibility';
const REF = 'id,displayName,mail,userPrincipalName,department,mailNickname';

const users = (extra: Partial<UserListParams> = {}): UserListParams => ({
  enabled: 'all',
  type: 'all',
  order: 'asc',
  top: 100,
  ...extra,
});
const groups = (extra: Partial<GroupListParams> = {}): GroupListParams => ({
  kind: 'all',
  order: 'asc',
  top: 100,
  ...extra,
});

describe('usersQuery (FR-C-202)', () => {
  it('sends the select, the order, the top and the advanced pair, and no filter without input', () => {
    const query = usersQuery(users());
    expect(query).toEqual({
      route: 'users.list',
      path: '/users',
      query: {
        $orderby: 'displayName asc',
        $select: USER_SELECT_LIST,
        $top: '100',
        $count: 'true',
      },
      consistencyLevelEventual: true,
    });
    expect(Object.keys(query.query)).not.toContain('$filter');
    expect(Object.keys(query.query)).not.toContain('$skip');
  });

  it.each([
    ['all', undefined],
    ['true', 'accountEnabled eq true'],
    ['false', 'accountEnabled eq false'],
  ] as const)('enabled %s', (enabled, filter) => {
    expect(usersQuery(users({ enabled })).query.$filter).toBe(filter);
  });

  it.each([
    ['all', undefined],
    ['member', "userType eq 'Member'"],
    ['guest', "userType eq 'Guest'"],
  ] as const)('type %s', (type, filter) => {
    expect(usersQuery(users({ type })).query.$filter).toBe(filter);
  });

  it.each([
    ['asc', 'displayName asc'],
    ['desc', 'displayName desc'],
  ] as const)('order %s', (order, orderby) => {
    expect(usersQuery(users({ order })).query.$orderby).toBe(orderby);
  });

  it('joins the search and the filters with and, the search first', () => {
    expect(usersQuery(users({ q: 'ann', enabled: 'false', type: 'guest' })).query.$filter).toBe(
      "(startsWith(displayName,'ann') or startsWith(mail,'ann') or startsWith(userPrincipalName,'ann')) and accountEnabled eq false and userType eq 'Guest'",
    );
  });

  it('leaves the user principal name out of the search for an actor who sees basic rows only', () => {
    expect(usersQuery(users({ q: 'ann', searchPrincipalName: false })).query.$filter).toBe(
      "(startsWith(displayName,'ann') or startsWith(mail,'ann'))",
    );
  });

  it('doubles the quote of the search text (EC-C2) and encodes it once on the wire', () => {
    const query = usersQuery(users({ q: "O'Neil" }));
    expect(query.query.$filter).toBe(
      "(startsWith(displayName,'O''Neil') or startsWith(mail,'O''Neil') or startsWith(userPrincipalName,'O''Neil'))",
    );
    expect(buildQuery(query.query)).toContain(
      "$filter=(startsWith(displayName%2C'O''Neil')%20or%20",
    );
  });

  it.each([
    ["'", "''"],
    ["''", "''''"],
    ["') or 1 eq 1 or ('", "'') or 1 eq 1 or (''"],
    ['%27', '%27'],
    [')', ')'],
    [' or ', ' or '],
    ['a\\b', 'a\\b'],
    ['é"x', 'é"x'],
  ])('keeps the canary %j inside the literal', (text, doubled) => {
    const filter = usersQuery(users({ q: text })).query.$filter ?? '';
    // The literal appears three times, each wrapped in quotes, with every quote of the text doubled.
    expect(filter).toBe(
      `(startsWith(displayName,'${doubled}') or startsWith(mail,'${doubled}') or startsWith(userPrincipalName,'${doubled}'))`,
    );
  });

  it('refuses control characters, a lone surrogate, the empty text and one over the limit', () => {
    const limit = LIMITS.directory.searchMaxChars;
    for (const q of [
      'a\nb',
      'a\u0000b',
      'a\u007fb',
      '\ud800',
      '',
      'x'.repeat(limit + 1),
      'x'.repeat(10_240),
    ]) {
      expect(() => usersQuery(users({ q })), JSON.stringify(q).slice(0, 20)).toThrow(
        GraphBadRequestError,
      );
    }
    expect(() => usersQuery(users({ q: 'x'.repeat(limit) }))).not.toThrow();
    expect(() => usersQuery(users({ q: '😀'.repeat(limit) }))).not.toThrow();
  });

  it('refuses a top outside 1 to 999 and a value outside the closed enums', () => {
    for (const top of [0, -1, 1000, 1.5, Number.NaN]) {
      expect(() => usersQuery(users({ top }))).toThrow(GraphBadRequestError);
    }
    expect(usersQuery(users({ top: 999 })).query.$top).toBe('999');
    expect(() => usersQuery(users({ enabled: "x' or 1 eq 1" as never }))).toThrow(
      GraphBadRequestError,
    );
    expect(() => usersQuery(users({ type: 'constructor' as never }))).toThrow(GraphBadRequestError);
    expect(() => usersQuery(users({ order: 'asc; drop' as never }))).toThrow(GraphBadRequestError);
  });
});

describe('groupsQuery (FR-C-301)', () => {
  it('sends the select, the order, the top and the advanced pair', () => {
    expect(groupsQuery(groups())).toEqual({
      route: 'groups.list',
      path: '/groups',
      query: {
        $orderby: 'displayName asc',
        $select: GROUP_SELECT_LIST,
        $top: '100',
        $count: 'true',
      },
      consistencyLevelEventual: true,
    });
  });

  it.each([
    ['all', undefined],
    ['m365', "groupTypes/any(c:c eq 'Unified')"],
    ['security', 'mailEnabled eq false and securityEnabled eq true'],
    [
      'mailsecurity',
      "not groupTypes/any(c:c eq 'Unified') and mailEnabled eq true and securityEnabled eq true",
    ],
    [
      'distribution',
      "not groupTypes/any(c:c eq 'Unified') and mailEnabled eq true and securityEnabled eq false",
    ],
  ] as const)('kind %s', (kind, filter) => {
    expect(groupsQuery(groups({ kind })).query.$filter).toBe(filter);
  });

  it('searches display name, mail and mail nickname, and joins the kind with and', () => {
    expect(groupsQuery(groups({ q: "d'a", kind: 'security', order: 'desc' })).query).toMatchObject({
      $filter:
        "(startsWith(displayName,'d''a') or startsWith(mail,'d''a') or startsWith(mailNickname,'d''a')) and mailEnabled eq false and securityEnabled eq true",
      $orderby: 'displayName desc',
    });
  });

  it('refuses a kind outside the closed enum and a long or control search text', () => {
    expect(() => groupsQuery(groups({ kind: "m365' or true" as never }))).toThrow(
      GraphBadRequestError,
    );
    expect(() => groupsQuery(groups({ q: 'x'.repeat(65) }))).toThrow(GraphBadRequestError);
    expect(() => groupsQuery(groups({ q: 'a\tb' }))).toThrow(GraphBadRequestError);
  });
});

describe('members, owners, the groups of a user and the manager', () => {
  it('lists members and owners with the select, the top and the advanced pair', () => {
    expect(membersQuery(GROUP.toUpperCase(), 50)).toEqual({
      route: 'groups.members',
      path: `/groups/${GROUP}/members`,
      query: { $select: REF, $top: '50', $count: 'true' },
      consistencyLevelEventual: true,
    });
    expect(ownersQuery(GROUP, 50)).toEqual({
      route: 'groups.owners',
      path: `/groups/${GROUP}/owners`,
      query: { $select: REF, $top: '50', $count: 'true' },
      consistencyLevelEventual: true,
    });
  });

  it('lists the transitive groups of a user through the group cast', () => {
    expect(userGroupsQuery(GROUP, 999)).toEqual({
      route: 'users.groups',
      path: `/users/${GROUP}/transitiveMemberOf/microsoft.graph.group`,
      query: { $select: GROUP_SELECT_LIST, $top: '999', $count: 'true' },
      consistencyLevelEventual: true,
    });
  });

  it('reads the manager as a single object', () => {
    expect(managerQuery(GROUP)).toEqual({
      route: 'users.manager',
      path: `/users/${GROUP}/manager`,
      query: { $select: REF },
    });
  });

  it('refuses an id that is not a GUID, so nothing is sent', () => {
    for (const id of ['x', '../organization', `${GROUP}/members`, `${GROUP}?$top=1`, '']) {
      expect(() => membersQuery(id, 10)).toThrow(GraphBadRequestError);
      expect(() => ownersQuery(id, 10)).toThrow(GraphBadRequestError);
      expect(() => userGroupsQuery(id, 10)).toThrow(GraphBadRequestError);
      expect(() => managerQuery(id)).toThrow(GraphBadRequestError);
    }
    expect(() => membersQuery(GROUP, 1000)).toThrow(GraphBadRequestError);
  });
});

describe('assertSelect (FR-C-104, FR-C-207)', () => {
  it('accepts plain property names and refuses licence, sign-in and malformed lists', () => {
    expect(assertSelect('id,displayName')).toBe('id,displayName');
    for (const bad of ['id,assignedLicenses', 'id,signInActivity', 'id;displayName', 'id,', '']) {
      expect(() => assertSelect(bad), bad).toThrow(GraphBadRequestError);
    }
  });
});

const SRC = fileURLToPath(new URL('../../../src', import.meta.url));

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sources(join(directory, entry.name))
      : entry.name.endsWith('.ts')
        ? [join(directory, entry.name)]
        : [],
  );
}

/** Any fragment of the directory filter grammar outside the one builder. */
const FILTER_FRAGMENT =
  /accountEnabled eq|userType eq|groupTypes\/any|securityEnabled eq|mailEnabled eq|startsWith\((?:displayName|mail|userPrincipalName|mailNickname),/;

function filtersOutsideBuilder(files: Readonly<Record<string, string>>): string[] {
  return Object.entries(files)
    .filter(([path]) => path !== 'integrations/graph/directory-query.ts')
    .filter(([, text]) => FILTER_FRAGMENT.test(text))
    .map(([path]) => path);
}

describe('no other file builds a directory $filter (FR-C-102)', () => {
  const files = Object.fromEntries(
    sources(SRC).map((file) => [
      relative(SRC, file).replaceAll('\\', '/'),
      readFileSync(file, 'utf8'),
    ]),
  );

  it('finds the fragments in the builder and nowhere else', () => {
    expect(FILTER_FRAGMENT.test(files['integrations/graph/directory-query.ts'] ?? '')).toBe(true);
    expect(filtersOutsideBuilder(files)).toEqual([]);
  });

  it('negative: a service that builds a filter itself is found', () => {
    const scan = (text: string): void => {
      const found = filtersOutsideBuilder({ 'directory/users-service.ts': text });
      if (found.length > 0) throw new Error(`a filter is built in ${found.join(', ')}`);
    };
    expectGuardFails(scan, 'const f = `accountEnabled eq ${enabled}`;', {
      reason: 'a filter is built',
    });
    expectGuardFails(scan, 'const f = "groupTypes/any(c:c eq \'Unified\')";', {
      reason: 'a filter is built',
    });
    expect(() => {
      scan('const f = usersQuery(params);');
    }).not.toThrow();
  });
});

// Handlers for the Phase C routes (P33 to P39), built from the shared wire schemas (T-C-040). The web
// tests never wait for the server: they plug these into the fetch of `createMockApi`-style tests and read
// exactly the shapes `packages/shared/src/schemas/directory.ts` freezes at gate GC0.
//
// Every success answer is parsed with the schema of its route before it is sent, so a fixture that does
// not fit the wire contract (a total, a licence field, a restricted row with a name) fails the handler
// and not, by luck, the page. The handlers also keep the rules the server keeps and the pages rely on:
// strict queries (422 `validation_failed`), opaque cursors bound to the query (400 `cursor_invalid` for an
// unknown, expired or foreign one), a user or group outside the actor's scope (403 `permission_denied`),
// an unknown id (404 `not_found`), a `basic` actor (no filters on state or type, basic rows only), and
// no members call for a group whose membership is hidden.
//
// The network stand-in here is a plain `fetch` function, like `helpers/mock-api.ts`: `msw` is not a
// dependency of the web package and this phase adds none.
import {
  DirectoryPageQuerySchema,
  GroupDetailSchema,
  GroupIdParamsSchema,
  GroupListQuerySchema,
  GroupListResponseSchema,
  MembersResponseSchema,
  OwnersResponseSchema,
  UserDetailSchema,
  UserGroupsResponseSchema,
  UserIdParamsSchema,
  UserListQuerySchema,
  UserListResponseSchema,
  type DirectoryRow,
  type GroupDetail,
  type GroupListItem,
  type ManagerState,
  type UserDetail,
} from '@m365portal/shared/schemas/directory';
import { PAGE_LIMIT_DEFAULT } from '@m365portal/shared/schemas/common';
import type { FetchFunction } from '../../src/lib/api';
import { json, problem, type Call } from '../helpers/mock-api';

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

/** A GUID from a number: lower case, the shape `GuidSchema` demands. */
export function guid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

/** The full detail of a user: `UserDetail` without the basic variant. */
export type FullUser = Extract<UserDetail, { userPrincipalName: string | null }>;

export function makeUser(n: number, overrides: Partial<FullUser> = {}): FullUser {
  const name = `User ${String(n).padStart(4, '0')}`;
  return {
    id: guid(1000 + n),
    displayName: name,
    givenName: 'User',
    surname: String(n).padStart(4, '0'),
    userPrincipalName: `user${String(n)}@example.test`,
    mail: `user${String(n)}@example.test`,
    department: n % 2 === 0 ? 'Finance' : 'Sales',
    jobTitle: 'Advisor',
    officeLocation: 'Utrecht',
    accountEnabled: true,
    userType: 'member',
    onPremisesSyncEnabled: false,
    createdDateTime: '2024-03-05T09:30:15.123Z',
    manager: { state: 'none' },
    ...overrides,
  };
}

export interface GroupRecord {
  readonly detail: GroupDetail;
  readonly owners: readonly DirectoryRow[];
  readonly ownersState: 'listed' | 'not_available';
  readonly members: readonly DirectoryRow[];
  readonly membersState: 'listed' | 'hidden';
}

export function makeGroup(n: number, overrides: Partial<GroupDetail> = {}): GroupDetail {
  return {
    id: guid(2000 + n),
    displayName: `Group ${String(n).padStart(4, '0')}`,
    description: 'A group for tests',
    mail: `group${String(n)}@example.test`,
    mailNickname: `group${String(n)}`,
    kind: 'm365',
    visibility: 'Private',
    membershipType: 'assigned',
    onPremisesSyncEnabled: false,
    createdDateTime: '2023-11-20T14:00:00.000Z',
    ...overrides,
  };
}

export function groupRecord(
  detail: GroupDetail,
  parts: Partial<Omit<GroupRecord, 'detail'>> = {},
): GroupRecord {
  return {
    detail,
    owners: [],
    ownersState: 'listed',
    members: [],
    membersState: 'listed',
    ...parts,
  };
}

/** A member row of kind `user` for user number `n`. */
export function userRow(n: number): DirectoryRow {
  return {
    kind: 'user',
    id: guid(1000 + n),
    displayName: `User ${String(n).padStart(4, '0')}`,
    mail: `user${String(n)}@example.test`,
    userPrincipalName: `user${String(n)}@example.test`,
  };
}

export function restrictedRow(kind: 'user' | 'group' | 'other' = 'user'): DirectoryRow {
  return { kind, restricted: true };
}

// ---------------------------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------------------------

export interface DirectoryWorld {
  users: FullUser[];
  groups: GroupRecord[];
  /** Group ids per user id (P35). */
  userGroups: Record<string, string[]>;
  /** What the actor holds: `basic` makes every user a basic row and refuses the filters. */
  usersQualifier: 'full' | 'basic';
  /** Without `groups:read` P35 answers 403. */
  groupsRead: boolean;
  /** Users and groups outside the actor's scope: absent from lists, 403 by id. */
  outsideUserIds: Set<string>;
  outsideGroupIds: Set<string>;
}

export function emptyWorld(): DirectoryWorld {
  return {
    users: [],
    groups: [],
    userGroups: {},
    usersQualifier: 'full',
    groupsRead: true,
    outsideUserIds: new Set(),
    outsideGroupIds: new Set(),
  };
}

/** A world with `userCount` users and `groupCount` groups, all assigned Microsoft 365 groups. */
export function seedWorld(userCount = 120, groupCount = 30): DirectoryWorld {
  const world = emptyWorld();
  for (let n = 1; n <= userCount; n += 1) world.users.push(makeUser(n));
  for (let n = 1; n <= groupCount; n += 1) {
    world.groups.push(groupRecord(makeGroup(n), { owners: [userRow(1)], members: [userRow(2)] }));
  }
  return world;
}

// ---------------------------------------------------------------------------------------------
// The handlers
// ---------------------------------------------------------------------------------------------

export const ROUTE_IDS = [
  'users.list',
  'users.get',
  'users.groups',
  'groups.list',
  'groups.get',
  'groups.owners',
  'groups.members',
] as const;
export type RouteId = (typeof ROUTE_IDS)[number];

const ROUTE_PATTERNS: readonly (readonly [RouteId, RegExp])[] = [
  ['users.list', /^\/api\/v1\/users$/],
  ['users.get', /^\/api\/v1\/users\/([^/]+)$/],
  ['users.groups', /^\/api\/v1\/users\/([^/]+)\/groups$/],
  ['groups.list', /^\/api\/v1\/groups$/],
  ['groups.get', /^\/api\/v1\/groups\/([^/]+)$/],
  ['groups.owners', /^\/api\/v1\/groups\/([^/]+)\/owners$/],
  ['groups.members', /^\/api\/v1\/groups\/([^/]+)\/members$/],
];

interface Parser<T> {
  parse(value: unknown): T;
}

/** A success answer: parsed with the schema of the route first, so a fixture off the contract throws. */
function ok<T>(schema: Parser<T>, body: unknown): Response {
  return json(200, schema.parse(body));
}

const validationFailed = () => problem(422, 'validation_failed');

/** A handler may take over a route: return a `Response`, or `undefined` to let the default answer. */
export type RouteOverride = (call: Call) => Response | Promise<Response | undefined> | undefined;

export interface DirectoryApi {
  readonly fetch: FetchFunction;
  readonly world: DirectoryWorld;
  readonly calls: Call[];
  /** The calls to one route. */
  readonly callsTo: (route: RouteId) => Call[];
  /** Take over a route (an error, a slow answer); `null` removes the override. */
  readonly override: (route: RouteId, handler: RouteOverride | null) => void;
  /** Forget every cursor handed out: the next use of one is `cursor_invalid`. */
  readonly expireCursors: () => void;
  /** The answer for a path that is not one of the seven routes (`/api/v1/me/access`, say). */
  readonly extra: (path: string, handler: (call: Call) => unknown) => void;
}

interface CursorState {
  readonly signature: string;
  readonly offset: number;
}

const startsWithFold = (value: string | null, prefix: string): boolean =>
  value?.toLowerCase().startsWith(prefix.toLowerCase()) === true;

export function createDirectoryApi(world: DirectoryWorld = seedWorld()): DirectoryApi {
  const calls: Call[] = [];
  const overrides = new Map<RouteId, RouteOverride>();
  const extras = new Map<string, (call: Call) => unknown>();
  let cursors = new Map<string, CursorState>();
  let counter = 0;

  /** One page of `items`: the cursor must belong to this route and query, else `cursor_invalid`. */
  function page<T>(
    route: RouteId,
    signature: string,
    items: readonly T[],
    query: { limit?: string | undefined; cursor?: string | undefined },
  ): { items: T[]; nextCursor?: string } | Response {
    const limit = query.limit === undefined ? PAGE_LIMIT_DEFAULT : Number(query.limit);
    let offset = 0;
    if (query.cursor !== undefined) {
      const state = cursors.get(query.cursor);
      if (state?.signature !== `${route}|${signature}`) return problem(400, 'cursor_invalid');
      offset = state.offset;
    }
    const slice = items.slice(offset, offset + limit);
    const next = offset + limit;
    if (next >= items.length) return { items: slice };
    counter += 1;
    const handle = `cur${String(counter)}_${String(Math.abs(Array.from(signature).reduce((a, c) => a * 31 + c.charCodeAt(0), 7) % 99999))}`;
    cursors.set(handle, { signature: `${route}|${signature}`, offset: next });
    return { items: slice, nextCursor: handle };
  }

  const basicOf = (user: FullUser) => ({
    id: user.id,
    displayName: user.displayName,
    mail: user.mail,
  });
  const listItemOf = (user: FullUser) => ({
    id: user.id,
    displayName: user.displayName,
    userPrincipalName: user.userPrincipalName,
    mail: user.mail,
    department: user.department,
    jobTitle: user.jobTitle,
    accountEnabled: user.accountEnabled,
    userType: user.userType,
  });
  const groupItemOf = (group: GroupDetail): GroupListItem => ({
    id: group.id,
    displayName: group.displayName,
    mail: group.mail,
    kind: group.kind,
    visibility: group.visibility,
  });
  const byName = <T extends { displayName: string | null }>(items: T[], order: 'asc' | 'desc') =>
    [...items].sort((a, b) => {
      const compare = (a.displayName ?? '').localeCompare(b.displayName ?? '');
      return order === 'asc' ? compare : -compare;
    });

  function usersList(call: Call): Response {
    const query = UserListQuerySchema.safeParse(Object.fromEntries(call.query));
    if (!query.success) return validationFailed();
    const { q, enabled, type, order, limit, cursor } = query.data;
    if (world.usersQualifier === 'basic' && (enabled !== 'all' || type !== 'all')) {
      return validationFailed();
    }
    const matching = world.users.filter(
      (user) =>
        !world.outsideUserIds.has(user.id) &&
        (q === undefined ||
          startsWithFold(user.displayName, q) ||
          startsWithFold(user.mail, q) ||
          startsWithFold(user.userPrincipalName, q)) &&
        (enabled === 'all' || user.accountEnabled === (enabled === 'true')) &&
        (type === 'all' || user.userType === type),
    );
    const sorted = byName(matching, order);
    const result = page('users.list', `${q ?? ''}|${enabled}|${type}|${order}`, sorted, {
      limit,
      cursor,
    });
    if (result instanceof Response) return result;
    return ok(UserListResponseSchema, {
      ...result,
      items: result.items.map((user) =>
        world.usersQualifier === 'basic' ? basicOf(user) : listItemOf(user),
      ),
    });
  }

  function findUser(id: string): FullUser | Response {
    if (!UserIdParamsSchema.safeParse({ id }).success) return validationFailed();
    const user = world.users.find((candidate) => candidate.id === id);
    if (user === undefined) return problem(404, 'not_found');
    if (world.outsideUserIds.has(id)) return problem(403, 'permission_denied');
    return user;
  }

  function usersGet(id: string): Response {
    const user = findUser(id);
    if (user instanceof Response) return user;
    return ok(UserDetailSchema, world.usersQualifier === 'basic' ? basicOf(user) : user);
  }

  function usersGroups(id: string, call: Call): Response {
    const user = findUser(id);
    if (user instanceof Response) return user;
    if (!world.groupsRead) return problem(403, 'permission_denied');
    const query = DirectoryPageQuerySchema.safeParse(Object.fromEntries(call.query));
    if (!query.success) return validationFailed();
    const groups = (world.userGroups[id] ?? [])
      .map((groupId) => world.groups.find((group) => group.detail.id === groupId))
      .filter(
        (group): group is GroupRecord =>
          group !== undefined && !world.outsideGroupIds.has(group.detail.id),
      )
      .map((group) => groupItemOf(group.detail));
    const result = page('users.groups', id, groups, query.data);
    if (result instanceof Response) return result;
    return ok(UserGroupsResponseSchema, result);
  }

  function groupsList(call: Call): Response {
    const query = GroupListQuerySchema.safeParse(Object.fromEntries(call.query));
    if (!query.success) return validationFailed();
    const { q, kind, order, limit, cursor } = query.data;
    const matching = world.groups
      .map((group) => group.detail)
      .filter(
        (group) =>
          !world.outsideGroupIds.has(group.id) &&
          (q === undefined ||
            startsWithFold(group.displayName, q) ||
            startsWithFold(group.mail, q) ||
            startsWithFold(group.mailNickname, q)) &&
          (kind === 'all' || group.kind === kind),
      );
    const result = page('groups.list', `${q ?? ''}|${kind}|${order}`, byName(matching, order), {
      limit,
      cursor,
    });
    if (result instanceof Response) return result;
    return ok(GroupListResponseSchema, { ...result, items: result.items.map(groupItemOf) });
  }

  function findGroup(id: string): GroupRecord | Response {
    if (!GroupIdParamsSchema.safeParse({ id }).success) return validationFailed();
    const group = world.groups.find((candidate) => candidate.detail.id === id);
    if (group === undefined) return problem(404, 'not_found');
    if (world.outsideGroupIds.has(id)) return problem(403, 'permission_denied');
    return group;
  }

  function groupsGet(id: string): Response {
    const group = findGroup(id);
    if (group instanceof Response) return group;
    return ok(GroupDetailSchema, group.detail);
  }

  function groupsSub(route: 'groups.owners' | 'groups.members', id: string, call: Call): Response {
    const group = findGroup(id);
    if (group instanceof Response) return group;
    const query = DirectoryPageQuerySchema.safeParse(Object.fromEntries(call.query));
    if (!query.success) return validationFailed();
    if (route === 'groups.owners') {
      if (group.ownersState === 'not_available') {
        return ok(OwnersResponseSchema, { items: [], ownersState: 'not_available' });
      }
      const result = page(route, id, group.owners, query.data);
      if (result instanceof Response) return result;
      return ok(OwnersResponseSchema, { ...result, ownersState: 'listed' });
    }
    if (group.membersState === 'hidden') {
      return ok(MembersResponseSchema, { items: [], membersState: 'hidden' });
    }
    const result = page(route, id, group.members, query.data);
    if (result instanceof Response) return result;
    return ok(MembersResponseSchema, { ...result, membersState: 'listed' });
  }

  async function answer(call: Call): Promise<Response> {
    for (const [route, pattern] of ROUTE_PATTERNS) {
      const match = pattern.exec(call.path);
      if (match === null) continue;
      const taken = await overrides.get(route)?.(call);
      if (taken !== undefined) return taken;
      const id = match[1] ?? '';
      switch (route) {
        case 'users.list':
          return usersList(call);
        case 'users.get':
          return usersGet(id);
        case 'users.groups':
          return usersGroups(id, call);
        case 'groups.list':
          return groupsList(call);
        case 'groups.get':
          return groupsGet(id);
        case 'groups.owners':
        case 'groups.members':
          return groupsSub(route, id, call);
      }
    }
    const extra = extras.get(call.path);
    if (extra !== undefined) {
      const body = extra(call);
      return body instanceof Response ? body : json(200, body);
    }
    return problem(404, 'not_found');
  }

  const network: FetchFunction = async (input, init) => {
    const url = new URL(input, 'http://panel.test');
    const method = (init?.method ?? 'GET').toUpperCase();
    const call: Call = { method, path: url.pathname, query: url.searchParams, body: undefined };
    calls.push(call);
    if (method !== 'GET') return problem(405, 'method_not_allowed');
    return answer(call);
  };

  return {
    fetch: network,
    world,
    calls,
    callsTo: (route) => {
      const pattern = ROUTE_PATTERNS.find(([id]) => id === route)?.[1];
      return calls.filter((call) => pattern?.test(call.path) === true);
    },
    override: (route, handler) => {
      if (handler === null) overrides.delete(route);
      else overrides.set(route, handler);
    },
    expireCursors: () => {
      cursors = new Map();
    },
    extra: (path, handler) => {
      extras.set(path, handler);
    },
  };
}

/** A manager state for a user fixture. */
export function presentManager(n: number): ManagerState {
  return { state: 'present', user: userRow(n) };
}

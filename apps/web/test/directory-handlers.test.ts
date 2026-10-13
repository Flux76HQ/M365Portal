// THE MSW-STYLE HANDLERS OF THE DIRECTORY ROUTES (T-C-040). Every answer parses with the shared wire schema
// of its route, the rules the pages rely on hold (strict queries, opaque cursors, scope, hidden
// membership), and a fixture that breaks the contract fails the handler (+ negative).
import {
  GroupDetailSchema,
  GroupListResponseSchema,
  MembersResponseSchema,
  OwnersResponseSchema,
  UserDetailSchema,
  UserGroupsResponseSchema,
  UserListResponseSchema,
  isRestrictedRow,
} from '@m365portal/shared/schemas/directory';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import {
  createDirectoryApi,
  emptyWorld,
  groupRecord,
  guid,
  makeGroup,
  makeUser,
  presentManager,
  restrictedRow,
  seedWorld,
  userRow,
  type DirectoryApi,
} from './support/directory-handlers';

async function get(api: DirectoryApi, path: string): Promise<{ status: number; body: unknown }> {
  const response = await api.fetch(path, { method: 'GET' });
  const text = await response.text();
  return { status: response.status, body: text === '' ? undefined : (JSON.parse(text) as unknown) };
}

describe('the success answers fit the wire schemas', () => {
  it('lists users in display-name order, 50 at a time, with a cursor and no total', async () => {
    const api = createDirectoryApi(seedWorld(120, 5));
    const first = await get(api, '/api/v1/users?limit=50');
    expect(first.status).toBe(200);
    const parsed = UserListResponseSchema.parse(first.body);
    expect(parsed.items).toHaveLength(50);
    expect(parsed.nextCursor).toBeDefined();
    expect(Object.keys(first.body as object).sort()).toEqual(['items', 'nextCursor']);
    const names = parsed.items.map((item) => item.displayName);
    expect(names).toEqual([...names].sort());
  });

  it('pages through every user once with the cursors', async () => {
    const api = createDirectoryApi(seedWorld(120, 5));
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const query = cursor === undefined ? '?limit=50' : `?limit=50&cursor=${cursor}`;
      const { body } = await get(api, `/api/v1/users${query}`);
      const parsed = UserListResponseSchema.parse(body);
      seen.push(...parsed.items.map((item) => item.id));
      cursor = parsed.nextCursor;
    } while (cursor !== undefined);
    expect(seen).toHaveLength(120);
    expect(new Set(seen).size).toBe(120);
  });

  it('filters by search, state and type, and orders both ways', async () => {
    const world = seedWorld(10, 3);
    world.users[3] = makeUser(4, { accountEnabled: false });
    world.users[4] = makeUser(5, { userType: 'guest' });
    const api = createDirectoryApi(world);
    const search = UserListResponseSchema.parse((await get(api, '/api/v1/users?q=user 0002')).body);
    expect(search.items.map((item) => item.displayName)).toEqual(['User 0002']);
    const disabled = UserListResponseSchema.parse(
      (await get(api, '/api/v1/users?enabled=false')).body,
    );
    expect(disabled.items.map((item) => item.displayName)).toEqual(['User 0004']);
    const guests = UserListResponseSchema.parse((await get(api, '/api/v1/users?type=guest')).body);
    expect(guests.items.map((item) => item.displayName)).toEqual(['User 0005']);
    const descending = UserListResponseSchema.parse(
      (await get(api, '/api/v1/users?order=desc')).body,
    );
    expect(descending.items[0]?.displayName).toBe('User 0010');
  });

  it('answers a user detail with each manager state', async () => {
    const world = emptyWorld();
    world.users.push(
      makeUser(1, { manager: presentManager(2) }),
      makeUser(2, { manager: { state: 'unavailable' } }),
      makeUser(3, { manager: { state: 'present', user: restrictedRow('user') } }),
      makeUser(4),
    );
    const api = createDirectoryApi(world);
    const states: string[] = [];
    for (const n of [1, 2, 3, 4]) {
      const detail = UserDetailSchema.parse(
        (await get(api, `/api/v1/users/${guid(1000 + n)}`)).body,
      );
      if ('manager' in detail) states.push(detail.manager.state);
    }
    expect(states).toEqual(['present', 'unavailable', 'present', 'none']);
  });

  it('answers the groups of a user, skipping a group outside the scope', async () => {
    const world = seedWorld(3, 3);
    world.userGroups[guid(1001)] = [guid(2001), guid(2002), guid(2003)];
    world.outsideGroupIds.add(guid(2002));
    const api = createDirectoryApi(world);
    const { body } = await get(api, `/api/v1/users/${guid(1001)}/groups`);
    expect(UserGroupsResponseSchema.parse(body).items.map((item) => item.id)).toEqual([
      guid(2001),
      guid(2003),
    ]);
  });

  it('lists groups with a kind filter and answers the group detail', async () => {
    const world = emptyWorld();
    world.groups.push(
      groupRecord(makeGroup(1, { kind: 'm365' })),
      groupRecord(makeGroup(2, { kind: 'security' })),
      groupRecord(makeGroup(3, { kind: 'distribution' })),
      groupRecord(makeGroup(4, { kind: 'mailsecurity' })),
    );
    const api = createDirectoryApi(world);
    const security = GroupListResponseSchema.parse(
      (await get(api, '/api/v1/groups?kind=security')).body,
    );
    expect(security.items.map((item) => item.kind)).toEqual(['security']);
    const detail = GroupDetailSchema.parse((await get(api, `/api/v1/groups/${guid(2003)}`)).body);
    expect(detail.kind).toBe('distribution');
  });

  it('pages 250 members, lists owners, and keeps restricted rows free of data', async () => {
    const world = emptyWorld();
    const members = Array.from({ length: 250 }, (_, index) => userRow(index + 1));
    members[1] = restrictedRow('user');
    world.groups.push(
      groupRecord(makeGroup(1), { members, owners: [userRow(1), restrictedRow('user')] }),
    );
    const api = createDirectoryApi(world);
    const id = guid(2001);
    const first = MembersResponseSchema.parse(
      (await get(api, `/api/v1/groups/${id}/members?limit=100`)).body,
    );
    expect(first.items).toHaveLength(100);
    const restricted = first.items.filter(isRestrictedRow);
    expect(restricted).toEqual([{ kind: 'user', restricted: true }]);
    const second = MembersResponseSchema.parse(
      (await get(api, `/api/v1/groups/${id}/members?limit=100&cursor=${first.nextCursor ?? ''}`))
        .body,
    );
    const third = MembersResponseSchema.parse(
      (await get(api, `/api/v1/groups/${id}/members?limit=100&cursor=${second.nextCursor ?? ''}`))
        .body,
    );
    expect(third.items).toHaveLength(50);
    expect(third.nextCursor).toBeUndefined();
    const owners = OwnersResponseSchema.parse((await get(api, `/api/v1/groups/${id}/owners`)).body);
    expect(owners.items).toHaveLength(2);
  });

  it('answers hidden membership and owners that are not available with empty lists', async () => {
    const world = emptyWorld();
    world.groups.push(
      groupRecord(makeGroup(1, { visibility: 'HiddenMembership' }), {
        membersState: 'hidden',
        ownersState: 'not_available',
      }),
    );
    const api = createDirectoryApi(world);
    const members = MembersResponseSchema.parse(
      (await get(api, `/api/v1/groups/${guid(2001)}/members`)).body,
    );
    expect(members).toEqual({ items: [], membersState: 'hidden' });
    const owners = OwnersResponseSchema.parse(
      (await get(api, `/api/v1/groups/${guid(2001)}/owners`)).body,
    );
    expect(owners).toEqual({ items: [], ownersState: 'not_available' });
  });
});

describe('the failure answers', () => {
  it('refuses an unknown query parameter, a long search and a bad id with 422 validation_failed', async () => {
    const api = createDirectoryApi(seedWorld(3, 3));
    expect((await get(api, '/api/v1/users?total=1')).status).toBe(422);
    expect((await get(api, `/api/v1/users?q=${'x'.repeat(65)}`)).status).toBe(422);
    expect((await get(api, '/api/v1/users/not-a-guid')).status).toBe(422);
    expect((await get(api, '/api/v1/groups?kind=licence')).status).toBe(422);
  });

  it('answers 404 not_found for an unknown id and 403 permission_denied outside the scope', async () => {
    const world = seedWorld(3, 3);
    world.outsideUserIds.add(guid(1002));
    world.outsideGroupIds.add(guid(2002));
    const api = createDirectoryApi(world);
    expect((await get(api, `/api/v1/users/${guid(9999)}`)).status).toBe(404);
    const denied = await get(api, `/api/v1/users/${guid(1002)}`);
    expect(denied.status).toBe(403);
    expect((denied.body as { code: string }).code).toBe('permission_denied');
    expect((await get(api, `/api/v1/groups/${guid(2002)}`)).status).toBe(403);
    expect((await get(api, `/api/v1/groups/${guid(2002)}/members`)).status).toBe(403);
    const list = UserListResponseSchema.parse((await get(api, '/api/v1/users')).body);
    expect(list.items.map((item) => item.id)).not.toContain(guid(1002));
  });

  it('answers 400 cursor_invalid for an unknown, expired or foreign cursor', async () => {
    const api = createDirectoryApi(seedWorld(120, 5));
    const first = UserListResponseSchema.parse((await get(api, '/api/v1/users?limit=50')).body);
    const cursor = first.nextCursor ?? '';
    const unknown = await get(api, '/api/v1/users?cursor=nope');
    expect(unknown.status).toBe(400);
    expect((unknown.body as { code: string }).code).toBe('cursor_invalid');
    const foreign = await get(api, `/api/v1/users?cursor=${cursor}&enabled=true`);
    expect((foreign.body as { code: string }).code).toBe('cursor_invalid');
    api.expireCursors();
    expect((await get(api, `/api/v1/users?limit=50&cursor=${cursor}`)).status).toBe(400);
  });

  it('serves a basic actor basic rows only and refuses the state and type filters', async () => {
    const world = seedWorld(3, 3);
    world.usersQualifier = 'basic';
    const api = createDirectoryApi(world);
    const list = UserListResponseSchema.parse((await get(api, '/api/v1/users')).body);
    for (const item of list.items)
      expect(Object.keys(item).sort()).toEqual(['displayName', 'id', 'mail']);
    expect((await get(api, '/api/v1/users?enabled=false')).status).toBe(422);
    const detail = UserDetailSchema.parse((await get(api, `/api/v1/users/${guid(1001)}`)).body);
    expect('manager' in detail).toBe(false);
  });

  it('refuses the groups of a user without groups:read, and any other method', async () => {
    const world = seedWorld(3, 3);
    world.groupsRead = false;
    const api = createDirectoryApi(world);
    expect((await get(api, `/api/v1/users/${guid(1001)}/groups`)).status).toBe(403);
    const response = await api.fetch('/api/v1/users', { method: 'POST' });
    expect(response.status).toBe(405);
  });

  it('lets a test take over one route with an error answer, and records every call', async () => {
    const api = createDirectoryApi(seedWorld(3, 3));
    api.override('groups.members', () => new Response(null, { status: 503 }));
    expect((await get(api, `/api/v1/groups/${guid(2001)}/members`)).status).toBe(503);
    api.override('groups.members', null);
    expect((await get(api, `/api/v1/groups/${guid(2001)}/members`)).status).toBe(200);
    expect(api.callsTo('groups.members')).toHaveLength(2);
    expect(api.calls).toHaveLength(2);
  });
});

describe('negative fixtures: a fixture off the contract fails the handler', () => {
  it('a user with a licence field is refused by the detail schema', async () => {
    const world = emptyWorld();
    world.users.push({ ...makeUser(1), assignedLicenses: [] } as never);
    const api = createDirectoryApi(world);
    await expectGuardFails(() => get(api, `/api/v1/users/${guid(1001)}`), undefined, {
      name: 'detail handler with a licence field',
    });
  });

  it('a restricted row that carries a name is refused', async () => {
    const world = emptyWorld();
    world.groups.push(
      groupRecord(makeGroup(1), {
        members: [{ kind: 'user', restricted: true, displayName: 'Leak' } as never],
      }),
    );
    const api = createDirectoryApi(world);
    await expectGuardFails(() => get(api, `/api/v1/groups/${guid(2001)}/members`), undefined, {
      name: 'members handler with a leaking restricted row',
    });
  });

  it('a hidden membership with members in the list is refused', () => {
    expect(() =>
      MembersResponseSchema.parse({
        items: [userRow(1)],
        membersState: 'hidden',
      }),
    ).toThrow();
  });
});

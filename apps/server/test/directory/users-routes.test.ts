// T-C-022, FR-C-201, FR-C-203 to FR-C-206, FR-C-107, EC-C1 to EC-C6, EC-C15, ODB-11, US-C1, US-C2,
// US-C4, US-C5: the users routes P33 to P35 on the real application and the seeded fake directory.
import {
  BasicUserSchema,
  UserDetailSchema,
  UserGroupsResponseSchema,
  UserListResponseSchema,
  type UserListItem,
} from '@m365portal/shared/schemas/directory';
import { describe, expect, it } from 'vitest';
import { GraphTransientError } from '../../src/ports/errors.js';
import {
  ALL_GROUPS,
  BASIC_USERS,
  DEPARTMENT_FINANCE,
  FULL_USERS,
  createDirectoryFixture,
  getJson,
  groupsScoped,
  usersScoped,
  walk,
  type Page,
  type ProblemBody,
} from './support.js';

const GUID = '3f2c1a9e-0b5d-4c61-8a77-5d9a2b7c4e10';

type Full = Extract<UserListItem, { userPrincipalName: string | null }>;
const names = (rows: readonly UserListItem[]): (string | null)[] =>
  rows.map((row) => row.displayName);

describe('GET /api/v1/users (P33): the list', () => {
  it('lists every user by display name, a page at a time, without a duplicate, a gap or a total', async () => {
    const f = await createDirectoryFixture();
    const me = f.actor(FULL_USERS);
    const first = await getJson(me.client, '/api/v1/users', { limit: '50' });
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toContain('no-store');
    const body = UserListResponseSchema.parse(first.body);
    expect(body.items).toHaveLength(50);
    expect(Object.keys(body).sort()).toEqual(['items', 'nextCursor']);
    expect(body.nextCursor).toMatch(/^[A-Za-z0-9_-]{24}$/);

    const all = await walk<UserListItem>(me.client, '/api/v1/users', { limit: '50' });
    expect(all.rows).toHaveLength(f.directory.users.size);
    expect(new Set(all.rows.map((row) => row.id)).size).toBe(all.rows.length);
    const sorted = [...all.rows].sort((a, b) =>
      (a.displayName ?? '').toLowerCase() < (b.displayName ?? '').toLowerCase() ? -1 : 1,
    );
    expect(names(all.rows)).toEqual(names(sorted));
    // Nothing is written, and a successful read is not audited (FR-B-602).
    expect(f.rows()).toEqual([]);
  });

  it('orders descending and filters on search, state and type', async () => {
    const f = await createDirectoryFixture();
    const me = f.actor(FULL_USERS);
    const desc = await walk<Full>(me.client, '/api/v1/users', { order: 'desc', limit: '200' });
    const asc = await walk<Full>(me.client, '/api/v1/users', { order: 'asc', limit: '200' });
    expect(names(desc.rows)).toEqual([...names(asc.rows)].reverse());

    const disabled = await walk<Full>(me.client, '/api/v1/users', { enabled: 'false' });
    expect(disabled.rows.length).toBeGreaterThan(5);
    expect(disabled.rows.every((row) => row.accountEnabled === false)).toBe(true);
    const guests = await walk<Full>(me.client, '/api/v1/users', { type: 'guest' });
    expect(guests.rows.length).toBeGreaterThan(3);
    expect(guests.rows.every((row) => row.userType === 'guest')).toBe(true);
    const both = await walk<Full>(me.client, '/api/v1/users', { type: 'member', enabled: 'true' });
    expect(both.rows.every((row) => row.userType === 'member' && row.accountEnabled === true)).toBe(
      true,
    );

    const found = await walk<Full>(me.client, '/api/v1/users', { q: 'ZO' });
    expect(found.rows.map((row) => row.id)).toContain(f.seeded.ids.quoteUser);
    for (const row of found.rows) {
      const hits = [row.displayName, row.mail, row.userPrincipalName].map((v) =>
        v?.toLowerCase().startsWith('zo'),
      );
      expect(hits.some(Boolean), row.id).toBe(true);
    }
    const quote = await walk<Full>(me.client, '/api/v1/users', { q: "Zoë O'Neil" });
    expect(quote.rows.map((row) => row.id)).toEqual([f.seeded.ids.quoteUser]);
  });

  it('answers EC-C1 with 422 validation_failed before any Graph call', async () => {
    const f = await createDirectoryFixture();
    const me = f.actor(FULL_USERS);
    await f.settle();
    for (const q of ['x'.repeat(65), 'a\nb', 'a\u0000b', '']) {
      const answer = await getJson<ProblemBody>(me.client, '/api/v1/users', { q });
      expect(answer.status, JSON.stringify(q).slice(0, 12)).toBe(422);
      expect(answer.body.code).toBe('validation_failed');
      expect(answer.body.errors?.[0]?.pointer).toBe('query/q');
    }
    for (const query of [
      { limit: '0' },
      { limit: '201' },
      { enabled: 'maybe' },
      { type: 'x' },
      { order: 'up' },
      { extra: '1' },
    ]) {
      expect((await getJson(me.client, '/api/v1/users', query)).status, JSON.stringify(query)).toBe(
        422,
      );
    }
    expect(f.fake.callsTo('listUsers')).toHaveLength(0);
  });

  it('is 401 without a session and 403 without users:read, and the denial is audited', async () => {
    const f = await createDirectoryFixture();
    expect((await getJson(f.anonymous(), '/api/v1/users')).status).toBe(401);
    const nobody = f.actor(ALL_GROUPS);
    const answer = await getJson<ProblemBody>(nobody.client, '/api/v1/users');
    expect(answer.status).toBe(403);
    expect(answer.body.code).toBe('permission_denied');
    expect(f.rows().map((row) => [row.action, row.outcome, row.reason_code])).toEqual([
      ['users.list', 'denied', 'permission_missing'],
    ]);
    expect(f.fake.callsTo('listUsers')).toHaveLength(0);
  });
});

describe('the cursor (FR-C-103, EC-C3)', () => {
  it('is 400 cursor_invalid for an unknown handle, another actor, another filter, another list and an expired one', async () => {
    const f = await createDirectoryFixture();
    const me = f.actor(FULL_USERS, ALL_GROUPS);
    const other = f.actor(FULL_USERS);
    const first = await getJson<Page<UserListItem>>(me.client, '/api/v1/users', { limit: '10' });
    const cursor = first.body.nextCursor ?? '';
    expect(cursor).not.toBe('');
    const problem = async (client: typeof me.client, params: Record<string, string>) => {
      const answer = await getJson<ProblemBody>(client, '/api/v1/users', params);
      return [answer.status, answer.body.code] as const;
    };
    expect(await problem(me.client, { cursor: 'AAAAAAAAAAAAAAAAAAAAAAAA' })).toEqual([
      400,
      'cursor_invalid',
    ]);
    expect(await problem(other.client, { cursor, limit: '10' })).toEqual([400, 'cursor_invalid']);
    expect(await problem(me.client, { cursor, limit: '10', enabled: 'false' })).toEqual([
      400,
      'cursor_invalid',
    ]);
    expect(await problem(me.client, { cursor, limit: '10', q: 'a' })).toEqual([
      400,
      'cursor_invalid',
    ]);
    // The cursor of the users list is not valid on the groups list.
    const groups = await getJson<ProblemBody>(me.client, '/api/v1/groups', { cursor });
    expect([groups.status, groups.body.code]).toEqual([400, 'cursor_invalid']);
    // The same actor, filters and handle still work (a page may be asked for twice) ...
    expect((await getJson(me.client, '/api/v1/users', { cursor, limit: '10' })).status).toBe(200);
    expect((await getJson(me.client, '/api/v1/users', { cursor, limit: '10' })).status).toBe(200);
    // ... until the handle expires (600 s).
    f.clock.advance(601_000);
    expect(await problem(me.client, { cursor, limit: '10' })).toEqual([400, 'cursor_invalid']);
  });

  it('never shows the Graph link to the browser', async () => {
    const f = await createDirectoryFixture();
    const me = f.actor(FULL_USERS);
    const first = await getJson(me.client, '/api/v1/users', { limit: '10' });
    const text = JSON.stringify(first.body);
    expect(text).not.toMatch(/graph\.microsoft|skiptoken|https?:/i);
  });
});

describe('a scoped actor (FR-C-203, US-C4, SC-C1)', () => {
  it('sees exactly the users of the department, the same through every page size, and nothing else', async () => {
    const f = await createDirectoryFixture({ users: 1_200, groups: 40 });
    const me = f.actor(usersScoped([DEPARTMENT_FINANCE]));
    // The naive reference: everything Graph lists in its own order, cut to the department.
    const everything = await walk<Full>(f.actor(FULL_USERS).client, '/api/v1/users', {
      limit: '200',
    });
    const expected = everything.rows
      .filter((row) => row.department === 'Finance')
      .map((row) => row.id);
    expect(expected.length).toBeGreaterThan(100);
    for (const limit of ['7', '50', '200']) {
      const all = await walk<Full>(me.client, '/api/v1/users', { limit });
      expect(all.rows.map((row) => row.id).sort(), `limit ${limit}`).toEqual([...expected].sort());
      expect(new Set(all.rows.map((row) => row.id)).size).toBe(all.rows.length);
      expect(all.rows.every((row) => row.department === 'Finance')).toBe(true);
    }
    const asc = await walk<Full>(me.client, '/api/v1/users', { limit: '200' });
    expect(asc.rows.map((row) => row.id)).toEqual(expected);
  }, 60_000);

  it('scans at most five Graph pages per request and hands back a cursor (EC-C4)', async () => {
    const f = await createDirectoryFixture({ users: 1_200, groups: 40 });
    // A department no seeded user has: every request scans, finds nothing and ends with no cursor.
    const nobody = f.actor(
      usersScoped([{ target: 'user', match: { by: 'department', value: 'Nowhere' } }]),
    );
    f.fake.calls.length = 0;
    const answer = await getJson<Page<UserListItem>>(nobody.client, '/api/v1/users');
    expect(answer.body).toEqual({ items: [] });
    // 1,200 users in pages of 999: two Graph pages, within the budget of five.
    expect(f.fake.callsTo('listUsers').length).toBe(2);
    expect(
      f.fake.callsTo('listUsers').every((call) => (call.args[0] as { top: number }).top === 999),
    ).toBe(true);
  });

  it('passes a Graph page through for an actor who sees everything: one call for the page asked', async () => {
    const f = await createDirectoryFixture();
    const me = f.actor(FULL_USERS);
    await f.settle();
    await getJson(me.client, '/api/v1/users', { limit: '25' });
    const calls = f.fake.callsTo('listUsers');
    expect(calls).toHaveLength(1);
    expect((calls[0]?.args[0] as { top: number }).top).toBe(25);
  });
});

describe('a basic actor (FR-C-204, US-C5)', () => {
  it('sees id, display name and mail only, in the list and the detail, and cannot filter on hidden properties', async () => {
    const f = await createDirectoryFixture();
    const me = f.actor(BASIC_USERS);
    const list = await walk<UserListItem>(me.client, '/api/v1/users');
    expect(list.rows).toHaveLength(f.directory.users.size);
    for (const row of list.rows) {
      expect(Object.keys(row).sort()).toEqual(['displayName', 'id', 'mail']);
      expect(BasicUserSchema.safeParse(row).success).toBe(true);
    }
    const text = JSON.stringify(list.rows);
    expect(text).not.toMatch(
      /contoso-fake\.onmicrosoft|accountEnabled|userType|jobTitle|department/,
    );

    for (const filter of [
      { enabled: 'false' },
      { enabled: 'true' },
      { type: 'guest' },
      { type: 'member' },
    ]) {
      const answer = await getJson<ProblemBody>(me.client, '/api/v1/users', filter);
      expect(answer.status, JSON.stringify(filter)).toBe(422);
      expect(answer.body.code).toBe('validation_failed');
      expect(answer.body.errors?.[0]?.code).toBe('filter_not_allowed');
    }
    expect(
      f.fake
        .callsTo('listUsers')
        .every((call) => (call.args[0] as { enabled: string }).enabled === 'all'),
    ).toBe(true);

    const detail = await getJson<Record<string, unknown>>(
      me.client,
      `/api/v1/users/${f.seeded.ids.userWithManager}`,
    );
    expect(detail.status).toBe(200);
    expect(Object.keys(detail.body).sort()).toEqual(['displayName', 'id', 'mail']);
    expect(f.fake.callsTo('getUserManager')).toHaveLength(0);
    // Memberships are not part of a basic grant (403), even with groups:read.
    const withGroups = f.actor(BASIC_USERS, ALL_GROUPS);
    const groups = await getJson<ProblemBody>(
      withGroups.client,
      `/api/v1/users/${f.seeded.ids.userWithManager}/groups`,
    );
    expect([groups.status, groups.body.code]).toEqual([403, 'permission_denied']);
  });

  it('does not search the principal name, which a basic row does not show', async () => {
    const f = await createDirectoryFixture();
    const guest = f.directory.users.get(f.seeded.ids.guest);
    // The seeded guest's principal name starts differently from its name and its mail address.
    const upnPrefix = guest?.userPrincipalName.slice(0, 24) ?? '';
    expect(guest?.mail?.toLowerCase().startsWith(upnPrefix.toLowerCase())).toBe(false);
    const full = f.actor(FULL_USERS);
    const found = await walk<Full>(full.client, '/api/v1/users', { q: upnPrefix });
    expect(found.rows.map((row) => row.id)).toEqual([f.seeded.ids.guest]);
    const basic = f.actor(BASIC_USERS);
    const hidden = await walk<UserListItem>(basic.client, '/api/v1/users', { q: upnPrefix });
    expect(hidden.rows).toEqual([]);
    expect(f.fake.callsTo('listUsers').at(-1)?.args[0]).toMatchObject({
      searchPrincipalName: false,
    });
  });

  it('lets a mixed actor (full for one department, basic for the rest) see each user in the right form', async () => {
    const f = await createDirectoryFixture();
    const me = f.actor(usersScoped([DEPARTMENT_FINANCE]), BASIC_USERS);
    const rows = await walk<UserListItem>(me.client, '/api/v1/users', { limit: '200' });
    expect(rows.rows).toHaveLength(f.directory.users.size);
    const finance = new Set(
      [...f.directory.users.values()]
        .filter((user) => user.department === 'Finance')
        .map((user) => user.id),
    );
    for (const row of rows.rows) {
      expect('userPrincipalName' in row, row.id).toBe(finance.has(row.id));
    }
    // The hidden-property filters would leak the basic rows' state: refused.
    expect((await getJson(me.client, '/api/v1/users', { enabled: 'false' })).status).toBe(422);
  });
});

describe('GET /api/v1/users/{id} (P34): the detail', () => {
  it('gives the core properties with the manager: none, not available, present, restricted', async () => {
    const f = await createDirectoryFixture();
    const me = f.actor(FULL_USERS);
    const ids = f.seeded.ids;
    const read = async (id: string) => {
      const answer = await getJson(me.client, `/api/v1/users/${id}`);
      expect(answer.status).toBe(200);
      expect(answer.headers.get('cache-control')).toContain('no-store');
      return UserDetailSchema.parse(answer.body) as Record<string, unknown>;
    };
    // Graph is not asked about the manager of an application by default (U66): "not available".
    const unavailable = await read(ids.userWithManager);
    expect(unavailable.manager).toEqual({ state: 'unavailable' });
    expect(unavailable).toMatchObject({ id: ids.userWithManager, userType: 'member' });
    expect(unavailable.createdDateTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);
    expect(JSON.stringify(unavailable)).not.toMatch(/licen|assigned|phone/i);

    const g = await createDirectoryFixture({ graphOptions: { managerForApps: 'allowed' } });
    const admin = g.actor(FULL_USERS);
    const none = await getJson<{ manager: unknown }>(
      admin.client,
      `/api/v1/users/${g.seeded.ids.noManagerUser}`,
    );
    expect(none.body.manager).toEqual({ state: 'none' });
    const present = await getJson<{ manager: { state: string; user: Record<string, unknown> } }>(
      admin.client,
      `/api/v1/users/${g.seeded.ids.userWithManager}`,
    );
    expect(present.body.manager.state).toBe('present');
    expect(present.body.manager.user).toMatchObject({
      kind: 'user',
      id: g.seeded.ids.managerOfWithManager,
    });

    // A manager outside the actor's scope is a restricted row: no id, no name (GC0 amendment).
    const manager = g.directory.users.get(g.seeded.ids.managerOfWithManager);
    const employee = g.directory.users.get(g.seeded.ids.userWithManager);
    expect(manager).toBeDefined();
    const scoped = g.actor(
      usersScoped([
        {
          target: 'user',
          match: { by: 'prefix', attr: 'displayName', value: employee?.displayName ?? '' },
        },
      ]),
    );
    const restricted = await getJson<{ manager: unknown }>(
      scoped.client,
      `/api/v1/users/${g.seeded.ids.userWithManager}`,
    );
    expect(restricted.status).toBe(200);
    expect(restricted.body.manager).toEqual({
      state: 'present',
      user: { kind: 'user', restricted: true },
    });
    expect(JSON.stringify(restricted.body)).not.toContain(manager?.displayName ?? 'unreachable');
  });

  it('keeps the user when the manager call fails: the page works (EC-C6)', async () => {
    const f = await createDirectoryFixture({ graphOptions: { managerForApps: 'allowed' } });
    const me = f.actor(FULL_USERS);
    f.fake.failNext(new GraphTransientError({ status: 503 }), {
      method: 'getUserManager',
    });
    const answer = await getJson<{ id: string; manager: unknown }>(
      me.client,
      `/api/v1/users/${f.seeded.ids.userWithManager}`,
    );
    expect(answer.status).toBe(200);
    expect(answer.body.manager).toEqual({ state: 'unavailable' });
    // One line, without an id or a name.
    const line = f.logs.lines().find((entry) => entry.event === 'directory_manager_unavailable');
    expect(line).toBeDefined();
    expect(JSON.stringify(line)).not.toContain(f.seeded.ids.userWithManager);
  });

  it('is 404 for an unknown id, 403 for a user outside the scope (ODB-11), 422 for an id that is not a GUID', async () => {
    const f = await createDirectoryFixture();
    const scoped = f.actor(usersScoped([DEPARTMENT_FINANCE]));
    const inside = [...f.directory.users.values()].find((user) => user.department === 'Finance');
    const outside = [...f.directory.users.values()].find((user) => user.department === 'Sales');
    expect(inside && outside).toBeTruthy();
    expect((await getJson(scoped.client, `/api/v1/users/${inside?.id ?? ''}`)).status).toBe(200);
    const denied = await getJson<ProblemBody>(scoped.client, `/api/v1/users/${outside?.id ?? ''}`);
    expect([denied.status, denied.body.code]).toEqual([403, 'permission_denied']);
    const unknown = await getJson<ProblemBody>(scoped.client, `/api/v1/users/${GUID}`);
    expect([unknown.status, unknown.body.code]).toEqual([404, 'not_found']);
    for (const bad of ['not-a-guid', 'anna@contoso-fake.example', `${GUID}x`]) {
      const answer = await getJson<ProblemBody>(
        scoped.client,
        `/api/v1/users/${encodeURIComponent(bad)}`,
      );
      expect([answer.status, answer.body.code], bad).toEqual([422, 'validation_failed']);
    }
    // The denial is audited before the 403: reason scope_mismatch, no name in the entry.
    const rows = f.rows().filter((row) => row.action === 'users.get');
    expect(rows.map((row) => [row.outcome, row.reason_code])).toEqual([
      ['denied', 'scope_mismatch'],
    ]);
    expect(JSON.stringify(rows)).not.toContain(outside?.displayName ?? 'unreachable');
  });

  it('shows a null property as null and a guest with its type', async () => {
    const f = await createDirectoryFixture();
    const me = f.actor(FULL_USERS);
    const ids = f.seeded.ids;
    const noMail = await getJson<Record<string, unknown>>(
      me.client,
      `/api/v1/users/${ids.noMailUser}`,
    );
    expect(noMail.body.mail).toBeNull();
    const nullType = await getJson<Record<string, unknown>>(
      me.client,
      `/api/v1/users/${ids.nullTypeUser}`,
    );
    expect(nullType.body.userType).toBeNull();
    const guest = await getJson<Record<string, unknown>>(me.client, `/api/v1/users/${ids.guest}`);
    expect(guest.body.userType).toBe('guest');
    expect(String(guest.body.userPrincipalName)).toContain('#EXT#');
  });
});

describe('GET /api/v1/users/{id}/groups (P35)', () => {
  it('needs both permissions: users:read alone is 403 permission_denied, audited as permission_missing', async () => {
    const f = await createDirectoryFixture();
    const usersOnly = f.actor(FULL_USERS);
    const answer = await getJson<ProblemBody>(
      usersOnly.client,
      `/api/v1/users/${f.seeded.ids.userWithManager}/groups`,
    );
    expect([answer.status, answer.body.code]).toEqual([403, 'permission_denied']);
    expect(
      f
        .rows()
        .filter((row) => row.action === 'users.groups')
        .map((row) => row.reason_code),
    ).toEqual(['permission_missing']);
    expect(f.fake.callsTo('listUserGroups')).toHaveLength(0);
  });

  it('lists the groups transitively, and only those the actor may see', async () => {
    const f = await createDirectoryFixture();
    const ids = f.seeded.ids;
    const nestedUser = [...(f.directory.groups.get(ids.nestedGroup)?.members ?? [])][0] ?? '';
    const all = f.actor(FULL_USERS, ALL_GROUPS);
    const answer = await getJson(all.client, `/api/v1/users/${nestedUser}/groups`);
    expect(answer.status).toBe(200);
    const body = UserGroupsResponseSchema.parse(answer.body);
    // A member of the nested group is in the outer one through it.
    expect(body.items.map((group) => group.id)).toEqual(
      expect.arrayContaining([ids.nestedGroup, ids.outerGroup]),
    );

    const onlyOuter = f.actor(
      FULL_USERS,
      groupsScoped([{ target: 'group', match: { by: 'id', id: ids.outerGroup } }]),
    );
    const narrowed = await getJson<{ items: { id: string }[] }>(
      onlyOuter.client,
      `/api/v1/users/${nestedUser}/groups`,
    );
    expect(narrowed.body.items.map((group) => group.id)).toEqual([ids.outerGroup]);
    // No restricted rows: a group the actor may not see is simply absent.
    expect(JSON.stringify(narrowed.body)).not.toContain('restricted');
  });

  it('pages with a cursor, and is 404 for an unknown user and 403 outside the user scope', async () => {
    const f = await createDirectoryFixture();
    const busiest = [...f.directory.users.keys()]
      .map((id) => [id, f.directory.transitiveGroupIds(id).size] as const)
      .sort((a, b) => b[1] - a[1])[0];
    expect(busiest?.[1]).toBeGreaterThan(2);
    const me = f.actor(FULL_USERS, ALL_GROUPS);
    const walked = await walk<{ id: string }>(
      me.client,
      `/api/v1/users/${busiest?.[0] ?? ''}/groups`,
      { limit: '2' },
    );
    expect(walked.pages).toBeGreaterThan(1);
    expect(new Set(walked.rows.map((row) => row.id)).size).toBe(walked.rows.length);
    expect(walked.rows.length).toBeLessThanOrEqual(busiest?.[1] ?? 0);

    expect((await getJson(me.client, `/api/v1/users/${GUID}/groups`)).status).toBe(404);
    const scoped = f.actor(usersScoped([DEPARTMENT_FINANCE]), ALL_GROUPS);
    const outside = [...f.directory.users.values()].find((user) => user.department === 'Sales');
    expect((await getJson(scoped.client, `/api/v1/users/${outside?.id ?? ''}/groups`)).status).toBe(
      403,
    );
  });
});

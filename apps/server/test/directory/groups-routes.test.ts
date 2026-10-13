// T-C-023, FR-C-301, FR-C-304 to FR-C-306, FR-C-108, FR-C-307, EC-C7 to EC-C10, US-C3, US-C6: the groups
// routes P36 to P39 on the real application and the seeded fake directory.
import {
  GroupDetailSchema,
  GroupListResponseSchema,
  MembersResponseSchema,
  OwnersResponseSchema,
  isRestrictedRow,
  type DirectoryRow,
  type GroupListItem,
} from '@m365portal/shared/schemas/directory';
import { describe, expect, it } from 'vitest';
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

describe('GET /api/v1/groups (P36)', () => {
  it('lists the four kinds, each filter returning only its kind, with the kind from groupKindOf', async () => {
    const f = await createDirectoryFixture();
    const me = f.actor(ALL_GROUPS);
    const all = await walk<GroupListItem>(me.client, '/api/v1/groups', { limit: '50' });
    expect(all.rows).toHaveLength(f.directory.groups.size);
    expect(new Set(all.rows.map((row) => row.kind))).toEqual(
      new Set(['m365', 'security', 'mailsecurity', 'distribution']),
    );
    for (const kind of ['m365', 'security', 'mailsecurity', 'distribution'] as const) {
      const rows = await walk<GroupListItem>(me.client, '/api/v1/groups', { kind });
      expect(rows.rows.length, kind).toBeGreaterThan(3);
      expect(
        rows.rows.every((row) => row.kind === kind),
        kind,
      ).toBe(true);
      expect(rows.rows.length).toBe(all.rows.filter((row) => row.kind === kind).length);
    }
    const body = GroupListResponseSchema.parse(
      (await getJson(me.client, '/api/v1/groups', { limit: '10' })).body,
    );
    expect(Object.keys(body).sort()).toEqual(['items', 'nextCursor']);
    // No source property of the kind reaches the wire (FR-C-303).
    expect(JSON.stringify(body)).not.toMatch(
      /groupTypes|mailEnabled|securityEnabled|membershipRule/,
    );
    expect(f.rows()).toEqual([]);
  });

  it('searches by name, mail and nickname (with a quote), orders both ways and pages without a gap', async () => {
    const f = await createDirectoryFixture();
    const me = f.actor(ALL_GROUPS);
    const quote = await walk<GroupListItem>(me.client, '/api/v1/groups', { q: "O'Brien" });
    expect(quote.rows.map((row) => row.id)).toEqual([f.seeded.ids.quoteGroup]);
    const nickname = await walk<GroupListItem>(me.client, '/api/v1/groups', { q: 'obrienteam' });
    expect(nickname.rows.map((row) => row.id)).toEqual([f.seeded.ids.quoteGroup]);
    const byMail = await walk<GroupListItem>(me.client, '/api/v1/groups', { q: 'everyone250@' });
    expect(byMail.rows.map((row) => row.id)).toEqual([f.seeded.ids.bigGroup]);
    const asc = await walk<GroupListItem>(me.client, '/api/v1/groups', { limit: '7' });
    const desc = await walk<GroupListItem>(me.client, '/api/v1/groups', {
      limit: '9',
      order: 'desc',
    });
    expect(asc.rows.map((row) => row.displayName)).toEqual(
      [...desc.rows.map((row) => row.displayName)].reverse(),
    );
    expect(new Set(asc.rows.map((row) => row.id)).size).toBe(asc.rows.length);
  });

  it('shows only the groups of the scope, and none outside it', async () => {
    const f = await createDirectoryFixture();
    const me = f.actor(
      groupsScoped([
        { target: 'group', match: { by: 'prefix', attr: 'displayName', value: 'Finance' } },
      ]),
    );
    const rows = await walk<GroupListItem>(me.client, '/api/v1/groups', { limit: '5' });
    expect(rows.rows.length).toBeGreaterThan(1);
    expect(rows.rows.every((row) => row.displayName?.startsWith('Finance'))).toBe(true);
    const expected = [...f.directory.groups.values()].filter((group) =>
      group.displayName?.startsWith('Finance'),
    );
    expect(rows.rows).toHaveLength(expected.length);
    const byId = f.actor(
      groupsScoped([{ target: 'group', match: { by: 'id', id: f.seeded.ids.bigGroup } }]),
    );
    expect(
      (await walk<GroupListItem>(byId.client, '/api/v1/groups')).rows.map((row) => row.id),
    ).toEqual([f.seeded.ids.bigGroup]);
  });

  it('is 422 for a bad query and 403 without groups:read, with the denial audited', async () => {
    const f = await createDirectoryFixture();
    const me = f.actor(ALL_GROUPS);
    for (const query of [
      { kind: 'dynamic' },
      { q: 'x'.repeat(65) },
      { order: 'x' },
      { limit: '300' },
    ]) {
      expect(
        (await getJson(me.client, '/api/v1/groups', query)).status,
        JSON.stringify(query),
      ).toBe(422);
    }
    const nobody = f.actor(FULL_USERS);
    expect((await getJson(nobody.client, '/api/v1/groups')).status).toBe(403);
    expect(f.rows().map((row) => [row.action, row.reason_code])).toEqual([
      ['groups.list', 'permission_missing'],
    ]);
  });
});

describe('GET /api/v1/groups/{id} (P37)', () => {
  it('gives the detail with kind, visibility and membership type, and 404 and 403 as ODB-11 says', async () => {
    const f = await createDirectoryFixture();
    const ids = f.seeded.ids;
    const me = f.actor(ALL_GROUPS);
    const read = async (id: string) => {
      const answer = await getJson(me.client, `/api/v1/groups/${id}`);
      expect(answer.status).toBe(200);
      expect(answer.headers.get('cache-control')).toContain('no-store');
      return GroupDetailSchema.parse(answer.body);
    };
    expect(await read(ids.m365Group)).toMatchObject({ kind: 'm365', membershipType: 'assigned' });
    expect(await read(ids.dynamicGroup)).toMatchObject({
      kind: 'security',
      membershipType: 'dynamic',
    });
    expect(await read(ids.distributionGroup)).toMatchObject({ kind: 'distribution' });
    expect(await read(ids.mailSecurityGroup)).toMatchObject({ kind: 'mailsecurity' });
    expect(await read(ids.hiddenGroup)).toMatchObject({ visibility: 'HiddenMembership' });
    const detail = await read(ids.bigGroup);
    expect(detail.createdDateTime).toMatch(/\.000Z$/);
    // The dynamic rule is not on the wire (GC0 note).
    expect(JSON.stringify(await read(ids.dynamicGroup))).not.toContain('department');

    const scoped = f.actor(
      groupsScoped([{ target: 'group', match: { by: 'id', id: ids.bigGroup } }]),
    );
    expect((await getJson(scoped.client, `/api/v1/groups/${ids.bigGroup}`)).status).toBe(200);
    const denied = await getJson<ProblemBody>(scoped.client, `/api/v1/groups/${ids.m365Group}`);
    expect([denied.status, denied.body.code]).toEqual([403, 'permission_denied']);
    const unknown = await getJson<ProblemBody>(scoped.client, `/api/v1/groups/${GUID}`);
    expect([unknown.status, unknown.body.code]).toEqual([404, 'not_found']);
    const malformed = await getJson<ProblemBody>(scoped.client, '/api/v1/groups/not-a-guid');
    expect([malformed.status, malformed.body.code]).toEqual([422, 'validation_failed']);
    expect(
      f
        .rows()
        .filter((row) => row.action === 'groups.get')
        .map((row) => row.reason_code),
    ).toEqual(['scope_mismatch']);
  });
});

describe('GET /api/v1/groups/{id}/members (P39)', () => {
  it('pages a group of 250 members to the end without a gap or a duplicate (US-C3)', async () => {
    const f = await createDirectoryFixture();
    const me = f.actor(ALL_GROUPS, FULL_USERS);
    const members = await walk<DirectoryRow>(
      me.client,
      `/api/v1/groups/${f.seeded.ids.bigGroup}/members`,
      {
        limit: '100',
      },
    );
    expect(members.rows).toHaveLength(250);
    expect(members.pages).toBe(3);
    const ids = members.rows.map((row) => ('id' in row ? row.id : ''));
    expect(new Set(ids).size).toBe(250);
    for (const row of members.rows) expect(row).toMatchObject({ kind: 'user' });
    const first = await getJson(me.client, `/api/v1/groups/${f.seeded.ids.bigGroup}/members`, {
      limit: '100',
    });
    const body = MembersResponseSchema.parse(first.body);
    expect(body.membersState).toBe('listed');
    const small = await walk<DirectoryRow>(
      me.client,
      `/api/v1/groups/${f.seeded.ids.bigGroup}/members`,
      { limit: '30' },
    );
    expect(small.rows.map((row) => ('id' in row ? row.id : ''))).toEqual(ids);
  });

  it('makes no members call for a hidden-membership group and says so (FR-C-108, EC-C7)', async () => {
    const f = await createDirectoryFixture();
    const me = f.actor(ALL_GROUPS, FULL_USERS);
    await f.settle();
    const answer = await getJson(me.client, `/api/v1/groups/${f.seeded.ids.hiddenGroup}/members`);
    expect(answer.status).toBe(200);
    expect(MembersResponseSchema.parse(answer.body)).toEqual({ items: [], membersState: 'hidden' });
    expect(f.fake.callsTo('listGroupMembers')).toHaveLength(0);
    // The owners of the same group are still listed.
    const owners = await getJson<{ items: unknown[]; ownersState: string }>(
      me.client,
      `/api/v1/groups/${f.seeded.ids.hiddenGroup}/owners`,
    );
    expect(owners.body.ownersState).toBe('listed');
    expect(owners.body.items).toHaveLength(1);
    expect(f.fake.callsTo('listGroupOwners')).toHaveLength(1);
  });

  it('shows what the actor may see in full and the rest as restricted rows without id, name or address (FR-C-307)', async () => {
    const f = await createDirectoryFixture();
    const ids = f.seeded.ids;
    const members = [...(f.directory.groups.get(ids.bigGroup)?.members ?? [])];
    const finance = members.filter((id) => f.directory.users.get(id)?.department === 'Finance');
    expect(finance.length).toBeGreaterThan(5);
    expect(finance.length).toBeLessThan(members.length);
    const me = f.actor(
      groupsScoped([{ target: 'group', match: { by: 'id', id: ids.bigGroup } }]),
      usersScoped([DEPARTMENT_FINANCE]),
    );
    const rows = await walk<DirectoryRow>(me.client, `/api/v1/groups/${ids.bigGroup}/members`, {
      limit: '200',
    });
    expect(rows.rows).toHaveLength(250);
    const restricted = rows.rows.filter(isRestrictedRow);
    expect(restricted).toHaveLength(250 - finance.length);
    for (const row of restricted) expect(row).toEqual({ kind: 'user', restricted: true });
    const full = rows.rows.filter((row) => !isRestrictedRow(row));
    expect(full.map((row) => ('id' in row ? row.id : ''))).toEqual(
      expect.arrayContaining(finance.slice(0, 3)),
    );
    // No restricted user's name, address or id is anywhere in the answer.
    const text = JSON.stringify(rows.rows);
    for (const id of members.filter((member) => !finance.includes(member)).slice(0, 40)) {
      const user = f.directory.users.get(id);
      expect(text).not.toContain(id);
      expect(text).not.toContain(user?.userPrincipalName ?? 'unreachable');
    }
  });

  it('counts a device, a service principal and a contact by kind without a name, and shows a nested group', async () => {
    const f = await createDirectoryFixture();
    const me = f.actor(ALL_GROUPS, FULL_USERS);
    const mixed = await walk<DirectoryRow>(
      me.client,
      `/api/v1/groups/${f.seeded.ids.mixedGroup}/members`,
    );
    expect(mixed.rows.map((row) => row.kind)).toEqual(['user', 'other', 'other', 'other']);
    for (const row of mixed.rows.filter((entry) => entry.kind === 'other')) {
      expect(row).toMatchObject({ displayName: null, mail: null, userPrincipalName: null });
    }
    expect(JSON.stringify(mixed.rows)).not.toMatch(/Laptop|Automation|Partner contact/);
    const outer = await walk<DirectoryRow>(
      me.client,
      `/api/v1/groups/${f.seeded.ids.outerGroup}/members`,
    );
    expect(outer.rows).toMatchObject([{ kind: 'group', id: f.seeded.ids.nestedGroup }]);
    // An actor who reads users only cannot see the nested group: restricted.
    const usersOnly = f.actor(
      FULL_USERS,
      groupsScoped([{ target: 'group', match: { by: 'id', id: f.seeded.ids.outerGroup } }]),
    );
    const hidden = await walk<DirectoryRow>(
      usersOnly.client,
      `/api/v1/groups/${f.seeded.ids.outerGroup}/members`,
    );
    expect(hidden.rows).toEqual([{ kind: 'group', restricted: true }]);
  });

  it('shows basic users with id, name and mail but no principal name', async () => {
    const f = await createDirectoryFixture();
    const me = f.actor(ALL_GROUPS, BASIC_USERS);
    const rows = await walk<DirectoryRow>(
      me.client,
      `/api/v1/groups/${f.seeded.ids.bigGroup}/members`,
      { limit: '200' },
    );
    expect(rows.rows).toHaveLength(250);
    for (const row of rows.rows) {
      expect(row).toMatchObject({ kind: 'user', userPrincipalName: null });
      expect(isRestrictedRow(row)).toBe(false);
    }
  });

  it('is 403 for a group outside the scope without a Graph call, 404 for an unknown one, 400 for a foreign cursor', async () => {
    const f = await createDirectoryFixture();
    const ids = f.seeded.ids;
    const scoped = f.actor(
      groupsScoped([{ target: 'group', match: { by: 'id', id: ids.bigGroup } }]),
    );
    await f.settle();
    const denied = await getJson<ProblemBody>(
      scoped.client,
      `/api/v1/groups/${ids.m365Group}/members`,
    );
    expect([denied.status, denied.body.code]).toEqual([403, 'permission_denied']);
    expect(f.fake.callsTo('listGroupMembers')).toHaveLength(0);
    expect((await getJson(scoped.client, `/api/v1/groups/${GUID}/members`)).status).toBe(404);
    const first = await getJson<Page<DirectoryRow>>(
      scoped.client,
      `/api/v1/groups/${ids.bigGroup}/members`,
      { limit: '10' },
    );
    const cursor = first.body.nextCursor ?? '';
    const other = f.actor(ALL_GROUPS);
    const stolen = await getJson<ProblemBody>(
      other.client,
      `/api/v1/groups/${ids.bigGroup}/members`,
      { cursor, limit: '10' },
    );
    expect([stolen.status, stolen.body.code]).toEqual([400, 'cursor_invalid']);
    const wrongGroup = await getJson<ProblemBody>(
      scoped.client,
      `/api/v1/groups/${ids.bigGroup}/owners`,
      { cursor, limit: '10' },
    );
    expect([wrongGroup.status, wrongGroup.body.code]).toEqual([400, 'cursor_invalid']);
  });
});

describe('GET /api/v1/groups/{id}/owners (P38)', () => {
  it('lists the owners of a group, and says "not available" for a distribution group with none (EC-C8)', async () => {
    const f = await createDirectoryFixture();
    const ids = f.seeded.ids;
    const me = f.actor(ALL_GROUPS, FULL_USERS);
    const listed = await getJson(me.client, `/api/v1/groups/${ids.bigGroup}/owners`);
    const body = OwnersResponseSchema.parse(listed.body);
    expect(body.ownersState).toBe('listed');
    expect(body.items).toHaveLength(2);
    for (const kind of [ids.distributionGroup, ids.mailSecurityGroup, ids.syncedGroup]) {
      const answer = await getJson(me.client, `/api/v1/groups/${kind}/owners`);
      expect(OwnersResponseSchema.parse(answer.body), kind).toEqual({
        items: [],
        ownersState: 'not_available',
      });
    }
    // A Microsoft 365 group with no owner is listed and empty: that is a fact, not a limit of Graph.
    const bare = f.directory.addGroup({
      displayName: 'No owners',
      groupTypes: ['Unified'],
      mailEnabled: true,
      securityEnabled: false,
    });
    const empty = await getJson(me.client, `/api/v1/groups/${bare.id}/owners`);
    expect(OwnersResponseSchema.parse(empty.body)).toEqual({ items: [], ownersState: 'listed' });
  });

  it('shows a service principal owner by kind only, and restricts a user owner the actor may not see', async () => {
    const f = await createDirectoryFixture();
    const ids = f.seeded.ids;
    const me = f.actor(ALL_GROUPS, FULL_USERS);
    const mixed = await getJson<{ items: DirectoryRow[] }>(
      me.client,
      `/api/v1/groups/${ids.mixedGroup}/owners`,
    );
    expect(mixed.body.items).toEqual([
      {
        kind: 'other',
        id: expect.any(String) as string,
        displayName: null,
        mail: null,
        userPrincipalName: null,
      },
    ]);
    const owners = [...(f.directory.groups.get(ids.bigGroup)?.owners ?? [])];
    const nobodyInFinance = f.actor(
      ALL_GROUPS,
      usersScoped([{ target: 'user', match: { by: 'department', value: 'Nowhere' } }]),
    );
    const restricted = await getJson<{ items: DirectoryRow[] }>(
      nobodyInFinance.client,
      `/api/v1/groups/${ids.bigGroup}/owners`,
    );
    expect(restricted.body.items).toEqual([
      { kind: 'user', restricted: true },
      { kind: 'user', restricted: true },
    ]);
    expect(JSON.stringify(restricted.body)).not.toContain(owners[0] ?? 'unreachable');
  });
});

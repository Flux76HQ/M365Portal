// T-D-118, T-D-120, FR-D-201, FR-D-202, FR-D-207, EC-D5: the read routes P40 to P42 and P45 on the real
// application, the in-memory Graph client and the in-memory Exchange client behind the registry.
import {
  DistributionListCandidatesResponseSchema,
  DistributionListDetailSchema,
  DistributionListListResponseSchema,
  DistributionListMembersResponseSchema,
  isRestrictedMemberRow,
  type DistributionListListItem,
  type DistributionListMemberRow,
} from '@m365portal/shared/schemas/distribution-lists';
import { describe, expect, it } from 'vitest';
import { ExchangeUnavailableError } from '../../src/ports/errors.js';
import {
  READ_CONTACTS,
  READ_LISTS,
  READ_USERS,
  WRITE_MEMBERS,
  call,
  contactPrefix,
  createListsFixture,
  listId,
  listPrefix,
  scoped,
  walkAll,
  type Page,
  type ProblemBody,
} from './support.js';

const A_GUID = '3f2c1a9e-0b5d-4c61-8a77-5d9a2b7c4e10';

describe('GET /api/v1/distribution-lists (P40)', () => {
  it('lists the three kinds, sorted by name, with kind badges, security flag and unknown values as null', async () => {
    const f = await createListsFixture();
    const me = f.actor(READ_LISTS);
    const answer = await call(me.client, 'GET', '/api/v1/distribution-lists');
    expect(answer.status).toBe(200);
    const body = DistributionListListResponseSchema.parse(answer.body);
    expect(body.items.map((row) => [row.displayName, row.kind])).toEqual([
      ['Dynamic Staff', 'dynamic'],
      ['Marketing', 'standard'],
      ['Sales', 'standard'],
      ['Sales EU', 'standard'],
      ['Synced Board', 'synced'],
    ]);
    expect(body.items.every((row) => row.memberCount === null && row.managers === null)).toBe(true);
    expect(Object.keys(body)).toEqual(['items']);
    expect(answer.headers.get('cache-control')).toContain('no-store');
    // A successful read is not audited (ODC-01).
    expect(f.rows()).toEqual([]);
  });

  it('filters by kind and searches by prefix of the name and the address (a quote and a case change are fine)', async () => {
    const f = await createListsFixture();
    const me = f.actor(READ_LISTS);
    for (const kind of ['standard', 'dynamic', 'synced'] as const) {
      const rows = await walkAll<DistributionListListItem>(
        me.client,
        '/api/v1/distribution-lists',
        {
          kind,
        },
      );
      expect(rows.rows.every((row) => row.kind === kind)).toBe(true);
      expect(rows.rows.length).toBeGreaterThan(0);
    }
    const sales = await walkAll<DistributionListListItem>(me.client, '/api/v1/distribution-lists', {
      q: 'sAlEs',
    });
    expect(sales.rows.map((row) => row.displayName)).toEqual(['Sales', 'Sales EU']);
    const byAddress = await walkAll<DistributionListListItem>(
      me.client,
      '/api/v1/distribution-lists',
      { q: 'marketing@' },
    );
    expect(byAddress.rows.map((row) => row.displayName)).toEqual(['Marketing']);
    const none = await walkAll<DistributionListListItem>(me.client, '/api/v1/distribution-lists', {
      q: "o'brien",
    });
    expect(none.rows).toEqual([]);
  });

  it('pages with the cursor store: no gap, no duplicate, both orders, and a cursor belongs to the actor and the query', async () => {
    const f = await createListsFixture();
    const me = f.actor(READ_LISTS);
    const asc = await walkAll<DistributionListListItem>(me.client, '/api/v1/distribution-lists', {
      limit: '2',
    });
    expect(asc.pages).toBe(3);
    const desc = await walkAll<DistributionListListItem>(me.client, '/api/v1/distribution-lists', {
      limit: '3',
      order: 'desc',
    });
    expect(asc.rows.map((row) => row.id)).toEqual(desc.rows.map((row) => row.id).reverse());
    expect(new Set(asc.rows.map((row) => row.id)).size).toBe(5);

    const first = await call<Page<DistributionListListItem>>(
      me.client,
      'GET',
      '/api/v1/distribution-lists?limit=2',
    );
    const cursor = first.body.nextCursor ?? '';
    expect(cursor).toMatch(/^[A-Za-z0-9_-]{24}$/);
    // Another query, another actor, and an invented handle are the same answer: 400 cursor_invalid.
    const changed = await call<ProblemBody>(
      me.client,
      'GET',
      `/api/v1/distribution-lists?limit=2&kind=standard&cursor=${cursor}`,
    );
    expect(changed.status).toBe(400);
    expect(changed.body.code).toBe('cursor_invalid');
    const other = f.actor(READ_LISTS);
    expect(
      (
        await call<ProblemBody>(
          other.client,
          'GET',
          `/api/v1/distribution-lists?limit=2&cursor=${cursor}`,
        )
      ).body.code,
    ).toBe('cursor_invalid');
    expect(
      (
        await call<ProblemBody>(
          me.client,
          'GET',
          '/api/v1/distribution-lists?cursor=AAAAAAAAAAAAAAAAAAAAAAAA',
        )
      ).status,
    ).toBe(400);
  });

  it('shows only the lists of the scope and the detail agrees', async () => {
    const f = await createListsFixture();
    const me = f.actor(
      scoped('distributionlists:read', [listPrefix('Sales'), listId(f.world.lists.marketing.guid)]),
    );
    const rows = await walkAll<DistributionListListItem>(me.client, '/api/v1/distribution-lists', {
      limit: '1',
    });
    expect(rows.rows.map((row) => row.displayName)).toEqual(['Marketing', 'Sales', 'Sales EU']);
    for (const list of Object.values(f.world.lists)) {
      const inScope = rows.rows.some((row) => row.id === list.guid);
      const detail = await call(me.client, 'GET', `/api/v1/distribution-lists/${list.guid}`);
      expect(detail.status, list.name).toBe(inScope ? 200 : 403);
    }
  });

  it('is 422 for a bad query, 403 (audited) without the permission and 401 without a session', async () => {
    const f = await createListsFixture();
    const me = f.actor(READ_LISTS);
    for (const query of ['kind=weird', 'order=x', 'limit=300', `q=${'x'.repeat(65)}`, 'extra=1']) {
      expect(
        (await call(me.client, 'GET', `/api/v1/distribution-lists?${query}`)).status,
        query,
      ).toBe(422);
    }
    const nobody = f.actor(READ_USERS);
    expect((await call(nobody.client, 'GET', '/api/v1/distribution-lists')).status).toBe(403);
    expect(f.rows().map((row) => [row.action, row.reason_code])).toEqual([
      ['distributionlists.list', 'permission_missing'],
    ]);
    expect((await f.anonymous().get('/api/v1/distribution-lists')).status).toBe(401);
  });

  it('says "narrow your search" for a result that does not fit the buffer, never a short list', async () => {
    const f = await createListsFixture({
      exchange: (fake) =>
        new Proxy(fake, {
          get(target, property, receiver) {
            if (property === 'listDistributionGroups') {
              return async (query: Parameters<typeof fake.listDistributionGroups>[0]) => ({
                ...(await fake.listDistributionGroups(query)),
                truncated: true,
              });
            }
            return Reflect.get(target, property, receiver) as unknown;
          },
        }),
    });
    const me = f.actor(READ_LISTS);
    const answer = await call<ProblemBody>(me.client, 'GET', '/api/v1/distribution-lists?q=s');
    expect(answer.status).toBe(422);
    expect(answer.body.code).toBe('validation_failed');
    expect(answer.body.errors).toEqual([{ pointer: '/q', code: 'narrow_search' }]);
  });

  it('answers 503 exchange_unavailable with a retry hint and the detail code of a role that is not effective yet', async () => {
    const f = await createListsFixture();
    const me = f.actor(READ_LISTS);
    f.exchange.failNext(new ExchangeUnavailableError({ reason: 'role_pending' }));
    const answer = await call<ProblemBody>(me.client, 'GET', '/api/v1/distribution-lists');
    expect(answer.status).toBe(503);
    expect(answer.body.code).toBe('exchange_unavailable');
    expect(answer.body.errors).toEqual([{ pointer: '', code: 'exchange_role_pending' }]);
    expect(answer.headers.get('retry-after')).toBe('30');
  });
});

describe('GET /api/v1/distribution-lists/{id} (P41)', () => {
  it('gives the detail with the member count, the alias and the managers for a caller who sees every user', async () => {
    const f = await createListsFixture();
    const list = f.world.lists.marketing;
    list.managedBy = ['Mara Manager', 'Max Manager'];
    const me = f.actor(READ_LISTS, READ_USERS);
    const answer = await call(me.client, 'GET', `/api/v1/distribution-lists/${list.guid}`);
    expect(answer.status).toBe(200);
    const body = DistributionListDetailSchema.parse(answer.body);
    expect(body).toMatchObject({
      id: list.guid,
      displayName: 'Marketing',
      kind: 'standard',
      alias: list.alias,
      memberCount: 2,
      managers: [
        { displayName: 'Mara Manager', mail: null },
        { displayName: 'Max Manager', mail: null },
      ],
    });
    expect(body.createdDateTime).toBe('2021-08-02T10:30:06.000Z');
    // Without users:read the managers are people the caller may not see: null.
    const blind = f.actor(READ_LISTS);
    const blindBody = DistributionListDetailSchema.parse(
      (await call(blind.client, 'GET', `/api/v1/distribution-lists/${list.guid}`)).body,
    );
    expect(blindBody.managers).toBeNull();
  });

  it('is 404 for an unknown list, 422 for an id that is not a GUID and 403 outside the scope', async () => {
    const f = await createListsFixture();
    const me = f.actor(scoped('distributionlists:read', [listPrefix('Sales')]));
    expect((await call(me.client, 'GET', `/api/v1/distribution-lists/${A_GUID}`)).status).toBe(404);
    expect((await call(me.client, 'GET', '/api/v1/distribution-lists/not-a-guid')).status).toBe(
      422,
    );
    const out = await call<ProblemBody>(
      me.client,
      'GET',
      `/api/v1/distribution-lists/${f.world.lists.marketing.guid}`,
    );
    expect(out.status).toBe(403);
    expect(out.body.code).toBe('permission_denied');
    expect(f.rows().map((row) => [row.action, row.reason_code])).toEqual([
      ['distributionlists.get', 'scope_mismatch'],
    ]);
  });

  it('shows a dynamic list read-only without a member count (its members cannot be listed)', async () => {
    const f = await createListsFixture();
    const me = f.actor(READ_LISTS);
    const detail = DistributionListDetailSchema.parse(
      (await call(me.client, 'GET', `/api/v1/distribution-lists/${f.world.lists.dynamic.guid}`))
        .body,
    );
    expect(detail.kind).toBe('dynamic');
    expect(detail.memberCount).toBeNull();
    const members = await call(
      me.client,
      'GET',
      `/api/v1/distribution-lists/${f.world.lists.dynamic.guid}/members`,
    );
    expect(members.status).toBe(200);
    expect(members.body).toEqual({ items: [] });
  });
});

describe('GET /api/v1/distribution-lists/{id}/members (P42)', () => {
  it('lists users and contacts by kind with the Entra id of a user and the Exchange id of a contact', async () => {
    const f = await createListsFixture();
    const me = f.actor(READ_LISTS, READ_USERS, READ_CONTACTS);
    const answer = await call(
      me.client,
      'GET',
      `/api/v1/distribution-lists/${f.world.lists.marketing.guid}/members`,
    );
    expect(answer.status).toBe(200);
    const body = DistributionListMembersResponseSchema.parse(answer.body);
    expect(body.items).toEqual([
      {
        kind: 'user',
        id: f.world.users.alice.id,
        displayName: 'Alice Example',
        primarySmtpAddress: 'alice@contoso-fake.example',
      },
      {
        kind: 'contact',
        id: f.world.contacts.dave.guid,
        displayName: 'Dave Outside',
        primarySmtpAddress: 'dave@elsewhere.example',
      },
    ]);
  });

  it('turns members the caller may not see into restricted rows without id, name or address', async () => {
    const f = await createListsFixture();
    // Reads the list, sees no users and only the contacts of "Erin": Alice and Dave are restricted.
    const me = f.actor(READ_LISTS, scoped('contacts:read', [contactPrefix('displayName', 'Erin')]));
    const body = DistributionListMembersResponseSchema.parse(
      (
        await call(
          me.client,
          'GET',
          `/api/v1/distribution-lists/${f.world.lists.marketing.guid}/members`,
        )
      ).body,
    );
    expect(body.items).toEqual([
      { kind: 'user', restricted: true },
      { kind: 'contact', restricted: true },
    ]);
    expect(body.items.every(isRestrictedMemberRow)).toBe(true);
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/alice|dave|Example|Outside|elsewhere/i);
    // A department-scoped actor sees users as restricted too: Exchange states no department (fail closed).
    const dept = f.actor(
      READ_LISTS,
      scoped('users:read', [{ target: 'user', match: { by: 'department', value: 'Finance' } }]),
    );
    const deptBody = DistributionListMembersResponseSchema.parse(
      (
        await call(
          dept.client,
          'GET',
          `/api/v1/distribution-lists/${f.world.lists.marketing.guid}/members`,
        )
      ).body,
    );
    expect(deptBody.items[0]).toEqual({ kind: 'user', restricted: true });
  });

  it('pages the members with a cursor, and a cursor is not valid on another list', async () => {
    const f = await createListsFixture();
    const group = f.exchangeState.distributionGroups.get(f.world.lists.sales.guid);
    for (let n = 0; n < 7; n += 1) {
      group?.members.push(
        f.exchangeState.addRecipient({
          displayName: `Member ${String(n).padStart(2, '0')}`,
          primarySmtpAddress: `member${String(n)}@contoso-fake.example`,
        }),
      );
    }
    const me = f.actor(READ_LISTS, READ_USERS);
    const all = await walkAll<DistributionListMemberRow>(
      me.client,
      `/api/v1/distribution-lists/${f.world.lists.sales.guid}/members`,
      { limit: '3' },
    );
    expect(all.pages).toBe(3);
    expect(all.rows).toHaveLength(7);
    const first = await call<Page<DistributionListMemberRow>>(
      me.client,
      'GET',
      `/api/v1/distribution-lists/${f.world.lists.sales.guid}/members?limit=3`,
    );
    const wrong = await call<ProblemBody>(
      me.client,
      'GET',
      `/api/v1/distribution-lists/${f.world.lists.marketing.guid}/members?cursor=${first.body.nextCursor ?? ''}`,
    );
    expect(wrong.body.code).toBe('cursor_invalid');
  });
});

describe('GET /api/v1/distribution-lists/{id}/candidates (P45)', () => {
  const candidatesOf = async (client: Parameters<typeof call>[0], list: string, q: string) =>
    call(client, 'GET', `/api/v1/distribution-lists/${list}/candidates?q=${encodeURIComponent(q)}`);

  it('offers users and contacts that match, with whether they are members, and no user without a mailbox', async () => {
    const f = await createListsFixture();
    const me = f.actor(WRITE_MEMBERS, READ_USERS, READ_CONTACTS);
    const users = DistributionListCandidatesResponseSchema.parse(
      (await candidatesOf(me.client, f.world.lists.marketing.guid, 'a')).body,
    );
    expect(users.items.map((item) => [item.kind, item.displayName, item.alreadyMember])).toEqual([
      ['user', 'Alice Example', true],
    ]);
    const dave = DistributionListCandidatesResponseSchema.parse(
      (await candidatesOf(me.client, f.world.lists.marketing.guid, 'dave')).body,
    );
    expect(dave.items).toEqual([
      {
        kind: 'contact',
        id: f.world.contacts.dave.guid,
        displayName: 'Dave Outside',
        mail: 'dave@elsewhere.example',
        alreadyMember: true,
      },
    ]);
    const erin = DistributionListCandidatesResponseSchema.parse(
      (await candidatesOf(me.client, f.world.lists.sales.guid, 'erin')).body,
    );
    expect(erin.items.map((item) => item.alreadyMember)).toEqual([false]);
    const nomail = DistributionListCandidatesResponseSchema.parse(
      (await candidatesOf(me.client, f.world.lists.marketing.guid, 'no mail')).body,
    );
    expect(nomail.items).toEqual([]);
    const bob = DistributionListCandidatesResponseSchema.parse(
      (await candidatesOf(me.client, f.world.lists.marketing.guid, 'bob')).body,
    );
    expect(bob.items).toEqual([
      {
        kind: 'user',
        id: f.world.users.bob.id,
        displayName: 'Bob Example',
        mail: 'bob@contoso-fake.example',
        alreadyMember: false,
      },
    ]);
  });

  it('needs the write permission on the list, cuts to users:read and contacts:read, and refuses a read-only list', async () => {
    const f = await createListsFixture();
    const readerOnly = f.actor(READ_LISTS, READ_USERS);
    expect(
      (await candidatesOf(readerOnly.client, f.world.lists.marketing.guid, 'bob')).status,
    ).toBe(403);
    const writerNoUsers = f.actor(WRITE_MEMBERS);
    const empty = await candidatesOf(writerNoUsers.client, f.world.lists.marketing.guid, 'bob');
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ items: [] });
    const writer = f.actor(WRITE_MEMBERS, READ_USERS);
    for (const list of [f.world.lists.dynamic, f.world.lists.synced]) {
      const refused = await candidatesOf(writer.client, list.guid, 'bob');
      expect(refused.status).toBe(409);
      expect((refused.body as ProblemBody).code).toBe('read_only_object');
    }
    expect((await candidatesOf(writer.client, f.world.lists.marketing.guid, '')).status).toBe(422);
    const withCursor = await call<ProblemBody>(
      writer.client,
      'GET',
      `/api/v1/distribution-lists/${f.world.lists.marketing.guid}/candidates?q=bob&cursor=AAAAAAAAAAAAAAAAAAAAAAAA`,
    );
    expect(withCursor.body.code).toBe('cursor_invalid');
  });
});

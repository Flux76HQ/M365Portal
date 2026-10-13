// T-D-119, T-D-120, FR-D-203 to FR-D-206, EC-D1 to EC-D8, US-D1: the member writes P43 and P44 on the real
// application, with the in-memory Graph and Exchange clients: per member results, "already" decided by
// reading the membership first (U92 to U94), identity resolution and the member types (EC-D3), chunks of
// 50, the step-up above 20, the read-back, the audit entries and the failure paths.
import {
  DistributionListMemberWriteResponseSchema,
  type DistributionListMemberWriteResponse,
} from '@m365portal/shared/schemas/member-writes';
import { LIMITS } from '@m365portal/shared/limits';
import { describe, expect, it } from 'vitest';
import {
  ExchangeCommandError,
  ExchangeThrottledError,
  ExchangeUnavailableError,
} from '../../src/ports/errors.js';
import {
  READ_CONTACTS,
  READ_LISTS,
  READ_USERS,
  WRITE_MEMBERS,
  call,
  createListsFixture,
  failingOn,
  listPrefix,
  scoped,
  type ListsFixture,
  type ProblemBody,
} from './support.js';

const path = (list: { guid: string }): string => `/api/v1/distribution-lists/${list.guid}/members`;
const WRITER = [WRITE_MEMBERS, READ_USERS, READ_CONTACTS] as const;

const writes = (f: ListsFixture): string[] =>
  f.exchange.calls
    .filter(
      (c) =>
        c.method === 'addDistributionGroupMember' || c.method === 'removeDistributionGroupMember',
    )
    .map((c) => c.method);

const auditRows = (f: ListsFixture, action: string) =>
  f.rows().filter((row) => row.action === action);

function parsed(body: unknown): DistributionListMemberWriteResponse {
  return DistributionListMemberWriteResponseSchema.parse(body);
}

describe('POST /api/v1/distribution-lists/{id}/members (P43)', () => {
  it('adds a user and a contact, one result each in the order asked, and reads the list back', async () => {
    const f = await createListsFixture();
    const me = f.actor(...WRITER);
    const list = f.world.lists.sales;
    const answer = await call(me.client, 'POST', path(list), {
      members: [f.world.users.bob.id, f.world.contacts.erin.guid, f.world.users.carol.id],
    });
    expect(answer.status).toBe(200);
    const body = parsed(answer.body);
    expect(body.results).toEqual([
      { id: f.world.users.bob.id, result: 'added' },
      { id: f.world.contacts.erin.guid, result: 'added' },
      { id: f.world.users.carol.id, result: 'added' },
    ]);
    expect(body.summary).toEqual({ added: 3, removed: 0, already: 0, failed: 0 });
    expect(body.readBackPending).toBe(false);
    expect(answer.headers.get('cache-control')).toContain('no-store');
    // Exchange holds the three; the fake recorded exactly three mutating calls and one membership read before.
    expect(
      f.exchangeState
        .groupMembers(list.guid)
        .map((member) => member.displayName)
        .sort(),
    ).toEqual(['Bob Example', 'Carol Example', 'Erin Partner']);
    expect(writes(f)).toEqual(Array<string>(3).fill('addDistributionGroupMember'));
    // The user is addressed by the mailbox address, the contact by its GUID; the bypass is sent (EC-D4, U78).
    const addCalls = f.exchange.calls.filter((c) => c.method === 'addDistributionGroupMember');
    expect(addCalls.map((c) => c.args[1])).toEqual([
      'bob@contoso-fake.example',
      f.world.contacts.erin.guid,
      'carol@contoso-fake.example',
    ]);
  });

  it('decides "already" from the membership it read first and sends no write for it (U92, U94)', async () => {
    const f = await createListsFixture();
    const me = f.actor(...WRITER);
    const answer = await call(me.client, 'POST', path(f.world.lists.marketing), {
      members: [f.world.users.alice.id, f.world.contacts.dave.guid, f.world.users.bob.id],
    });
    const body = parsed(answer.body);
    expect(body.results.map((item) => item.result)).toEqual(['already', 'already', 'added']);
    expect(body.summary).toEqual({ added: 1, removed: 0, already: 2, failed: 0 });
    expect(writes(f)).toEqual(['addDistributionGroupMember']);
    // A request that changes nothing says so and is still audited.
    const again = await call(me.client, 'POST', path(f.world.lists.marketing), {
      members: [f.world.users.bob.id],
    });
    expect(parsed(again.body).results).toEqual([{ id: f.world.users.bob.id, result: 'already' }]);
    expect(writes(f)).toHaveLength(1);
    expect(parsed(again.body).readBackPending).toBe(false);
  });

  it('names the reason before any call: unknown, no mailbox address, a group (EC-D3), and still adds the rest', async () => {
    const f = await createListsFixture();
    const me = f.actor(...WRITER);
    const unknown = '9d2b6e1c-7a44-4c0e-9f5a-1b2c3d4e5f60';
    const answer = await call(me.client, 'POST', path(f.world.lists.sales), {
      members: [unknown, f.world.noMail.id, f.world.m365Group.id, f.world.users.bob.id],
    });
    expect(answer.status).toBe(200);
    const body = parsed(answer.body);
    expect(body.results).toEqual([
      { id: unknown, result: 'failed', reason: 'not_found' },
      { id: f.world.noMail.id, result: 'failed', reason: 'mail_disabled' },
      { id: f.world.m365Group.id, result: 'failed', reason: 'member_type_not_allowed' },
      { id: f.world.users.bob.id, result: 'added' },
    ]);
    expect(body.summary).toEqual({ added: 1, removed: 0, already: 0, failed: 3 });
    expect(writes(f)).toEqual(['addDistributionGroupMember']);
  });

  it('works in chunks of 50: 120 members are 120 calls in order, one result and one audit entry each, plus a summary', async () => {
    const f = await createListsFixture();
    const ids: string[] = [];
    for (let n = 0; n < 120; n += 1) {
      const user = f.directory.addUser({
        userPrincipalName: `bulk${String(n)}@contoso-fake.example`,
        displayName: `Bulk ${String(n)}`,
      });
      f.exchangeState.addRecipient({
        displayName: `Bulk ${String(n)}`,
        primarySmtpAddress: `bulk${String(n)}@contoso-fake.example`,
        externalDirectoryObjectId: user.id,
      });
      ids.push(user.id);
    }
    const me = f.actor(...WRITER);
    const answer = await call(me.client, 'POST', path(f.world.lists.sales), { members: ids });
    expect(answer.status).toBe(200);
    const body = parsed(answer.body);
    expect(body.results.map((item) => item.id)).toEqual(ids);
    expect(body.summary.added).toBe(120);
    expect(writes(f)).toHaveLength(120);
    const rows = auditRows(f, 'dl.member.add');
    expect(rows).toHaveLength(121);
    expect(rows.filter((row) => row.detail?.includes('"summary":true'))).toHaveLength(1);
    expect(LIMITS.distributionLists.bulkChunk).toBe(50);
    // The three chunks were committed as they were done: 50, 50, 20 entries before the summary.
    expect(rows.slice(0, 120).every((row) => row.outcome === 'success')).toBe(true);
  });

  it('is 422 for an empty list of members, a duplicate, a non-GUID, more than 200 and an unknown key', async () => {
    const f = await createListsFixture();
    const me = f.actor(...WRITER);
    const id = f.world.users.bob.id;
    const many = Array.from(
      { length: 201 },
      (_, n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`,
    );
    for (const body of [
      { members: [] },
      { members: [id, id] },
      { members: ['bob@contoso-fake.example'] },
      { members: many },
      { members: [id], extra: true },
      {},
    ]) {
      const answer = await call<ProblemBody>(me.client, 'POST', path(f.world.lists.sales), body);
      expect(answer.status, JSON.stringify(body).slice(0, 40)).toBe(422);
    }
    expect(writes(f)).toEqual([]);
  });
});

describe('DELETE /api/v1/distribution-lists/{id}/members (P44)', () => {
  it('removes members, treats a non-member as "already" without a write, and reads the list back', async () => {
    const f = await createListsFixture();
    const me = f.actor(...WRITER);
    const answer = await call(me.client, 'DELETE', path(f.world.lists.marketing), {
      members: [f.world.users.alice.id, f.world.contacts.dave.guid, f.world.users.bob.id],
    });
    expect(answer.status).toBe(200);
    const body = parsed(answer.body);
    expect(body.results.map((item) => item.result)).toEqual(['removed', 'removed', 'already']);
    expect(body.summary).toEqual({ added: 0, removed: 2, already: 1, failed: 0 });
    expect(body.readBackPending).toBe(false);
    expect(f.exchangeState.groupMembers(f.world.lists.marketing.guid)).toEqual([]);
    expect(writes(f)).toEqual(['removeDistributionGroupMember', 'removeDistributionGroupMember']);
    expect(auditRows(f, 'dl.member.remove')).toHaveLength(4);
  });
});

describe('the read-back (FR-D-206, EC-D7, U82)', () => {
  it('says readBackPending when Exchange does not show the change yet, and not when it does', async () => {
    const f = await createListsFixture();
    f.exchangeState.setReadBackDelay(5);
    const me = f.actor(...WRITER);
    const stale = parsed(
      (
        await call(me.client, 'POST', path(f.world.lists.sales), {
          members: [f.world.users.bob.id],
        })
      ).body,
    );
    expect(stale.results).toEqual([{ id: f.world.users.bob.id, result: 'added' }]);
    expect(stale.readBackPending).toBe(true);
    const g = await createListsFixture();
    const you = g.actor(...WRITER);
    const fresh = parsed(
      (
        await call(you.client, 'POST', path(g.world.lists.sales), {
          members: [g.world.users.bob.id],
        })
      ).body,
    );
    expect(fresh.readBackPending).toBe(false);
  });

  it('counts a failed read-back as stale, never as done', async () => {
    let reads = 0;
    const f = await createListsFixture({
      exchange: (fake) => {
        const base = failingOn('listDistributionGroupMembers', 99, new Error('unused'))(fake);
        return new Proxy(base, {
          get(target, property) {
            const value = Reflect.get(target, property, target) as unknown;
            if (property !== 'listDistributionGroupMembers') {
              return typeof value === 'function'
                ? (value as (...a: never[]) => unknown).bind(target)
                : value;
            }
            return (...args: never[]) => {
              reads += 1;
              if (reads === 2) {
                // eslint-disable-next-line require-yield -- the iterator fails at its first step
                return (async function* () {
                  await Promise.resolve();
                  throw new ExchangeUnavailableError({ reason: 'worker_crashed' });
                })();
              }
              return (value as (...a: never[]) => unknown).apply(target, args);
            };
          },
        });
      },
    });
    const me = f.actor(...WRITER);
    const body = parsed(
      (
        await call(me.client, 'POST', path(f.world.lists.sales), {
          members: [f.world.users.bob.id],
        })
      ).body,
    );
    expect(body.results[0]?.result).toBe('added');
    expect(body.readBackPending).toBe(true);
  });
});

describe('read-only lists, scope and step-up (FR-D-204, EC-D5)', () => {
  it('answers 409 read_only_object for a dynamic and a synced list and sends nothing to Exchange', async () => {
    const f = await createListsFixture();
    const me = f.actor(...WRITER);
    for (const list of [f.world.lists.dynamic, f.world.lists.synced]) {
      for (const method of ['POST', 'DELETE'] as const) {
        const answer = await call<ProblemBody>(me.client, method, path(list), {
          members: [f.world.users.bob.id],
        });
        expect(answer.status, `${method} ${list.name}`).toBe(409);
        expect(answer.body.code).toBe('read_only_object');
      }
    }
    expect(writes(f)).toEqual([]);
    expect(f.rows().filter((row) => row.action.startsWith('dl.'))).toEqual([]);
  });

  it('is 403 outside the scope or without the write permission, audited as a denial, and 404 for an unknown list', async () => {
    const f = await createListsFixture();
    const body = { members: [f.world.users.bob.id] };
    const scopedWriter = f.actor(
      scoped('distributionlists:members:write', [listPrefix('Sales')]),
      READ_USERS,
    );
    const out = await call<ProblemBody>(
      scopedWriter.client,
      'POST',
      path(f.world.lists.marketing),
      body,
    );
    expect(out.status).toBe(403);
    expect(out.body.code).toBe('permission_denied');
    const reader = f.actor(READ_LISTS, READ_USERS);
    expect((await call(reader.client, 'DELETE', path(f.world.lists.sales), body)).status).toBe(403);
    const inside = await call(scopedWriter.client, 'POST', path(f.world.lists.salesEu), body);
    expect(inside.status).toBe(200);
    expect(
      (
        await call(
          scopedWriter.client,
          'POST',
          '/api/v1/distribution-lists/9d2b6e1c-7a44-4c0e-9f5a-1b2c3d4e5f60/members',
          body,
        )
      ).status,
    ).toBe(404);
    const denials = f.rows().filter((row) => row.outcome === 'denied');
    expect(denials.map((row) => [row.action, row.reason_code])).toEqual([
      ['distributionlists.members.add', 'scope_mismatch'],
      ['distributionlists.members.remove', 'permission_missing'],
    ]);
    expect(writes(f)).toHaveLength(1);
  });

  it('needs a fresh step-up above 20 members and none for 20 or fewer', async () => {
    const f = await createListsFixture();
    const stale = f.staleActor(...WRITER);
    const fresh = f.actor(...WRITER);
    const ids: string[] = [];
    for (let n = 0; n < 21; n += 1) {
      const user = f.directory.addUser({
        userPrincipalName: `step${String(n)}@contoso-fake.example`,
      });
      f.exchangeState.addRecipient({
        displayName: `Step ${String(n)}`,
        primarySmtpAddress: `step${String(n)}@contoso-fake.example`,
        externalDirectoryObjectId: user.id,
      });
      ids.push(user.id);
    }
    expect(LIMITS.distributionLists.stepUpAbove).toBe(20);
    const refused = await call<ProblemBody>(stale.client, 'POST', path(f.world.lists.sales), {
      members: ids,
    });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('step_up_required');
    expect(writes(f)).toEqual([]);
    expect(f.rows().map((row) => [row.action, row.outcome, row.reason_code])).toEqual([
      ['distributionlists.members.add', 'denied', 'step_up_required'],
    ]);
    // Twenty members need none; twenty-one need it and pass with it.
    expect(
      (await call(stale.client, 'POST', path(f.world.lists.sales), { members: ids.slice(0, 20) }))
        .status,
    ).toBe(200);
    const done = await call(fresh.client, 'POST', path(f.world.lists.salesEu), { members: ids });
    expect(done.status).toBe(200);
    expect(parsed(done.body).summary.added).toBe(21);
  });
});

describe('failures of Exchange (FR-D-105, EC-D1, EC-D4)', () => {
  it('fails the whole request, with nothing claimed, when the first write is refused for the role or the manager check', async () => {
    const f = await createListsFixture();
    f.exchangeState.setAppHoldsOrganizationManagement(false);
    f.exchangeState.distributionGroups.get(f.world.lists.sales.guid)?.managedBy.splice(0);
    const me = f.actor(...WRITER);
    const answer = await call<ProblemBody>(me.client, 'POST', path(f.world.lists.sales), {
      members: [f.world.users.bob.id, f.world.users.carol.id],
    });
    expect(answer.status).toBe(503);
    expect(answer.body.code).toBe('exchange_permission_missing');
    expect(f.exchangeState.groupMembers(f.world.lists.sales.guid)).toEqual([]);
    // The attempt is traced by one summary entry with the problem as reason, and no entry names a member.
    const rows = auditRows(f, 'dl.member.add');
    expect(rows.map((row) => [row.outcome, row.reason_code])).toEqual([
      ['error', 'exchange_permission_missing'],
    ]);
  });

  it('answers 503 exchange_throttled with Retry-After when the first write is throttled for good', async () => {
    const f = await createListsFixture({
      exchange: failingOn(
        'addDistributionGroupMember',
        1,
        new ExchangeThrottledError({ retryAfterMs: 7_300 }),
      ),
    });
    const me = f.actor(...WRITER);
    const answer = await call<ProblemBody>(me.client, 'POST', path(f.world.lists.sales), {
      members: [f.world.users.bob.id],
    });
    expect(answer.status).toBe(503);
    expect(answer.body.code).toBe('exchange_throttled');
    expect(answer.headers.get('retry-after')).toBe('8');
  });

  it('keeps what was done when Exchange gives out in the middle: the rest fail with the same reason and are not tried', async () => {
    const f = await createListsFixture({
      exchange: failingOn(
        'addDistributionGroupMember',
        2,
        new ExchangeUnavailableError({ reason: 'timeout' }),
      ),
    });
    const me = f.actor(...WRITER);
    const answer = await call(me.client, 'POST', path(f.world.lists.sales), {
      members: [f.world.users.bob.id, f.world.users.carol.id, f.world.contacts.erin.guid],
    });
    expect(answer.status).toBe(200);
    const body = parsed(answer.body);
    expect(body.results).toEqual([
      { id: f.world.users.bob.id, result: 'added' },
      { id: f.world.users.carol.id, result: 'failed', reason: 'timeout' },
      { id: f.world.contacts.erin.guid, result: 'failed', reason: 'timeout' },
    ]);
    // The second call was refused on its way (it never reached the fake) and the third was not tried.
    expect(writes(f)).toHaveLength(1);
    const rows = auditRows(f, 'dl.member.add');
    expect(rows.map((row) => [row.outcome, row.reason_code])).toEqual([
      ['success', null],
      ['error', 'timeout'],
      ['error', 'timeout'],
      ['success', null],
    ]);
  });

  it('makes a refusal for one member that member’s result and goes on (a type Exchange does not take)', async () => {
    const f = await createListsFixture({
      exchange: failingOn(
        'addDistributionGroupMember',
        1,
        new ExchangeCommandError('member_type_not_allowed'),
      ),
    });
    const me = f.actor(...WRITER);
    const body = parsed(
      (
        await call(me.client, 'POST', path(f.world.lists.sales), {
          members: [f.world.users.bob.id, f.world.users.carol.id],
        })
      ).body,
    );
    expect(body.results).toEqual([
      { id: f.world.users.bob.id, result: 'failed', reason: 'member_type_not_allowed' },
      { id: f.world.users.carol.id, result: 'added' },
    ]);
  });
});

describe('the audit entries of a member write (FR-D-205)', () => {
  it('writes one entry per member and a summary, with object ids and counts only', async () => {
    const f = await createListsFixture();
    const me = f.actor(...WRITER);
    await call(me.client, 'POST', path(f.world.lists.marketing), {
      members: [f.world.users.alice.id, f.world.users.bob.id, f.world.m365Group.id],
    });
    const rows = auditRows(f, 'dl.member.add');
    expect(rows).toHaveLength(4);
    const members = rows.slice(0, 3);
    // What needs no write is audited first, in request order; then the writes; then the summary.
    expect(
      members.map((row) => [
        row.outcome,
        row.reason_code,
        JSON.parse(row.detail ?? '{}') as unknown,
      ]),
    ).toEqual([
      ['success', null, { memberId: f.world.users.alice.id, result: 'already' }],
      ['error', 'member_type_not_allowed', { memberId: f.world.m365Group.id, result: 'failed' }],
      ['success', null, { memberId: f.world.users.bob.id, result: 'added' }],
    ]);
    expect(JSON.parse(rows[3]?.detail ?? '{}')).toEqual({
      summary: true,
      total: 3,
      added: 1,
      removed: 0,
      already: 1,
      failed: 1,
    });
    expect(
      rows.every(
        (row) => row.actor_id === me.oid && row.target_id === f.world.lists.marketing.guid,
      ),
    ).toBe(true);
    // No name and no address in any entry.
    expect(JSON.stringify(rows)).not.toMatch(/Alice|Bob|Example|@contoso-fake|Marketing/);
  });
});

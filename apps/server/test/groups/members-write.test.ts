// T-D-123, FR-D-352 to FR-D-354, R-D-08, U92, U93, U96, US-D3: the group member write routes P53 and P54 on
// the real application with the in-memory Graph client: per member results, "already" from the membership
// read first, one call per member, chunks of 20, 409 read_only_object for every group Graph cannot change
// here, the step-up above 20, and the audit entries.
import { LIMITS } from '@m365portal/shared/limits';
import {
  GroupMemberWriteResponseSchema,
  type GroupMemberWriteResponse,
} from '@m365portal/shared/schemas/member-writes';
import { describe, expect, it } from 'vitest';
import {
  GraphForbiddenError,
  GraphNotFoundError,
  GraphThrottledError,
  GraphTransientError,
} from '../../src/ports/errors.js';
import { MEMBERSHIP_PAGES_MAX } from '../../src/groups/members-write.js';
import {
  READ_GROUPS,
  READ_USERS,
  WRITE_GROUP_MEMBERS,
  call,
  createListsFixture,
  scoped,
  type ListsFixture,
  type ProblemBody,
} from '../distribution-lists/support.js';

const path = (group: { id: string }): string => `/api/v1/groups/${group.id}/members`;

function parsed(body: unknown): GroupMemberWriteResponse {
  return GroupMemberWriteResponseSchema.parse(body);
}

const graphWrites = (f: ListsFixture): string[] =>
  f.fake.calls
    .filter((c) => c.method === 'addGroupMember' || c.method === 'removeGroupMember')
    .map((c) => c.method);

const rows = (f: ListsFixture, action: string) => f.rows().filter((row) => row.action === action);

async function withGroups() {
  const f = await createListsFixture();
  const team = f.directory.addGroup({
    displayName: 'Team Phoenix',
    mailNickname: 'phoenixteam',
    groupTypes: ['Unified'],
    mailEnabled: true,
    securityEnabled: false,
    visibility: 'Private',
  });
  const security = f.directory.addGroup({
    displayName: 'Security Crew',
    groupTypes: [],
    mailEnabled: false,
    securityEnabled: true,
  });
  const readOnly = {
    dynamic: f.directory.addGroup({
      displayName: 'Dynamic Crew',
      groupTypes: ['DynamicMembership'],
      membershipRule: '(user.department -eq "Sales")',
      mailEnabled: false,
      securityEnabled: true,
    }),
    synced: f.directory.addGroup({
      displayName: 'Synced Crew',
      mailEnabled: false,
      securityEnabled: true,
      onPremisesSyncEnabled: true,
    }),
    distribution: f.directory.addGroup({
      displayName: 'Distribution Crew',
      mailEnabled: true,
      securityEnabled: false,
    }),
    mailSecurity: f.directory.addGroup({
      displayName: 'Mail Security Crew',
      mailEnabled: true,
      securityEnabled: true,
    }),
    hidden: f.directory.addGroup({
      displayName: 'Hidden Team',
      groupTypes: ['Unified'],
      mailEnabled: true,
      securityEnabled: false,
      visibility: 'HiddenMembership',
      hiddenMembership: true,
    }),
  };
  f.directory.addMember(team.id, f.world.users.alice.id);
  return { f, team, security, readOnly };
}

const WRITER = [WRITE_GROUP_MEMBERS, READ_GROUPS, READ_USERS] as const;

describe('POST /api/v1/groups/{id}/members (P53)', () => {
  it('adds users to a Microsoft 365 group and a security group, one call per member, "already" without a call', async () => {
    const { f, team, security } = await withGroups();
    const me = f.actor(...WRITER);
    const answer = await call(me.client, 'POST', path(team), {
      members: [f.world.users.alice.id, f.world.users.bob.id, f.world.users.carol.id],
    });
    expect(answer.status).toBe(200);
    expect(answer.headers.get('cache-control')).toContain('no-store');
    const body = parsed(answer.body);
    expect(body.results).toEqual([
      { id: f.world.users.alice.id, result: 'already' },
      { id: f.world.users.bob.id, result: 'added' },
      { id: f.world.users.carol.id, result: 'added' },
    ]);
    expect(body.summary).toEqual({ added: 2, removed: 0, already: 1, failed: 0 });
    expect(Object.keys(body).sort()).toEqual(['results', 'summary']);
    expect(graphWrites(f)).toEqual(['addGroupMember', 'addGroupMember']);
    expect([...(f.directory.groups.get(team.id)?.members ?? [])].sort()).toEqual(
      [f.world.users.alice.id, f.world.users.bob.id, f.world.users.carol.id].sort(),
    );
    const second = await call(me.client, 'POST', path(security), {
      members: [f.world.users.bob.id],
    });
    expect(parsed(second.body).results).toEqual([{ id: f.world.users.bob.id, result: 'added' }]);
  });

  it('names the reason before the call: unknown, and a group (a type this route does not add)', async () => {
    const { f, team, readOnly } = await withGroups();
    const me = f.actor(...WRITER);
    const unknown = '9d2b6e1c-7a44-4c0e-9f5a-1b2c3d4e5f60';
    const body = parsed(
      (
        await call(me.client, 'POST', path(team), {
          members: [unknown, readOnly.dynamic.id, f.world.users.bob.id],
        })
      ).body,
    );
    expect(body.results).toEqual([
      { id: unknown, result: 'failed', reason: 'not_found' },
      { id: readOnly.dynamic.id, result: 'failed', reason: 'member_type_not_allowed' },
      { id: f.world.users.bob.id, result: 'added' },
    ]);
    expect(graphWrites(f)).toEqual(['addGroupMember']);
  });

  it('answers 409 read_only_object for a dynamic, synchronised, distribution, mail-enabled security and hidden-membership group, and calls nothing', async () => {
    const { f, readOnly } = await withGroups();
    const me = f.actor(...WRITER);
    for (const [name, group] of Object.entries(readOnly)) {
      for (const method of ['POST', 'DELETE'] as const) {
        const answer = await call<ProblemBody>(me.client, method, path(group), {
          members: [f.world.users.bob.id],
        });
        expect(answer.status, `${method} ${name}`).toBe(409);
        expect(answer.body.code).toBe('read_only_object');
      }
    }
    expect(graphWrites(f)).toEqual([]);
    expect(f.fake.calls.filter((c) => c.method === 'listGroupMembers')).toEqual([]);
    expect(rows(f, 'group.member.add')).toEqual([]);
  });

  it('works in chunks of 20: 55 members are 55 calls, one audit entry each and a summary', async () => {
    const { f, security } = await withGroups();
    const ids: string[] = [];
    for (let n = 0; n < 55; n += 1) {
      ids.push(f.directory.addUser({ userPrincipalName: `g${String(n)}@contoso-fake.example` }).id);
    }
    expect(LIMITS.groupMembers.bulkChunk).toBe(20);
    const me = f.actor(...WRITER);
    const answer = await call(me.client, 'POST', path(security), { members: ids });
    expect(answer.status).toBe(200);
    const body = parsed(answer.body);
    expect(body.results.map((item) => item.id)).toEqual(ids);
    expect(body.summary.added).toBe(55);
    expect(graphWrites(f)).toHaveLength(55);
    expect(rows(f, 'group.member.add')).toHaveLength(56);
  });

  it('is 422 for bad bodies and 404 for an unknown group, 403 out of scope or without the permission', async () => {
    const { f, team, security } = await withGroups();
    const me = f.actor(...WRITER);
    const id = f.world.users.bob.id;
    for (const body of [
      { members: [] },
      { members: [id, id] },
      { members: ['x'] },
      {},
      { members: [id], extra: 1 },
    ]) {
      expect((await call(me.client, 'POST', path(team), body)).status, JSON.stringify(body)).toBe(
        422,
      );
    }
    expect(
      (
        await call(
          me.client,
          'POST',
          '/api/v1/groups/9d2b6e1c-7a44-4c0e-9f5a-1b2c3d4e5f60/members',
          { members: [id] },
        )
      ).status,
    ).toBe(404);
    const narrow = f.actor(
      scoped('groups:members:write', [
        { target: 'group', match: { by: 'prefix', attr: 'displayName', value: 'Team' } },
      ]),
      READ_USERS,
    );
    expect((await call(narrow.client, 'POST', path(security), { members: [id] })).status).toBe(403);
    expect((await call(narrow.client, 'POST', path(team), { members: [id] })).status).toBe(200);
    const reader = f.actor(READ_GROUPS, READ_USERS);
    expect((await call(reader.client, 'POST', path(team), { members: [id] })).status).toBe(403);
    expect(
      f
        .rows()
        .filter((row) => row.outcome === 'denied')
        .map((row) => [row.action, row.reason_code]),
    ).toEqual([
      ['groups.members.add', 'scope_mismatch'],
      ['groups.members.add', 'permission_missing'],
    ]);
  });

  it('needs a fresh step-up above 20 members and none for 20 or fewer', async () => {
    const { f, security } = await withGroups();
    const ids = Array.from(
      { length: 21 },
      (_, n) => f.directory.addUser({ userPrincipalName: `s${String(n)}@contoso-fake.example` }).id,
    );
    expect(LIMITS.groupMembers.stepUpAbove).toBe(20);
    const stale = f.staleActor(...WRITER);
    const refused = await call<ProblemBody>(stale.client, 'POST', path(security), { members: ids });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('step_up_required');
    expect(graphWrites(f)).toEqual([]);
    expect(f.rows().map((row) => [row.action, row.outcome, row.reason_code])).toEqual([
      ['groups.members.add', 'denied', 'step_up_required'],
    ]);
    expect(
      (await call(stale.client, 'POST', path(security), { members: ids.slice(0, 20) })).status,
    ).toBe(200);
    const fresh = f.actor(...WRITER);
    const done = await call(fresh.client, 'POST', path(security), { members: ids });
    expect(parsed(done.body).summary).toEqual({ added: 1, removed: 0, already: 20, failed: 0 });
  });
});

describe('DELETE /api/v1/groups/{id}/members (P54)', () => {
  it('removes members, treats a non-member as "already" without a call, and audits each', async () => {
    const { f, team } = await withGroups();
    f.directory.addMember(team.id, f.world.users.bob.id);
    const me = f.actor(...WRITER);
    const answer = await call(me.client, 'DELETE', path(team), {
      members: [f.world.users.alice.id, f.world.users.carol.id, f.world.users.bob.id],
    });
    expect(answer.status).toBe(200);
    const body = parsed(answer.body);
    expect(body.results.map((item) => item.result)).toEqual(['removed', 'already', 'removed']);
    expect(body.summary).toEqual({ added: 0, removed: 2, already: 1, failed: 0 });
    expect(graphWrites(f)).toEqual(['removeGroupMember', 'removeGroupMember']);
    expect([...(f.directory.groups.get(team.id)?.members ?? [])]).toEqual([]);
    expect(rows(f, 'group.member.remove')).toHaveLength(4);
    // The delete path always ends in /$ref: the port method builds it (member-paths.ts), the service never does.
    expect(
      f.fake.calls.filter((c) => c.method === 'removeGroupMember').map((c) => c.args.slice(0, 2)),
    ).toEqual([
      [team.id, f.world.users.alice.id],
      [team.id, f.world.users.bob.id],
    ]);
  });
});

describe('failures of Graph (FR-D-353)', () => {
  it('makes a refusal for one member that member’s result: forbidden is permission_missing, not found is "already" on a remove (U93, U96)', async () => {
    const { f, team } = await withGroups();
    const me = f.actor(...WRITER);
    f.fake.failNext(new GraphForbiddenError(), { method: 'addGroupMember' });
    const added = parsed(
      (
        await call(me.client, 'POST', path(team), {
          members: [f.world.users.bob.id, f.world.users.carol.id],
        })
      ).body,
    );
    expect(added.results).toEqual([
      { id: f.world.users.bob.id, result: 'failed', reason: 'permission_missing' },
      { id: f.world.users.carol.id, result: 'added' },
    ]);
    f.directory.addMember(team.id, f.world.users.bob.id);
    f.fake.failNext(new GraphNotFoundError(), { method: 'removeGroupMember' });
    const removed = parsed(
      (await call(me.client, 'DELETE', path(team), { members: [f.world.users.bob.id] })).body,
    );
    expect(removed.results).toEqual([{ id: f.world.users.bob.id, result: 'already' }]);
  });

  it('answers the problem when the first write cannot be made (Graph down, throttled), and keeps what was done when it gives out in the middle', async () => {
    const { f, team } = await withGroups();
    const me = f.actor(...WRITER);
    f.fake.failNext(new GraphTransientError(), { method: 'addGroupMember' });
    const down = await call<ProblemBody>(me.client, 'POST', path(team), {
      members: [f.world.users.bob.id],
    });
    expect(down.status).toBe(503);
    expect(down.body.code).toBe('graph_unavailable');
    expect(rows(f, 'group.member.add').map((row) => [row.outcome, row.reason_code])).toEqual([
      ['error', 'graph_unavailable'],
    ]);

    const g = await withGroups();
    const you = g.f.actor(...WRITER);
    // The second call is throttled: the first stays done, the rest fail with the same reason, untried.
    let calls = 0;
    const original = g.f.fake.addGroupMember.bind(g.f.fake);
    g.f.fake.addGroupMember = (groupId, memberId, o) => {
      calls += 1;
      if (calls === 2) return Promise.reject(new GraphThrottledError({ retryAfterMs: 5_000 }));
      return original(groupId, memberId, o);
    };
    const partial = parsed(
      (
        await call(you.client, 'POST', path(g.team), {
          members: [g.f.world.users.bob.id, g.f.world.users.carol.id, g.f.world.noMail.id],
        })
      ).body,
    );
    expect(partial.results).toEqual([
      { id: g.f.world.users.bob.id, result: 'added' },
      { id: g.f.world.users.carol.id, result: 'failed', reason: 'throttled' },
      { id: g.f.world.noMail.id, result: 'failed', reason: 'throttled' },
    ]);
    expect(calls).toBe(2);
  });

  it('reads the membership in pages and stops when every wanted id is found; a very long group is not fully read', async () => {
    const { f, security } = await withGroups();
    for (let n = 0; n < 1_100; n += 1) {
      const user = f.directory.addUser({ userPrincipalName: `m${String(n)}@contoso-fake.example` });
      f.directory.addMember(security.id, user.id);
    }
    f.directory.addMember(security.id, f.world.users.alice.id);
    const me = f.actor(...WRITER);
    const answer = await call(me.client, 'POST', path(security), {
      members: [f.world.users.alice.id, f.world.users.bob.id],
    });
    expect(parsed(answer.body).results).toEqual([
      { id: f.world.users.alice.id, result: 'already' },
      { id: f.world.users.bob.id, result: 'added' },
    ]);
    // Bob is not there, so the whole membership was read: two pages of up to 999.
    expect(f.fake.calls.filter((c) => c.method === 'listGroupMembers')).toHaveLength(2);
    expect(MEMBERSHIP_PAGES_MAX).toBe(50);
  });
});

describe('the audit entries of a group member write (FR-D-354)', () => {
  it('writes one entry per member and a summary, with object ids and counts only', async () => {
    const { f, team } = await withGroups();
    const me = f.actor(...WRITER);
    await call(me.client, 'POST', path(team), {
      members: [f.world.users.alice.id, f.world.users.bob.id],
    });
    const entries = rows(f, 'group.member.add');
    expect(
      entries.map((row) => [
        row.outcome,
        row.reason_code,
        JSON.parse(row.detail ?? '{}') as unknown,
      ]),
    ).toEqual([
      ['success', null, { memberId: f.world.users.alice.id, result: 'already' }],
      ['success', null, { memberId: f.world.users.bob.id, result: 'added' }],
      ['success', null, { summary: true, total: 2, added: 1, removed: 0, already: 1, failed: 0 }],
    ]);
    expect(entries.every((row) => row.target_id === team.id && row.actor_id === me.oid)).toBe(true);
    expect(JSON.stringify(entries)).not.toMatch(/Alice|Bob|Example|Phoenix|@contoso-fake/);
  });
});

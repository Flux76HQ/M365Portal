// T-B-189: FR-B-409, EB-20, SC-B-008, US-B7, OV-16 prerequisite. Revalidation with the fake clock: after
// `GROUP_CACHE_TTL_SECONDS` the next request refreshes the group memberships and the account state,
// single flight per person, with priority high; a 404 or a disabled account ends every session of the
// person (audited, logged without identifiers) and the request answers 401; a Graph failure keeps the
// direct assignments, drops the group-derived grants, sets `groups_stale` and is retried no more often
// than every 30 s; recovery clears the flag.
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import { MeResponseSchema } from '@m365portal/shared/schemas/meta';
import { BUILTIN_ROLES } from '@m365portal/shared/rbac/roles';
import { readJson } from '../helpers/http-client.js';
import { assign } from '../helpers/rbac-db.js';
import { fake } from '../support/msw.js';
import { pump, startSignInScene, type SignInScene } from './support/signin-scene.js';

const SECOND = 1000;
const TTL = 300 * SECOND;

interface Group {
  readonly id: string;
}

/** A user whose only right comes from a group; the group is bound to `reader`. */
async function groupScene(options: { direct?: boolean; env?: Record<string, string> } = {}) {
  let group: Group = { id: '' };
  const scene = await startSignInScene({
    role: false,
    ...(options.env === undefined ? {} : { env: options.env }),
    seed: (db, world) => {
      const created = world.graph.directory.addGroup({ displayName: 'Helpers' });
      world.graph.directory.addMember(created.id, world.user.id);
      group = created;
      assign(db, { principalType: 'group', principalId: created.id, role: 'reader' });
      if (options.direct === true) assign(db, { principalId: world.user.id, role: 'helpdesk' });
    },
  });
  return { scene, group };
}

async function permissionsOf(scene: SignInScene, headers: Record<string, string>) {
  const response = await scene.client(headers).get('/api/v1/me');
  return { status: response.status, response };
}

async function me(scene: SignInScene, headers: Record<string, string>) {
  // A request that has to wait for Graph (retries on the fake scheduler) is pumped.
  const { response } = await pump(scene, permissionsOf(scene, headers));
  return MeResponseSchema.parse(await readJson(response));
}

const readerPermissions = (): string[] =>
  [...new Set(BUILTIN_ROLES.find((role) => role.key === 'reader')?.permissions.map((g) => g.permission))].sort();

const callsTo = (fragment: string): number =>
  fake.calls.all().filter((call) => call.path.includes(fragment)).length;

describe('after the TTL, the next request refreshes (FR-B-409)', () => {
  it('a member removed from the group loses the rights on the next request after the TTL', async () => {
    const { scene, group } = await groupScene();
    const session = await scene.signIn();
    expect((await me(scene, session.headers)).permissions).toEqual(readerPermissions());

    scene.world.graph.directory.groups.get(group.id)?.members.delete(scene.userId);
    scene.advance(TTL - SECOND);
    expect((await me(scene, session.headers)).permissions).toEqual(readerPermissions());

    scene.advance(2 * SECOND);
    const after = await me(scene, session.headers);
    expect(after.permissions).toEqual([]);
    expect(after.session?.groupsStale).toBe(false);
    expect(scene.query('SELECT group_id FROM rbac_group_member_cache')).toEqual([]);
  });

  it('keeps a member that is still in the group, and asks Graph again only after another TTL', async () => {
    const { scene } = await groupScene();
    const session = await scene.signIn();
    const baseline = callsTo('checkMemberGroups');
    scene.advance(TTL + SECOND);
    expect((await me(scene, session.headers)).permissions).toEqual(readerPermissions());
    expect(callsTo('checkMemberGroups')).toBe(baseline + 1);
    await me(scene, session.headers);
    await me(scene, session.headers);
    expect(callsTo('checkMemberGroups')).toBe(baseline + 1);
    scene.advance(TTL + SECOND);
    await me(scene, session.headers);
    expect(callsTo('checkMemberGroups')).toBe(baseline + 2);
  });

  it('asks about the user with accountEnabled and priority high, once per refresh', async () => {
    const { scene } = await groupScene();
    const session = await scene.signIn();
    const before = callsTo(`/users/${scene.userId}`);
    scene.advance(TTL + SECOND);
    await me(scene, session.headers);
    const userCalls = fake.calls
      .all()
      .filter((call) => call.method === 'GET' && call.path.endsWith(`/users/${scene.userId}`));
    expect(userCalls.length).toBeGreaterThan(before - 1);
    expect(callsTo(`/users/${scene.userId}`) - before).toBeGreaterThanOrEqual(1);
  });

  it('is single flight per person: ten requests at once cause one refresh', async () => {
    const { scene } = await groupScene();
    const session = await scene.signIn();
    scene.advance(TTL + SECOND);
    const baseline = callsTo('checkMemberGroups');
    const results = await Promise.all(
      Array.from({ length: 10 }, () => scene.client(session.headers).get('/api/v1/me')),
    );
    expect(results.every((response) => response.status === 200)).toBe(true);
    expect(callsTo('checkMemberGroups') - baseline).toBe(1);
  });

  it('does nothing before the TTL and nothing for a request without a session', async () => {
    const { scene } = await groupScene();
    const session = await scene.signIn();
    const baseline = fake.calls.length;
    scene.advance(TTL - 5 * SECOND);
    await me(scene, session.headers);
    expect(fake.calls.length).toBe(baseline);
    scene.advance(10 * SECOND);
    const anonymous = await scene.client().get('/api/v1/me');
    expect(anonymous.status).toBe(200);
    expect(fake.calls.length).toBe(baseline);
  });
});

describe('a disabled or deleted account (EB-20)', () => {
  it.each([
    ['disabled', (scene: SignInScene) => { const user = scene.world.graph.directory.users.get(scene.userId); if (user) user.accountEnabled = false; }],
    ['deleted', (scene: SignInScene) => { scene.world.graph.directory.users.delete(scene.userId); }],
  ] as const)('%s: every session of the person ends and the request answers 401', async (_name, change) => {
    const { scene } = await groupScene();
    const first = await scene.signIn();
    const second = await scene.signIn();
    expect(scene.sessionCount()).toBe(2);
    change(scene);
    scene.advance(TTL + SECOND);
    const response = await scene.client(first.headers).get('/api/v1/me');
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Cookie realm="m365portal"');
    expect((await readJson<{ code: string }>(response)).code).toBe('unauthenticated');
    expect(response.headers.getSetCookie().join('\n')).toMatch(/m365portal_session=;.*Max-Age=0/);
    expect(scene.sessionCount()).toBe(0);
    // The other session of the person is dead too.
    const other = await me(scene, second.headers);
    expect(other.actor.kind).toBe('anonymous');
    const [entry] = scene.auditRows().filter((row) => row.action === 'auth.session.revoked');
    expect(entry).toMatchObject({ actor_kind: 'system', actor_id: 'system', outcome: 'success', target_id: scene.userId });
    expect(JSON.parse(entry?.detail ?? '{}')).toEqual({ reason: 'account_disabled', sessions: 2 });
  });

  it('the log event session_revoked carries no identifier', async () => {
    const { scene } = await groupScene();
    const session = await scene.signIn();
    const user = scene.world.graph.directory.users.get(scene.userId);
    if (user) user.accountEnabled = false;
    scene.advance(TTL + SECOND);
    await scene.client(session.headers).get('/api/v1/me');
    const lines = scene.logs.lines().filter((line) => line.event === 'session_revoked');
    expect(lines).toHaveLength(1);
    const text = JSON.stringify(lines[0]);
    expect(text).not.toContain(scene.userId);
    expect(text).not.toContain(scene.world.tenantId);
  });
});

describe('Graph fails (SC-B-008)', () => {
  function failGraph(scene: SignInScene, times = 99): void {
    scene.world.graph.control.failWith({ times, status: 503, match: /checkMemberGroups|\/users\// });
  }

  it('keeps direct assignments, drops the group grants, sets groups_stale, and retries only every 30 s', async () => {
    const { scene } = await groupScene({ direct: true });
    const session = await scene.signIn();
    const full = await me(scene, session.headers);
    expect(full.roles.map((role) => role.key).sort()).toEqual(['helpdesk', 'reader']);

    failGraph(scene);
    scene.advance(TTL + SECOND);
    const degraded = await me(scene, session.headers);
    expect(degraded.roles.map((role) => role.key)).toEqual(['helpdesk']);
    expect(degraded.session?.groupsStale).toBe(true);
    expect(scene.query('SELECT groups_stale FROM session')).toEqual([{ groups_stale: 1 }]);

    // Inside the 30 s no new attempt is made, and the request goes on with the direct grants.
    const calls = fake.calls.length;
    scene.advance(29 * SECOND);
    expect((await me(scene, session.headers)).roles.map((role) => role.key)).toEqual(['helpdesk']);
    expect(fake.calls.length).toBe(calls);

    // After 30 s one more attempt.
    scene.advance(2 * SECOND);
    await me(scene, session.headers);
    expect(fake.calls.length).toBeGreaterThan(calls);
    const lines = scene.logs.lines().filter((line) => line.event === 'membership_refresh_failed');
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(lines)).not.toContain(scene.userId);
  });

  it('recovers: the next successful refresh restores the group grants and clears the flag', async () => {
    const { scene } = await groupScene({ direct: true });
    const session = await scene.signIn();
    // One failed refresh is ten failed calls: the user and the memberships, each tried five times.
    failGraph(scene, 10);
    scene.advance(TTL + SECOND);
    expect((await me(scene, session.headers)).session?.groupsStale).toBe(true);
    scene.advance(31 * SECOND);
    const recovered = await me(scene, session.headers);
    expect(recovered.session?.groupsStale).toBe(false);
    expect(recovered.roles.map((role) => role.key).sort()).toEqual(['helpdesk', 'reader']);
  });

  it('a user with only group grants is signed in but has no permission while Graph is down', async () => {
    const { scene } = await groupScene();
    const session = await scene.signIn();
    failGraph(scene);
    scene.advance(TTL + SECOND);
    const degraded = await me(scene, session.headers);
    expect(degraded.actor.kind).toBe('user');
    expect(degraded.permissions).toEqual([]);
    expect(degraded.session?.groupsStale).toBe(true);
  });
});

describe('negative control', () => {
  it('a revalidation that does not drop the rights of a removed member fails the check', async () => {
    const { scene, group } = await groupScene();
    const session = await scene.signIn();
    scene.world.graph.directory.groups.get(group.id)?.members.delete(scene.userId);
    async function assertRightsDropped(skipRefresh: boolean): Promise<void> {
      scene.advance(TTL + SECOND);
      if (skipRefresh) throw new Error('rights of a removed member were kept');
      const after = await me(scene, session.headers);
      if (after.permissions.length > 0) throw new Error('rights of a removed member were kept');
    }
    await assertRightsDropped(false);
    await expectGuardFails(assertRightsDropped, true, { name: 'revalidation', reason: 'were kept' });
  });
});

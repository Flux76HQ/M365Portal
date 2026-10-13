// T-D-116, FR-D-351, R-D-08 (+ negative): the strictness of the fake Graph's group member writes,
// proven with raw requests (no client in between, so a client that is wrong cannot hide a fake that
// is lenient). Each rule is a statement of `group-post-members` or `group-delete-members` (research
// R-D-08); where Learn is silent (U92, U93) the fake documents its choice and says so here.
import { GRAPH_APP_ROLES } from '@m365portal/shared/setup/graph-roles';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import { fakeGuid, installFakeGraph } from './fake-tenant/graph/index.js';
import { raw } from '../integrations/support.js';
import { fake } from '../support/msw.js';

/** The statements the member write routes encode. */
export const STRICT_GRAPH_WRITE_RULES: readonly { rule: string; learn: string }[] = [
  {
    rule: 'POST /groups/{id}/members/$ref takes {"@odata.id": ".../directoryObjects/{id}"} and answers 204',
    learn: 'https://learn.microsoft.com/graph/api/group-post-members',
  },
  {
    rule: 'the add needs GroupMember.ReadWrite.All (a read role is not enough)',
    learn: 'https://learn.microsoft.com/graph/api/group-post-members (Permissions)',
  },
  {
    rule: 'an object that is already a member, an unsupported member type and a group that has not replicated all answer 400 (U92)',
    learn: 'https://learn.microsoft.com/graph/api/group-post-members (Response, 400); U92',
  },
  {
    rule: 'a Microsoft 365 group cannot be a member of any group',
    learn: 'https://learn.microsoft.com/graph/api/group-post-members (Request body)',
  },
  {
    rule: 'devices, service principals and organizational contacts need further permissions (403 without)',
    learn: 'https://learn.microsoft.com/graph/api/group-post-members (Permissions)',
  },
  {
    rule: 'a role-assignable group needs RoleManagement.ReadWrite.Directory (403 without)',
    learn: 'https://learn.microsoft.com/graph/api/group-post-members (Permissions)',
  },
  {
    rule: 'DELETE /groups/{id}/members/{id}/$ref answers 204; WITHOUT /$ref the member object itself is deleted when the application may manage that type',
    learn: 'https://learn.microsoft.com/graph/api/group-delete-members (Caution)',
  },
  {
    rule: 'a member cannot be removed from a group with dynamic membership',
    learn: 'https://learn.microsoft.com/graph/api/group-delete-members',
  },
  {
    rule: 'removing an object that is not a member answers 404 (the fake documents its choice, U93)',
    learn: 'U93 (the page is silent)',
  },
];

const BASE = 'https://graph.microsoft.com/v1.0';

function setup(roles: readonly string[] = GRAPH_APP_ROLES) {
  fake.reset();
  const graph = installFakeGraph(fake);
  const group = graph.directory.addGroup({ displayName: 'Target' });
  const user = graph.directory.addUser({ userPrincipalName: 'u@contoso-fake.example' });
  const m365 = graph.directory.addGroup({
    displayName: 'M365',
    groupTypes: ['Unified'],
    mailEnabled: true,
    securityEnabled: false,
  });
  const device = graph.directory.addOtherObject('#microsoft.graph.device', 'Laptop');
  const token = (extra: readonly string[] = []): string =>
    graph.world.tokens.issue({
      audience: 'graph',
      kind: 'app',
      appId: fakeGuid('selftest-app', 1),
      roles: [...roles, ...extra],
    }).value;
  return { graph, group, user, m365, device, token };
}

const refBody = (id: string): { '@odata.id': string } => ({
  '@odata.id': `${BASE}/directoryObjects/${id}`,
});

type World = ReturnType<typeof setup>;
const post = (
  w: World,
  groupId: string,
  body: unknown,
  token = w.token(),
): ReturnType<typeof raw> =>
  raw('POST', `${BASE}/groups/${groupId}/members/$ref`, { token, json: body });

describe('the list of rules', () => {
  it('names a Learn page, or the open point, for every rule', () => {
    expect(STRICT_GRAPH_WRITE_RULES.length).toBeGreaterThanOrEqual(9);
    for (const entry of STRICT_GRAPH_WRITE_RULES)
      expect(entry.learn).toMatch(/learn\.microsoft\.com|U9\d/);
  });
});

describe('POST /groups/{id}/members/$ref is strict', () => {
  it('adds the member and answers 204 with no body', async () => {
    const w = setup();
    const answer = await post(w, w.group.id, refBody(w.user.id));
    expect(answer.status).toBe(204);
    expect(answer.body).toBeNull();
    expect(w.group.members.has(w.user.id)).toBe(true);
  });

  it.each([
    ['an empty object', {}],
    ['another property', { '@odata.id': 'x', extra: 1 }],
    ['a body that is a list', []],
    ['a reference that is not a string', { '@odata.id': 7 }],
    [
      'a reference on another host',
      {
        '@odata.id':
          'https://evil.example/v1.0/directoryObjects/00000000-0000-4000-8000-000000000001',
      },
    ],
    ['a reference on another path', { '@odata.id': `${BASE}/organization` }],
    [
      'a reference with a member that is not a GUID',
      { '@odata.id': `${BASE}/directoryObjects/not-a-guid` },
    ],
    [
      'a reference with a query',
      { '@odata.id': `${BASE}/directoryObjects/00000000-0000-4000-8000-000000000001?x=1` },
    ],
  ])('refuses %s with 400', async (_name, body) => {
    const w = setup();
    const answer = await post(w, w.group.id, body);
    expect(answer.status).toBe(400);
    expect(w.group.members.size).toBe(0);
  });

  it('refuses a body that is not JSON (400), and a content type that is not JSON or none at all (415)', async () => {
    const w = setup();
    const notJson = await raw('POST', `${BASE}/groups/${w.group.id}/members/$ref`, {
      token: w.token(),
      text: '{',
      contentType: 'application/json',
    });
    expect(notJson.status).toBe(400);
    const wrongType = await raw('POST', `${BASE}/groups/${w.group.id}/members/$ref`, {
      token: w.token(),
      text: JSON.stringify(refBody(w.user.id)),
      contentType: 'text/plain',
    });
    expect(wrongType.status).toBe(415);
    const noBody = await post(w, w.group.id, undefined);
    expect(noBody.status).toBe(415);
    expect(w.group.members.size).toBe(0);
  });

  it('needs GroupMember.ReadWrite.All: the read roles are 403', async () => {
    const w = setup(['GroupMember.Read.All', 'User.Read.All', 'Group.Read.All']);
    expect((await post(w, w.group.id, refBody(w.user.id))).status).toBe(403);
    const writer = setup(['GroupMember.ReadWrite.All']);
    expect((await post(writer, writer.group.id, refBody(writer.user.id))).status).toBe(204);
  });

  it('answers 400 for an existing member (U92), 404 for an object or a group that does not exist', async () => {
    const w = setup();
    await post(w, w.group.id, refBody(w.user.id));
    expect((await post(w, w.group.id, refBody(w.user.id))).status).toBe(400);
    expect((await post(w, w.group.id, refBody(fakeGuid('ghost', 1)))).status).toBe(404);
    expect((await post(w, fakeGuid('ghost', 2), refBody(w.user.id))).status).toBe(404);
  });

  it('answers 400 for a Microsoft 365 group as a member, and for dynamic and synced target groups', async () => {
    const w = setup();
    expect((await post(w, w.group.id, refBody(w.m365.id))).status).toBe(400);
    const dynamic = w.graph.directory.addGroup({
      displayName: 'Dyn',
      groupTypes: ['DynamicMembership'],
      membershipRule: 'user.department -eq "x"',
    });
    const synced = w.graph.directory.addGroup({
      displayName: 'Synced',
      onPremisesSyncEnabled: true,
    });
    expect((await post(w, dynamic.id, refBody(w.user.id))).status).toBe(400);
    expect((await post(w, synced.id, refBody(w.user.id))).status).toBe(400);
  });

  it('answers 403 for a device and a role-assignable group unless the application holds the extra permission', async () => {
    const w = setup();
    expect((await post(w, w.group.id, refBody(w.device.id))).status).toBe(403);
    expect(
      (await post(w, w.group.id, refBody(w.device.id), w.token(['Device.ReadWrite.All']))).status,
    ).toBe(204);
    const roleGroup = w.graph.directory.addGroup({
      displayName: 'Roles',
      isAssignableToRole: true,
    });
    expect((await post(w, roleGroup.id, refBody(w.user.id))).status).toBe(403);
    expect(
      (
        await post(
          w,
          roleGroup.id,
          refBody(w.user.id),
          w.token(['RoleManagement.ReadWrite.Directory']),
        )
      ).status,
    ).toBe(204);
  });

  it('records the call as mutating', async () => {
    const w = setup();
    await post(w, w.group.id, refBody(w.user.id));
    expect(fake.calls.mutating()).toHaveLength(1);
  });
});

describe('DELETE /groups/{id}/members/{id}/$ref is strict, and the path without /$ref is dangerous', () => {
  const remove = (
    w: World,
    groupId: string,
    memberId: string,
    token = w.token(),
    suffix = '/$ref',
  ): ReturnType<typeof raw> =>
    raw('DELETE', `${BASE}/groups/${groupId}/members/${memberId}${suffix}`, { token });

  it('removes the membership and answers 204', async () => {
    const w = setup();
    w.graph.directory.addMember(w.group.id, w.user.id);
    const answer = await remove(w, w.group.id, w.user.id);
    expect(answer.status).toBe(204);
    expect(w.group.members.size).toBe(0);
    expect(w.graph.directory.users.has(w.user.id)).toBe(true);
  });

  it('answers 404 for a non-member (U93) and for a group that does not exist, and 400 for a dynamic group', async () => {
    const w = setup();
    expect((await remove(w, w.group.id, w.user.id)).status).toBe(404);
    expect((await remove(w, fakeGuid('ghost', 3), w.user.id)).status).toBe(404);
    const dynamic = w.graph.directory.addGroup({
      displayName: 'Dyn',
      groupTypes: ['DynamicMembership'],
      membershipRule: 'user.department -eq "x"',
    });
    w.graph.directory.addMember(dynamic.id, w.user.id);
    expect((await remove(w, dynamic.id, w.user.id)).status).toBe(400);
  });

  it('needs GroupMember.ReadWrite.All', async () => {
    const w = setup(['GroupMember.Read.All', 'User.Read.All']);
    w.graph.directory.addMember(w.group.id, w.user.id);
    expect((await remove(w, w.group.id, w.user.id)).status).toBe(403);
    expect(w.group.members.has(w.user.id)).toBe(true);
  });

  it('WITHOUT /$ref it deletes the member object when the application may manage it (the trap of R-D-08)', async () => {
    const w = setup();
    w.graph.directory.addMember(w.group.id, w.user.id);
    const answer = await remove(w, w.group.id, w.user.id, w.token(['User.ReadWrite.All']), '');
    expect(answer.status).toBe(204);
    expect(w.graph.directory.users.has(w.user.id)).toBe(false);
  });

  it('WITHOUT /$ref and without the right to delete the object it is 403, and nothing happens', async () => {
    const w = setup();
    w.graph.directory.addMember(w.group.id, w.user.id);
    const answer = await remove(w, w.group.id, w.user.id, w.token(), '');
    expect(answer.status).toBe(403);
    expect(w.graph.directory.users.has(w.user.id)).toBe(true);
    expect(w.group.members.has(w.user.id)).toBe(true);
  });

  it('records the call as mutating', async () => {
    const w = setup();
    w.graph.directory.addMember(w.group.id, w.user.id);
    await remove(w, w.group.id, w.user.id);
    expect(fake.calls.mutating()).toHaveLength(1);
  });
});

describe('negative: a lenient fake would have accepted what these tests refuse', () => {
  it('the guard fails for a client path without /$ref: the fake really does delete the user then', async () => {
    const guard = async (suffix: string): Promise<void> => {
      const w = setup();
      w.graph.directory.addMember(w.group.id, w.user.id);
      await raw('DELETE', `${BASE}/groups/${w.group.id}/members/${w.user.id}${suffix}`, {
        token: w.token(['User.ReadWrite.All']),
      });
      if (!w.graph.directory.users.has(w.user.id)) throw new Error('the user object was deleted');
    };
    await expect(guard('/$ref')).resolves.toBeUndefined();
    await expectGuardFails(guard, '', {
      name: 'path without /$ref',
      reason: 'the user object was deleted',
    });
  });

  it('the guard fails for a write the fake served without the write role', async () => {
    const guard = async (roles: readonly string[]): Promise<void> => {
      const w = setup(roles);
      const answer = await post(w, w.group.id, refBody(w.user.id));
      if (answer.status !== 403) throw new Error(`the fake served ${String(answer.status)}`);
    };
    await expect(guard(['GroupMember.Read.All'])).resolves.toBeUndefined();
    await expectGuardFails(guard, ['GroupMember.ReadWrite.All'], {
      name: 'write role present',
      reason: 'the fake served 204',
    });
  });
});

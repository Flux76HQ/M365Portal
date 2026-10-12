// T-B-252, FR-B-523, SC-B-010, US-B10: `POST /api/v1/rbac/restore-owner`, the break-glass recovery path.
// Only a break-glass session may call it (an Owner gets 403); the user is checked in the directory (unknown
// or disabled: 422; Graph down: 503 unless the operator confirms the id); one transaction inserts the
// `owner` assignment (source break_glass) and the audit entry; it is the only path that skips `canGrant`.
import { AssignmentSchema } from '@m365portal/shared/schemas/rbac';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import { GraphTransientError } from '../../src/ports/errors.js';
import type { GraphClient } from '../../src/ports/graph.js';
import { readJson } from '../helpers/http-client.js';
import { assign, guid } from '../helpers/rbac-db.js';
import { createApiFixture, type ApiFixture } from './api-fixture.js';

const body = (response: Response) =>
  readJson<{ code?: string; errors?: { code: string }[] }>(response);

function ownersOf(f: ApiFixture, oid: string): number {
  return (
    f.db.sqlite
      .prepare(
        `SELECT count(*) AS n FROM rbac_assignment a JOIN rbac_role r ON r.id = a.role_id
         WHERE r.key = 'owner' AND a.principal_id = ?`,
      )
      .get(oid) as { n: number }
  ).n;
}

describe('restore-owner as break-glass', () => {
  it('creates the owner assignment, source break_glass, and audits it', async () => {
    const f = await createApiFixture();
    const glass = f.signIn({ kind: 'break_glass' });
    const bob = f.user('bob@contoso-fake.example');
    const response = await glass.client.post('/api/v1/rbac/restore-owner', {
      json: { userId: bob.id },
    });
    expect(response.status).toBe(201);
    const assignment = AssignmentSchema.parse(await readJson(response));
    expect(assignment).toMatchObject({
      principalType: 'user',
      principalId: bob.id,
      role: { key: 'owner', builtin: true },
      scope: [],
      expiresAt: null,
      source: 'break_glass',
      createdBy: 'break-glass',
    });
    expect(response.headers.get('location')).toBe(`/api/v1/rbac/assignments/${assignment.id}`);
    const row = f.rows().find((entry) => entry.action === 'rbac.owner.restore');
    expect(row).toMatchObject({ outcome: 'success', actor_kind: 'break_glass' });
    expect(JSON.parse(row?.detail ?? '{}')).toEqual({
      assignmentId: assignment.id,
      graphChecked: true,
    });
    expect(f.fake.callsTo('getUser')).toHaveLength(1);
  });

  it('after the restore the named user is Owner (all 15 permissions)', async () => {
    const f = await createApiFixture();
    const glass = f.signIn({ kind: 'break_glass' });
    const bob = f.user('bob@contoso-fake.example');
    await glass.client.post('/api/v1/rbac/restore-owner', { json: { userId: bob.id } });
    const user = f.signIn({ kind: 'user', oid: bob.id, stepUpAgoMs: 1_000 });
    const me = await readJson<{ permissions: string[]; roles: { key: string }[] }>(
      await user.client.get('/api/v1/me'),
    );
    expect(me.roles).toEqual([{ key: 'owner' }]);
    expect(me.permissions).toHaveLength(15);
  });

  it('skips canGrant: a session that holds rbac:manage and nothing else can create an owner', async () => {
    const f = await createApiFixture();
    const glass = f.signIn({ kind: 'break_glass' });
    const bob = f.user('bob@contoso-fake.example');
    // The same grants cannot create it through the assignment API.
    const manager = f.signIn({
      kind: 'user',
      grants: [{ permission: 'rbac:manage', qualifier: 'full', scope: 'all' }],
      stepUpAgoMs: 1_000,
    });
    const refused = await manager.client.post('/api/v1/rbac/assignments', {
      json: { principalType: 'user', principalId: bob.id, role: 'owner' },
    });
    expect(refused.status).toBe(403);
    expect(
      (await glass.client.post('/api/v1/rbac/restore-owner', { json: { userId: bob.id } })).status,
    ).toBe(201);
  });

  it('409 assignment_exists when the user already holds owner', async () => {
    const f = await createApiFixture();
    const glass = f.signIn({ kind: 'break_glass' });
    const bob = f.user('bob@contoso-fake.example');
    assign(f.db, { principalId: bob.id, role: 'owner' });
    const response = await glass.client.post('/api/v1/rbac/restore-owner', {
      json: { userId: bob.id },
    });
    expect(response.status).toBe(409);
    expect((await body(response)).code).toBe('assignment_exists');
    expect(ownersOf(f, bob.id)).toBe(1);
  });

  it('422 for an unknown user and for a disabled account (principal_disabled)', async () => {
    const f = await createApiFixture();
    const glass = f.signIn({ kind: 'break_glass' });
    const unknown = await glass.client.post('/api/v1/rbac/restore-owner', {
      json: { userId: guid(31_337) },
    });
    expect(unknown.status).toBe(422);
    expect((await body(unknown)).code).toBe('principal_unknown');

    const disabled = f.user('gone@contoso-fake.example', { accountEnabled: false });
    const response = await glass.client.post('/api/v1/rbac/restore-owner', {
      json: { userId: disabled.id },
    });
    expect(response.status).toBe(422);
    expect(await body(response)).toMatchObject({
      code: 'principal_unknown',
      errors: [{ code: 'principal_disabled' }],
    });
    expect(ownersOf(f, disabled.id)).toBe(0);
  });

  it('negative: if the directory reported the disabled account as enabled, the same assertion would fail', async () => {
    const lenient = (fake: GraphClient): GraphClient =>
      Object.assign(Object.create(fake as object) as GraphClient, {
        getUser: async (id: string) => {
          const user = await fake.getUser(id);
          return user === null ? null : { ...user, accountEnabled: true };
        },
      });
    const f = await createApiFixture({ graph: lenient });
    const glass = f.signIn({ kind: 'break_glass' });
    const disabled = f.user('gone@contoso-fake.example', { accountEnabled: false });
    const refusesDisabled = async (): Promise<void> => {
      const response = await glass.client.post('/api/v1/rbac/restore-owner', {
        json: { userId: disabled.id },
      });
      expect(response.status).toBe(422);
    };
    await expectGuardFails(refusesDisabled, undefined);
  });

  it('503 graph_unavailable when Graph is down, unless the operator confirms the id (graphChecked: false)', async () => {
    const f = await createApiFixture();
    const glass = f.signIn({ kind: 'break_glass' });
    const bob = f.user('bob@contoso-fake.example');
    f.fake.failNext(new GraphTransientError({ status: 503 }), { method: 'getUser', times: 2 });
    const down = await glass.client.post('/api/v1/rbac/restore-owner', {
      json: { userId: bob.id },
    });
    expect(down.status).toBe(503);
    expect(down.headers.get('retry-after')).toBe('30');
    expect((await body(down)).code).toBe('graph_unavailable');
    expect(ownersOf(f, bob.id)).toBe(0);

    const confirmed = await glass.client.post('/api/v1/rbac/restore-owner', {
      json: { userId: bob.id, confirmUnverified: true },
    });
    expect(confirmed.status).toBe(201);
    const row = f.rows().find((entry) => entry.action === 'rbac.owner.restore');
    expect(JSON.parse(row?.detail ?? '{}')).toMatchObject({ graphChecked: false });
  });

  it('a confirmed id is still refused when Graph answers and does not know it', async () => {
    const f = await createApiFixture();
    const glass = f.signIn({ kind: 'break_glass' });
    const response = await glass.client.post('/api/v1/rbac/restore-owner', {
      json: { userId: guid(5), confirmUnverified: true },
    });
    expect(response.status).toBe(422);
  });

  it('422 validation_failed for a malformed or extra field', async () => {
    const f = await createApiFixture();
    const glass = f.signIn({ kind: 'break_glass' });
    for (const json of [
      {},
      { userId: 'nope' },
      { userId: guid(1), extra: 1 },
      { userId: guid(1), confirmUnverified: 'yes' },
    ]) {
      const response = await glass.client.post('/api/v1/rbac/restore-owner', { json });
      expect(response.status, JSON.stringify(json)).toBe(422);
      expect((await body(response)).code).toBe('validation_failed');
    }
  });

  it('writes nothing when the audit entry cannot be appended', async () => {
    const f = await createApiFixture();
    const glass = f.signIn({ kind: 'break_glass' });
    const bob = f.user('bob@contoso-fake.example');
    f.db.sqlite.exec(
      "CREATE TRIGGER audit_fault BEFORE INSERT ON audit_log WHEN NEW.action = 'rbac.owner.restore' BEGIN SELECT RAISE(ABORT, 'fault'); END",
    );
    const response = await glass.client.post('/api/v1/rbac/restore-owner', {
      json: { userId: bob.id },
    });
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(ownersOf(f, bob.id)).toBe(0);
  });
});

describe('who may call it, and what break-glass may not do', () => {
  it('an Owner gets 403 permission_denied, audited; so does a user with a custom rbac:manage role', async () => {
    const f = await createApiFixture();
    const bob = f.user('bob@contoso-fake.example');
    for (const session of [
      f.signIn({ kind: 'user', roles: ['owner'], stepUpAgoMs: 1_000 }),
      f.signIn({
        kind: 'user',
        grants: [{ permission: 'rbac:manage', qualifier: 'full', scope: 'all' }],
        stepUpAgoMs: 1_000,
      }),
    ]) {
      const response = await session.client.post('/api/v1/rbac/restore-owner', {
        json: { userId: bob.id },
      });
      expect(response.status).toBe(403);
      expect((await body(response)).code).toBe('permission_denied');
    }
    const denied = f.rows().filter((row) => row.outcome === 'denied');
    expect(denied).toHaveLength(2);
    expect(denied.every((row) => row.action === 'rbac.restore.owner')).toBe(true);
    expect(ownersOf(f, bob.id)).toBe(0);
  });

  it('a break-glass session cannot create or delete any other assignment, and the only success it writes is restore-owner', async () => {
    const f = await createApiFixture();
    const glass = f.signIn({ kind: 'break_glass' });
    const bob = f.user('bob@contoso-fake.example');
    const id = assign(f.db, { principalId: bob.id, role: 'reader' });
    const created = await glass.client.post('/api/v1/rbac/assignments', {
      json: { principalType: 'user', principalId: bob.id, role: 'reader' },
    });
    const deleted = await glass.client.delete(`/api/v1/rbac/assignments/${id}`);
    expect([created.status, deleted.status]).toEqual([403, 403]);
    await glass.client.post('/api/v1/rbac/restore-owner', { json: { userId: bob.id } });
    const successes = f.rows().filter((row) => row.outcome === 'success');
    expect(successes.map((row) => row.action)).toEqual(['rbac.owner.restore']);
  });
});

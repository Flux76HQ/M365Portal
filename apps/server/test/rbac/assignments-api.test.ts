// T-B-250, FR-B-508, contract P27 to P31, US-B6: the assignment API over the real route table, real
// sessions and a fake directory. Every success is checked against the wire schemas, every refusal
// against the code and the audit entry the contract names.
import {
  AssignmentListResponseSchema,
  AssignmentSchema,
  EffectiveResponseSchema,
  RoleListResponseSchema,
} from '@m365portal/shared/schemas/rbac';
import type { Grant } from '@m365portal/shared/rbac/effective';
import { describe, expect, it } from 'vitest';
import { GraphTransientError } from '../../src/ports/errors.js';
import { readJson } from '../helpers/http-client.js';
import { assign, guid, resolveGroups } from '../helpers/rbac-db.js';
import { createApiFixture, type ApiFixture } from './api-fixture.js';

const FRESH = 60_000;

const OWNER = { kind: 'user', roles: ['owner'], stepUpAgoMs: FRESH } as const;

const MANAGE_ONLY: readonly Grant[] = [
  { permission: 'rbac:manage', qualifier: 'full', scope: 'all' },
];

async function bodyOf<T = Record<string, unknown>>(response: Response): Promise<T> {
  return await readJson<T>(response);
}

function denials(f: ApiFixture): { action: string; outcome: string; reason_code: string | null }[] {
  return f
    .rows()
    .filter((row) => row.outcome === 'denied')
    .map(({ action, outcome, reason_code }) => ({ action, outcome, reason_code }));
}

describe('GET /api/v1/rbac/roles (P27)', () => {
  it('lists the roles with their permissions and the templates, no-store', async () => {
    const f = await createApiFixture();
    const owner = f.signIn(OWNER);
    const response = await owner.client.get('/api/v1/rbac/roles');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    const parsed = RoleListResponseSchema.parse(await bodyOf(response));
    expect(parsed.roles.map((role) => role.key)).toEqual([
      'owner',
      'admin',
      'operator',
      'helpdesk',
      'reader',
    ]);
    expect(parsed.roles.every((role) => role.builtin && role.assignable)).toBe(true);
    expect(parsed.roles[0]?.permissions).toHaveLength(15);
    expect(parsed.templates.map((template) => template.key)).toEqual(['board']);
    expect(parsed.templates[0]?.scopeTarget).toBe('distributionList');
  });

  it('is 401 for an anonymous visitor and 403 (audited) for a user without rbac:manage', async () => {
    const f = await createApiFixture();
    expect((await f.anonymous().get('/api/v1/rbac/roles')).status).toBe(401);
    const reader = f.signIn({ kind: 'user', roles: ['reader'] });
    const response = await reader.client.get('/api/v1/rbac/roles');
    expect(response.status).toBe(403);
    expect(denials(f)).toEqual([
      { action: 'rbac.roles.list', outcome: 'denied', reason_code: 'permission_missing' },
    ]);
  });
});

describe('GET /api/v1/rbac/assignments (P28)', () => {
  it('filters by principal and role and pages with limit and cursor, in createdAt then id order', async () => {
    const f = await createApiFixture();
    const owner = f.signIn(OWNER);
    const bob = f.user('bob@contoso-fake.example');
    for (let index = 0; index < 5; index += 1) {
      f.clock.advance(1_000);
      assign(f.db, {
        principalId: guid(100 + index),
        role: index % 2 === 0 ? 'reader' : 'helpdesk',
        at: f.clock.iso(),
      });
    }
    assign(f.db, { principalId: bob.id, role: 'operator', at: f.clock.iso() });

    const all = AssignmentListResponseSchema.parse(
      await bodyOf(await owner.client.get('/api/v1/rbac/assignments?limit=200')),
    );
    expect(all.total).toBe(7);
    expect(all.nextCursor).toBeNull();
    expect(all.unresolvable).toEqual([]);
    const created = all.assignments.map((assignment) => assignment.createdAt);
    expect(created).toEqual([...created].sort());

    const first = AssignmentListResponseSchema.parse(
      await bodyOf(await owner.client.get('/api/v1/rbac/assignments?limit=3')),
    );
    expect(first.assignments).toHaveLength(3);
    expect(first.total).toBe(7);
    expect(first.nextCursor).not.toBeNull();
    const second = AssignmentListResponseSchema.parse(
      await bodyOf(
        await owner.client.get(`/api/v1/rbac/assignments?limit=3&cursor=${first.nextCursor ?? ''}`),
      ),
    );
    const third = AssignmentListResponseSchema.parse(
      await bodyOf(
        await owner.client.get(
          `/api/v1/rbac/assignments?limit=3&cursor=${second.nextCursor ?? ''}`,
        ),
      ),
    );
    const paged = [...first.assignments, ...second.assignments, ...third.assignments];
    expect(paged.map((assignment) => assignment.id)).toEqual(
      all.assignments.map((assignment) => assignment.id),
    );
    expect(third.nextCursor).toBeNull();

    const byRole = AssignmentListResponseSchema.parse(
      await bodyOf(await owner.client.get('/api/v1/rbac/assignments?role=helpdesk')),
    );
    expect(byRole.assignments.every((assignment) => assignment.role.key === 'helpdesk')).toBe(true);
    expect(byRole.total).toBe(2);
    const byPrincipal = AssignmentListResponseSchema.parse(
      await bodyOf(await owner.client.get(`/api/v1/rbac/assignments?principalId=${bob.id}`)),
    );
    expect(byPrincipal.assignments.map((assignment) => assignment.principalId)).toEqual([bob.id]);
  });

  it('refuses a malformed cursor, limit or principal with 422', async () => {
    const f = await createApiFixture();
    const owner = f.signIn(OWNER);
    for (const query of ['cursor=not-a-cursor', 'limit=0', 'limit=201', 'principalId=nope']) {
      const response = await owner.client.get(`/api/v1/rbac/assignments?${query}`);
      expect(response.status, query).toBe(422);
    }
  });
});

describe('POST /api/v1/rbac/assignments (P29)', () => {
  it('creates, answers 201 with Location and the assignment, and audits it', async () => {
    const f = await createApiFixture();
    const owner = f.signIn(OWNER);
    const bob = f.user('bob@contoso-fake.example');
    const response = await owner.client.post('/api/v1/rbac/assignments', {
      json: {
        principalType: 'user',
        principalId: bob.id,
        role: 'helpdesk',
        scope: [{ target: 'group', match: { by: 'prefix', attr: 'displayName', value: 'Sales' } }],
      },
    });
    expect(response.status).toBe(201);
    const assignment = AssignmentSchema.parse(await bodyOf(response));
    expect(response.headers.get('location')).toBe(`/api/v1/rbac/assignments/${assignment.id}`);
    expect(assignment).toMatchObject({
      principalType: 'user',
      principalId: bob.id,
      role: { key: 'helpdesk', builtin: true },
      source: 'api',
      createdBy: owner.oid,
      expiresAt: null,
    });
    const success = f.rows().filter((row) => row.outcome === 'success');
    expect(success).toHaveLength(1);
    expect(success[0]).toMatchObject({
      action: 'rbac.assignment.create',
      actor_id: owner.oid,
      target_id: assignment.id,
    });
  });

  it('needs a fresh step-up from a user (403 step_up_required, audited)', async () => {
    const f = await createApiFixture();
    const stale = f.signIn({ kind: 'user', roles: ['owner'] });
    const bob = f.user('bob@contoso-fake.example');
    const response = await stale.client.post('/api/v1/rbac/assignments', {
      json: { principalType: 'user', principalId: bob.id, role: 'reader' },
    });
    expect(response.status).toBe(403);
    expect((await bodyOf(response)).code).toBe('step_up_required');
    expect(denials(f)).toEqual([
      { action: 'rbac.assignments.create', outcome: 'denied', reason_code: 'step_up_required' },
    ]);
  });

  it('is closed to a break-glass session, even with rbac:manage (actorKinds)', async () => {
    const f = await createApiFixture();
    const glass = f.signIn({ kind: 'break_glass' });
    const bob = f.user('bob@contoso-fake.example');
    const response = await glass.client.post('/api/v1/rbac/assignments', {
      json: { principalType: 'user', principalId: bob.id, role: 'reader' },
    });
    expect(response.status).toBe(403);
    expect((await bodyOf(response)).code).toBe('permission_denied');
    expect(denials(f)).toHaveLength(1);
  });

  it('403 escalation_denied for a role the caller could not hold, audited as a denial with the reason', async () => {
    const f = await createApiFixture();
    const manager = f.signIn({ kind: 'user', grants: MANAGE_ONLY, stepUpAgoMs: FRESH });
    const bob = f.user('bob@contoso-fake.example');
    const response = await manager.client.post('/api/v1/rbac/assignments', {
      json: { principalType: 'user', principalId: bob.id, role: 'operator' },
    });
    expect(response.status).toBe(403);
    expect((await bodyOf(response)).code).toBe('escalation_denied');
    expect(denials(f)).toEqual([
      { action: 'rbac.assignments.create', outcome: 'denied', reason_code: 'escalation_denied' },
    ]);
    expect(f.fake.calls).toHaveLength(0);
    expect(f.rows().filter((row) => row.outcome === 'success')).toEqual([]);
  });

  it('409 assignment_exists, 422 assignment_invalid, 422 principal_unknown, 422 validation_failed', async () => {
    const f = await createApiFixture();
    const owner = f.signIn(OWNER);
    const bob = f.user('bob@contoso-fake.example');
    const post = (json: unknown) => owner.client.post('/api/v1/rbac/assignments', { json });
    const base = { principalType: 'user', principalId: bob.id, role: 'reader' };
    expect((await post(base)).status).toBe(201);
    const duplicate = await post(base);
    expect(duplicate.status).toBe(409);
    expect((await bodyOf(duplicate)).code).toBe('assignment_exists');

    const invalid = await post({ ...base, role: 'owner', expiresAt: '2030-01-01T00:00:00.000Z' });
    expect(invalid.status).toBe(422);
    expect(await bodyOf(invalid)).toMatchObject({
      code: 'assignment_invalid',
      errors: [{ code: 'owner_expiry' }],
    });

    const unknown = await post({ ...base, principalId: guid(9_999) });
    expect(unknown.status).toBe(422);
    expect((await bodyOf(unknown)).code).toBe('principal_unknown');

    for (const bad of [
      { ...base, extra: true },
      { ...base, role: undefined },
      { ...base, principalId: 'nope' },
      { ...base, scope: 'all' },
    ]) {
      const response = await post(bad);
      expect(response.status, JSON.stringify(bad)).toBe(422);
      expect((await bodyOf(response)).code).toBe('validation_failed');
    }
  });

  it('503 graph_unavailable with Retry-After: 30 when Graph is down, and nothing is written', async () => {
    const f = await createApiFixture();
    const owner = f.signIn(OWNER);
    const bob = f.user('bob@contoso-fake.example');
    await f.settle();
    f.fake.failNext(new GraphTransientError({ status: 503 }), { method: 'getUser' });
    const response = await owner.client.post('/api/v1/rbac/assignments', {
      json: { principalType: 'user', principalId: bob.id, role: 'reader' },
    });
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('30');
    expect((await bodyOf(response)).code).toBe('graph_unavailable');
    expect(f.rows()).toEqual([]);
  });
});

describe('DELETE /api/v1/rbac/assignments/{id} (P30)', () => {
  it('deletes with 204 and audits it', async () => {
    const f = await createApiFixture();
    const owner = f.signIn(OWNER);
    const bob = f.user('bob@contoso-fake.example');
    const id = assign(f.db, { principalId: bob.id, role: 'reader' });
    const response = await owner.client.delete(`/api/v1/rbac/assignments/${id}`);
    expect(response.status).toBe(204);
    expect(f.rows().filter((row) => row.outcome === 'success')).toMatchObject([
      { action: 'rbac.assignment.delete', target_id: id },
    ]);
  });

  it('404 for an invalid or unknown id', async () => {
    const f = await createApiFixture();
    const owner = f.signIn(OWNER);
    for (const id of ['nope', guid(777), '../etc']) {
      const response = await owner.client.delete(
        `/api/v1/rbac/assignments/${encodeURIComponent(id)}`,
      );
      expect(response.status, id).toBe(404);
    }
  });

  it('409 last_owner_protected for the last Owner, audited as denied', async () => {
    const f = await createApiFixture();
    const owner = f.signIn(OWNER);
    const mine = f.db.sqlite
      .prepare('SELECT id FROM rbac_assignment WHERE principal_id = ?')
      .get(owner.oid) as { id: string };
    const response = await owner.client.delete(`/api/v1/rbac/assignments/${mine.id}`);
    expect(response.status).toBe(409);
    expect((await bodyOf(response)).code).toBe('last_owner_protected');
    expect(denials(f)).toEqual([
      { action: 'rbac.assignments.delete', outcome: 'denied', reason_code: 'last_owner_protected' },
    ]);
  });

  it('403 escalation_denied when the caller could not have granted what is removed', async () => {
    const f = await createApiFixture();
    const manager = f.signIn({ kind: 'user', grants: MANAGE_ONLY, stepUpAgoMs: FRESH });
    const bob = f.user('bob@contoso-fake.example');
    const id = assign(f.db, { principalId: bob.id, role: 'admin' });
    const response = await manager.client.delete(`/api/v1/rbac/assignments/${id}`);
    expect(response.status).toBe(403);
    expect((await bodyOf(response)).code).toBe('escalation_denied');
    expect(denials(f).map((row) => row.reason_code)).toEqual(['escalation_denied']);
  });
});

describe('GET /api/v1/rbac/effective (P31)', () => {
  it('uses the cache inside the TTL and asks Graph for nothing', async () => {
    const f = await createApiFixture();
    const owner = f.signIn(OWNER);
    const bob = f.user('bob@contoso-fake.example');
    const sales = f.group('Sales');
    assign(f.db, { principalId: bob.id, role: 'reader' });
    assign(f.db, { principalType: 'group', principalId: sales.id, role: 'helpdesk' });
    resolveGroups(f.db, bob.id, [sales.id], f.clock.iso());
    await f.settle();
    const response = await owner.client.get(`/api/v1/rbac/effective?principal=${bob.id}`);
    expect(response.status).toBe(200);
    const parsed = EffectiveResponseSchema.parse(await bodyOf(response));
    expect(parsed.groupsResolved).toBe(true);
    expect(parsed.resolvedAt).toBe(f.clock.iso());
    expect(
      parsed.assignments.map((entry) => [entry.assignment.role.key, entry.origin.type]).sort(),
    ).toEqual([
      ['helpdesk', 'group'],
      ['reader', 'direct'],
    ]);
    expect(parsed.grants.map((grant) => grant.permission)).toContain('groups:members:write');
    expect(f.fake.callsTo('checkMemberGroups')).toHaveLength(0);
  });

  it('asks Graph live when the cache is older than the TTL, and does not write the answer', async () => {
    const f = await createApiFixture();
    const owner = f.signIn(OWNER);
    const bob = f.user('bob@contoso-fake.example');
    const sales = f.group('Sales');
    f.directory.addMember(sales.id, bob.id);
    assign(f.db, { principalType: 'group', principalId: sales.id, role: 'helpdesk' });
    await f.settle();
    const response = await owner.client.get(`/api/v1/rbac/effective?principal=${bob.id}`);
    const parsed = EffectiveResponseSchema.parse(await bodyOf(response));
    expect(parsed.assignments.map((entry) => entry.origin.type)).toEqual(['group']);
    expect(f.fake.callsTo('checkMemberGroups')).toHaveLength(1);
    expect(f.db.sqlite.prepare('SELECT count(*) AS n FROM rbac_group_member_cache').get()).toEqual({
      n: 0,
    });
  });

  it('answers 200 with direct assignments and groupsResolved: false when Graph fails', async () => {
    const f = await createApiFixture();
    const owner = f.signIn(OWNER);
    const bob = f.user('bob@contoso-fake.example');
    const sales = f.group('Sales');
    f.directory.addMember(sales.id, bob.id);
    assign(f.db, { principalId: bob.id, role: 'reader' });
    assign(f.db, { principalType: 'group', principalId: sales.id, role: 'helpdesk' });
    await f.settle();
    f.fake.failNext(new GraphTransientError({ status: 503 }), {
      method: 'checkMemberGroups',
      times: 9,
    });
    const response = await owner.client.get(`/api/v1/rbac/effective?principal=${bob.id}`);
    expect(response.status).toBe(200);
    const parsed = EffectiveResponseSchema.parse(await bodyOf(response));
    expect(parsed.groupsResolved).toBe(false);
    expect(parsed.assignments.map((entry) => entry.origin.type)).toEqual(['direct']);
  });

  it('leaves out expired assignments, and a group principal yields its own assignments only', async () => {
    const f = await createApiFixture();
    const owner = f.signIn(OWNER);
    const bob = f.user('bob@contoso-fake.example');
    const sales = f.group('Sales');
    assign(f.db, { principalId: bob.id, role: 'reader', expiresAt: '2026-10-10T11:00:00.000Z' });
    assign(f.db, { principalId: bob.id, role: 'helpdesk' });
    assign(f.db, { principalType: 'group', principalId: sales.id, role: 'operator' });
    const user = EffectiveResponseSchema.parse(
      await bodyOf(await owner.client.get(`/api/v1/rbac/effective?principal=${bob.id}`)),
    );
    expect(user.assignments.map((entry) => entry.assignment.role.key)).toEqual(['helpdesk']);
    const asGroup = EffectiveResponseSchema.parse(
      await bodyOf(
        await owner.client.get(`/api/v1/rbac/effective?principal=${sales.id}&principalType=group`),
      ),
    );
    expect(asGroup.principal).toMatchObject({ type: 'group', id: sales.id, label: 'Sales' });
    expect(asGroup.assignments.map((entry) => entry.assignment.role.key)).toEqual(['operator']);
    expect(asGroup.grants.map((grant) => grant.permission)).not.toContain('settings:branding');
  });

  it('422 for a missing or malformed principal; a break-glass session may read it', async () => {
    const f = await createApiFixture();
    const owner = f.signIn(OWNER);
    expect((await owner.client.get('/api/v1/rbac/effective')).status).toBe(422);
    expect((await owner.client.get('/api/v1/rbac/effective?principal=nope')).status).toBe(422);
    const glass = f.signIn({ kind: 'break_glass' });
    const bob = f.user('bob@contoso-fake.example');
    expect((await glass.client.get(`/api/v1/rbac/effective?principal=${bob.id}`)).status).toBe(200);
    expect((await glass.client.get('/api/v1/rbac/roles')).status).toBe(200);
    expect((await glass.client.get('/api/v1/rbac/assignments')).status).toBe(200);
  });
});

// T-B-251, FR-B-514 (server half), P09, US-B12: "Mijn toegang". `GET /api/v1/me/access` is open to a user
// or a break-glass session (the setup actor and a visitor get 401) and read-only. It lists the active
// assignments with their origin (direct, or through a named group), scope items, expiry, the effective
// grants and whether the group part may be out of date.
import { MyAccessResponseSchema } from '@m365portal/shared/schemas/auth';
import { describe, expect, it } from 'vitest';
import { GraphTransientError } from '../../src/ports/errors.js';
import { readJson } from '../helpers/http-client.js';
import { assign, resolveGroups } from '../helpers/rbac-db.js';
import { createApiFixture } from './api-fixture.js';

describe('GET /api/v1/me/access (P09)', () => {
  it('lists direct and group-derived assignments, scope, expiry, grants and the stale flag', async () => {
    const f = await createApiFixture();
    const sales = f.group('Sales');
    const me = f.signIn({ kind: 'user', roles: [], groupsStale: true });
    const expiresAt = new Date(f.clock.nowMs() + 3_600_000).toISOString();
    const direct = assign(f.db, {
      principalId: me.oid,
      role: 'reader',
      scope: [{ target: 'user', match: { by: 'department', value: 'Finance' } }],
      expiresAt,
    });
    const viaGroup = assign(f.db, {
      principalType: 'group',
      principalId: sales.id,
      role: 'helpdesk',
    });
    assign(f.db, { principalId: me.oid, role: 'operator', expiresAt: '2026-10-10T11:00:00.000Z' });
    resolveGroups(f.db, me.oid, [sales.id], f.clock.iso());

    const response = await me.client.get('/api/v1/me/access');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    const body = MyAccessResponseSchema.parse(await readJson(response));
    expect(body.principal).toMatchObject({ kind: 'user', id: me.oid });
    expect(body.assignments.map((entry) => entry.id).sort()).toEqual([direct, viaGroup].sort());
    const byId = new Map(body.assignments.map((entry) => [entry.id, entry]));
    expect(byId.get(direct)).toMatchObject({
      role: { key: 'reader', builtin: true },
      origin: { type: 'direct' },
      expiresAt,
      scope: [{ target: 'user', match: { by: 'department', value: 'Finance' } }],
    });
    expect(byId.get(viaGroup)).toMatchObject({
      role: { key: 'helpdesk', builtin: true },
      origin: { type: 'group', groupId: sales.id, groupName: 'Sales' },
      expiresAt: null,
      scope: [],
    });
    expect(body.grants.map((grant) => grant.permission)).toContain('groups:members:write');
    expect(body.groupsStale).toBe(true);
    expect(f.rows()).toEqual([]);
  });

  it('gives the group name null when Graph cannot be asked', async () => {
    const f = await createApiFixture();
    const sales = f.group('Sales');
    const me = f.signIn({ kind: 'user' });
    assign(f.db, { principalType: 'group', principalId: sales.id, role: 'helpdesk' });
    resolveGroups(f.db, me.oid, [sales.id], f.clock.iso());
    f.fake.failNext(new GraphTransientError({ status: 503 }), { method: 'getGroup', times: 5 });
    const response = await me.client.get('/api/v1/me/access');
    expect(response.status).toBe(200);
    const body = MyAccessResponseSchema.parse(await readJson(response));
    expect(body.assignments[0]?.origin).toEqual({
      type: 'group',
      groupId: sales.id,
      groupName: null,
    });
  });

  it('an expired assignment is not listed and gives nothing, while the session stays valid', async () => {
    const f = await createApiFixture();
    const me = f.signIn({ kind: 'user' });
    assign(f.db, { principalId: me.oid, role: 'reader', expiresAt: '2026-10-10T12:10:00.000Z' });
    const before = MyAccessResponseSchema.parse(
      await readJson(await me.client.get('/api/v1/me/access')),
    );
    expect(before.assignments).toHaveLength(1);
    f.clock.set('2026-10-10T12:10:00.000Z');
    const after = MyAccessResponseSchema.parse(
      await readJson(await me.client.get('/api/v1/me/access')),
    );
    expect(after.assignments).toEqual([]);
    expect(after.grants).toEqual([]);
  });

  it('a break-glass session has no assignments and the single grant rbac:manage, full, all', async () => {
    const f = await createApiFixture();
    const glass = f.signIn({ kind: 'break_glass' });
    const body = MyAccessResponseSchema.parse(
      await readJson(await glass.client.get('/api/v1/me/access')),
    );
    expect(body.principal.kind).toBe('break_glass');
    expect(body.assignments).toEqual([]);
    expect(body.grants).toEqual([{ permission: 'rbac:manage', qualifier: 'full', scope: 'all' }]);
  });

  it('is 401 for a visitor and for the setup actor', async () => {
    const f = await createApiFixture();
    expect((await f.anonymous().get('/api/v1/me/access')).status).toBe(401);
    const setup = f.signIn({ kind: 'setup' });
    expect((await setup.client.get('/api/v1/me/access')).status).toBe(401);
  });

  it('is read-only: there is no write method on the path', async () => {
    const f = await createApiFixture();
    const me = f.signIn({ kind: 'user', roles: ['reader'] });
    const response = await me.client.post('/api/v1/me/access', { json: {} });
    expect(response.status).toBe(405);
  });
});

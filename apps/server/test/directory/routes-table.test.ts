// T-C-024, FR-C-401, FR-C-402, FR-C-403: the seven routes of Phase C are in the table and in the OpenAPI
// document, all GET, class read, access `permission` with `scoped`, no audit action, and every answer is
// `no-store`. A POST route among them fails the guard.
import { PERMISSION_RESOURCE } from '@m365portal/shared/permissions';
import { expectGuardFails } from '@m365portal/shared/testing';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { DirectoryContext } from '../../src/directory/context.js';
import { directoryRoutes } from '../../src/directory/routes.js';
import { defineRoute, type RouteDefinition } from '../../src/http/route.js';
import { readJson } from '../helpers/http-client.js';
import { ALL_GROUPS, FULL_USERS, createDirectoryFixture, getJson } from './support.js';

const EXPECTED = [
  ['users.list', '/api/v1/users', 'users:read', 'user'],
  ['users.get', '/api/v1/users/{id}', 'users:read', 'user'],
  ['users.groups', '/api/v1/users/{id}/groups', 'users:read', 'user'],
  ['groups.list', '/api/v1/groups', 'groups:read', 'group'],
  ['groups.get', '/api/v1/groups/{id}', 'groups:read', 'group'],
  ['groups.owners', '/api/v1/groups/{id}/owners', 'groups:read', 'group'],
  ['groups.members', '/api/v1/groups/{id}/members', 'groups:read', 'group'],
] as const;

const routes = (): RouteDefinition[] => directoryRoutes({} as DirectoryContext);

/** The guard: every route of the list is a GET with no audit action, a scoped permission and the read class. */
function checkRoutes(list: readonly RouteDefinition[]): void {
  for (const route of list) {
    if (route.method !== 'GET') throw new Error(`${route.id} is a ${route.method} route`);
    if (route.audit !== undefined) throw new Error(`${route.id} declares an audit action`);
    if (route.access.scoped === undefined) throw new Error(`${route.id} declares no scope`);
    const rate: string = route.rateLimit;
    if (rate !== 'read') throw new Error(`${route.id} is not in the read class`);
  }
}

describe('the route table of Phase C (FR-C-401, FR-C-402)', () => {
  it('declares the seven routes of table 6.7.1, in order, each scoped to the resource of its permission', () => {
    expect(
      routes().map((route) => [route.id, route.path, route.access.permission, route.access.scoped]),
    ).toEqual(EXPECTED.map((row) => [...row]));
    for (const route of routes()) {
      expect(PERMISSION_RESOURCE[route.access.permission!], route.id).toBe(route.access.scoped);
    }
    expect(() => {
      checkRoutes(routes());
    }).not.toThrow();
  });

  it('agrees with the route index of the spec (id, method, path, permission)', () => {
    const spec = readFileSync(
      fileURLToPath(new URL('../../../../specs/003-phase-c/spec.md', import.meta.url)),
      'utf8',
    );
    const rows = [
      ...spec.matchAll(/^\| P\d+ \| `([a-z.]+)` \| `GET (\/api\/v1[^`]*)` \| `([a-z:]+)`/gm),
    ].map((m) => [m[1], m[2], m[3]]);
    expect(rows).toEqual(EXPECTED.map(([id, path, permission]) => [id, path, permission]));
  });

  it('negative: a POST route, a route with an audit action or a route without a scope fails the guard', () => {
    const body = z.strictObject({ name: z.string() });
    const post = defineRoute({
      id: 'users.create',
      method: 'POST',
      path: '/api/v1/users',
      access: { permission: 'groups:members:write', scoped: 'group' },
      rateLimit: 'write',
      request: { body: { required: true, content: { 'application/json': { schema: body } } } },
      responses: { 201: { description: 'created' } },
      handler: (c) => c.body(null, 201),
    });
    expectGuardFails(checkRoutes, [...routes(), post], { reason: 'users.create is a POST route' });
    const audited = defineRoute({
      id: 'users.audited',
      method: 'GET',
      path: '/api/v1/users/audited',
      access: { permission: 'users:read', scoped: 'user' },
      rateLimit: 'read',
      audit: 'users.view',
      responses: { 200: { description: 'ok' } },
      handler: (c) => c.body(null, 200),
    });
    expectGuardFails(checkRoutes, [...routes(), audited], { reason: 'declares an audit action' });
    const unscoped = defineRoute({
      id: 'users.unscoped',
      method: 'GET',
      path: '/api/v1/users/unscoped',
      access: { permission: 'users:read', unscopedReason: 'fixture: no user data in the answer' },
      rateLimit: 'read',
      responses: { 200: { description: 'ok' } },
      handler: (c) => c.body(null, 200),
    });
    expectGuardFails(checkRoutes, [...routes(), unscoped], { reason: 'declares no scope' });
  });
});

describe('the OpenAPI document and the answers of the running application (FR-C-401, FR-C-403)', () => {
  it('lists the seven operations, all GET, with their access and no audit extension', async () => {
    const f = await createDirectoryFixture();
    const me = f.actor(FULL_USERS, ALL_GROUPS);
    const response = await me.client.get('/api/v1/openapi.json');
    const document = await readJson<{
      paths: Record<string, Record<string, Record<string, unknown>>>;
    }>(response);
    const operations = Object.entries(document.paths)
      .filter(([path]) => /^\/api\/v1\/(users|groups)(\/|$)/.test(path))
      .flatMap(([path, methods]) =>
        Object.entries(methods).map(([method, operation]) => ({ path, method, operation })),
      )
      // P53 and P54 are Phase D step D1 (module `groups`): the seven reads of Phase C are what this is about.
      .filter(({ method }) => method === 'get');
    expect(
      operations.map((entry) => [entry.operation['x-route-id'], entry.path, entry.method]),
    ).toEqual(expect.arrayContaining(EXPECTED.map(([id, path]) => [id, path, 'get'])));
    expect(operations).toHaveLength(7);
    for (const { method, operation } of operations) {
      expect(method).toBe('get');
      expect(operation['x-access']).toBe('permission');
      expect(operation['x-scoped']).toMatch(/^(user|group)$/);
      expect('x-audit' in operation).toBe(false);
      expect(operation['x-rate-limit']).toBe('read');
    }
  });

  it('answers every route with Cache-Control: no-store, and answers a write method with 405', async () => {
    const f = await createDirectoryFixture();
    const me = f.actor(FULL_USERS, ALL_GROUPS);
    const ids = f.seeded.ids;
    const user = ids.userWithManager;
    const paths = [
      '/api/v1/users',
      `/api/v1/users/${user}`,
      `/api/v1/users/${user}/groups`,
      '/api/v1/groups',
      `/api/v1/groups/${ids.m365Group}`,
      `/api/v1/groups/${ids.m365Group}/owners`,
      `/api/v1/groups/${ids.m365Group}/members`,
    ];
    for (const path of paths) {
      const answer = await getJson(me.client, path);
      expect(answer.status, path).toBe(200);
      expect(answer.headers.get('cache-control'), path).toBe('no-store');
      expect(answer.headers.get('content-type'), path).toMatch(/^application\/json/);
      for (const method of ['post', 'put', 'patch', 'delete'] as const) {
        // P53 and P54 (Phase D step D1, module `groups`) answer POST and DELETE on the members path.
        if (path.endsWith('/members') && (method === 'post' || method === 'delete')) continue;
        const written = await me.client[method](path, { json: {} });
        expect(written.status, `${method} ${path}`).toBe(405);
      }
    }
    // Nothing was written by any of it.
    expect(f.rows()).toEqual([]);
  });

  it('keeps the no-store header on an error answer too', async () => {
    const f = await createDirectoryFixture();
    const me = f.actor(FULL_USERS, ALL_GROUPS);
    for (const path of [
      '/api/v1/users/not-a-guid',
      '/api/v1/groups/3f2c1a9e-0b5d-4c61-8a77-5d9a2b7c4e10',
    ]) {
      const answer = await getJson(me.client, path);
      expect(answer.status).toBeGreaterThanOrEqual(400);
      expect(answer.headers.get('cache-control'), path).toBe('no-store');
    }
  });
});

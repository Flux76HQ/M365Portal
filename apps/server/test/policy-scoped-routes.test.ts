// T-B-243, FR-B-505, EB-35, RB-08, plan 11.8 and 11.9: the net under the routes of Phases C and D.
//
// A route whose permission has a resource type declares `scoped: <type>` and must apply the scope of
// the caller: by asking `ctx.authorizeResource(permission, resource)` for the one resource it touches,
// or `ctx.visibleScopes(permission)` for the set it lists. A handler that returns 2xx without doing
// either is a forgotten check; the wrapper replaces its answer with 500 `policy_not_applied` and
// audits it as `error`. The net finds a forgotten check; it cannot undo a write the handler already
// made, which is why the services of Phases C and D take the capabilities as arguments: a value that
// only `ctx` can make (a branded type, compile-time) cannot be built by a handler that never asked.
//
// No Phase B route has a resource type (every Phase B route uses `unscopedReason`), so the routes
// below are a test-only module. It is never part of `appModules`.
import type { ScopeItem } from '@m365portal/shared/rbac/scope';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { createDenialAudit, createPolicyErrorAudit } from '../src/http/denial-audit.js';
import { defineRoute, type RouteDefinition } from '../src/http/route.js';
import { appModules } from '../src/modules.js';
import type { AuthorizedResource, VisibleScope } from '../src/policy/index.js';
import { createFixtureApp, fixtureRoutes } from './helpers/http-app.js';
import { readJson } from './helpers/http-client.js';
import { createPolicyHarness, type PolicyHarness } from './helpers/policy-harness.js';
import { guid } from './helpers/rbac-db.js';

const SALES: ScopeItem = {
  target: 'group',
  match: { by: 'prefix', attr: 'displayName', value: 'sales' },
};
const OK = z.strictObject({ ok: z.literal(true) });
const RESPONSES = {
  200: { description: 'ok', content: { 'application/json': { schema: OK } } },
  404: { description: 'gone' },
} as const;

/** What the handlers received, to prove the capabilities carry what was asked. */
interface Seen {
  authorized: AuthorizedResource<'group'>[];
  visible: VisibleScope<'group'>[];
}

function scopedRoutes(enter: (id: string) => void, seen: Seen): RouteDefinition[] {
  return [
    defineRoute({
      id: 'scoped.visible',
      method: 'GET',
      path: '/api/v1/scoped/visible',
      access: { permission: 'groups:read', scoped: 'group' },
      rateLimit: 'read',
      responses: RESPONSES,
      handler: (c, _input, ctx) => {
        enter('scoped.visible');
        seen.visible.push(ctx.visibleScopes('groups:read'));
        return c.json({ ok: true as const }, 200);
      },
    }),
    defineRoute({
      id: 'scoped.authorized',
      method: 'POST',
      path: '/api/v1/scoped/authorized/{name}',
      access: { permission: 'groups:members:write', scoped: 'group' },
      rateLimit: 'write',
      request: { params: z.object({ name: z.string() }) },
      responses: RESPONSES,
      handler: (c, input, ctx) => {
        enter('scoped.authorized');
        seen.authorized.push(
          ctx.authorizeResource('groups:members:write', {
            type: 'group',
            id: guid(5),
            displayName: input.params.name,
          }),
        );
        return c.json({ ok: true as const }, 200);
      },
    }),
    defineRoute({
      id: 'scoped.forgetful',
      method: 'GET',
      path: '/api/v1/scoped/forgetful',
      access: { permission: 'groups:read', scoped: 'group' },
      rateLimit: 'read',
      responses: RESPONSES,
      handler: (c) => {
        enter('scoped.forgetful');
        return c.json({ ok: true as const }, 200);
      },
    }),
    defineRoute({
      id: 'scoped.forgetful.make',
      method: 'POST',
      path: '/api/v1/scoped/forgetful',
      access: { permission: 'groups:members:write', scoped: 'group' },
      rateLimit: 'write',
      responses: RESPONSES,
      handler: (c) => {
        enter('scoped.forgetful.make');
        return c.json({ ok: true as const }, 200);
      },
    }),
    defineRoute({
      id: 'scoped.notfound',
      method: 'GET',
      path: '/api/v1/scoped/notfound',
      access: { permission: 'groups:read', scoped: 'group' },
      rateLimit: 'read',
      responses: RESPONSES,
      handler: (c) => {
        enter('scoped.notfound');
        return c.body(null, 404);
      },
    }),
    defineRoute({
      id: 'scoped.unscoped',
      method: 'GET',
      path: '/api/v1/scoped/unscoped',
      access: {
        permission: 'groups:read',
        unscopedReason: 'fixture: the route returns no group data',
      },
      rateLimit: 'read',
      responses: RESPONSES,
      handler: (c) => {
        enter('scoped.unscoped');
        return c.json({ ok: true as const }, 200);
      },
    }),
    defineRoute({
      id: 'scoped.wrongtype',
      method: 'GET',
      path: '/api/v1/scoped/wrongtype',
      access: { permission: 'groups:read', scoped: 'group' },
      rateLimit: 'read',
      responses: RESPONSES,
      handler: (c, _input, ctx) => {
        enter('scoped.wrongtype');
        // A bug: a contact where the permission applies to groups.
        ctx.authorizeResource('groups:read', { type: 'contact' } as never);
        return c.json({ ok: true as const }, 200);
      },
    }),
  ];
}

interface Rig {
  readonly harness: PolicyHarness;
  readonly app: Awaited<ReturnType<typeof createFixtureApp>>;
  readonly seen: Seen;
  readonly client: ReturnType<Awaited<ReturnType<typeof createFixtureApp>>['clientFor']>;
  audit(): {
    action: string;
    outcome: string;
    reason_code: string | null;
    actor_id: string;
    detail: string;
  }[];
}

async function rig(): Promise<Rig> {
  const harness = await createPolicyHarness();
  const seen: Seen = { authorized: [], visible: [] };
  const session = harness.seedSession({
    oid: guid(20),
    assignments: [{ role: 'helpdesk', scope: [SALES] }],
  });
  const denied = createDenialAudit({
    database: () => harness.db,
    now: () => harness.clock.nowMs(),
  });
  const errors = createPolicyErrorAudit({
    database: () => harness.db,
    now: () => harness.clock.nowMs(),
  });
  const app = await createFixtureApp({
    clock: harness.clock,
    resolveActor: harness.resolve,
    onDenied: denied,
    onPolicyError: errors,
    routes: ({ calls, csrf, publicOrigin }) => [
      ...fixtureRoutes(calls, csrf, { withCsrf: true, publicOrigin }).filter(
        (route) => route.id === 'fixture.csrf',
      ),
      ...scopedRoutes((id) => {
        calls.byRoute.set(id, (calls.byRoute.get(id) ?? 0) + 1);
      }, seen),
    ],
  });
  return {
    harness,
    app,
    seen,
    client: app.clientFor({ headers: session.headers }),
    audit: () =>
      harness.db.sqlite
        .prepare(
          "SELECT action, outcome, reason_code, actor_id, detail FROM audit_log WHERE action LIKE 'scoped.%' ORDER BY seq",
        )
        .all() as ReturnType<Rig['audit']>,
  };
}

describe('a scoped route that applies the policy (FR-B-505)', () => {
  it('answers 2xx when the handler asked for the visible scopes', async () => {
    const { client, seen, app } = await rig();
    const response = await client.get('/api/v1/scoped/visible');
    expect(response.status).toBe(200);
    expect(app.calls.of('scoped.visible')).toBe(1);
    expect(seen.visible).toHaveLength(1);
  });

  it('hands the handler the scopes of the caller, not a copy it could widen', async () => {
    const { client, seen } = await rig();
    await client.get('/api/v1/scoped/visible');
    const [visible] = seen.visible;
    expect(visible?.permission).toBe('groups:read');
    expect(visible?.scopes).toEqual({ full: [SALES], basic: 'none' });
    expect(Object.isFrozen(visible)).toBe(true);
  });

  it('answers 2xx when the handler authorised the resource it touches, and tells it the qualifier', async () => {
    const { client, seen } = await rig();
    const response = await client.post('/api/v1/scoped/authorized/Sales%20Benelux', { json: {} });
    expect(response.status).toBe(200);
    expect(seen.authorized[0]?.qualifier).toBe('full');
    expect(seen.authorized[0]?.resource).toMatchObject({
      type: 'group',
      displayName: 'Sales Benelux',
    });
  });

  it('answers 403 permission_denied for a resource the scope does not cover, and audits it as scope_mismatch', async () => {
    const { client, app, audit, seen } = await rig();
    const response = await client.post('/api/v1/scoped/authorized/HR', { json: {} });
    expect(response.status).toBe(403);
    expect((await readJson<{ code: string }>(response)).code).toBe('permission_denied');
    expect(seen.authorized).toHaveLength(0);
    expect(audit()).toMatchObject([
      {
        action: 'scoped.authorized',
        outcome: 'denied',
        reason_code: 'scope_mismatch',
        actor_id: guid(20),
      },
    ]);
    // The handler was entered (the denial came from the question it asked) and did nothing after it.
    expect(app.calls.of('scoped.authorized')).toBe(1);
  });
});

describe('a scoped route that forgets the policy becomes 500 policy_not_applied (EB-35)', () => {
  it('replaces the 2xx of a read and audits the error', async () => {
    const { client, audit } = await rig();
    const response = await client.get('/api/v1/scoped/forgetful');
    expect(response.status).toBe(500);
    expect((await readJson<{ code: string }>(response)).code).toBe('policy_not_applied');
    expect(audit()).toMatchObject([
      {
        action: 'scoped.forgetful',
        outcome: 'error',
        reason_code: 'policy_not_applied',
        actor_id: guid(20),
      },
    ]);
  });

  it('replaces the 2xx of a write (the net finds the mistake; it cannot undo what the handler did)', async () => {
    const { client, audit, app } = await rig();
    const response = await client.post('/api/v1/scoped/forgetful', { json: {} });
    expect(response.status).toBe(500);
    expect((await readJson<{ code: string }>(response)).code).toBe('policy_not_applied');
    expect(app.calls.of('scoped.forgetful.make')).toBe(1);
    expect(audit()).toMatchObject([{ action: 'scoped.forgetful.make', outcome: 'error' }]);
  });

  it('puts nothing of the handler in the body of the replacement', async () => {
    const { client } = await rig();
    const response = await client.get('/api/v1/scoped/forgetful');
    const body = await readJson<Record<string, unknown>>(response);
    expect(JSON.stringify(body)).not.toContain('"ok"');
    expect(Object.keys(body).sort()).toEqual([
      'code',
      'detail',
      'requestId',
      'status',
      'title',
      'type',
    ]);
  });

  it('leaves a non-2xx answer alone: nothing was served, so nothing leaked', async () => {
    const { client, audit } = await rig();
    expect((await client.get('/api/v1/scoped/notfound')).status).toBe(404);
    expect(audit()).toEqual([]);
  });

  it('does not touch a route that declared unscopedReason instead', async () => {
    const { client } = await rig();
    expect((await client.get('/api/v1/scoped/unscoped')).status).toBe(200);
  });

  it('turns a wrong resource type (a bug in the handler) into a 500 audited as error, never an allow', async () => {
    const { client, audit } = await rig();
    const response = await client.get('/api/v1/scoped/wrongtype');
    expect(response.status).toBe(500);
    expect((await readJson<{ code: string }>(response)).code).toBe('internal_error');
    expect(audit()).toMatchObject([
      { action: 'scoped.wrongtype', outcome: 'error', reason_code: 'policy_usage' },
    ]);
  });

  it('answers 503 instead when the audit of the error cannot be written', async () => {
    const harness = await createPolicyHarness();
    const session = harness.seedSession({ assignments: [{ role: 'helpdesk', scope: [SALES] }] });
    const app = await createFixtureApp({
      clock: harness.clock,
      resolveActor: harness.resolve,
      onPolicyError: () => {
        throw Object.assign(new Error('disk full'), { code: 'SQLITE_FULL' });
      },
      routes: ({ calls, csrf, publicOrigin }) => [
        ...fixtureRoutes(calls, csrf, { withCsrf: true, publicOrigin }).filter(
          (route) => route.id === 'fixture.csrf',
        ),
        ...scopedRoutes(() => undefined, { authorized: [], visible: [] }),
      ],
    });
    const response = await app
      .clientFor({ headers: session.headers })
      .get('/api/v1/scoped/forgetful');
    expect(response.status).toBe(503);
  });
});

describe('the guard that finds a forgetful route (tasks.md section 0.3)', () => {
  /** Every scoped route of a table, called as a caller who may use it, must apply the policy. */
  async function assertScopedRoutesApplyPolicy(rigged: Rig, ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      const route = rigged.app.http.table.routes.find((candidate) => candidate.id === id);
      if (route === undefined) throw new Error(`no route ${id}`);
      const method = route.methods[0] ?? 'GET';
      const path = (route.paths[0] ?? '').replaceAll('{name}', 'Sales');
      const response =
        method === 'GET'
          ? await rigged.client.get(path)
          : await rigged.client.post(path, { json: {} });
      if (response.status === 500) {
        const body = await readJson<{ code?: string }>(response);
        if (body.code === 'policy_not_applied') throw new Error(`${id}: policy_not_applied`);
      }
    }
  }

  it('passes for the routes that ask', async () => {
    const rigged = await rig();
    await expect(
      assertScopedRoutesApplyPolicy(rigged, ['scoped.visible', 'scoped.authorized']),
    ).resolves.toBeUndefined();
  });

  it('fails for the forgetful routes', async () => {
    const rigged = await rig();
    await expectGuardFails(
      (id: string) => assertScopedRoutesApplyPolicy(rigged, [id]),
      'scoped.forgetful',
      { reason: 'scoped.forgetful: policy_not_applied' },
    );
    await expectGuardFails(
      (id: string) => assertScopedRoutesApplyPolicy(rigged, [id]),
      'scoped.forgetful.make',
      { reason: 'policy_not_applied' },
    );
  });
});

describe('the capabilities cannot be built outside the policy layer (plan 11.9)', () => {
  it('has the group type and the permission in the type of what ctx hands out', () => {
    expectTypeOf<AuthorizedResource<'group'>>().not.toEqualTypeOf<AuthorizedResource<'contact'>>();
    expectTypeOf<VisibleScope<'group'>>().not.toEqualTypeOf<VisibleScope<'user'>>();
  });

  it('is a compile error to make one by hand (a compile-fail fixture)', () => {
    // A handler that never asked has no way to produce the value a service demands.
    // @ts-expect-error -- the brand is a key nobody outside the policy layer can write
    const forged: AuthorizedResource<'group'> = { resource: { type: 'group' }, qualifier: 'full' };
    // @ts-expect-error -- the same for the visible scope
    const forgedScope: VisibleScope<'group'> = {
      permission: 'groups:read',
      scopes: { full: 'all', basic: 'none' },
    };
    // @ts-expect-error -- and a bare resource is not an authorised one
    const bare: AuthorizedResource<'group'> = { type: 'group' };
    expect([forged, forgedScope, bare]).toHaveLength(3);
  });

  it('is a compile error to hand a service the capability of another type', () => {
    const takesGroup = (_group: AuthorizedResource<'group'>): void => undefined;
    const contact = undefined as unknown as AuthorizedResource<'contact'>;
    // @ts-expect-error -- a contact is not a group
    takesGroup(contact);
    expect(takesGroup).toBeTypeOf('function');
  });
});

describe('the test-only module is not an application module', () => {
  it('is not in appModules, and no module of the application registers the scoped routes', () => {
    expect(appModules.map((factory) => factory.name)).not.toContain('scopedRoutes');
    expect(
      scopedRoutes(() => undefined, { authorized: [], visible: [] }).map((route) => route.id),
    ).toEqual(expect.arrayContaining(['scoped.forgetful']));
  });
});

// T-C-024, FR-C-401, EB-35: every handler of the seven routes asks the policy layer, and a handler that
// does not gets 500 `policy_not_applied` (the net of the wrapper), audited as an error. Route-table
// driven: the routes are the real definitions, rebuilt with a handler that skips the check.
import { describe, expect, it } from 'vitest';
import type { DirectoryContext } from '../../src/directory/context.js';
import { directoryRoutes } from '../../src/directory/routes.js';
import { createDenialAudit, createPolicyErrorAudit } from '../../src/http/denial-audit.js';
import { defineRoute, type RouteDefinition } from '../../src/http/route.js';
import { createFixtureApp, fixtureRoutes } from '../helpers/http-app.js';
import { readJson } from '../helpers/http-client.js';
import { createPolicyHarness } from '../helpers/policy-harness.js';
import { guid } from '../helpers/rbac-db.js';
import { ALL_GROUPS, FULL_USERS, createDirectoryFixture, getJson } from './support.js';

const ID = '3f2c1a9e-0b5d-4c61-8a77-5d9a2b7c4e10';
const real = (): RouteDefinition[] => directoryRoutes({} as DirectoryContext);
const concrete = (path: string): string => path.replace('{id}', ID);

/** The same declaration, with a handler that answers 200 and never asks `ctx`. */
function skipping(route: RouteDefinition): RouteDefinition {
  return defineRoute({
    id: route.id,
    method: route.method,
    path: route.path,
    access: route.access,
    rateLimit: route.rateLimit,
    ...(route.request === undefined ? {} : { request: route.request }),
    responses: route.responses,
    handler: (c) => c.json({ items: [] }, 200),
  });
}

describe('a handler that skips the policy layer gets 500 policy_not_applied (FR-C-401)', () => {
  it.each(real().map((route) => [route.id, route] as const))('%s', async (id, route) => {
    const harness = await createPolicyHarness();
    const session = harness.seedSession({
      oid: guid(31),
      assignments: [{ role: 'admin' }],
    });
    const app = await createFixtureApp({
      clock: harness.clock,
      resolveActor: harness.resolve,
      onDenied: createDenialAudit({ database: () => harness.db, now: () => harness.clock.nowMs() }),
      onPolicyError: createPolicyErrorAudit({
        database: () => harness.db,
        now: () => harness.clock.nowMs(),
      }),
      routes: ({ calls, csrf, publicOrigin }) => [
        ...fixtureRoutes(calls, csrf, { withCsrf: true, publicOrigin }).filter(
          (entry) => entry.id === 'fixture.csrf',
        ),
        skipping(route),
      ],
    });
    const client = app.clientFor({ headers: session.headers });
    const response = await client.get(concrete(route.path));
    expect(response.status, id).toBe(500);
    expect((await readJson<{ code: string }>(response)).code).toBe('policy_not_applied');
    const rows = harness.db.sqlite
      .prepare('SELECT action, outcome, reason_code FROM audit_log WHERE action = ?')
      .all(id);
    expect(rows).toEqual([{ action: id, outcome: 'error', reason_code: 'policy_not_applied' }]);
  });
});

describe('the real handlers ask the policy layer: all seven answer 200, not 500', () => {
  it('for an actor who may read users and groups', async () => {
    const f = await createDirectoryFixture();
    const me = f.actor(FULL_USERS, ALL_GROUPS);
    const ids = f.seeded.ids;
    for (const route of real()) {
      const path = route.path
        .replace('/users/{id}', `/users/${ids.userWithManager}`)
        .replace('/groups/{id}', `/groups/${ids.m365Group}`);
      const answer = await getJson(me.client, path);
      expect(answer.status, route.id).toBe(200);
    }
    expect(f.rows()).toEqual([]);
  });
});

// T-C-027, FR-C-106, EC-C13, EC-C14: the failures of Graph as the problems the directory routes answer,
// for every route; and no text of Graph, no id and no name in any answer.
import {
  GraphBadRequestError,
  GraphForbiddenError,
  GraphNetworkError,
  GraphNotFoundError,
  GraphThrottledError,
  GraphTransientError,
  NotConnectedError,
  SecretsUnavailableError,
  type GraphError,
} from '../../src/ports/errors.js';
import { describe, expect, it } from 'vitest';
import type { GraphClient } from '../../src/ports/graph.js';
import type { FakeGraphClient } from '../fakes/fake-graph-client.js';
import type { SeededDirectory } from '../fakes/fake-tenant/graph/seed-directory.js';
import {
  ALL_GROUPS,
  FULL_USERS,
  createDirectoryFixture,
  getJson,
  type ProblemBody,
} from './support.js';

type Method = Parameters<FakeGraphClient['callsTo']>[0];

const CANARY = {
  code: 'Authorization_RequestDenied',
  request: 'canary-request-id-77',
} as const;

interface RouteCase {
  readonly id: string;
  /** The Graph methods the route calls; the failure is injected on the last one. */
  readonly method: Method;
  readonly path: (ids: SeededDirectory['ids']) => string;
}

const ROUTES: readonly RouteCase[] = [
  { id: 'users.list', method: 'listUsers', path: () => '/api/v1/users' },
  { id: 'users.get', method: 'getUser', path: (ids) => `/api/v1/users/${ids.userWithManager}` },
  {
    id: 'users.groups',
    method: 'listUserGroups',
    path: (ids) => `/api/v1/users/${ids.userWithManager}/groups`,
  },
  { id: 'groups.list', method: 'listGroups', path: () => '/api/v1/groups' },
  { id: 'groups.get', method: 'getGroup', path: (ids) => `/api/v1/groups/${ids.m365Group}` },
  {
    id: 'groups.owners',
    method: 'listGroupOwners',
    path: (ids) => `/api/v1/groups/${ids.m365Group}/owners`,
  },
  {
    id: 'groups.members',
    method: 'listGroupMembers',
    path: (ids) => `/api/v1/groups/${ids.m365Group}/members`,
  },
];

async function rig() {
  const f = await createDirectoryFixture();
  const me = f.actor(FULL_USERS, ALL_GROUPS);
  await f.settle();
  return { f, me };
}

describe.each(ROUTES)('$id: a failure of Graph (FR-C-106)', (route) => {
  it('Graph 403 for the application: 503 graph_unavailable with the detail code graph_permission_missing (EC-C14)', async () => {
    const { f, me } = await rig();
    f.fake.failNext(
      new GraphForbiddenError({ graphCode: CANARY.code, requestId: CANARY.request }),
      {
        method: route.method,
      },
    );
    const answer = await getJson<ProblemBody>(me.client, route.path(f.seeded.ids));
    expect(answer.status).toBe(503);
    expect(answer.body.code).toBe('graph_unavailable');
    expect(answer.body.errors).toEqual([{ pointer: '', code: 'graph_permission_missing' }]);
    expect(answer.headers.get('retry-after')).toBe('30');
    const text = JSON.stringify(answer.body);
    expect(text).not.toContain(CANARY.code);
    expect(text).not.toContain(CANARY.request);
  });

  it.each([
    [
      'a throttle that outlasts the wait (more than 60 s)',
      new GraphThrottledError({ retryAfterMs: 120_000 }),
      'graph_throttled',
    ],
    [
      'a short throttle that ran out of budget',
      new GraphThrottledError({ retryAfterMs: 5_000 }),
      'graph_unavailable',
    ],
    ['an outage (5xx)', new GraphTransientError({ status: 503 }), 'graph_unavailable'],
    ['a network failure', new GraphNetworkError(), 'graph_unavailable'],
    [
      'an answer of an unexpected shape',
      new GraphBadRequestError({ graphCode: 'unexpected_shape' }),
      'graph_unavailable',
    ],
  ] as [string, GraphError, string][])(
    '%s is 503 %s, without a detail code',
    async (_name, failure, code) => {
      const { f, me } = await rig();
      f.fake.failNext(failure, { method: route.method });
      const answer = await getJson<ProblemBody>(me.client, route.path(f.seeded.ids));
      expect(answer.status).toBe(503);
      expect(answer.body.code).toBe(code);
      expect(answer.body.errors).toBeUndefined();
    },
  );

  it('works again once Graph does: the failure is not remembered', async () => {
    const { f, me } = await rig();
    f.fake.failNext(new GraphTransientError({ status: 503 }), { method: route.method });
    expect((await getJson(me.client, route.path(f.seeded.ids))).status).toBe(503);
    expect((await getJson(me.client, route.path(f.seeded.ids))).status).toBe(200);
  });
});

describe('failures of the connection and bugs', () => {
  it('an unusable secrets state is 503 secrets_unavailable and no tenant yet is 503 graph_unavailable', async () => {
    const down = (error: Error): GraphClient =>
      new Proxy({} as GraphClient, {
        get: () => () => Promise.reject(error),
      });
    for (const [error, code] of [
      [new SecretsUnavailableError({ reason: 'app_key_missing' }), 'secrets_unavailable'],
      [new NotConnectedError(), 'graph_unavailable'],
    ] as const) {
      const f = await createDirectoryFixture({ graph: () => down(error) });
      const me = f.actor(FULL_USERS, ALL_GROUPS);
      const answer = await getJson<ProblemBody>(me.client, '/api/v1/groups');
      expect([answer.status, answer.body.code]).toEqual([503, code]);
    }
  });

  it('Graph 404 on an object that was there a moment ago is 404 not_found', async () => {
    const { f, me } = await rig();
    f.fake.failNext(new GraphNotFoundError({ graphCode: CANARY.code }), {
      method: 'listGroupMembers',
    });
    const answer = await getJson<ProblemBody>(
      me.client,
      `/api/v1/groups/${f.seeded.ids.m365Group}/members`,
    );
    expect([answer.status, answer.body.code]).toEqual([404, 'not_found']);
    expect(JSON.stringify(answer.body)).not.toContain(CANARY.code);
  });

  it('a bug in the code (not an error of the client) is 500 internal_error with a generic body', async () => {
    const { f, me } = await rig();
    const bug = new TypeError('canary: undefined is not a function');
    f.fake.failNext(bug as unknown as GraphError, { method: 'listUsers' });
    const answer = await getJson<ProblemBody & { detail: string }>(me.client, '/api/v1/users');
    expect(answer.status).toBe(500);
    expect(answer.body.code).toBe('internal_error');
    expect(JSON.stringify(answer.body)).not.toContain('canary');
  });

  it('a failed manager call never fails the detail (EC-C6)', async () => {
    const { f, me } = await rig();
    f.fake.failNext(new GraphThrottledError({ retryAfterMs: 120_000 }), {
      method: 'getUserManager',
    });
    const detail = await getJson<{ manager: unknown }>(
      me.client,
      `/api/v1/users/${f.seeded.ids.userWithManager}`,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.manager).toEqual({ state: 'unavailable' });
  });
});

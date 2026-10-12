// FR-A-024, E-27 (H-38): every response carries `X-Request-Id`, and an inbound id is used only if it
// has the shape the pattern allows. T-A-026 lands the request id part of this file; T-A-040 extends
// it with the route conventions (unknown /api path, 405 with Allow, OPTIONS, 415).
import { RequestIdSchema } from '@m365portal/shared/schemas/common';
import { expectGuardFails } from '@m365portal/shared/testing';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import {
  generateRequestId,
  requestContext,
  resolveRequestId,
  type AppEnv,
} from '../src/http/request-context.js';
import { ADMIN, createFixtureApp, fixtureRoutes, type FixtureApp } from './helpers/http-app.js';
import { defineRoute } from '../src/http/route.js';
import { readJson } from './helpers/http-client.js';
import { createTestApp } from './helpers/test-app.js';

import { LIMITS } from '@m365portal/shared/limits';
import { vi, type Mock } from 'vitest';
import { z } from 'zod';
import {
  ANONYMOUS_ACTOR,
  type Actor,
  type ActorResolver,
  type SessionSlider,
} from '../src/policy/actor.js';
import type { RouteDefinition } from '../src/http/route.js';
import { createLazyActor } from '../src/http/lazy-actor.js';
import { testActor } from './helpers/test-actor.js';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

const VALID_IDS = [
  'abcd1234',
  'ABCD-1234',
  '0b8d3f9c-5f0e-4c7e-9a7e-6d2d3f8a1b2c',
  'a'.repeat(64),
  '12345678',
  '--------',
];

const INVALID_IDS = [
  '',
  'short77',
  'a'.repeat(65),
  'has space1',
  'tab\tinside1',
  'under_score1',
  'dot.dot.dot',
  'slash/slash1',
  'abcdefgh\n',
  'abcdefgh\r\nX-Injected: 1',
  'abc\r\ndef12345',
  'ééééééééé',
  'abcdefg\u0000h',
  '<script>alert1</script>',
  '%0d%0aSet-Cookie:x',
  'a'.repeat(200),
];

describe('resolveRequestId (FR-A-024)', () => {
  it.each(VALID_IDS)('keeps the valid id %j', (id) => {
    expect(resolveRequestId(id)).toBe(id);
  });

  it.each(INVALID_IDS)('replaces the invalid id %j', (id) => {
    const replaced = resolveRequestId(id);
    expect(replaced).not.toBe(id);
    expect(replaced).toMatch(REQUEST_ID_PATTERN);
    // Not derived from the hostile input.
    if (id !== '') expect(replaced).not.toContain(id.slice(0, 8));
  });

  it('generates an id when there is none', () => {
    for (const missing of [null, undefined]) {
      expect(resolveRequestId(missing)).toMatch(REQUEST_ID_PATTERN);
    }
  });

  it('generates a different id every time', () => {
    const ids = new Set(Array.from({ length: 200 }, () => generateRequestId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(REQUEST_ID_PATTERN);
  });

  it('accepts exactly what the shared RequestIdSchema accepts: one pattern in the code base', () => {
    for (const candidate of [...VALID_IDS, ...INVALID_IDS]) {
      expect(resolveRequestId(candidate) === candidate, candidate).toBe(
        RequestIdSchema.safeParse(candidate).success,
      );
    }
  });

  it('takes the generator it is given', () => {
    expect(resolveRequestId('bad', () => 'generated-0001')).toBe('generated-0001');
    expect(resolveRequestId('good-id-1', () => 'generated-0001')).toBe('good-id-1');
  });
});

/** The guard behind the negative fixture: a resolver must keep valid ids and replace the rest. */
function assertRequestIdRules(resolve: (inbound: string | null) => string): void {
  for (const id of VALID_IDS) {
    if (resolve(id) !== id) throw new Error(`a valid id was replaced: ${id}`);
  }
  for (const id of INVALID_IDS) {
    const result = resolve(id);
    if (result === id) throw new Error(`an invalid id was accepted: ${JSON.stringify(id)}`);
    if (!REQUEST_ID_PATTERN.test(result))
      throw new Error(`the replacement is not an id: ${result}`);
  }
}

describe('the request id guard', () => {
  it('passes for the real resolver', () => {
    expect(() => {
      assertRequestIdRules((inbound) => resolveRequestId(inbound));
    }).not.toThrow();
  });

  it('fails for a resolver that trusts any header value', () => {
    expectGuardFails(
      assertRequestIdRules,
      (inbound: string | null) => inbound ?? 'generated-0001',
      {
        reason: 'an invalid id was accepted',
      },
    );
  });

  it('fails for a resolver that only checks the length', () => {
    const lengthOnly = (inbound: string | null): string =>
      inbound !== null && inbound.length >= 8 && inbound.length <= 64
        ? inbound
        : resolveRequestId(null);
    expectGuardFails(assertRequestIdRules, lengthOnly, { reason: 'an invalid id was accepted' });
  });

  it('fails for a resolver that always generates', () => {
    expectGuardFails(assertRequestIdRules, () => 'generated-0001', {
      reason: 'a valid id was replaced',
    });
  });

  it('fails for a resolver that matches the pattern up to a line break', () => {
    const multiline = (inbound: string | null): string =>
      inbound !== null && /^[A-Za-z0-9-]{8,64}$/m.test(inbound) ? inbound : resolveRequestId(null);
    expectGuardFails(assertRequestIdRules, multiline, { reason: 'an invalid id was accepted' });
  });
});

function buildApp() {
  const result = loadConfig({});
  if (!result.ok) throw new Error('configuration refused');
  const app = new Hono<AppEnv>();
  app.use(requestContext({ config: result.config }));
  app.get('/ok', (c) => c.json({ requestId: c.get('requestId') }));
  app.get('/redirect', (c) => c.redirect('/ok'));
  // Responses a handler builds itself: a plain Response, one with immutable headers, and one that a
  // guard returns before the handler runs. The id has to be on all of them.
  app.get('/raw', () => new Response('raw'));
  app.get('/immutable', () => Response.redirect('http://localhost:9300/ok', 302));
  app.use('/guarded', (c) => Promise.resolve(c.json({ denied: true }, 403)));
  app.get('/guarded', (c) => c.json({ reached: true }));
  app.get('/fails', () => {
    throw new Error('handler failed');
  });
  app.onError((_error, c) => c.text('failed', 500));
  return app;
}

describe('X-Request-Id on every response (FR-A-024)', () => {
  it.each([
    ['a JSON response', '/ok', 200],
    ['a redirect', '/redirect', 302],
    ['a 404', '/nowhere', 404],
    ['a plain Response', '/raw', 200],
    ['a redirect with immutable headers', '/immutable', 302],
    ['a response from a guard', '/guarded', 403],
    ['an error response', '/fails', 500],
  ])('is present on %s', async (_name, path, status) => {
    const harness = await createTestApp({ buildApp });
    const response = await harness.client.get(path);
    expect(response.status).toBe(status);
    expect(response.headers.get('x-request-id')).toMatch(REQUEST_ID_PATTERN);
  });

  it('is present on a response to HEAD', async () => {
    const harness = await createTestApp({ buildApp });
    const response = await harness.client.request('HEAD', '/ok');
    expect(response.headers.get('x-request-id')).toMatch(REQUEST_ID_PATTERN);
  });

  it('keeps a valid inbound id, and hands the same one to the handler', async () => {
    const harness = await createTestApp({ buildApp });
    const response = await harness.client.get('/ok', {
      headers: { 'x-request-id': 'client-id-0001' },
    });
    expect(response.headers.get('x-request-id')).toBe('client-id-0001');
    expect(await response.json()).toEqual({ requestId: 'client-id-0001' });
  });

  it.each(['short77', 'a'.repeat(65), 'under_score1', 'ééééééééé', 'has space1'])(
    'replaces the inbound id %j on the response and for the handler',
    async (inbound) => {
      const harness = await createTestApp({ buildApp });
      const response = await harness.client.get('/ok', { headers: { 'x-request-id': inbound } });
      const header = response.headers.get('x-request-id');
      expect(header).toMatch(REQUEST_ID_PATTERN);
      expect(header).not.toBe(inbound);
      expect(await response.json()).toEqual({ requestId: header });
    },
  );

  it('gives two requests without an id two different ids', async () => {
    const harness = await createTestApp({ buildApp });
    const first = await harness.client.get('/ok');
    const second = await harness.client.get('/ok');
    expect(first.headers.get('x-request-id')).not.toBe(second.headers.get('x-request-id'));
  });

  it('cannot be used to inject a header: a hostile id never reaches the response as written', async () => {
    const harness = await createTestApp({ buildApp });
    const running = await harness.listen();
    const response = await running.client.get('/ok', {
      headers: { 'x-request-id': 'abcdefgh%0d%0aInjected: yes' },
    });
    expect(response.headers.get('injected')).toBeNull();
    expect(response.headers.get('x-request-id')).toMatch(REQUEST_ID_PATTERN);
  });
});

// ---------------------------------------------------------------------------------------------
// T-A-040: the route conventions (FR-A-020), through the real pipeline of `createHttpApp`
// ---------------------------------------------------------------------------------------------

const PROBLEM_TYPE = 'application/problem+json';

async function problemOf(response: Response): Promise<Record<string, unknown>> {
  expect(response.headers.get('content-type')).toContain(PROBLEM_TYPE);
  return await readJson<Record<string, unknown>>(response);
}

describe('an unknown /api path is a 404 problem, never HTML (FR-A-020)', () => {
  it.each([
    '/api/v1/nonexistent',
    '/api/nothing',
    '/api/v1/fixture/read/extra',
    '/api/v1/fixture/items',
    '/api/v1/fixture/items/',
    '/api/v1/',
    '/api/',
    '/api/v2/fixture/read',
    '/api/v1/%2e%2e/etc',
    '/api/v1/fixture/READ',
  ])('GET %s', async (path) => {
    const app = await createFixtureApp();
    const response = await app.client.get(path, { headers: { accept: 'text/html,*/*' } });
    expect(response.status).toBe(404);
    const body = await problemOf(response);
    expect(body.code).toBe('not_found');
    expect(body.requestId).toBe(response.headers.get('x-request-id'));
    expect(response.headers.get('content-type')).not.toContain('text/html');
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    '%s to an unknown path is a 404, not a 405',
    async (method) => {
      const app = await createFixtureApp();
      const response = await app.client.request(method, '/api/v1/nonexistent', { json: {} });
      expect(response.status).toBe(404);
      expect((await problemOf(response)).code).toBe('not_found');
      expect(app.calls.total()).toBe(0);
    },
  );

  it('answers a page navigation outside /api with the fallback and an unknown /api path with a problem', async () => {
    const app = await createFixtureApp();
    const page = await app.client.get('/some/page', { headers: { accept: 'text/html' } });
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    const api = await app.client.get('/api/some/page', { headers: { accept: 'text/html' } });
    expect(api.status).toBe(404);
  });
});

describe('a wrong method on a known path is a 405 problem with Allow (FR-A-020)', () => {
  it.each([
    ['POST', '/api/v1/fixture/read', 'GET, HEAD'],
    ['DELETE', '/api/v1/fixture/read', 'GET, HEAD'],
    ['GET', '/api/v1/fixture/ping', 'POST'],
    ['DELETE', '/api/v1/fixture/ping', 'POST'],
    ['PATCH', '/api/v1/fixture/things/abc', 'DELETE, PUT'],
    ['POST', '/api/v1/fixture/things/abc', 'DELETE, PUT'],
    ['PUT', '/api/v1/fixture/things', 'POST'],
  ])('%s %s answers 405 and Allow: %s', async (method, path, allow) => {
    const app = await createFixtureApp();
    const response = await app.client.request(method, path, method === 'GET' ? {} : { json: {} });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe(allow);
    expect((await problemOf(response)).code).toBe('method_not_allowed');
    expect(app.calls.total()).toBe(0);
  });

  it('does not run the CSRF or Origin check first: the answer is the same without them', async () => {
    const app = await createFixtureApp();
    const response = await app.client.delete('/api/v1/fixture/ping', {
      origin: null,
      csrf: 'none',
    });
    expect(response.status).toBe(405);
  });

  it('serves HEAD for a GET route, with the headers and no body', async () => {
    const app = await createFixtureApp();
    const get = await app.client.get('/api/v1/fixture/read');
    const head = await app.client.request('HEAD', '/api/v1/fixture/read');
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect(head.headers.get('content-type')).toBe(get.headers.get('content-type'));
  });
});

describe('OPTIONS is not answered and no CORS header is sent (FR-A-047)', () => {
  it.each([
    '/api/v1/fixture/read',
    '/api/v1/fixture/things',
    '/api/v1/nonexistent',
    '/',
    '/healthz',
  ])('OPTIONS %s is a 405 problem', async (path) => {
    const app = await createFixtureApp();
    const response = await app.client.request('OPTIONS', path, {
      headers: {
        origin: 'https://evil.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'x-csrf-token',
      },
    });
    expect(response.status).toBe(405);
    expect((await problemOf(response)).code).toBe('method_not_allowed');
    expect(response.headers.get('allow')).toMatch(/^[A-Z]+(, [A-Z]+)*$/);
    for (const name of response.headers.keys()) {
      expect(name.startsWith('access-control-')).toBe(false);
    }
  });

  it('lists the methods the route really has', async () => {
    const app = await createFixtureApp();
    const response = await app.client.request('OPTIONS', '/api/v1/fixture/things/abc');
    expect(response.headers.get('allow')).toBe('DELETE, PUT');
  });
});

describe('a JSON write needs a JSON content type (FR-A-020)', () => {
  it.each([
    'text/plain',
    'application/x-www-form-urlencoded',
    'multipart/form-data; boundary=x',
    'application/xml',
    'application/jsonp',
    'text/json',
  ])('%s gives 415 unsupported_media_type', async (contentType) => {
    const app = await createFixtureApp({ signedIn: ADMIN });
    const response = await app.client.post('/api/v1/fixture/things', {
      body: '{"name":"ok"}',
      headers: { 'content-type': contentType },
    });
    expect(response.status).toBe(415);
    expect((await problemOf(response)).code).toBe('unsupported_media_type');
    expect(app.calls.total()).toBe(0);
  });

  it.each(['application/json', 'application/json; charset=utf-8', 'Application/JSON'])(
    '%s is accepted',
    async (contentType) => {
      const app = await createFixtureApp({ signedIn: ADMIN });
      const response = await app.client.post('/api/v1/fixture/things', {
        body: '{"name":"ok"}',
        headers: { 'content-type': contentType },
      });
      expect(response.status).toBe(201);
    },
  );

  it('requires multipart for the upload route', async () => {
    const app = await createFixtureApp({ signedIn: ADMIN });
    const json = await app.client.post('/api/v1/fixture/upload', { json: { file: 'x' } });
    expect(json.status).toBe(415);
    const form = new FormData();
    form.set('file', new Blob(['abc']), 'a.png');
    const multipart = await app.client.post('/api/v1/fixture/upload', { body: form });
    expect(multipart.status).toBe(200);
  });

  it('refuses a body on a DELETE route unless it is JSON, and accepts none', async () => {
    const app = await createFixtureApp({ signedIn: ADMIN });
    const none = await app.client.delete('/api/v1/fixture/things/abc');
    expect(none.status).toBe(200);
    const text = await app.client.delete('/api/v1/fixture/things/abc', {
      body: 'x',
      headers: { 'content-type': 'text/plain' },
    });
    expect(text.status).toBe(415);
  });
});

describe('every response has X-Request-Id and a problem carries the same id (FR-A-024)', () => {
  const CASES: readonly {
    readonly name: string;
    readonly mode: 'anonymous' | 'admin';
    readonly send: (app: Awaited<ReturnType<typeof createFixtureApp>>) => Promise<Response>;
    readonly status: number;
  }[] = [
    {
      name: 'a 200',
      mode: 'admin',
      send: (a) => a.client.get('/api/v1/fixture/read'),
      status: 200,
    },
    {
      name: 'a 201',
      mode: 'admin',
      send: (a) => a.client.post('/api/v1/fixture/things', { json: { name: 'x' } }),
      status: 201,
    },
    { name: 'a 404', mode: 'anonymous', send: (a) => a.client.get('/api/v1/zzz'), status: 404 },
    {
      name: 'a 405',
      mode: 'anonymous',
      send: (a) => a.client.post('/api/v1/fixture/read'),
      status: 405,
    },
    {
      name: 'a 415',
      mode: 'anonymous',
      send: (a) =>
        a.client.post('/api/v1/fixture/things', {
          body: 'x',
          headers: { 'content-type': 'text/plain' },
        }),
      status: 415,
    },
    {
      name: 'a 403 for the Origin',
      mode: 'anonymous',
      send: (a) =>
        a.client.post('/api/v1/fixture/things', { json: {}, origin: 'https://evil.example' }),
      status: 403,
    },
    {
      name: 'a 401 for the anonymous actor on a permission route (was 403 in Phase A, FR-B-414)',
      mode: 'anonymous',
      send: (a) => a.client.post('/api/v1/fixture/things', { json: { name: 'x' } }),
      status: 401,
    },
    {
      name: 'a 422',
      mode: 'admin',
      send: (a) => a.client.post('/api/v1/fixture/things', { json: {} }),
      status: 422,
    },
    {
      name: 'a 422 for a path parameter',
      mode: 'anonymous',
      send: (a) => a.client.get('/api/v1/fixture/items/x'),
      status: 422,
    },
    {
      name: 'a 500',
      mode: 'anonymous',
      send: (a) => a.client.get('/api/v1/fixture/boom'),
      status: 500,
    },
    {
      name: 'a 405 for OPTIONS',
      mode: 'anonymous',
      send: (a) => a.client.request('OPTIONS', '/api/v1/fixture/read'),
      status: 405,
    },
  ];

  it.each(CASES)('$name', async ({ mode, send, status }) => {
    const app = await createFixtureApp(mode === 'admin' ? { signedIn: ADMIN } : {});
    const response = await send(app);
    expect(response.status).toBe(status);
    const id = response.headers.get('x-request-id');
    expect(id).toMatch(REQUEST_ID_PATTERN);
    if (status >= 400) expect((await problemOf(response)).requestId).toBe(id);
  });

  it('puts a 429 on the same footing, with an integer Retry-After', async () => {
    const app = await createFixtureApp({
      rules: {
        read: { capacity: 1, refillIntervalMs: 2_000 },
        write: { capacity: 10, refillIntervalMs: 2_000 },
        upload: { capacity: 3, refillIntervalMs: 10_000 },
      },
    });
    await app.client.get('/api/v1/fixture/read');
    const limited = await app.client.get('/api/v1/fixture/read');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toMatch(/^[1-9]\d*$/);
    expect(limited.headers.get('x-request-id')).toMatch(REQUEST_ID_PATTERN);
    expect((await problemOf(limited)).code).toBe('rate_limited');
  });

  it('keeps a valid inbound id and puts it in the problem body', async () => {
    const app = await createFixtureApp();
    const response = await app.client.get('/api/v1/zzz', {
      headers: { 'x-request-id': 'client-id-0001' },
    });
    expect(response.headers.get('x-request-id')).toBe('client-id-0001');
    expect((await problemOf(response)).requestId).toBe('client-id-0001');
  });
});

describe('a problem leaves nothing of the request behind (FR-A-022, FR-A-023)', () => {
  it('does not echo the path, the query or a body into a 404, 405, 415 or 422', async () => {
    const app = await createFixtureApp({ signedIn: ADMIN });
    const canary = 'canary-8f2c91';
    const responses = [
      await app.client.get(`/api/v1/${canary}?q=${canary}`),
      await app.client.post(`/api/v1/fixture/read?q=${canary}`, { json: { canary } }),
      await app.client.post('/api/v1/fixture/things', {
        body: canary,
        headers: { 'content-type': 'text/plain' },
      }),
      await app.client.post('/api/v1/fixture/things', { json: { name: 5, canary } }),
      await app.client.get(`/api/v1/fixture/items/${canary}${canary}`),
    ];
    for (const response of responses) {
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(await readJson(response))).not.toContain(canary);
    }
  });
});

describe('the request line and the storage hook of the pipeline (FR-A-051, plan 7.2)', () => {
  it('logs the route template, the status and the id, and nothing of the path or the query', async () => {
    const app = await createFixtureApp();
    const canary = 'canary-4e8b';
    const response = await app.client.get(`/api/v1/fixture/items/${canary}?secret=${canary}`);
    expect(response.status).toBe(200);
    const id = response.headers.get('x-request-id');
    const line = app.logs.lines().find((candidate) => candidate.requestId === id);
    expect(line).toMatchObject({
      msg: 'request',
      method: 'GET',
      route: '/api/v1/fixture/items/:id',
      status: 200,
      requestId: id,
    });
    expect(app.logs.text()).not.toContain(canary);
  });

  it('logs a path no route claimed without the path', async () => {
    const app = await createFixtureApp();
    const canary = 'canary-77ad';
    const response = await app.client.get(`/api/v1/${canary}`);
    expect(response.status).toBe(404);
    expect(app.logs.text()).not.toContain(canary);
  });

  it('tells onStorageFailure about a storage error a handler throws, and answers 503', async () => {
    const seen: string[] = [];
    const app = await createFixtureApp({
      onStorageFailure: (failure) => {
        seen.push(failure.kind);
      },
      routes: ({ calls, csrf }) => [
        ...fixtureRoutes(calls, csrf),
        defineRoute({
          id: 'fixture.corrupt',
          method: 'GET',
          path: '/api/v1/fixture/corrupt',
          access: { public: true },
          rateLimit: 'read',
          responses: { 200: { description: 'never' } },
          handler: () => {
            throw Object.assign(new Error('database disk image is malformed'), {
              code: 'SQLITE_CORRUPT',
            });
          },
        }),
      ],
    });
    const response = await app.client.get('/api/v1/fixture/corrupt');
    expect(response.status).toBe(503);
    expect((await readJson<{ code: string }>(response)).code).toBe('storage_unavailable');
    expect(seen).toEqual(['corrupt']);
    expect(app.logs.text()).not.toContain('malformed');
  });
});

// ---------------------------------------------------------------------------------------------
// Phase B: the resolution order of the wrapper (T-B-237, contracts section 1, FR-B-505, FR-B-415)
// ---------------------------------------------------------------------------------------------

const OK_RESPONSE = {
  200: {
    description: 'Done',
    content: { 'application/json': { schema: z.strictObject({ ok: z.literal(true) }) } },
  },
} as const;

type RouteSpecOf = Parameters<typeof defineRoute>[0];

function probeRoute(
  spec: Partial<RouteSpecOf> & Pick<RouteSpecOf, 'id' | 'method' | 'path'>,
  enter: (id: string) => void,
): RouteDefinition {
  return defineRoute({
    access: { public: true },
    rateLimit: spec.method === 'GET' ? 'read' : 'write',
    responses: OK_RESPONSE,
    handler: (c) => {
      enter(spec.id);
      return c.json({ ok: true }, 200);
    },
    ...spec,
  });
}

interface Pipeline {
  readonly app: FixtureApp;
  actor: Actor;
  gate: { setupOpen: boolean; breakGlass: boolean };
  readonly resolve: Mock<ActorResolver>;
  readonly slide: Mock<SessionSlider>;
}

async function pipelineOf(
  routes: (enter: (id: string) => void) => RouteDefinition[],
  extra: {
    readonly rules?: Parameters<typeof createFixtureApp>[0] extends infer O
      ? O extends { rules?: infer R }
        ? R
        : never
      : never;
  } = {},
): Promise<Pipeline> {
  const state: Pipeline = {
    actor: ANONYMOUS_ACTOR,
    gate: { setupOpen: true, breakGlass: true },
    resolve: vi.fn<ActorResolver>(),
    slide: vi.fn<SessionSlider>(),
    app: undefined as unknown as FixtureApp,
  };
  state.resolve.mockImplementation(() => state.actor);
  const app = await createFixtureApp({
    ...(extra.rules === undefined ? {} : { rules: extra.rules }),
    resolveActor: (request) => state.resolve(request),
    slideSession: (actor) => {
      state.slide(actor);
    },
    availability: {
      setupOpen: () => state.gate.setupOpen,
      breakGlass: () => state.gate.breakGlass,
    },
    routes: ({ calls, csrf }) => [
      ...fixtureRoutes(calls, csrf, { withCsrf: true }).filter(
        (route) => route.id === 'fixture.csrf',
      ),
      ...routes((id) => {
        calls.byRoute.set(id, (calls.byRoute.get(id) ?? 0) + 1);
      }),
    ],
  });
  return Object.assign(state, { app });
}

/** The paths the actor was resolved for, apart from the CSRF route a client fetches its token from. */
function resolvedPaths(pipeline: Pipeline): string[] {
  return pipeline.resolve.mock.calls
    .map(([request]) => new URL(request.url).pathname)
    .filter((path) => path !== '/api/v1/csrf');
}

/** Everything of a response except the request id, to compare a gate with an unknown path. */
async function shapeOf(response: Response): Promise<unknown> {
  const headers = [...response.headers.entries()]
    .filter(([name]) => name !== 'x-request-id')
    .sort(([a], [b]) => a.localeCompare(b));
  const body = (await response.json()) as Record<string, unknown>;
  return { status: response.status, headers, body: { ...body, requestId: '-' } };
}

/** The guard of FR-B-207: a closed route and an unknown path cannot be told apart. */
async function assertIndistinguishable(input: {
  readonly pipeline: Pipeline;
  readonly closedPath: string;
  readonly unknownPath: string;
}): Promise<void> {
  const closed = await shapeOf(await input.pipeline.app.client.get(input.closedPath));
  const unknown = await shapeOf(await input.pipeline.app.client.get(input.unknownPath));
  if (JSON.stringify(closed) !== JSON.stringify(unknown)) {
    throw new Error('the closed route and the unknown path can be told apart');
  }
}

describe('the availability gate (T-B-237, FR-B-207 mechanism, SB-29)', () => {
  const gatedRoutes = (enter: (id: string) => void): RouteDefinition[] => [
    probeRoute(
      { id: 'gated.read', method: 'GET', path: '/api/v1/gated/read', availability: 'setupOpen' },
      enter,
    ),
    probeRoute(
      { id: 'gated.make', method: 'POST', path: '/api/v1/gated/make', availability: 'setupOpen' },
      enter,
    ),
    probeRoute(
      {
        id: 'gated.second',
        method: 'GET',
        path: '/api/v1/gated/second',
        availability: 'breakGlass',
      },
      enter,
    ),
  ];

  it('lets the handler answer while the gate is open', async () => {
    const pipeline = await pipelineOf(gatedRoutes);
    const response = await pipeline.app.client.get('/api/v1/gated/read');
    expect(response.status).toBe(200);
    expect(pipeline.app.calls.of('gated.read')).toBe(1);
  });

  it('answers a closed gate byte for byte like an unknown path, apart from the request id', async () => {
    const pipeline = await pipelineOf(gatedRoutes);
    pipeline.gate.setupOpen = false;
    await assertIndistinguishable({
      pipeline,
      closedPath: '/api/v1/gated/read',
      unknownPath: '/api/v1/gated/nothing',
    });
    expect((await pipeline.app.client.get('/api/v1/gated/read')).status).toBe(404);
    expect(pipeline.app.calls.of('gated.read')).toBe(0);
  });

  it('does not let a closed gate show up as a 405 for another method', async () => {
    const pipeline = await pipelineOf(gatedRoutes);
    pipeline.gate.setupOpen = false;
    const closed = await shapeOf(await pipeline.app.client.delete('/api/v1/gated/read'));
    const unknown = await shapeOf(await pipeline.app.client.delete('/api/v1/gated/nothing'));
    expect(closed).toEqual(unknown);
    expect((closed as { status: number }).status).toBe(404);
  });

  it('is decided per gate: the other gate stays open', async () => {
    const pipeline = await pipelineOf(gatedRoutes);
    pipeline.gate.setupOpen = false;
    expect((await pipeline.app.client.get('/api/v1/gated/second')).status).toBe(200);
    pipeline.gate.breakGlass = false;
    expect((await pipeline.app.client.get('/api/v1/gated/second')).status).toBe(404);
  });

  it('answers before Origin, CSRF and the actor: a closed POST gate is a plain 404', async () => {
    const pipeline = await pipelineOf(gatedRoutes);
    pipeline.gate.setupOpen = false;
    const response = await pipeline.app.client.post('/api/v1/gated/make', {
      json: {},
      origin: 'https://evil.example',
      csrf: 'none',
    });
    expect(response.status).toBe(404);
    expect(resolvedPaths(pipeline)).toEqual([]);
  });

  describe('it consumes one token of the bucket the unknown-path fallback consumes', () => {
    const rules = {
      read: { capacity: 3, refillIntervalMs: 3_600_000 },
      write: { capacity: 2, refillIntervalMs: 3_600_000 },
    } as const;

    it('read for GET: gate hits and unknown hits share the bucket', async () => {
      const pipeline = await pipelineOf(gatedRoutes, { rules });
      pipeline.gate.setupOpen = false;
      const statuses: number[] = [];
      for (const path of ['/api/v1/gated/read', '/api/v1/gated/nothing', '/api/v1/gated/read']) {
        statuses.push((await pipeline.app.client.get(path)).status);
      }
      statuses.push((await pipeline.app.client.get('/api/v1/gated/read')).status);
      expect(statuses).toEqual([404, 404, 404, 429]);
    });

    it('write for every other method: a closed POST gate spends a write token', async () => {
      const pipeline = await pipelineOf(gatedRoutes, { rules });
      pipeline.gate.setupOpen = false;
      const post = (path: string): Promise<Response> =>
        pipeline.app.client.post(path, { json: {}, csrf: 'none' });
      expect((await post('/api/v1/gated/make')).status).toBe(404);
      expect((await post('/api/v1/gated/nothing')).status).toBe(404);
      expect((await post('/api/v1/gated/make')).status).toBe(429);
      // The read bucket is untouched.
      expect((await pipeline.app.client.get('/api/v1/gated/read')).status).toBe(404);
    });

    it('negative fixture: a route that is reachable is told apart from an unknown path', async () => {
      // The same comparison on a gate that is open: the route answers, the unknown path does not.
      const pipeline = await pipelineOf(gatedRoutes, { rules });
      await expectGuardFails(
        assertIndistinguishable,
        { pipeline, closedPath: '/api/v1/gated/read', unknownPath: '/api/v1/gated/nothing' },
        { reason: 'told apart' },
      );
    });
  });
});

describe('the order of the guards of a route (T-B-237, contracts section 1)', () => {
  const orderRoutes = (enter: (id: string) => void): RouteDefinition[] => [
    probeRoute(
      {
        id: 'order.make',
        method: 'POST',
        path: '/api/v1/order/make',
        access: { authenticated: true },
        request: {
          body: {
            required: true,
            content: { 'application/json': { schema: z.strictObject({ name: z.string() }) } },
          },
        },
      },
      enter,
    ),
  ];

  it('asks for the actor only after the rate limit, the body rules, Origin and CSRF', async () => {
    const pipeline = await pipelineOf(orderRoutes, {
      rules: { write: { capacity: 1, refillIntervalMs: 3_600_000 } },
    });
    pipeline.actor = testActor('user');
    const client = pipeline.app.client;
    await client.csrfToken();

    // Origin and CSRF refuse first.
    expect(
      (
        await client.post('/api/v1/order/make', {
          json: { name: 'a' },
          origin: 'https://evil.example',
        })
      ).status,
    ).toBe(403);
    expect(resolvedPaths(pipeline)).toEqual([]);
  });

  it('does not ask for the actor of a request the limiter refused', async () => {
    const pipeline = await pipelineOf(orderRoutes, {
      rules: { write: { capacity: 1, refillIntervalMs: 3_600_000 } },
    });
    pipeline.actor = testActor('user');
    expect(
      (await pipeline.app.client.post('/api/v1/order/make', { json: { name: 'a' } })).status,
    ).toBe(200);
    expect(resolvedPaths(pipeline)).toEqual(['/api/v1/order/make']);
    const refused = await pipeline.app.client.post('/api/v1/order/make', { json: { name: 'a' } });
    expect(refused.status).toBe(429);
    expect(resolvedPaths(pipeline)).toEqual(['/api/v1/order/make']);
  });

  it('does not ask for the actor when the CSRF token is wrong', async () => {
    const pipeline = await pipelineOf(orderRoutes);
    const response = await pipeline.app.client.post('/api/v1/order/make', {
      json: { name: 'a' },
      csrf: 'none',
    });
    expect(response.status).toBe(403);
    expect(await readJson(response)).toMatchObject({ code: 'csrf_invalid' });
    expect(resolvedPaths(pipeline)).toEqual([]);
  });

  it('answers 401 before validation, so an anonymous caller learns nothing about the body', async () => {
    const pipeline = await pipelineOf(orderRoutes);
    const response = await pipeline.app.client.post('/api/v1/order/make', { json: {} });
    expect(response.status).toBe(401);
    expect(await readJson(response)).toMatchObject({ code: 'unauthenticated' });
    expect(pipeline.app.calls.of('order.make')).toBe(0);
  });

  it('answers validation 422 only for a caller who passed every access rule', async () => {
    const pipeline = await pipelineOf(orderRoutes);
    pipeline.actor = testActor('user');
    const response = await pipeline.app.client.post('/api/v1/order/make', { json: {} });
    expect(response.status).toBe(422);
    expect(pipeline.app.calls.of('order.make')).toBe(0);
  });

  it('extends the session only for a request that passed its guards, and not on the polled reads', async () => {
    const pipeline = await pipelineOf((enter) => [
      probeRoute(
        {
          id: 'connection.log',
          method: 'GET',
          path: '/api/v1/connection/log',
          access: { connection: true },
          slidesSession: false,
        },
        enter,
      ),
      probeRoute(
        {
          id: 'connection.get',
          method: 'GET',
          path: '/api/v1/connection',
          access: { connection: true },
        },
        enter,
      ),
    ]);
    pipeline.actor = testActor('setup');
    await pipeline.app.client.get('/api/v1/connection/log');
    expect(pipeline.slide).not.toHaveBeenCalled();
    await pipeline.app.client.get('/api/v1/connection');
    expect(pipeline.slide).toHaveBeenCalledTimes(1);
    expect(pipeline.slide.mock.calls[0]?.[0].kind).toBe('setup');
    // A refused request does not extend anything.
    pipeline.actor = ANONYMOUS_ACTOR;
    expect((await pipeline.app.client.get('/api/v1/connection')).status).toBe(401);
    expect(pipeline.slide).toHaveBeenCalledTimes(1);
  });

  it('asks for the actor of a refused write only if the denial audit reads it', async () => {
    const denials: string[] = [];
    const actors: Actor[] = [];
    const state = {
      resolve: vi.fn<ActorResolver>(() => testActor('user', { id: 'someone' })),
    };
    const app = await createFixtureApp({
      resolveActor: (request) => state.resolve(request),
      onDenied: (c, denial) => {
        denials.push(denial.code);
        actors.push(c.get('actor'));
      },
      routes: ({ calls, csrf }) => [
        ...fixtureRoutes(calls, csrf, { withCsrf: true }).filter(
          (route) => route.id === 'fixture.csrf',
        ),
        ...orderRoutes(() => undefined),
      ],
    });
    const response = await app.client.post('/api/v1/order/make', {
      json: { name: 'a' },
      origin: 'https://evil.example',
    });
    expect(response.status).toBe(403);
    expect(denials).toEqual(['origin_not_allowed']);
    expect(actors[0]?.kind).toBe('user');
    expect(actors[0]?.id).toBe('someone');
    expect(
      state.resolve.mock.calls.filter(
        ([request]) => new URL(request.url).pathname === '/api/v1/order/make',
      ),
    ).toHaveLength(1);
  });
});

describe('who may call a route: the access words, the kinds and the step-up (T-B-237)', () => {
  const RBAC = 'rbac:manage';
  const accessRoutes = (enter: (id: string) => void): RouteDefinition[] => [
    probeRoute(
      {
        id: 'acc.authenticated',
        method: 'GET',
        path: '/api/v1/acc/authenticated',
        access: { authenticated: true },
      },
      enter,
    ),
    probeRoute(
      {
        id: 'acc.usersonly',
        method: 'GET',
        path: '/api/v1/acc/usersonly',
        access: { authenticated: true, actorKinds: ['user'] },
      },
      enter,
    ),
    probeRoute(
      {
        id: 'acc.permission',
        method: 'GET',
        path: '/api/v1/acc/permission',
        access: { permission: RBAC, unscopedReason: 'global-only permission' },
      },
      enter,
    ),
    probeRoute(
      {
        id: 'acc.kinds',
        method: 'GET',
        path: '/api/v1/acc/kinds',
        access: {
          permission: RBAC,
          actorKinds: ['user'],
          unscopedReason: 'global-only permission',
        },
      },
      enter,
    ),
    probeRoute(
      {
        id: 'acc.stepup',
        method: 'GET',
        path: '/api/v1/acc/stepup',
        access: { permission: RBAC, stepUp: true, unscopedReason: 'global-only permission' },
      },
      enter,
    ),
    probeRoute(
      { id: 'acc.setup', method: 'GET', path: '/api/v1/setup/acc', access: { setup: true } },
      enter,
    ),
    probeRoute(
      {
        id: 'acc.connection',
        method: 'GET',
        path: '/api/v1/connection/acc',
        access: { connection: true },
      },
      enter,
    ),
    probeRoute(
      {
        id: 'acc.connection.stepup',
        method: 'GET',
        path: '/api/v1/connection/stepup',
        access: { connection: true, stepUp: true },
      },
      enter,
    ),
  ];

  interface Row {
    readonly route: string;
    readonly path: string;
    readonly actor: Actor;
    readonly status: number;
    readonly code?: string;
  }

  const user = (permissions: Parameters<typeof testActor>[1] = {}): Actor =>
    testActor('user', permissions);
  const rows: readonly Row[] = [
    { route: 'authenticated: user', path: '/api/v1/acc/authenticated', actor: user(), status: 200 },
    {
      route: 'authenticated: break-glass',
      path: '/api/v1/acc/authenticated',
      actor: testActor('break_glass'),
      status: 200,
    },
    {
      route: 'authenticated: anonymous',
      path: '/api/v1/acc/authenticated',
      actor: ANONYMOUS_ACTOR,
      status: 401,
      code: 'unauthenticated',
    },
    {
      route: 'authenticated: the setup actor is not authenticated in this sense',
      path: '/api/v1/acc/authenticated',
      actor: testActor('setup'),
      status: 401,
      code: 'unauthenticated',
    },
    {
      route: 'actorKinds: a user passes',
      path: '/api/v1/acc/usersonly',
      actor: user(),
      status: 200,
    },
    {
      route: 'actorKinds: break-glass is refused',
      path: '/api/v1/acc/usersonly',
      actor: testActor('break_glass'),
      status: 403,
      code: 'permission_denied',
    },
    {
      route: 'actorKinds: anonymous is 401, not 403',
      path: '/api/v1/acc/usersonly',
      actor: ANONYMOUS_ACTOR,
      status: 401,
      code: 'unauthenticated',
    },
    {
      route: 'permission: held',
      path: '/api/v1/acc/permission',
      actor: user({ permissions: [RBAC] }),
      status: 200,
    },
    {
      route: 'permission: missing',
      path: '/api/v1/acc/permission',
      actor: user(),
      status: 403,
      code: 'permission_denied',
    },
    {
      route: 'permission: the setup actor lacks it',
      path: '/api/v1/acc/permission',
      actor: testActor('setup', { permissions: ['settings:branding', 'settings:connection'] }),
      status: 403,
      code: 'permission_denied',
    },
    {
      route: 'kinds before permission: a break-glass actor that holds it',
      path: '/api/v1/acc/kinds',
      actor: testActor('break_glass', { permissions: [RBAC] }),
      status: 403,
      code: 'permission_denied',
    },
    {
      route: 'kinds: a user that holds it',
      path: '/api/v1/acc/kinds',
      actor: user({ permissions: [RBAC] }),
      status: 200,
    },
    {
      route: 'stepUp: fresh',
      path: '/api/v1/acc/stepup',
      actor: user({ permissions: [RBAC], stepUpFresh: true }),
      status: 200,
    },
    {
      route: 'stepUp: stale',
      path: '/api/v1/acc/stepup',
      actor: user({ permissions: [RBAC], stepUpFresh: false }),
      status: 403,
      code: 'step_up_required',
    },
    {
      route: 'stepUp: permission is checked before it',
      path: '/api/v1/acc/stepup',
      actor: user({ stepUpFresh: false }),
      status: 403,
      code: 'permission_denied',
    },
    {
      route: 'stepUp: break-glass is exempt',
      path: '/api/v1/acc/stepup',
      actor: testActor('break_glass', { permissions: [RBAC] }),
      status: 200,
    },
    {
      route: 'setup: the setup actor',
      path: '/api/v1/setup/acc',
      actor: testActor('setup'),
      status: 200,
    },
    {
      route: 'setup: a signed-in user is not the setup actor',
      path: '/api/v1/setup/acc',
      actor: user({ permissions: ['settings:connection'] }),
      status: 401,
      code: 'unauthenticated',
    },
    {
      route: 'setup: anonymous',
      path: '/api/v1/setup/acc',
      actor: ANONYMOUS_ACTOR,
      status: 401,
      code: 'unauthenticated',
    },
    {
      route: 'connection: the setup actor',
      path: '/api/v1/connection/acc',
      actor: testActor('setup'),
      status: 200,
    },
    {
      route: 'connection: a user with settings:connection',
      path: '/api/v1/connection/acc',
      actor: user({ permissions: ['settings:connection'] }),
      status: 200,
    },
    {
      route: 'connection: a user without it',
      path: '/api/v1/connection/acc',
      actor: user(),
      status: 403,
      code: 'permission_denied',
    },
    {
      route: 'connection: break-glass',
      path: '/api/v1/connection/acc',
      actor: testActor('break_glass', { permissions: [RBAC] }),
      status: 403,
      code: 'permission_denied',
    },
    {
      route: 'connection: anonymous',
      path: '/api/v1/connection/acc',
      actor: ANONYMOUS_ACTOR,
      status: 401,
      code: 'unauthenticated',
    },
    {
      route: 'connection + stepUp: the setup actor is exempt',
      path: '/api/v1/connection/stepup',
      actor: testActor('setup'),
      status: 200,
    },
    {
      route: 'connection + stepUp: a stale user',
      path: '/api/v1/connection/stepup',
      actor: user({ permissions: ['settings:connection'], stepUpFresh: false }),
      status: 403,
      code: 'step_up_required',
    },
    {
      route: 'connection + stepUp: a fresh user',
      path: '/api/v1/connection/stepup',
      actor: user({ permissions: ['settings:connection'], stepUpFresh: true }),
      status: 200,
    },
  ];

  it.each(rows)('$route', async ({ path, actor, status, code }) => {
    const pipeline = await pipelineOf(accessRoutes);
    pipeline.actor = actor;
    const response = await pipeline.app.client.get(path);
    expect(response.status).toBe(status);
    if (code !== undefined) expect(await readJson(response)).toMatchObject({ code });
    expect(Object.fromEntries(pipeline.app.calls.byRoute)).toEqual(
      status === 200 ? { [rowId(path)]: 1 } : {},
    );
  });

  function rowId(path: string): string {
    const found = [
      ...[
        ['/api/v1/acc/authenticated', 'acc.authenticated'],
        ['/api/v1/acc/usersonly', 'acc.usersonly'],
        ['/api/v1/acc/permission', 'acc.permission'],
        ['/api/v1/acc/kinds', 'acc.kinds'],
        ['/api/v1/acc/stepup', 'acc.stepup'],
        ['/api/v1/setup/acc', 'acc.setup'],
        ['/api/v1/connection/acc', 'acc.connection'],
        ['/api/v1/connection/stepup', 'acc.connection.stepup'],
      ],
    ].find(([candidate]) => candidate === path);
    return found?.[1] ?? '';
  }

  it('answers a refused step-up before validation', async () => {
    const pipeline = await pipelineOf((enter) => [
      probeRoute(
        {
          id: 'acc.make',
          method: 'POST',
          path: '/api/v1/acc/make',
          access: { permission: RBAC, stepUp: true, unscopedReason: 'global-only permission' },
          request: {
            body: {
              required: true,
              content: { 'application/json': { schema: z.strictObject({ name: z.string() }) } },
            },
          },
        },
        enter,
      ),
    ]);
    pipeline.actor = user({ permissions: [RBAC], stepUpFresh: false });
    const stale = await pipeline.app.client.post('/api/v1/acc/make', { json: {} });
    expect(stale.status).toBe(403);
    expect(await readJson(stale)).toMatchObject({ code: 'step_up_required' });
    pipeline.actor = user({ permissions: [RBAC], stepUpFresh: true });
    expect((await pipeline.app.client.post('/api/v1/acc/make', { json: {} })).status).toBe(422);
    expect(
      (await pipeline.app.client.post('/api/v1/acc/make', { json: { name: 'x' } })).status,
    ).toBe(200);
  });

  it('is the actor kind that decides, not a name in the request', async () => {
    const pipeline = await pipelineOf(accessRoutes);
    pipeline.actor = user({ permissions: [RBAC] });
    const response = await pipeline.app.client.get('/api/v1/acc/permission', {
      headers: { 'x-actor': 'break_glass', cookie: 'actor=setup' },
    });
    expect(response.status).toBe(200);
    expect(pipeline.resolve.mock.calls[0]?.[0]).toBeInstanceOf(Request);
  });
});

describe('the Sec-Fetch-Site exemption (T-B-237, SB-25)', () => {
  const callback = (enter: (id: string) => void): RouteDefinition[] => [
    probeRoute(
      {
        id: 'auth.callback',
        method: 'GET',
        path: '/auth/callback',
        audit: 'auth.signin',
        rateLimit: 'auth',
        secFetch: 'cross-site-allowed',
      },
      enter,
    ),
    probeRoute(
      {
        id: 'auth.audited',
        method: 'GET',
        path: '/auth/audited',
        audit: 'auth.signin',
        rateLimit: 'auth',
      },
      enter,
    ),
  ];

  it('lets a cross-site navigation reach auth.callback and nothing else', async () => {
    const pipeline = await pipelineOf(callback);
    const crossSite = { headers: { 'sec-fetch-site': 'cross-site' } };
    expect((await pipeline.app.client.get('/auth/callback', crossSite)).status).toBe(200);
    expect((await pipeline.app.client.get('/auth/audited', crossSite)).status).toBe(403);
  });

  it('spends the auth class on both', async () => {
    const pipeline = await pipelineOf(callback, {
      rules: { auth: { capacity: 2, refillIntervalMs: 3_600_000 } },
    });
    const statuses = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      statuses.push((await pipeline.app.client.get('/auth/callback')).status);
    }
    expect(statuses).toEqual([200, 200, 429]);
    expect(LIMITS.rateLimit.auth.capacity).toBe(10);
  });
});

describe('the lazy actor (T-B-237, SB-32)', () => {
  it('resolves nothing until it is read, and once', () => {
    const resolve = vi.fn(() => testActor('user', { id: 'u1', permissions: ['audit:read'] }));
    const lazy = createLazyActor(resolve);
    expect(resolve).not.toHaveBeenCalled();
    expect(lazy.kind).toBe('user');
    expect(lazy.id).toBe('u1');
    expect(lazy.permissions.has('audit:read')).toBe(true);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('behaves as the actor for spread, in and keys', () => {
    const lazy = createLazyActor(() => testActor('setup', { id: 'setup' }));
    expect('kind' in lazy).toBe(true);
    expect({ ...lazy }).toMatchObject({ kind: 'setup', id: 'setup' });
    expect(Object.keys(lazy)).toContain('permissions');
  });

  it('cannot be changed through the handle', () => {
    const lazy = createLazyActor(() => testActor('user'));
    expect(() => {
      (lazy as { kind: string }).kind = 'break_glass';
    }).toThrow(TypeError);
    expect(lazy.kind).toBe('user');
  });

  it('asks again after a failure, and keeps the first answer after a success', () => {
    let attempt = 0;
    const lazy = createLazyActor(() => {
      attempt += 1;
      if (attempt === 1) throw new Error('storage');
      return testActor('user', { id: `attempt-${String(attempt)}` });
    });
    expect(() => lazy.kind).toThrow('storage');
    expect(lazy.id).toBe('attempt-2');
    expect(lazy.id).toBe('attempt-2');
  });
});

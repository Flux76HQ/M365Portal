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
import { createFixtureApp, fixtureRoutes } from './helpers/http-app.js';
import { defineRoute } from '../src/http/route.js';
import { readJson } from './helpers/http-client.js';
import { createTestApp } from './helpers/test-app.js';

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
    const app = await createFixtureApp({ env: { PREVIEW_MODE: 'true' } });
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
      const app = await createFixtureApp({ env: { PREVIEW_MODE: 'true' } });
      const response = await app.client.post('/api/v1/fixture/things', {
        body: '{"name":"ok"}',
        headers: { 'content-type': contentType },
      });
      expect(response.status).toBe(201);
    },
  );

  it('requires multipart for the upload route', async () => {
    const app = await createFixtureApp({ env: { PREVIEW_MODE: 'true' } });
    const json = await app.client.post('/api/v1/fixture/upload', { json: { file: 'x' } });
    expect(json.status).toBe(415);
    const form = new FormData();
    form.set('file', new Blob(['abc']), 'a.png');
    const multipart = await app.client.post('/api/v1/fixture/upload', { body: form });
    expect(multipart.status).toBe(200);
  });

  it('refuses a body on a DELETE route unless it is JSON, and accepts none', async () => {
    const app = await createFixtureApp({ env: { PREVIEW_MODE: 'true' } });
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
    readonly mode: 'anonymous' | 'preview';
    readonly send: (app: Awaited<ReturnType<typeof createFixtureApp>>) => Promise<Response>;
    readonly status: number;
  }[] = [
    {
      name: 'a 200',
      mode: 'preview',
      send: (a) => a.client.get('/api/v1/fixture/read'),
      status: 200,
    },
    {
      name: 'a 201',
      mode: 'preview',
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
      name: 'a 403 for the permission',
      mode: 'anonymous',
      send: (a) => a.client.post('/api/v1/fixture/things', { json: { name: 'x' } }),
      status: 403,
    },
    {
      name: 'a 422',
      mode: 'preview',
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
    const app = await createFixtureApp(mode === 'preview' ? { env: { PREVIEW_MODE: 'true' } } : {});
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
    const app = await createFixtureApp({ env: { PREVIEW_MODE: 'true' } });
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

// T-A-040 (FR-A-031, FR-A-033 mechanism, PD-22, C4): the route wrapper, the route table and the fixed
// order of the guards.
//
//   - A route without an `access` declaration is a type error, and one that slips through at run time
//     (a cast, a plain object) makes the application refuse to boot (`createHttpApp` throws).
//   - The table check refuses every other malformed declaration as well: two accesses, a permission
//     that is not in the catalogue, a duplicate id or path, a write outside `/api/v1`, a rate class
//     that does not fit the method, a fallback that claims to be documented.
//   - The guards run in the order rate limit, body limit, content type, Origin, CSRF, authorisation,
//     validation, handler. A request that fails two of them reports the earlier one, and a cross-site
//     request learns nothing about permissions.
//
// Negative fixtures (tasks.md section 0.3): every table rule is run through `expectGuardFails` with
// an entry that breaks it, and the order matrix is run on pipelines built in the wrong order.
import { LIMITS } from '@m365portal/shared/limits';
import { PERMISSIONS } from '@m365portal/shared/permissions';
import { expectGuardFails } from '@m365portal/shared/testing';
import { Hono, type MiddlewareHandler } from 'hono';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { loadConfig } from '../src/config/index.js';
import { createCsrf, csrfGuard } from '../src/http/csrf.js';
import { originGuard } from '../src/http/origin.js';
import { bodyLimit } from '../src/http/body-limit.js';
import { requireContentType } from '../src/http/content-type.js';
import { createErrorHandler } from '../src/http/error-handler.js';
import { problemResponse } from '../src/http/problem.js';
import { createRateLimiter, rateLimit } from '../src/http/rate-limit.js';
import { requestContext, type AppEnv } from '../src/http/request-context.js';
import {
  defineFallback,
  defineRoute,
  type FallbackDefinition,
  type RouteDefinition,
} from '../src/http/route.js';
import {
  RouteTable,
  RouteTableError,
  assertRouteTable,
  assertRouterMatchesTable,
  registeredRoutesOf,
  validateRouteTable,
  type RouteTableEntry,
} from '../src/http/route-table.js';
import { authorize, createActorResolver } from '../src/policy/index.js';
import { createFakeClock } from './helpers/fake-clock.js';
import { createHttpClient, readJson, type HttpClient } from './helpers/http-client.js';
import {
  FIXTURE_PERMISSION,
  createFixtureApp,
  createFixtureCalls,
  fixtureRoutes,
} from './helpers/http-app.js';
import { createCaptureLogger } from './helpers/capture-logger.js';
import { createLogCapture } from './helpers/log-capture.js';

const noop = (): Response => new Response(null, { status: 204 });

function entry(overrides: Partial<Record<keyof RouteTableEntry, unknown>> = {}): unknown {
  return {
    kind: 'route',
    id: 'thing.list',
    methods: ['GET'],
    paths: ['/api/v1/things'],
    access: { public: true },
    rateLimit: 'read',
    openapi: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------------
// The declaration: a type error, and a refusal to boot
// ---------------------------------------------------------------------------------------------

describe('a route must declare its access (FR-A-031)', () => {
  it('is a type error to define a route without access', () => {
    // @ts-expect-error -- `access` is required: exactly one of `{ public: true }` or `{ permission }`
    const missing = defineRoute({
      id: 'thing.list',
      method: 'GET',
      path: '/api/v1/things',
      rateLimit: 'read',
      responses: { 200: { description: 'ok' } },
      handler: noop,
    });
    expect(missing.kind).toBe('route');
  });

  it('is a type error to declare both a permission and public: true', () => {
    const both = defineRoute({
      id: 'thing.list',
      method: 'GET',
      path: '/api/v1/things',
      // @ts-expect-error -- one or the other, never both
      access: { public: true, permission: 'users:read' },
      rateLimit: 'read',
      responses: { 200: { description: 'ok' } },
      handler: noop,
    });
    expect(both.kind).toBe('route');
  });

  it('is a type error to name a permission that is not in the catalogue', () => {
    const unknown = defineRoute({
      id: 'thing.list',
      method: 'GET',
      path: '/api/v1/things',
      // @ts-expect-error -- 'users:write' is not one of the fifteen
      access: { permission: 'users:write' },
      rateLimit: 'read',
      responses: { 200: { description: 'ok' } },
      handler: noop,
    });
    expect(unknown.kind).toBe('route');
  });

  it('is a type error to leave out the rate class', () => {
    // @ts-expect-error -- `rateLimit` is required
    const missing = defineRoute({
      id: 'thing.list',
      method: 'GET',
      path: '/api/v1/things',
      access: { public: true },
      responses: { 200: { description: 'ok' } },
      handler: noop,
    });
    expect(missing.kind).toBe('route');
  });

  it('is a type error for a fallback to leave out access, or to claim it is documented', () => {
    // @ts-expect-error -- `access` is required for a fallback too
    const noAccess = defineFallback({
      id: 'fallback.thing',
      methods: ['GET'],
      paths: ['/*'],
      rateLimit: 'read',
      openapi: false,
      handler: () => undefined,
    });
    const documented = defineFallback({
      id: 'fallback.thing',
      methods: ['GET'],
      paths: ['/*'],
      access: { public: true },
      rateLimit: 'read',
      // @ts-expect-error -- a fallback is never part of the OpenAPI document: `openapi: false`
      openapi: true,
      handler: () => undefined,
    });
    expect(noAccess.kind).toBe('fallback');
    expect(documented.kind).toBe('fallback');
  });

  it('types the handler input from the request schemas', () => {
    defineRoute({
      id: 'thing.create',
      method: 'POST',
      path: '/api/v1/things/{id}',
      access: { permission: 'contacts:create' },
      rateLimit: 'write',
      request: {
        params: z.object({ id: z.string() }),
        query: z.object({ dryRun: z.enum(['true', 'false']) }),
        body: {
          required: true,
          content: { 'application/json': { schema: z.object({ name: z.string() }) } },
        },
      },
      responses: { 201: { description: 'created' } },
      handler: (c, input) => {
        expectTypeOf(input.params.id).toEqualTypeOf<string>();
        expectTypeOf(input.query.dryRun).toEqualTypeOf<'true' | 'false'>();
        expectTypeOf(input.body.name).toEqualTypeOf<string>();
        return c.body(null, 201);
      },
    });
  });
});

describe('the application refuses to boot on a malformed table (FR-A-031)', () => {
  const calls = createFixtureCalls();
  const csrf = createCsrf({ now: () => 0 });
  const good = fixtureRoutes(calls, csrf);

  /** A definition that got past the compiler, the way a cast or untyped JavaScript would. */
  function slippedThrough(patch: Record<string, unknown>): RouteDefinition {
    return defineRoute({
      id: 'slipped.route',
      method: 'GET',
      path: '/api/v1/slipped',
      access: { public: true },
      rateLimit: 'read',
      responses: { 200: { description: 'ok' } },
      handler: noop,
      ...patch,
    } as never);
  }

  async function boot(routes: readonly RouteDefinition[]): Promise<void> {
    const app = await createFixtureApp({ routes: () => routes });
    await app.close();
  }

  it('boots with the fixture routes', async () => {
    await expect(boot(good)).resolves.toBeUndefined();
  });

  it('throws at boot for a route without access, naming the route and nothing else', async () => {
    const route = slippedThrough({ access: undefined });
    await expect(boot([...good, route])).rejects.toThrow(RouteTableError);
    await expect(boot([...good, route])).rejects.toThrow(/slipped\.route.*access/);
  });

  it('throws at boot for a route that declares both a permission and public: true', async () => {
    const route = slippedThrough({ access: { public: true, permission: 'users:read' } });
    await expect(boot([...good, route])).rejects.toThrow(/slipped\.route.*exactly one/);
  });

  it('throws at boot for access that is empty, falsy or not an object', async () => {
    for (const access of [{}, { public: false }, { public: 'yes' }, 'public', null, 7]) {
      await expect(boot([...good, slippedThrough({ access })])).rejects.toThrow(RouteTableError);
    }
  });

  it('throws at boot for a permission that is not in the catalogue', async () => {
    const route = slippedThrough({ access: { permission: 'users:write' } });
    await expect(boot([...good, route])).rejects.toThrow(/slipped\.route.*catalogue/);
  });

  it('throws at boot for an object that did not come from defineRoute', async () => {
    const plain = {
      id: 'plain.route',
      method: 'GET',
      path: '/api/v1/plain',
      access: { public: true },
      rateLimit: 'read',
      responses: {},
      handler: noop,
    } as unknown as RouteDefinition;
    await expect(boot([...good, plain])).rejects.toThrow(/defineRoute/);
  });

  it('does not echo the content of a definition in the error', async () => {
    const route = slippedThrough({ access: { permission: 'canary-value-1f3a' } });
    const failure = await boot([...good, route]).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect((failure as Error).message).not.toContain('canary-value-1f3a');
  });
});

// ---------------------------------------------------------------------------------------------
// The table check, rule by rule, each with the entry that must fail it
// ---------------------------------------------------------------------------------------------

const TABLE_RULES: readonly {
  readonly name: string;
  readonly entries: readonly unknown[];
  readonly reason: RegExp;
}[] = [
  {
    name: 'no access',
    entries: [entry({ access: undefined })],
    reason: /thing\.list.*access/,
  },
  {
    name: 'both accesses',
    entries: [entry({ access: { public: true, permission: 'users:read' } })],
    reason: /thing\.list.*exactly one/,
  },
  {
    name: 'a permission outside the catalogue',
    entries: [entry({ access: { permission: 'users:write' } })],
    reason: /thing\.list.*catalogue/,
  },
  {
    name: 'a missing id',
    entries: [entry({ id: undefined })],
    reason: /id/,
  },
  {
    name: 'an id that is not dotted words',
    entries: [entry({ id: 'List Things' })],
    reason: /id/,
  },
  {
    name: 'a duplicate id',
    entries: [entry(), entry({ paths: ['/api/v1/other'] })],
    reason: /thing\.list.*more than once/,
  },
  {
    name: 'a duplicate method and path',
    entries: [entry(), entry({ id: 'thing.again' })],
    reason: /GET \/api\/v1\/things.*more than one/,
  },
  {
    name: 'a method that is not a route method',
    entries: [entry({ methods: ['HEAD'] })],
    reason: /method/,
  },
  {
    name: 'a path that does not start with a slash',
    entries: [entry({ paths: ['api/v1/things'] })],
    reason: /path/,
  },
  {
    name: 'a path with a query string',
    entries: [entry({ paths: ['/api/v1/things?x=1'] })],
    reason: /path/,
  },
  {
    name: 'a route path with a wildcard',
    entries: [entry({ paths: ['/api/v1/things/*'] })],
    reason: /wildcard/,
  },
  {
    name: 'Hono-style path parameters',
    entries: [entry({ paths: ['/api/v1/things/:id'] })],
    reason: /path/,
  },
  {
    name: 'a write route outside /api/v1',
    entries: [
      entry({ id: 'thing.make', methods: ['POST'], paths: ['/things'], rateLimit: 'write' }),
    ],
    reason: /thing\.make.*\/api\/v1/,
  },
  {
    name: 'a write route whose id is not an audit action',
    entries: [
      entry({
        id: 'thing.makeOne',
        methods: ['POST'],
        paths: ['/api/v1/things'],
        rateLimit: 'write',
      }),
    ],
    reason: /thing\.makeOne.*audit action/,
  },
  {
    name: 'a write route in the read class',
    entries: [
      entry({
        id: 'thing.make',
        methods: ['POST'],
        paths: ['/api/v1/things'],
        rateLimit: 'read',
      }),
    ],
    reason: /thing\.make.*write or upload/,
  },
  {
    name: 'a read route in the upload class',
    entries: [entry({ rateLimit: 'upload' })],
    reason: /thing\.list.*read or exempt/,
  },
  {
    name: 'an unknown rate class',
    entries: [entry({ rateLimit: 'fast' })],
    reason: /rate/,
  },
  {
    name: 'an audit action that is not a name',
    entries: [entry({ audit: 'Export Things' })],
    reason: /audit/,
  },
  {
    name: 'a route that is not part of the OpenAPI document',
    entries: [entry({ openapi: false })],
    reason: /thing\.list.*documented/,
  },
  {
    name: 'a fallback that is part of the OpenAPI document',
    entries: [entry({ kind: 'fallback', id: 'fallback.page', paths: ['/*'], openapi: true })],
    reason: /fallback\.page.*openapi: false/,
  },
  {
    name: 'a fallback with no methods',
    entries: [
      entry({ kind: 'fallback', id: 'fallback.page', paths: ['/*'], methods: [], openapi: false }),
    ],
    reason: /fallback\.page.*method/,
  },
  {
    name: 'a fallback with a wildcard in the middle of its path',
    entries: [entry({ kind: 'fallback', id: 'fallback.page', paths: ['/a/*/b'], openapi: false })],
    reason: /fallback\.page.*path/,
  },
  {
    name: 'an entry that is neither a route nor a fallback',
    entries: [entry({ kind: 'middleware' })],
    reason: /kind/,
  },
];

describe('validateRouteTable and assertRouteTable', () => {
  it('accepts a correct table: routes, an audited read, a fallback', () => {
    const entries = [
      entry(),
      entry({ id: 'thing.export', paths: ['/api/v1/things/export'], audit: 'thing.export' }),
      entry({
        id: 'thing.make',
        methods: ['POST'],
        paths: ['/api/v1/things'],
        access: { permission: 'contacts:create' },
        rateLimit: 'write',
      }),
      entry({ id: 'health.live', paths: ['/healthz'], rateLimit: 'exempt' }),
      entry({
        kind: 'fallback',
        id: 'fallback.page',
        paths: ['/*', '/assets/*'],
        rateLimit: 'by-method',
        openapi: false,
      }),
    ];
    expect(validateRouteTable(entries)).toEqual([]);
    expect(() => {
      assertRouteTable(entries);
    }).not.toThrow();
  });

  it('accepts every permission of the catalogue', () => {
    PERMISSIONS.forEach((permission, index) => {
      expect(
        validateRouteTable([
          entry({
            id: `thing.get${String(index)}`,
            paths: [`/api/v1/things${String(index)}`],
            access: { permission },
          }),
        ]),
      ).toEqual([]);
    });
  });

  it.each(TABLE_RULES)('reports $name', ({ entries, reason }) => {
    const problems = validateRouteTable(entries);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('\n')).toMatch(reason);
  });

  describe.each(TABLE_RULES)('negative fixture: $name', ({ entries, reason }) => {
    it('makes the boot check fail on purpose', () => {
      expectGuardFails(assertRouteTable, entries, { reason });
    });
  });

  it('reports every problem, not only the first', () => {
    const problems = validateRouteTable([
      entry({ access: undefined }),
      entry({ id: 'thing.two', paths: ['/api/v1/two'], rateLimit: 'fast' }),
    ]);
    expect(problems.length).toBeGreaterThanOrEqual(2);
  });

  it('throws a RouteTableError that lists the problems', () => {
    try {
      assertRouteTable([entry({ access: undefined })]);
      expect.unreachable();
    } catch (failure) {
      expect(failure).toBeInstanceOf(RouteTableError);
      expect((failure as RouteTableError).problems.length).toBeGreaterThan(0);
    }
  });
});

describe('RouteTable: which methods a path answers', () => {
  const table = new RouteTable([
    entry() as RouteTableEntry,
    entry({
      id: 'thing.item',
      paths: ['/api/v1/things/{id}'],
      methods: ['GET'],
    }) as RouteTableEntry,
    entry({
      id: 'thing.change',
      methods: ['PUT'],
      paths: ['/api/v1/things/{id}'],
      rateLimit: 'write',
    }) as RouteTableEntry,
    entry({
      id: 'thing.remove',
      methods: ['DELETE'],
      paths: ['/api/v1/things/{id}'],
      rateLimit: 'write',
    }) as RouteTableEntry,
    entry({
      kind: 'fallback',
      id: 'fallback.page',
      paths: ['/*'],
      openapi: false,
    }) as RouteTableEntry,
  ]);

  it('lists the methods of the routes that match, HEAD with GET, sorted', () => {
    expect(table.allowFor('/api/v1/things')).toEqual(['GET', 'HEAD']);
    expect(table.allowFor('/api/v1/things/abc')).toEqual(['DELETE', 'GET', 'HEAD', 'PUT']);
  });

  it('lists nothing for a path no route matches, whatever a fallback says', () => {
    expect(table.allowFor('/nowhere')).toEqual([]);
    expect(table.allowFor('/api/v1/things/abc/def')).toEqual([]);
    expect(table.allowFor('/api/v1/thingsabc')).toEqual([]);
  });

  it('does not let a parameter match an empty segment or cross a slash', () => {
    expect(table.allowFor('/api/v1/things/')).toEqual([]);
    expect(table.allowFor('/api/v1/things/a/b')).toEqual([]);
  });

  it('keeps routes and fallbacks apart', () => {
    expect(table.routes.map((route) => route.id)).toEqual([
      'thing.list',
      'thing.item',
      'thing.change',
      'thing.remove',
    ]);
    expect(table.fallbacks.map((fallback) => fallback.id)).toEqual(['fallback.page']);
  });
});

// ---------------------------------------------------------------------------------------------
// The fixed guard order
// ---------------------------------------------------------------------------------------------

type Mode = 'anonymous' | 'preview';

interface Probe {
  readonly client: HttpClient;
  readonly handlerCalls: () => number;
}

const THINGS = '/api/v1/fixture/things';
const ORIGIN = 'http://localhost:9300';
const FOREIGN = 'https://evil.example';
const VALID_BODY = { name: 'ok' };

const TIGHT_WRITE = {
  read: LIMITS.rateLimit.read,
  write: { capacity: 1, refillIntervalMs: 60_000 },
  upload: LIMITS.rateLimit.upload,
} as const;

interface OrderCase {
  readonly name: string;
  readonly mode: Mode;
  readonly tight?: true;
  /** How many requests burn the single token of the tight write bucket first. */
  readonly prime?: number;
  readonly send: (client: HttpClient) => Promise<Response>;
  readonly status: number;
  readonly code: string;
  /** The handler must not have been entered (it is for the last case only). */
  readonly handled?: true;
}

const ORDER_CASES: readonly OrderCase[] = [
  {
    name: 'rate limit comes before every other guard',
    mode: 'anonymous',
    tight: true,
    prime: 1,
    send: (client) =>
      client.post(THINGS, {
        body: 'x'.repeat(LIMITS.body.jsonBytes + 1),
        headers: { 'content-type': 'text/plain' },
        origin: FOREIGN,
        csrf: 'none',
      }),
    status: 429,
    code: 'rate_limited',
  },
  {
    name: 'the body limit comes before the content type check',
    mode: 'anonymous',
    send: (client) =>
      client.post(THINGS, {
        body: 'x'.repeat(LIMITS.body.jsonBytes + 1),
        headers: { 'content-type': 'text/plain' },
        origin: FOREIGN,
        csrf: 'none',
      }),
    status: 413,
    code: 'payload_too_large',
  },
  {
    name: 'the content type check comes before the Origin check',
    mode: 'anonymous',
    send: (client) =>
      client.post(THINGS, {
        body: 'name=ok',
        headers: { 'content-type': 'text/plain' },
        origin: FOREIGN,
        csrf: 'none',
      }),
    status: 415,
    code: 'unsupported_media_type',
  },
  {
    name: 'the Origin check comes before the CSRF check',
    mode: 'anonymous',
    send: (client) =>
      client.post(THINGS, { json: VALID_BODY, origin: FOREIGN, csrf: { token: 'v1.invalid' } }),
    status: 403,
    code: 'origin_not_allowed',
  },
  {
    name: 'the CSRF check comes before authorisation',
    mode: 'anonymous',
    send: (client) => client.post(THINGS, { json: VALID_BODY, origin: ORIGIN, csrf: 'none' }),
    status: 403,
    code: 'csrf_invalid',
  },
  {
    name: 'authorisation comes before validation',
    mode: 'anonymous',
    send: (client) => client.post(THINGS, { json: {} }),
    status: 403,
    code: 'permission_denied',
  },
  {
    name: 'validation comes before the handler',
    mode: 'preview',
    send: (client) => client.post(THINGS, { json: {} }),
    status: 422,
    code: 'validation_failed',
  },
  {
    name: 'a request that passes every guard reaches the handler',
    mode: 'preview',
    send: (client) => client.post(THINGS, { json: VALID_BODY }),
    status: 201,
    code: '',
    handled: true,
  },
];

/**
 * The guard behind the negative fixtures: throws, naming the case, when a pipeline answers a request
 * that fails two guards with the later one's answer, or enters a handler it should not have.
 */
async function assertOrderMatrix(
  make: (mode: Mode, tight: boolean) => Promise<Probe>,
  cases: readonly OrderCase[] = ORDER_CASES,
): Promise<void> {
  for (const testCase of cases) {
    const probe = await make(testCase.mode, testCase.tight === true);
    for (let burn = 0; burn < (testCase.prime ?? 0); burn += 1) {
      await probe.client.post(THINGS, { json: VALID_BODY });
    }
    const before = probe.handlerCalls();
    const response = await testCase.send(probe.client);
    const body = await readJson<{ code?: string }>(response);
    if (response.status !== testCase.status || (body.code ?? '') !== testCase.code) {
      throw new Error(
        `${testCase.name}: expected ${String(testCase.status)} ${testCase.code}, got ${String(response.status)} ${String(body.code)}`,
      );
    }
    const entered = probe.handlerCalls() - before;
    if (entered !== (testCase.handled === true ? 1 : 0)) {
      throw new Error(`${testCase.name}: the handler was entered ${String(entered)} time(s)`);
    }
  }
}

/** The real pipeline: `createHttpApp` over the fixture routes. */
async function realPipeline(mode: Mode, tight: boolean): Promise<Probe> {
  const app = await createFixtureApp({
    env: mode === 'preview' ? { PREVIEW_MODE: 'true' } : {},
    ...(tight ? { rules: TIGHT_WRITE } : {}),
  });
  return { client: app.client, handlerCalls: () => app.calls.of('fixture.create') };
}

type GuardName = 'rate' | 'body' | 'type' | 'origin' | 'csrf' | 'authz' | 'validate';

/** The same guards, assembled by hand in the order given: the reference the matrix is checked on. */
function referencePipeline(
  order: readonly GuardName[],
): (mode: Mode, tight: boolean) => Promise<Probe> {
  return (mode, tight) => {
    const clock = createFakeClock();
    const loaded = loadConfig({
      DATA_DIR: '/tmp/unused',
      PUBLIC_BASE_URL: ORIGIN,
      ...(mode === 'preview' ? { PREVIEW_MODE: 'true' } : {}),
    });
    if (!loaded.ok) throw new Error('configuration refused');
    const { config } = loaded;
    const csrf = createCsrf({ now: () => clock.nowMs() });
    const limiter = createRateLimiter({
      now: () => clock.nowMs(),
      ...(tight ? { rules: TIGHT_WRITE } : {}),
    });
    const resolve = createActorResolver(config);
    let handled = 0;

    const guards: Record<GuardName, MiddlewareHandler<AppEnv>> = {
      rate: rateLimit({
        limiter,
        classOf: (request) => (request.method === 'GET' ? 'read' : 'write'),
      }),
      body: bodyLimit('json'),
      type: requireContentType('json'),
      origin: originGuard({ expectedOrigin: config.publicOrigin }),
      csrf: csrfGuard({ csrf }),
      authz: async (c, next) => {
        const decision = authorize(c.get('actor'), FIXTURE_PERMISSION);
        if (!decision.allow) return problemResponse(c, 'permission_denied');
        await next();
        return undefined;
      },
      validate: async (c, next) => {
        const body = (await c.req.json().catch(() => ({}))) as { name?: unknown };
        if (typeof body.name !== 'string') {
          return problemResponse(c, 'validation_failed', {
            errors: [{ pointer: '/name', code: 'required' }],
          });
        }
        await next();
        return undefined;
      },
    };

    const app = new Hono<AppEnv>();
    const log = createCaptureLogger(createLogCapture());
    app.use(requestContext({ config, now: () => clock.nowMs() }));
    app.use(async (c, next) => {
      c.set('actor', resolve(c.req.raw));
      await next();
    });
    app.onError(createErrorHandler({ log }));
    app.get('/api/v1/csrf', (c) => c.json(csrf.issue(''), 200));
    const final: MiddlewareHandler<AppEnv> = (c) => {
      handled += 1;
      return Promise.resolve(c.json({ id: 'one', name: 'ok' }, 201));
    };
    app.on('POST', [THINGS], ...[...order.map((name) => guards[name]), final]);
    return Promise.resolve({
      client: createHttpClient({
        fetch: (request) => app.fetch(request),
        baseUrl: ORIGIN,
        origin: ORIGIN,
      }),
      handlerCalls: () => handled,
    });
  };
}

const CORRECT_ORDER: readonly GuardName[] = [
  'rate',
  'body',
  'type',
  'origin',
  'csrf',
  'authz',
  'validate',
];

describe('the fixed guard order (PD-22, plan 7.2)', () => {
  it('rate limit, body limit, content type, Origin, CSRF, authorisation, validation, handler', async () => {
    await expect(assertOrderMatrix(realPipeline)).resolves.toBeUndefined();
  });

  describe('the matrix, case by case, on the real pipeline', () => {
    it.each(ORDER_CASES)('$name', async (testCase) => {
      await expect(assertOrderMatrix(realPipeline, [testCase])).resolves.toBeUndefined();
    });
  });

  it('is not tied to the implementation: a hand-built pipeline in the right order passes it too', async () => {
    await expect(assertOrderMatrix(referencePipeline(CORRECT_ORDER))).resolves.toBeUndefined();
  });

  describe('negative fixtures: a pipeline in the wrong order fails the matrix', () => {
    const wrong: readonly {
      readonly name: string;
      readonly order: readonly GuardName[];
      readonly reason: RegExp;
    }[] = [
      {
        name: 'authorisation before the Origin and CSRF checks (a foreign page learns about permissions)',
        order: ['rate', 'body', 'type', 'authz', 'origin', 'csrf', 'validate'],
        reason: /Origin check comes before the CSRF check|CSRF check comes before authorisation/,
      },
      {
        name: 'the CSRF check before the Origin check',
        order: ['rate', 'body', 'type', 'csrf', 'origin', 'authz', 'validate'],
        reason: /Origin check comes before the CSRF check/,
      },
      {
        name: 'the content type check before the body limit',
        order: ['rate', 'type', 'body', 'origin', 'csrf', 'authz', 'validate'],
        reason: /body limit comes before the content type check/,
      },
      {
        name: 'validation before authorisation',
        order: ['rate', 'body', 'type', 'origin', 'csrf', 'validate', 'authz'],
        reason: /authorisation comes before validation/,
      },
      {
        name: 'the rate limit last',
        order: ['body', 'type', 'origin', 'csrf', 'authz', 'validate', 'rate'],
        reason: /rate limit comes before every other guard|body limit/,
      },
      {
        name: 'a pipeline without the CSRF check',
        order: ['rate', 'body', 'type', 'origin', 'authz', 'validate'],
        reason: /CSRF check comes before authorisation/,
      },
    ];

    it.each(wrong)('$name', async ({ order, reason }) => {
      await expectGuardFails(assertOrderMatrix, referencePipeline(order), { reason });
    });
  });

  it('answers a cross-site request the same way whether or not the actor holds the permission', async () => {
    const anonymous = await createFixtureApp();
    const preview = await createFixtureApp({ env: { PREVIEW_MODE: 'true' } });
    const attempt = async (client: HttpClient): Promise<Record<string, unknown>> => {
      const response = await client.post(THINGS, { json: VALID_BODY, origin: FOREIGN });
      const body = await readJson<Record<string, unknown>>(response);
      expect(response.status).toBe(403);
      return { ...body, requestId: 'x' };
    };
    const forAnonymous = await attempt(anonymous.client);
    const forPreview = await attempt(preview.client);
    expect(forAnonymous).toEqual(forPreview);
    expect(forAnonymous.code).toBe('origin_not_allowed');
    expect(forAnonymous.expectedOrigin).toBe(ORIGIN);
    expect(JSON.stringify(forAnonymous)).not.toContain(FIXTURE_PERMISSION);
    expect(anonymous.calls.of('fixture.create')).toBe(0);
    expect(preview.calls.of('fixture.create')).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// The wrapper itself
// ---------------------------------------------------------------------------------------------

describe('defineRoute and defineFallback return the definition, frozen', () => {
  it('freezes the definition and keeps what was declared', () => {
    const route = defineRoute({
      id: 'thing.list',
      method: 'GET',
      path: '/api/v1/things',
      access: { permission: 'users:read' },
      rateLimit: 'read',
      summary: 'List things',
      responses: { 200: { description: 'ok' } },
      handler: noop,
    });
    expect(Object.isFrozen(route)).toBe(true);
    expect(route.id).toBe('thing.list');
    expect(route.access).toEqual({ permission: 'users:read' });
    expect(route.rateLimit).toBe('read');
  });

  it('a fallback keeps its methods, paths and the openapi: false marker', () => {
    const fallback: FallbackDefinition = defineFallback({
      id: 'fallback.thing',
      methods: ['GET'],
      paths: ['/*'],
      access: { public: true },
      rateLimit: 'by-method',
      openapi: false,
      handler: () => undefined,
    });
    expect(fallback.openapi).toBe(false);
    expect(fallback.paths).toEqual(['/*']);
    expect(Object.isFrozen(fallback)).toBe(true);
  });
});

describe('the boot check also reconciles the router with the table', () => {
  it('the router of the real application holds exactly what the table declares', async () => {
    const app = await createFixtureApp();
    expect(() => {
      assertRouterMatchesTable(app.http.table, registeredRoutesOf(app.http.app));
    }).not.toThrow();
  });

  it('refuses to boot when the router holds a route the table does not know', async () => {
    const app = await createFixtureApp();
    // A route added behind the wrapper's back, the way a direct `app.get` would.
    const sneaky = new Hono<AppEnv>();
    sneaky.get('/api/v1/sneaky', () => new Response('x'));
    expect(() => {
      assertRouterMatchesTable(app.http.table, registeredRoutesOf(sneaky));
    }).toThrow(/GET \/api\/v1\/sneaky/);
  });

  it('refuses to boot when the table declares a route the router does not hold', async () => {
    const app = await createFixtureApp();
    const empty = new Hono<AppEnv>();
    expect(() => {
      assertRouterMatchesTable(app.http.table, registeredRoutesOf(empty));
    }).toThrow(/fixture\.read/);
  });

  it('negative fixture: a router with an extra route fails the check on purpose', async () => {
    const app = await createFixtureApp();
    const sneaky = new Hono<AppEnv>();
    sneaky.post('/api/v1/sneaky', () => new Response('x'));
    expectGuardFails(
      (registered: ReturnType<typeof registeredRoutesOf>) => {
        assertRouterMatchesTable(app.http.table, registered);
      },
      registeredRoutesOf(sneaky),
      { reason: 'POST /api/v1/sneaky' },
    );
  });
});

// ---------------------------------------------------------------------------------------------
// An audited read (FR-A-044)
// ---------------------------------------------------------------------------------------------

describe('a GET route that declares an audit action applies the Sec-Fetch-Site rule (FR-A-044)', () => {
  const EXPORT = '/api/v1/fixture/export';

  it.each([
    ['cross-site', 403],
    ['same-site', 403],
    ['', 403],
    ['unexpected', 403],
    ['same-origin', 200],
    ['none', 200],
  ])('Sec-Fetch-Site %j gives %i', async (value, status) => {
    const app = await createFixtureApp({ env: { PREVIEW_MODE: 'true' } });
    const response = await app.client.get(EXPORT, { headers: { 'sec-fetch-site': value } });
    expect(response.status).toBe(status);
    if (status === 403) {
      const body = await readJson<{ code: string; expectedOrigin: string }>(response);
      expect(body.code).toBe('origin_not_allowed');
      expect(body.expectedOrigin).toBe(ORIGIN);
      expect(app.calls.of('fixture.export')).toBe(0);
    } else {
      expect(app.calls.of('fixture.export')).toBe(1);
    }
  });

  it('lets a request without Sec-Fetch-Site through (a client that does not send it)', async () => {
    const app = await createFixtureApp({ env: { PREVIEW_MODE: 'true' } });
    expect((await app.client.get(EXPORT)).status).toBe(200);
  });

  it('refuses a cross-site request before it asks who the actor is', async () => {
    const app = await createFixtureApp();
    const response = await app.client.get(EXPORT, { headers: { 'sec-fetch-site': 'cross-site' } });
    expect((await readJson<{ code: string }>(response)).code).toBe('origin_not_allowed');
  });

  it('leaves a GET route without an audit action alone', async () => {
    const app = await createFixtureApp();
    const response = await app.client.get('/api/v1/fixture/read', {
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(response.status).toBe(200);
  });

  it('does not report a refused read to the denial hook: a refused GET is not audited', async () => {
    const denials: string[] = [];
    const app = await createFixtureApp({
      env: { PREVIEW_MODE: 'true' },
      onDenied: (_c, denial) => {
        denials.push(denial.code);
      },
    });
    await app.client.get(EXPORT, { headers: { 'sec-fetch-site': 'cross-site' } });
    expect(denials).toEqual([]);
  });
});

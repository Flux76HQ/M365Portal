// An application under test for the route-level tests (T-A-040 and after): the real pipeline of
// `createHttpApp` (request context, headers, compression, cache rules, the per-route guards, the
// error handler) with a small set of synthetic routes that cover every shape a real route can have:
// public and permission routes, reads and writes, an audited read, an upload, an import, a route
// whose handler throws. The real routes (health, meta, robots, static files, and the branding module
// of S2) are added by the tests that concern them, through `routes` and `fallbacks`.
//
// Everything that tests move is injected: the clock (CSRF tokens, request times), the rate limits,
// the configuration (as environment variables), the denial hook. Counters record how often each
// handler was entered, which is how a test proves that a guard stopped a request BEFORE the handler.
import { LIMITS } from '@m365portal/shared/limits';
import { CsrfResponseSchema } from '@m365portal/shared/schemas/meta';
import { z } from 'zod';
import { loadConfig } from '../../src/config/index.js';
import { withLegacyPreview } from './legacy-preview.js';
import { createCsrf, type Csrf } from '../../src/http/csrf.js';
import { createRateLimiter, type RateLimiter, type RateRule } from '../../src/http/rate-limit.js';
import {
  createHttpApp,
  defineFallback,
  defineRoute,
  type FallbackDefinition,
  type HttpApp,
  type HttpAppDeps,
  type OnRouteDenied,
  type RouteDefinition,
} from '../../src/http/route.js';
import { createDocumentSource } from '../../src/http/openapi.js';
import { createLogger } from '../../src/logging/logger.js';
import { healthRoutes, type Readiness } from '../../src/routes/health.js';
import { metaRoutes } from '../../src/routes/meta.js';
import { robotsRoutes } from '../../src/routes/robots.js';
import type { FakeClock } from './fake-clock.js';
import { createTestApp, type TestApp, type TestAppContext } from './test-app.js';

export const FIXTURE_PERMISSION = 'settings:branding';

export const ThingInputSchema = z
  .strictObject({ name: z.string().min(1).max(32) })
  .meta({ id: 'FixtureThingInput' });
export const ThingSchema = z
  .strictObject({ id: z.string(), name: z.string() })
  .meta({ id: 'FixtureThing' });

/** How often each handler of the fixture routes was entered (`total` leaves the CSRF route out). */
export interface FixtureCalls {
  readonly byRoute: Map<string, number>;
  total(): number;
  of(id: string): number;
}

export function createFixtureCalls(): FixtureCalls {
  const byRoute = new Map<string, number>();
  return {
    byRoute,
    // The CSRF route is how a client gets its token: it is not a handler a guard should have stopped.
    total: () =>
      [...byRoute].reduce((sum, [id, count]) => (id === 'fixture.csrf' ? sum : sum + count), 0),
    of: (id) => byRoute.get(id) ?? 0,
  };
}

/**
 * The routes every fixture app has unless the test passes its own. `withCsrf: false` leaves out the
 * fixture's own `/api/v1/csrf` (the real meta routes bring theirs).
 */
export function fixtureRoutes(
  calls: FixtureCalls,
  csrf: Csrf,
  options: { readonly withCsrf?: boolean } = {},
): RouteDefinition[] {
  const enter = (id: string): void => {
    calls.byRoute.set(id, (calls.byRoute.get(id) ?? 0) + 1);
  };
  const emptyOk = {
    200: {
      description: 'Done',
      content: { 'application/json': { schema: z.strictObject({ ok: z.literal(true) }) } },
    },
  } as const;

  const csrfRoutes =
    options.withCsrf === false
      ? []
      : [
          defineRoute({
            id: 'fixture.csrf',
            method: 'GET',
            path: '/api/v1/csrf',
            access: { public: true },
            rateLimit: 'read',
            summary: 'Fixture CSRF token',
            responses: {
              200: {
                description: 'A token',
                content: { 'application/json': { schema: CsrfResponseSchema } },
              },
            },
            handler: (c) => {
              enter('fixture.csrf');
              return c.json(csrf.issue(''), 200);
            },
          }),
        ];

  return [
    ...csrfRoutes,
    defineRoute({
      id: 'fixture.read',
      method: 'GET',
      path: '/api/v1/fixture/read',
      access: { public: true },
      rateLimit: 'read',
      responses: emptyOk,
      handler: (c) => {
        enter('fixture.read');
        return c.json({ ok: true }, 200);
      },
    }),
    defineRoute({
      id: 'fixture.item',
      method: 'GET',
      path: '/api/v1/fixture/items/{id}',
      access: { public: true },
      rateLimit: 'read',
      request: { params: z.object({ id: z.string().min(2).max(16) }) },
      responses: {
        200: {
          description: 'The item',
          content: { 'application/json': { schema: z.strictObject({ id: z.string() }) } },
        },
      },
      handler: (c, input) => {
        enter('fixture.item');
        return c.json({ id: input.params.id }, 200);
      },
    }),
    defineRoute({
      id: 'fixture.secret',
      method: 'GET',
      path: '/api/v1/fixture/secret',
      access: { permission: 'audit:read' },
      rateLimit: 'read',
      responses: emptyOk,
      handler: (c) => {
        enter('fixture.secret');
        return c.json({ ok: true }, 200);
      },
    }),
    defineRoute({
      id: 'fixture.export',
      method: 'GET',
      path: '/api/v1/fixture/export',
      access: { permission: FIXTURE_PERMISSION },
      rateLimit: 'read',
      audit: 'fixture.export',
      responses: emptyOk,
      handler: (c) => {
        enter('fixture.export');
        return c.json({ ok: true }, 200);
      },
    }),
    defineRoute({
      id: 'fixture.create',
      method: 'POST',
      path: '/api/v1/fixture/things',
      access: { permission: FIXTURE_PERMISSION },
      rateLimit: 'write',
      audit: 'fixture.create',
      request: {
        body: { required: true, content: { 'application/json': { schema: ThingInputSchema } } },
      },
      responses: {
        201: {
          description: 'Created',
          content: { 'application/json': { schema: ThingSchema } },
        },
      },
      handler: (c, input) => {
        enter('fixture.create');
        return c.json({ id: 'one', name: input.body.name }, 201);
      },
    }),
    defineRoute({
      id: 'fixture.update',
      method: 'PUT',
      path: '/api/v1/fixture/things/{id}',
      access: { permission: FIXTURE_PERMISSION },
      rateLimit: 'write',
      request: {
        params: z.object({ id: z.string().min(1).max(16) }),
        body: { required: true, content: { 'application/json': { schema: ThingInputSchema } } },
      },
      responses: {
        200: { description: 'Updated', content: { 'application/json': { schema: ThingSchema } } },
      },
      handler: (c, input) => {
        enter('fixture.update');
        return c.json({ id: input.params.id, name: input.body.name }, 200);
      },
    }),
    defineRoute({
      id: 'fixture.remove',
      method: 'DELETE',
      path: '/api/v1/fixture/things/{id}',
      access: { permission: FIXTURE_PERMISSION },
      rateLimit: 'write',
      request: { params: z.object({ id: z.string().min(1).max(16) }) },
      responses: emptyOk,
      handler: (c) => {
        enter('fixture.remove');
        return c.json({ ok: true }, 200);
      },
    }),
    defineRoute({
      id: 'fixture.ping',
      method: 'POST',
      path: '/api/v1/fixture/ping',
      access: { public: true },
      rateLimit: 'write',
      responses: emptyOk,
      handler: (c) => {
        enter('fixture.ping');
        return c.json({ ok: true }, 200);
      },
    }),
    defineRoute({
      id: 'fixture.upload',
      method: 'POST',
      path: '/api/v1/fixture/upload',
      access: { permission: FIXTURE_PERMISSION },
      rateLimit: 'upload',
      request: {
        body: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                properties: { file: { type: 'string', format: 'binary' } },
                required: ['file'],
              },
            },
          },
        },
      },
      responses: emptyOk,
      handler: async (c) => {
        enter('fixture.upload');
        const form = await c.req.formData();
        return c.json({ ok: form.has('file') as true }, 200);
      },
    }),
    defineRoute({
      id: 'fixture.import',
      method: 'POST',
      path: '/api/v1/fixture/import',
      access: { permission: FIXTURE_PERMISSION },
      rateLimit: 'upload',
      bodyLimit: 'import',
      request: {
        body: { required: true, content: { 'application/json': { schema: z.looseObject({}) } } },
      },
      responses: emptyOk,
      handler: (c) => {
        enter('fixture.import');
        return c.json({ ok: true }, 200);
      },
    }),
    defineRoute({
      id: 'fixture.boom',
      method: 'GET',
      path: '/api/v1/fixture/boom',
      access: { public: true },
      rateLimit: 'read',
      responses: emptyOk,
      handler: () => {
        throw new Error('canary-boom');
      },
    }),
  ];
}

/** A page-like fallback: HTML for a navigation, a decline for everything else. */
export function fixtureFallbacks(): FallbackDefinition[] {
  return [
    defineFallback({
      id: 'fixture.page',
      methods: ['GET'],
      paths: ['/*'],
      access: { public: true },
      rateLimit: 'read',
      openapi: false,
      handler: (c) => {
        const accept = c.req.header('accept') ?? '';
        if (!accept.includes('text/html') || c.req.path.startsWith('/api')) return undefined;
        return c.html('<!doctype html><title>fixture</title>', 200);
      },
    }),
  ];
}

/** The real health, meta and robots routes (T-A-042) in place of the fixture's CSRF route. */
export interface SystemOptions {
  readonly readiness?: Readiness;
  readonly storageAvailable?: () => boolean;
  readonly version?: string;
}

export const SYSTEM_VERSION = '1.2.3-test';

export interface FixtureAppOptions {
  /** Add the real system routes: health, `/api/v1/me`, CSRF, the OpenAPI document, robots. */
  readonly system?: SystemOptions;
  /** Environment variables over the harness defaults (`PREVIEW_MODE`, `TRUST_PROXY`, ...). */
  readonly env?: Readonly<Record<string, string>>;
  /** Replaces the fixture routes. The fixture CSRF route is added when none of them is `/api/v1/csrf`. */
  readonly routes?: (context: { calls: FixtureCalls; csrf: Csrf }) => readonly RouteDefinition[];
  readonly fallbacks?: readonly FallbackDefinition[];
  /** Rate limit rules instead of `LIMITS.rateLimit`, for a test that must reach a limit. */
  readonly rules?: Readonly<Record<'read' | 'write' | 'upload', RateRule>>;
  readonly onDenied?: OnRouteDenied;
  /** Told about every storage failure the error handler answers (readiness follows it). */
  readonly onStorageFailure?: HttpAppDeps['onStorageFailure'];
  readonly context?: Partial<Pick<TestAppContext, 'dataDir'>>;
  /** A clock the test already has (the denial audit reads time from the same one). */
  readonly clock?: FakeClock;
}

export interface FixtureApp extends TestApp<FixtureFetchable> {
  readonly calls: FixtureCalls;
  readonly csrf: Csrf;
  readonly limiter: RateLimiter;
  readonly http: HttpApp;
}

export interface FixtureFetchable {
  fetch(request: Request, env?: unknown): Response | Promise<Response>;
  readonly http: HttpApp;
}

export async function createFixtureApp(options: FixtureAppOptions = {}): Promise<FixtureApp> {
  const calls = createFixtureCalls();
  let csrf: Csrf | undefined;
  let limiter: RateLimiter | undefined;

  const testApp = await createTestApp<FixtureFetchable>({
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.context?.dataDir === undefined ? {} : { dataDir: options.context.dataDir }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    buildApp: (context) => {
      const loaded = loadConfig(context.env);
      if (!loaded.ok) throw new Error('the fixture configuration was refused');
      const config = withLegacyPreview(loaded.config, context.env);
      csrf = createCsrf({ now: () => context.clock.nowMs() });
      limiter = createRateLimiter({
        now: () => context.clock.nowMs(),
        ...(options.rules === undefined ? {} : { rules: options.rules }),
      });
      const log = createLogger({
        level: 'debug',
        destination: context.logs,
        now: () => context.clock.nowMs(),
      });
      const source = createDocumentSource();
      const version = options.system?.version ?? SYSTEM_VERSION;
      const readyChecks = ['data_dir', 'database', 'schema'] as const;
      const systemRoutes =
        options.system === undefined
          ? []
          : [
              ...healthRoutes({
                version,
                readiness: options.system.readiness ?? {
                  check: () => ({
                    status: 'ready',
                    checks: readyChecks.map((name) => ({ name, ok: true })),
                  }),
                },
              }),
              ...metaRoutes({
                version,
                publicOrigin: config.publicOrigin,
                showcase: config.showcase,
                storageAvailable: options.system.storageAvailable ?? (() => true),
                csrf,
                document: source,
              }),
              ...robotsRoutes(),
            ];
      const routes = options.routes?.({ calls, csrf }) ?? [
        ...systemRoutes,
        ...fixtureRoutes(calls, csrf, { withCsrf: options.system === undefined }),
      ];
      const http = createHttpApp({
        config,
        routes,
        fallbacks: options.fallbacks ?? fixtureFallbacks(),
        csrf,
        limiter,
        log,
        now: () => context.clock.nowMs(),
        ...(options.onDenied === undefined ? {} : { onDenied: options.onDenied }),
        ...(options.onStorageFailure === undefined
          ? {}
          : { onStorageFailure: options.onStorageFailure }),
        openApi: { version: '0.0.0-test', source },
      });
      return { fetch: (request, env) => http.app.fetch(request, env as never), http };
    },
  });
  if (csrf === undefined || limiter === undefined) throw new Error('the fixture was not built');
  return Object.assign(testApp, { calls, csrf, limiter, http: testApp.app.http });
}

/** The default limits, for tests that need a number from them. */
export const WRITE_BUCKET = LIMITS.rateLimit.write.capacity;

// ---------------------------------------------------------------------------------------------
// The write routes of a table, read from the table and the OpenAPI document
// ---------------------------------------------------------------------------------------------

const WRITE_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export type RequestBody = NonNullable<
  NonNullable<ConstructorParameters<typeof Request>[1]>['body']
>;

export interface WriteRoute {
  readonly id: string;
  readonly method: string;
  /** The path with every parameter replaced by `abc`: a path that can be requested. */
  readonly path: string;
  /** The path as declared, `{name}` and all. */
  readonly template: string;
  readonly permission: string | undefined;
  readonly multipart: boolean;
}

/** Every write route under /api/v1 in the table of an application. */
export function writeRoutesOf(app: { readonly http: HttpApp }): WriteRoute[] {
  const operations = new Map<string, { requestBody?: { content?: Record<string, unknown> } }>();
  for (const [path, item] of Object.entries(app.http.document.paths ?? {})) {
    for (const [method, operation] of Object.entries(item as Record<string, unknown>)) {
      operations.set(`${method.toUpperCase()} ${path}`, operation as never);
    }
  }
  return app.http.table.routes
    .filter((route) => route.paths[0]?.startsWith('/api/v1/') === true)
    .filter((route) => WRITE_METHODS.has(route.methods[0] ?? ''))
    .map((route) => {
      const method = route.methods[0] ?? '';
      const template = route.paths[0] ?? '';
      const content = operations.get(`${method} ${template}`)?.requestBody?.content ?? {};
      return {
        id: route.id,
        method,
        path: template.replaceAll(/\{[^}]+\}/g, 'abc'),
        template,
        permission: 'permission' in route.access ? route.access.permission : undefined,
        multipart: Object.keys(content).some((type) => type.startsWith('multipart/form-data')),
      };
    });
}

/** A body of the kind the route takes (JSON, or one multipart `file` part). */
export function requestBodyFor(route: WriteRoute): { body?: RequestBody; json?: unknown } {
  if (route.multipart) {
    const form = new FormData();
    form.set('file', new Blob(['abc']), 'a.png');
    return { body: form };
  }
  return { json: { name: 'x' } };
}

// The route wrapper (FR-A-020, FR-A-021, FR-A-031, FR-A-033 mechanism, PD-22, contract C4): the only
// way a route is registered. `defineRoute` and `defineFallback` return plain definitions; the
// application hands them to `createHttpApp`, which checks the table, registers each route with its
// guards in one fixed order, and generates the OpenAPI document from the same definitions.
//
// The order of the guards is the order of plan 7.2 and it is not configurable:
//
//   rate limit -> body limit -> content type -> Origin -> CSRF -> authorisation -> validation -> handler
//
// so that a request failing two of them reports the earlier one, a foreign page learns nothing about
// permissions (the Origin check answers before the actor is asked anything), and the handler is only
// ever entered with a request that is allowed, small enough, of the right type and valid.
//
//   - Reads (GET) skip the body, content type, Origin and CSRF guards. A GET that declares an audit
//     action runs the `Sec-Fetch-Site` rule instead (FR-A-044, plan 8.3 step 5).
//   - Writes (every other method) run all of them. A denial by Origin, CSRF or authorisation is
//     handed to `onDenied` BEFORE the response is built, so the audit entry exists before the client
//     hears about it (FR-A-034); if the hook throws, the request fails closed.
//   - Access is a declaration, not a convention: `{ public: true }` or `{ permission }`, nothing else.
//     A definition without one does not compile, and one that slips through (a cast, plain
//     JavaScript) stops the application from booting (`assertRouteTable`).
//
// A fallback is a route for "everything else": the static files, the page shell and the 404. It has
// the same declaration, appears in the table, and is never documented (`openapi: false`). Its
// handler may return `undefined` to decline, and the next fallback gets the request.
//
// This file is the only place that creates the Hono application and registers routes on it (the lint
// rule `no-direct-route-registration` excludes it, and nothing else).
import { OpenAPIHono, createRoute, type RouteConfig } from '@hono/zod-openapi';
import { ProblemSchema } from '@m365portal/shared/problem';
import type { Permission } from '@m365portal/shared/permissions';
import type { Context, MiddlewareHandler } from 'hono';
import { ZodType, type z } from 'zod';
import type { AppConfig } from '../config/env.js';
import { authorize, createActorResolver } from '../policy/index.js';
import { bodyLimit, type BodyClass } from './body-limit.js';
import { cacheHeaders } from './cache-headers.js';
import { compress } from './compress.js';
import { requireContentType } from './content-type.js';
import { isWriteMethod, type Csrf } from './csrf.js';
import { createErrorHandler, errorBoundary, type ErrorHandlerOptions } from './error-handler.js';
import {
  assertOpenApiParity,
  buildOpenApiDocument,
  type DocumentSource,
  type OpenApiDocument,
} from './openapi.js';
import { auditedReadGuard, originAndCsrfGuard } from './origin.js';
import { problemResponse, validationProblemResponse } from './problem.js';
import {
  classifyRequest,
  rateLimit,
  type RateClass,
  type RateLimiter,
  type RequestShape,
} from './rate-limit.js';
import { requestContext, type AppEnv } from './request-context.js';
import {
  HTTP_METHODS,
  RouteTable,
  assertRouteTable,
  assertRouterMatchesTable,
  registeredRoutesOf,
  type FallbackRateSetting,
  type HttpMethod,
  type RateSetting,
  type RouteAccess,
  type RouteTableEntry,
} from './route-table.js';
import { rejectOptions, securityHeaders } from './security-headers.js';
import { createRequestLogger } from '../logging/request-logger.js';
import type { Logger } from '../logging/logger.js';

export type { RouteAccess, HttpMethod, RateSetting } from './route-table.js';
export { RouteTableError } from './route-table.js';

/** What a handler receives: the Hono context, with the typed variables of the pipeline. */
export type RouteContext = Context<AppEnv>;

// ---------------------------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------------------------

type RequestConfig = NonNullable<RouteConfig['request']>;
type ResponsesConfig = RouteConfig['responses'];

type OutputOf<Schema> = Schema extends ZodType ? z.output<Schema> : undefined;

type BodyOutput<Request> = Request extends { readonly body: { readonly content: infer Content } }
  ? {
      [Media in keyof Content]: Content[Media] extends { readonly schema: infer Schema }
        ? OutputOf<Schema>
        : undefined;
    }[keyof Content]
  : undefined;

/**
 * What a handler gets of a validated request, typed from the schemas the route declares. A part
 * the route does not declare is `undefined`. The body is the output of the schema of its JSON (or
 * form) media type; a media type declared with a plain OpenAPI schema (a multipart upload that the
 * handler reads itself) is not validated and gives `undefined`.
 */
export interface RouteInput<Request extends RequestConfig> {
  readonly params: Request extends { readonly params: infer Schema } ? OutputOf<Schema> : undefined;
  readonly query: Request extends { readonly query: infer Schema } ? OutputOf<Schema> : undefined;
  readonly headers: Request extends { readonly headers: infer Schema }
    ? OutputOf<Schema>
    : undefined;
  readonly body: BodyOutput<Request>;
}

export interface RouteSpec<Request extends RequestConfig> {
  /** Dotted words, unique: `health.live`. For a write route it is also the audit action of a denial. */
  readonly id: string;
  readonly method: HttpMethod;
  /** Under `/api/v1` for an API route; `{name}` marks a parameter. */
  readonly path: string;
  /** Exactly one of `{ public: true }` and `{ permission }`. */
  readonly access: RouteAccess;
  readonly rateLimit: RateSetting;
  /** The audit action a success writes. On a GET it also switches on the `Sec-Fetch-Site` rule. */
  readonly audit?: string;
  readonly summary?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  /** Default: the JSON class, or the upload class for a multipart body. */
  readonly bodyLimit?: BodyClass | number;
  readonly request?: Request;
  /** The success responses. The problem responses the guards can produce are added. */
  readonly responses: ResponsesConfig;
  readonly handler: (c: RouteContext, input: RouteInput<Request>) => Response | Promise<Response>;
}

type StoredHandler = (c: RouteContext, input: never) => Response | Promise<Response>;

export interface RouteDefinition {
  readonly kind: 'route';
  readonly id: string;
  readonly method: HttpMethod;
  readonly path: string;
  readonly access: RouteAccess;
  readonly rateLimit: RateSetting;
  readonly audit?: string;
  readonly summary?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly bodyLimit?: BodyClass | number;
  readonly request?: RequestConfig;
  readonly responses: ResponsesConfig;
  readonly handler: StoredHandler;
}

export interface FallbackSpec {
  readonly id: string;
  readonly methods: readonly HttpMethod[];
  /** Patterns of the table: `{name}` for a parameter, `*` as the final segment. */
  readonly paths: readonly string[];
  readonly access: RouteAccess;
  readonly rateLimit: FallbackRateSetting;
  /** A fallback is never part of the OpenAPI document. */
  readonly openapi: false;
  /** Answer, or return `undefined` to hand the request to the next fallback. */
  readonly handler: (c: RouteContext) => Response | undefined | Promise<Response | undefined>;
}

export interface FallbackDefinition extends FallbackSpec {
  readonly kind: 'fallback';
}

/** The definitions that came through `defineRoute` and `defineFallback`, and no others. */
const defined = new WeakSet<object>();

function seal<T extends object>(definition: T): T {
  const frozen = Object.freeze(definition);
  defined.add(frozen);
  return frozen;
}

/** The request of a route that declares none: every part is absent. */
export interface NoRequest {
  readonly params?: undefined;
  readonly query?: undefined;
  readonly headers?: undefined;
  readonly body?: undefined;
}

/**
 * Declare a route. Returns the definition; nothing is registered until the application is built, and
 * the table check runs then. `access` and `rateLimit` are required by the type.
 */
export function defineRoute<const Request extends RequestConfig = NoRequest>(
  spec: RouteSpec<Request>,
): RouteDefinition {
  return seal({ kind: 'route', ...spec } as unknown as RouteDefinition);
}

/** Declare a fallback: the same declaration as a route, never documented. */
export function defineFallback(spec: FallbackSpec): FallbackDefinition {
  return seal({ kind: 'fallback', ...spec });
}

// ---------------------------------------------------------------------------------------------
// Denials
// ---------------------------------------------------------------------------------------------

/** Which route a denial belongs to: what the audit entry of FR-A-034 names. */
export interface RouteSummary {
  readonly id: string;
  readonly method: HttpMethod;
  /** The path as declared, `{name}` and all: the route template, never the requested path. */
  readonly path: string;
  /** The permission the route requires, when it requires one. */
  readonly permission?: Permission;
}

export interface RouteDenial {
  readonly code: 'origin_not_allowed' | 'csrf_invalid' | 'permission_denied';
  /** Why, for the log and the audit entry; never sent to the client. */
  readonly reason: string;
  readonly route: RouteSummary;
}

/**
 * Called for a denial on a write route, before the response exists. Awaited. If it throws, the
 * request fails (closed) with the error handler's answer and the handler is never reached.
 */
export type OnRouteDenied = (c: RouteContext, denial: RouteDenial) => void | Promise<void>;

// ---------------------------------------------------------------------------------------------
// The guards of one route
// ---------------------------------------------------------------------------------------------

interface GuardContext {
  readonly limiter: RateLimiter;
  readonly csrf: Csrf;
  readonly expectedOrigin: string;
  readonly onDenied: OnRouteDenied | undefined;
}

function rateGuard(setting: FallbackRateSetting, limiter: RateLimiter): MiddlewareHandler<AppEnv> {
  const classOf = (request: RequestShape): RateClass | 'exempt' =>
    setting === 'by-method' ? classifyRequest(request) : setting;
  return rateLimit({ limiter, classOf });
}

/** Authorisation (stage 11): `authorize` for a route that names a permission, nothing for a public one. */
function authorisationGuard(
  access: RouteAccess,
  summary: RouteSummary,
  onDenied: OnRouteDenied | undefined,
): MiddlewareHandler<AppEnv> | undefined {
  if (access.permission === undefined) return undefined;
  const required = access.permission;
  return async (c, next) => {
    const decision = authorize(c.get('actor'), required);
    if (decision.allow) {
      await next();
      return undefined;
    }
    // A denied read is not audited (FR-A-034); a denied write is, before the answer exists.
    if (isWriteMethod(c.req.method)) {
      await onDenied?.(c, { code: 'permission_denied', reason: decision.reason, route: summary });
    }
    return problemResponse(c, 'permission_denied');
  };
}

function summaryOf(definition: RouteDefinition): RouteSummary {
  return {
    id: definition.id,
    method: definition.method,
    path: definition.path,
    ...(definition.access.permission === undefined
      ? {}
      : { permission: definition.access.permission }),
  };
}

function mediaTypesOf(request: RequestConfig | undefined): string[] {
  const content: unknown = request?.body?.content;
  return typeof content === 'object' && content !== null ? Object.keys(content) : [];
}

/** The guards of a route in their fixed order. */
function guardsOf(definition: RouteDefinition, context: GuardContext): MiddlewareHandler<AppEnv>[] {
  const guards: MiddlewareHandler<AppEnv>[] = [rateGuard(definition.rateLimit, context.limiter)];
  const summary = summaryOf(definition);
  const write = isWriteMethod(definition.method);

  if (write) {
    const multipart = mediaTypesOf(definition.request).some((type) =>
      type.toLowerCase().startsWith('multipart/form-data'),
    );
    guards.push(
      bodyLimit(definition.bodyLimit ?? (multipart ? 'upload' : 'json')),
      requireContentType(multipart ? 'multipart' : 'json'),
      originAndCsrfGuard({
        expectedOrigin: context.expectedOrigin,
        csrf: context.csrf,
        ...(context.onDenied === undefined
          ? {}
          : {
              onDenied: async (c, denial) => {
                await context.onDenied?.(c, {
                  code: denial.code,
                  reason: denial.reason,
                  route: summary,
                });
              },
            }),
      }),
    );
  } else if (definition.audit !== undefined) {
    // A GET that writes an audit entry: a cross-site `<img>` must not be able to make the server
    // write rows or assemble an export (FR-A-044).
    guards.push(auditedReadGuard({ expectedOrigin: context.expectedOrigin }));
  }

  const authorisation = authorisationGuard(definition.access, summary, context.onDenied);
  if (authorisation !== undefined) guards.push(authorisation);
  return guards;
}

// ---------------------------------------------------------------------------------------------
// The OpenAPI side of a route
// ---------------------------------------------------------------------------------------------

const PROBLEM_CONTENT = { 'application/problem+json': { schema: ProblemSchema } } as const;

function problemEntry(description: string): {
  description: string;
  content: typeof PROBLEM_CONTENT;
} {
  return { description, content: PROBLEM_CONTENT };
}

/** The problem responses the guards of this route can produce, so the document says so. */
function standardResponses(definition: RouteDefinition): ResponsesConfig {
  const responses: Record<number, ReturnType<typeof problemEntry>> = {};
  const write = isWriteMethod(definition.method);
  const request = definition.request;
  if (definition.rateLimit !== 'exempt') {
    responses[429] = problemEntry('Too many requests; Retry-After says when to try again.');
  }
  if (write) {
    responses[403] = problemEntry(
      'Refused: the Origin, the CSRF token or the permission of the actor.',
    );
    responses[413] = problemEntry('The request body is larger than the limit of this route.');
    responses[415] = problemEntry('The content type is not the one this route takes.');
  } else if (definition.access.permission !== undefined || definition.audit !== undefined) {
    responses[403] = problemEntry(
      'Refused: the permission of the actor or the Sec-Fetch-Site rule.',
    );
  }
  if (
    request !== undefined &&
    (request.params !== undefined ||
      request.query !== undefined ||
      request.headers !== undefined ||
      request.body !== undefined)
  ) {
    responses[422] = problemEntry('The request did not pass validation.');
  }
  responses[500] = problemEntry('An unhandled error; the body is generic.');
  return responses;
}

function routeConfigOf(
  definition: RouteDefinition,
  guards: MiddlewareHandler<AppEnv>[],
): RouteConfig {
  const config = {
    method: definition.method.toLowerCase(),
    path: definition.path,
    operationId: definition.id,
    summary: definition.summary ?? definition.id,
    ...(definition.description === undefined ? {} : { description: definition.description }),
    tags: definition.tags ?? [definition.id.split('.')[0] ?? definition.id],
    ...(definition.request === undefined ? {} : { request: definition.request }),
    responses: { ...standardResponses(definition), ...definition.responses },
    middleware: guards,
    'x-route-id': definition.id,
    ...(definition.access.permission === undefined
      ? { 'x-public': true }
      : { 'x-permission': definition.access.permission }),
    'x-rate-limit': definition.rateLimit,
    ...(definition.audit === undefined ? {} : { 'x-audit': definition.audit }),
  };
  return createRoute(config as never);
}

/** Which validator target holds the body of a route: `json` or `form`, from its validated media type. */
function bodyTargetOf(request: RequestConfig | undefined): 'json' | 'form' | undefined {
  const content = request?.body?.content as Record<string, { schema?: unknown }> | undefined;
  for (const [media, entry] of Object.entries(content ?? {})) {
    if (!(entry.schema instanceof ZodType)) continue;
    const lower = media.toLowerCase();
    if (/^application\/([a-z-.]+\+)?json/.test(lower)) return 'json';
    if (
      lower.startsWith('multipart/form-data') ||
      lower.startsWith('application/x-www-form-urlencoded')
    ) {
      return 'form';
    }
  }
  return undefined;
}

type ValidData = (target: 'param' | 'query' | 'header' | 'json' | 'form') => unknown;

function inputOf(c: RouteContext, request: RequestConfig | undefined): unknown {
  const valid = (c.req as unknown as { valid: ValidData }).valid.bind(c.req);
  const bodyTarget = bodyTargetOf(request);
  return {
    params: request?.params === undefined ? undefined : valid('param'),
    query: request?.query === undefined ? undefined : valid('query'),
    headers: request?.headers === undefined ? undefined : valid('header'),
    body: bodyTarget === undefined ? undefined : valid(bodyTarget),
  };
}

// ---------------------------------------------------------------------------------------------
// The application
// ---------------------------------------------------------------------------------------------

/** What the pipeline reads of the configuration. `AppConfig` fits. */
export type HttpAppConfig = Pick<
  AppConfig,
  | 'trustProxy'
  | 'publicIsHttps'
  | 'publicOrigin'
  | 'publicHost'
  | 'hsts'
  | 'previewMode'
  | 'previewModeAllowRemote'
>;

export interface HttpAppDeps {
  readonly config: HttpAppConfig;
  readonly routes: readonly RouteDefinition[];
  /** Tried in order for a request no route claimed; the 404 and 405 answer is added last. */
  readonly fallbacks?: readonly FallbackDefinition[];
  readonly csrf: Csrf;
  readonly limiter: RateLimiter;
  readonly log: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>;
  /** The clock for request times, in milliseconds. Default: a monotonic clock. */
  readonly now?: () => number;
  readonly onDenied?: OnRouteDenied;
  readonly onStorageFailure?: ErrorHandlerOptions['onStorageFailure'];
  readonly openApi: {
    readonly version: string;
    readonly title?: string;
    /** Filled with the document once the routes are registered (for `GET /api/v1/openapi.json`). */
    readonly source?: DocumentSource;
  };
}

export interface HttpApp {
  readonly app: OpenAPIHono<AppEnv>;
  readonly table: RouteTable;
  readonly document: OpenApiDocument;
}

const ALL_METHODS: readonly HttpMethod[] = HTTP_METHODS;

function entryOf(definition: RouteDefinition | FallbackDefinition): unknown {
  if (!defined.has(definition)) {
    // Not from defineRoute or defineFallback: the table check names it.
    return { kind: 'unregistered', id: (definition as { id?: unknown }).id };
  }
  if (definition.kind === 'route') {
    const entry: RouteTableEntry = {
      kind: 'route',
      id: definition.id,
      methods: [definition.method],
      paths: [definition.path],
      access: definition.access,
      rateLimit: definition.rateLimit,
      openapi: true,
      audit: definition.audit,
    };
    return entry;
  }
  const entry: RouteTableEntry = {
    kind: 'fallback',
    id: definition.id,
    methods: definition.methods,
    paths: definition.paths,
    access: definition.access,
    rateLimit: definition.rateLimit,
    openapi: definition.openapi,
  };
  return entry;
}

/**
 * Build the application: the global pipeline of plan 7.2, every route with its guards, the
 * fallbacks, and the 404 and 405 answer. Throws a `RouteTableError` (and builds nothing) when the
 * table is malformed, when the router and the table disagree, or when the OpenAPI document and the
 * routes disagree.
 */
export function createHttpApp(deps: HttpAppDeps): HttpApp {
  const fallbacks = deps.fallbacks ?? [];
  const unmatched = createUnmatchedFallback((path) => table.allowFor(path));
  const entries = [...deps.routes, ...fallbacks, unmatched].map(entryOf);
  assertRouteTable(entries);
  const table = new RouteTable(entries as RouteTableEntry[]);

  const { config } = deps;
  const app = new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) =>
      result.success
        ? undefined
        : validationProblemResponse(c, {
            target: result.target,
            error: result.error,
          }),
  });

  // The global pipeline (plan 7.2, stages 1 to 5, OPTIONS, and the error boundary).
  const handleError = createErrorHandler({
    log: deps.log,
    ...(deps.onStorageFailure === undefined ? {} : { onStorageFailure: deps.onStorageFailure }),
  });
  const resolveActor = createActorResolver(config);
  app.use(requestContext({ config, ...(deps.now === undefined ? {} : { now: deps.now }) }));
  app.use(securityHeaders({ config }));
  app.use(async (c, next) => {
    c.set('actor', resolveActor(c.req.raw));
    await next();
  });
  app.use(
    createRequestLogger({ log: deps.log, ...(deps.now === undefined ? {} : { now: deps.now }) }),
  );
  app.use(compress());
  app.use(cacheHeaders());
  // An OPTIONS request is rated like any other (stage 6) before it is refused (stage 7).
  const rateOptions = rateLimit({ limiter: deps.limiter });
  app.use(async (c, next) => {
    if (c.req.method === 'OPTIONS') return await rateOptions(c, next);
    await next();
    return undefined;
  });
  app.use(rejectOptions((request) => table.allowFor(new URL(request.url).pathname)));
  app.use(errorBoundary(handleError));

  const guardContext: GuardContext = {
    limiter: deps.limiter,
    csrf: deps.csrf,
    expectedOrigin: config.publicOrigin,
    onDenied: deps.onDenied,
  };

  for (const definition of deps.routes) {
    const handler = definition.handler as (
      c: RouteContext,
      input: unknown,
    ) => Response | Promise<Response>;
    app.openapi(routeConfigOf(definition, guardsOf(definition, guardContext)), ((c: RouteContext) =>
      handler(c, inputOf(c, definition.request))) as never);
  }

  for (const definition of [...fallbacks, unmatched]) {
    const guards: MiddlewareHandler<AppEnv>[] = [rateGuard(definition.rateLimit, deps.limiter)];
    const authorisation = authorisationGuard(
      definition.access,
      { id: definition.id, method: 'GET', path: definition.paths[0] ?? '' },
      deps.onDenied,
    );
    if (authorisation !== undefined) guards.push(authorisation);
    app.on([...definition.methods], [...definition.paths], ...guards, async (c, next) => {
      const answer = await definition.handler(c);
      if (answer === undefined) {
        await next();
        return undefined;
      }
      return answer;
    });
  }

  // Safety nets: a method no fallback lists, and an error Hono rethrows.
  app.notFound((c) => answerUnmatched(c, (path) => table.allowFor(path)));
  app.onError(handleError);

  const registered = registeredRoutesOf(app);
  assertRouterMatchesTable(table, registered);
  const document = buildOpenApiDocument(app, {
    title: deps.openApi.title ?? 'M365Portal API',
    version: deps.openApi.version,
  });
  assertOpenApiParity({ document, table, registered });
  deps.openApi.source?.set(document);

  return { app, table, document };
}

// ---------------------------------------------------------------------------------------------
// 404 and 405
// ---------------------------------------------------------------------------------------------

/** A known path with another method is 405 with `Allow`; anything else is a 404 problem, never HTML. */
function answerUnmatched(c: RouteContext, allowFor: (path: string) => readonly string[]): Response {
  const allow = allowFor(c.req.path);
  return allow.length > 0
    ? problemResponse(c, 'method_not_allowed', { allow })
    : problemResponse(c, 'not_found');
}

/** The last fallback (S3 `fallback.notFound`): everything no route and no other fallback claimed. */
function createUnmatchedFallback(
  allowFor: (path: string) => readonly string[],
): FallbackDefinition {
  return defineFallback({
    id: 'fallback.notFound',
    methods: ALL_METHODS,
    paths: ['/*'],
    access: { public: true },
    rateLimit: 'by-method',
    openapi: false,
    handler: (c) => answerUnmatched(c, allowFor),
  });
}

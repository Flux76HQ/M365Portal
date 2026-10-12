// The route wrapper (FR-A-020, FR-A-021, FR-A-031, FR-A-033 mechanism, PD-22, contract C4): the only
// way a route is registered. `defineRoute` and `defineFallback` return plain definitions; the
// application hands them to `createHttpApp`, which checks the table, registers each route with its
// guards in one fixed order, and generates the OpenAPI document from the same definitions.
//
// The order of the guards is the order of plan 7.2 and it is not configurable:
//
//   availability gate -> rate limit -> body limit -> content type -> Origin -> CSRF ->
//   authorisation -> validation -> handler
//
// so that a request failing two of them reports the earlier one, a foreign page learns nothing about
// permissions (the Origin check answers before the actor is asked anything), and the handler is only
// ever entered with a request that is allowed, small enough, of the right type and valid. The actor
// is resolved when something first reads it (SB-32): authorisation is the first thing that does, so a
// request the gate, the limiter, Origin or CSRF refuses costs no database read (the denial audit of
// a refused write is the exception: it records who the caller was).
//
//   - Reads (GET) skip the body, content type, Origin and CSRF guards. A GET that declares an audit
//     action runs the `Sec-Fetch-Site` rule instead (FR-A-044, plan 8.3 step 5).
//   - Writes (every other method) run all of them. A denial by Origin, CSRF or authorisation is
//     handed to `onDenied` BEFORE the response is built, so the audit entry exists before the client
//     hears about it (FR-A-034); if the hook throws, the request fails closed.
//   - Access is a declaration, not a convention: one word of `public`, `authenticated`, `permission`,
//     `setup` and `connection` with its modifiers (`access-guard.ts`). A definition without one does
//     not compile, and one that slips through (a cast, plain JavaScript) stops the application from
//     booting (`assertRouteTable`).
//   - A route may name an availability gate (`setupOpen`, `breakGlass`). While the gate is closed the
//     route does not exist: the request spends the token the unknown-path fallback would spend and is
//     answered by the same function (FR-B-207, SB-29).
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
import {
  ANONYMOUS_ACTOR,
  PolicyUsageError,
  ResourceDenied,
  createPolicyContext,
  type ActorResolver,
  type PolicyContext,
  type SessionSlider,
} from '../policy/index.js';
import { csrfBindingOfHeaders } from '../policy/session-hash.js';
import { createLazyActor } from './lazy-actor.js';
import type { AvailabilityGate, ModuleAvailability } from '../module.js';
import { accessGuard } from './access-guard.js';
import { bodyLimit, type BodyClass } from './body-limit.js';
import { cacheHeaders } from './cache-headers.js';
import { compress } from './compress.js';
import { requireContentType } from './content-type.js';
import { isWriteMethod, type Csrf } from './csrf.js';
import { createErrorHandler, errorBoundary, type ErrorHandlerOptions } from './error-handler.js';
import {
  accessExtensions,
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
  RouteTableError,
  accessWordOf,
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
export { decideAccess, type AccessVerdict } from './access-guard.js';

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
  /** Exactly one access word with its modifiers (`RouteAccess`). */
  readonly access: RouteAccess;
  readonly rateLimit: RateSetting;
  /** The gate that decides whether the route exists for a request (`setupOpen`, `breakGlass`). */
  readonly availability?: AvailabilityGate;
  /** `cross-site-allowed` lifts the `Sec-Fetch-Site` rule of an audited GET; `auth.callback` only. */
  readonly secFetch?: 'cross-site-allowed';
  /** Does a request keep a user session alive? Default true; false on the two polled reads only. */
  readonly slidesSession?: boolean;
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
  /**
   * `ctx` is the policy layer for this request: `ctx.authorizeResource` and `ctx.visibleScopes`
   * (FR-B-505). A route that declared `scoped` must call one of them or its 2xx becomes a 500.
   */
  readonly handler: (
    c: RouteContext,
    input: RouteInput<Request>,
    ctx: PolicyContext,
  ) => Response | Promise<Response>;
}

type StoredHandler = (
  c: RouteContext,
  input: never,
  ctx: PolicyContext,
) => Response | Promise<Response>;

export interface RouteDefinition {
  readonly kind: 'route';
  readonly id: string;
  readonly method: HttpMethod;
  readonly path: string;
  readonly access: RouteAccess;
  readonly rateLimit: RateSetting;
  readonly availability?: AvailabilityGate;
  readonly secFetch?: 'cross-site-allowed';
  readonly slidesSession?: boolean;
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
  /**
   * The reason code of the audit entry (FR-B-602): the two guards of Origin and CSRF keep their
   * Phase A codes; an authorisation denial is one of the five reasons of the contract.
   */
  readonly code:
    | 'origin_not_allowed'
    | 'csrf_invalid'
    | 'permission_missing'
    | 'scope_mismatch'
    | 'step_up_required'
    | 'escalation_denied'
    | 'last_owner_protected';
  /** Why, for the log and the audit entry; never sent to the client. */
  readonly reason: string;
  readonly route: RouteSummary;
}

/**
 * Called for a denial on a write route, before the response exists. Awaited. If it throws, the
 * request fails (closed) with the error handler's answer and the handler is never reached.
 */
export type OnRouteDenied = (c: RouteContext, denial: RouteDenial) => void | Promise<void>;

/**
 * What went wrong in a scoped route (T-B-243): the handler answered 2xx without applying the scope of
 * the caller, or asked the policy layer about a resource of the wrong type.
 */
export interface RoutePolicyFailure {
  readonly code: 'policy_not_applied' | 'policy_usage';
  readonly route: RouteSummary;
}

/** Called before the 500 leaves; awaited. If it throws, the request fails closed instead. */
export type OnRoutePolicyError = (
  c: RouteContext,
  failure: RoutePolicyFailure,
) => void | Promise<void>;

// ---------------------------------------------------------------------------------------------
// The guards of one route
// ---------------------------------------------------------------------------------------------

interface GuardContext {
  readonly limiter: RateLimiter;
  readonly csrf: Csrf;
  readonly expectedOrigin: string;
  readonly onDenied: OnRouteDenied | undefined;
  readonly slideSession: SessionSlider | undefined;
  /** The gate of the route, when it names one: open or closed for this request, and how to answer. */
  readonly gate: ((gate: AvailabilityGate) => MiddlewareHandler<AppEnv>) | undefined;
}

/**
 * After every guard has passed: a request of a route that slides extends the idle deadline of the
 * session behind its actor (FR-B-407). A refused request never gets here, and the two polled reads
 * (`slidesSession: false`, FR-B-420) leave the guard out.
 */
function slideGuard(slide: SessionSlider): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    slide(c.get('actor'));
    await next();
  };
}

/**
 * The requests of routes that want the setup session when the browser holds both cookies (an Owner
 * who reopened setup): the setup and connection routes. Every other route prefers the user session.
 */
const preferSetup = new WeakSet<Request>();

/** Requests that have already spent a token: one request is rated once, whatever guards it meets. */
const rated = new WeakSet<Request>();

function rateGuard(setting: FallbackRateSetting, limiter: RateLimiter): MiddlewareHandler<AppEnv> {
  const classOf = (request: RequestShape): RateClass | 'exempt' =>
    setting === 'by-method' ? classifyRequest(request) : setting;
  const limit = rateLimit({ limiter, classOf });
  // A request that no route claims meets the rate guard of every fallback in turn (the page shell,
  // then the 404). It must still cost one token, the same as the closed availability gate, which
  // answers in place of the whole chain (FR-B-207, SB-29).
  return async (c, next) => {
    if (rated.has(c.req.raw)) {
      await next();
      return undefined;
    }
    return await limit(c, async () => {
      if (classOf({ method: c.req.method, path: c.req.path }) !== 'exempt') rated.add(c.req.raw);
      await next();
    });
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
  const guards: MiddlewareHandler<AppEnv>[] = [];
  const word = accessWordOf(definition.access);
  if (word === 'setup' || word === 'connection') {
    guards.push(async (c, next) => {
      preferSetup.add(c.req.raw);
      await next();
    });
  }
  if (definition.availability !== undefined && context.gate !== undefined) {
    guards.push(context.gate(definition.availability));
  }
  guards.push(rateGuard(definition.rateLimit, context.limiter));
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
        // The cookies as sent, no database read (FR-B-408): a cross-site request learns nothing.
        binding: (c) => csrfBindingOfHeaders(c.req.raw.headers, context.expectedOrigin),
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
  } else if (definition.audit !== undefined && definition.secFetch !== 'cross-site-allowed') {
    // A GET that writes an audit entry: a cross-site `<img>` must not be able to make the server
    // write rows or assemble an export (FR-A-044). `auth.callback` is the one exception: Entra's
    // redirect is a cross-site top-level navigation by design (SB-25).
    guards.push(auditedReadGuard({ expectedOrigin: context.expectedOrigin }));
  }

  const authorisation = accessGuard({
    access: definition.access,
    route: summary,
    onDenied: context.onDenied,
    publicOrigin: context.expectedOrigin,
  });
  if (authorisation !== undefined) guards.push(authorisation);
  // The probes and the build output carry no session; the polled reads must not extend one.
  if (
    context.slideSession !== undefined &&
    definition.rateLimit !== 'exempt' &&
    definition.slidesSession !== false
  ) {
    guards.push(slideGuard(context.slideSession));
  }
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
  const needsSession = accessWordOf(definition.access) !== 'public';
  if (needsSession) {
    responses[401] = problemEntry('No valid session, or the session has expired.');
  }
  if (write) {
    responses[403] = problemEntry(
      'Refused: the Origin, the CSRF token, the permission or the step-up of the actor.',
    );
    responses[413] = problemEntry('The request body is larger than the limit of this route.');
    responses[415] = problemEntry('The content type is not the one this route takes.');
  } else if (needsSession || definition.audit !== undefined) {
    responses[403] = problemEntry(
      'Refused: the permission or the step-up of the actor, or the Sec-Fetch-Site rule.',
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
    ...accessExtensions(definition),
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
  'trustProxy' | 'publicIsHttps' | 'publicOrigin' | 'publicHost' | 'hsts'
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
  /** Audits a scoped route that did not apply the policy as `error` (T-B-243). */
  readonly onPolicyError?: OnRoutePolicyError;
  /**
   * Turns a request into an actor, on the first read of the actor of a request (SB-32): a request
   * that is refused before anything asks who the caller is costs no database read. The application
   * passes the one resolver of `ModuleDeps`; without one every request is anonymous (deny by default).
   */
  readonly resolveActor?: ActorResolver;
  /** Extends the idle deadline of a session for a request that passed every guard (FR-B-407). */
  readonly slideSession?: SessionSlider;
  /** The predicates of the availability gates, merged from the modules (`mergeAvailability`). */
  readonly availability?: ModuleAvailability;
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
      availability: definition.availability,
      secFetch: definition.secFetch,
      slidesSession: definition.slidesSession,
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
  const unmatched = createUnmatchedFallback((request) => allowFor(request));
  const entries = [...deps.routes, ...fallbacks, unmatched].map(entryOf);
  assertRouteTable(entries);
  const table = new RouteTable(entries as RouteTableEntry[]);
  assertGatesHavePredicates(table, deps.availability);

  /** Is the gate of this route open for this request? A route without a gate is always open. */
  const isOpen = (entry: RouteTableEntry, request: Request): boolean => {
    if (entry.availability === undefined) return true;
    return deps.availability?.[entry.availability]?.(request) === true;
  };
  /** The methods a path answers for this request: a route behind a closed gate is not among them. */
  function allowFor(request: Request): readonly string[] {
    return table.allowFor(new URL(request.url).pathname, (entry) => isOpen(entry, request));
  }

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
  const resolveActor: ActorResolver = deps.resolveActor ?? (() => ANONYMOUS_ACTOR);
  app.use(requestContext({ config, ...(deps.now === undefined ? {} : { now: deps.now }) }));
  app.use(securityHeaders({ config }));
  // The actor is resolved when something first reads it: the gate, the limiter and the checks that
  // need no credential cost no database read (SB-32).
  app.use(async (c, next) => {
    c.set(
      'actor',
      createLazyActor(() =>
        resolveActor(c.req.raw, { prefer: preferSetup.has(c.req.raw) ? 'setup' : 'session' }),
      ),
    );
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
  app.use(rejectOptions((request) => allowFor(request)));
  app.use(errorBoundary(handleError));

  const guardContext: GuardContext = {
    limiter: deps.limiter,
    csrf: deps.csrf,
    expectedOrigin: config.publicOrigin,
    onDenied: deps.onDenied,
    slideSession: deps.slideSession,
    gate: (gate) =>
      availabilityGuard(gate, {
        isOpen: deps.availability?.[gate],
        limiter: deps.limiter,
        allowFor,
      }),
  };

  for (const definition of deps.routes) {
    const handler = definition.handler as (
      c: RouteContext,
      input: unknown,
      ctx: PolicyContext,
    ) => Response | Promise<Response>;
    const route = summaryOf(definition);
    app.openapi(routeConfigOf(definition, guardsOf(definition, guardContext)), (async (
      c: RouteContext,
    ) => {
      const ctx = createPolicyContext(c.get('actor'));
      let response: Response;
      try {
        response = await handler(c, inputOf(c, definition.request), ctx);
      } catch (error) {
        if (error instanceof ResourceDenied) {
          // The handler asked and the answer was no: audited like any denial, before the 403.
          await deps.onDenied?.(c, { code: error.reason, reason: 'resource', route });
          return problemResponse(c, 'permission_denied');
        }
        if (error instanceof PolicyUsageError) {
          // A bug of the handler (a resource of the wrong type): a 500, audited, never an allow.
          await deps.onPolicyError?.(c, { code: 'policy_usage', route });
          return problemResponse(c, 'internal_error');
        }
        throw error;
      }
      // The net of FR-B-505: a scoped route that answered 2xx without asking the policy layer.
      if (
        definition.access.scoped !== undefined &&
        response.status >= 200 &&
        response.status < 300 &&
        !ctx.applied
      ) {
        await deps.onPolicyError?.(c, { code: 'policy_not_applied', route });
        return problemResponse(c, 'policy_not_applied');
      }
      return response;
    }) as never);
  }

  for (const definition of [...fallbacks, unmatched]) {
    const guards: MiddlewareHandler<AppEnv>[] = [rateGuard(definition.rateLimit, deps.limiter)];
    const authorisation = accessGuard({
      access: definition.access,
      route: { id: definition.id, method: 'GET', path: definition.paths[0] ?? '' },
      onDenied: deps.onDenied,
      publicOrigin: config.publicOrigin,
    });
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
  app.notFound((c) => answerUnmatched(c, allowFor(c.req.raw)));
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
function answerUnmatched(c: RouteContext, allow: readonly string[]): Response {
  return allow.length > 0
    ? problemResponse(c, 'method_not_allowed', { allow })
    : problemResponse(c, 'not_found');
}

/** The last fallback (S3 `fallback.notFound`): everything no route and no other fallback claimed. */
function createUnmatchedFallback(
  allowFor: (request: Request) => readonly string[],
): FallbackDefinition {
  return defineFallback({
    id: 'fallback.notFound',
    methods: ALL_METHODS,
    paths: ['/*'],
    access: { public: true },
    rateLimit: 'by-method',
    openapi: false,
    handler: (c) => answerUnmatched(c, allowFor(c.req.raw)),
  });
}

// ---------------------------------------------------------------------------------------------
// The availability gate (stage 1b of plan 6.3)
// ---------------------------------------------------------------------------------------------

interface GateOptions {
  /** The predicate of the gate; `undefined` is refused at boot, and closed here. */
  readonly isOpen: ((request: Request) => boolean) | undefined;
  readonly limiter: RateLimiter;
  readonly allowFor: (request: Request) => readonly string[];
}

/**
 * The first guard of a gated route. Open: the request goes on. Closed: the route does not exist, so
 * the request spends the token that the unknown-path fallback spends for the same method (`read`
 * for GET and HEAD, `write` for every other method; SB-29) and is answered by the same function as
 * an unknown path. Nothing else runs: no Origin, no CSRF and no actor, so a closed gate shows an
 * outsider nothing and costs no database read (FR-B-207).
 */
function availabilityGuard(
  _gate: AvailabilityGate,
  options: GateOptions,
): MiddlewareHandler<AppEnv> {
  const spend = rateGuard('by-method', options.limiter);
  return async (c, next) => {
    if (options.isOpen?.(c.req.raw) === true) {
      await next();
      return undefined;
    }
    const limited = await spend(c, async () => {
      // Allowed: nothing to run, the answer is the unknown-path one.
    });
    return limited instanceof Response ? limited : answerUnmatched(c, options.allowFor(c.req.raw));
  };
}

/** Every gate a route names has a predicate; a table that names one nobody offers does not boot. */
function assertGatesHavePredicates(
  table: RouteTable,
  availability: ModuleAvailability | undefined,
): void {
  const problems = table.routes.flatMap((entry) =>
    entry.availability !== undefined && availability?.[entry.availability] === undefined
      ? [
          `${entry.id}: the availability gate ${entry.availability} has no predicate; a module must offer it`,
        ]
      : [],
  );
  if (problems.length > 0) throw new RouteTableError(problems);
}

/**
 * The predicates of the modules as one map. A gate offered by two modules is a mistake, not a
 * choice: the table could not say which one counts (plan 6.3).
 */
export function mergeAvailability(
  modules: readonly { readonly id: string; readonly availability?: ModuleAvailability }[],
): ModuleAvailability {
  const merged: Partial<Record<AvailabilityGate, (request: Request) => boolean>> = {};
  for (const module of modules) {
    for (const [gate, predicate] of Object.entries(module.availability ?? {}) as [
      AvailabilityGate,
      (request: Request) => boolean,
    ][]) {
      if (merged[gate] !== undefined) {
        throw new Error(
          `the availability gate ${gate} is offered by more than one module (${module.id})`,
        );
      }
      merged[gate] = predicate;
    }
  }
  return merged;
}

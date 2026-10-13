// `GraphHttp`: the one HTTP layer under every Microsoft Graph client (T-B-071, FR-B-312, FR-B-313,
// FR-B-317; plan 8.3). `HttpGraphClient` (app-only, runtime) and `TenantProvisioner` (delegated,
// wizard) are both built on it; they differ only in the token they pass and the budget they ask for.
//
// What it owns:
//   - the origin `https://graph.microsoft.com` and the prefix `/v1.0/`, fixed at construction;
//   - the `Authorization` header (the token comes from the `GraphTokenSource` per attempt and goes
//     straight into `JsonFetch`; it is never stored, logged, decoded or put in an error);
//   - retry (429 with `Retry-After`; 503/504 with backoff for repeatable calls), the call budget
//     (20 s interactive, 60 s wizard with no retries), at most 4 calls in flight with a FIFO queue
//     of 64, the throttle priority and `client-request-id` headers;
//   - typed errors (errors-map.ts) and the short-TTL cache for GET results (cache.ts);
//   - `@odata.nextLink` following, only for a URL of the same origin under `/v1.0/`.
//
// A request names a path template result and a query; both are built with url-guard.ts by the
// client. Time, randomness and timers are injected. Logging is one `debug` line per attempt and a
// `warn` line for a retry or a failure, with fixed fields: no token, no query, no id, no body.
import type { Clock, RandomSource, Scheduler } from '../../ports/clock.js';
import {
  GraphBadRequestError,
  GraphNetworkError,
  GraphTransientError,
} from '../../ports/errors.js';
import { createCallEngine, type CallBudget } from '../http/call-engine.js';
import { MICROSOFT_ORIGINS, UrlRefusedError, buildQuery, resolveUnder } from '../http/url-guard.js';
import { mayRepeatAfter5xx } from '../http/retry.js';
import { GraphCache, cacheKey } from './cache.js';
import { graphErrorFor, refusedAsBadRequest } from './errors-map.js';

export const GRAPH_ORIGIN = MICROSOFT_ORIGINS.graph;
export const GRAPH_PREFIX = '/v1.0/';
/** Graph answers are JSON of at most this size (plan 8.3). */
export const GRAPH_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
/** Pages followed by `requestAll` before it gives up. */
export const GRAPH_MAX_PAGES = 20;

/** Returns an access token for Graph. `skipCache` asks for a freshly issued one (FR-B-316). */
export type GraphTokenSource = (options?: { skipCache?: boolean }) => Promise<string>;

export type GraphMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface GraphRequest {
  readonly method: GraphMethod;
  /** A fixed lower-case template name for the logs, such as `users.get`. */
  readonly route: string;
  /** The path below `/v1.0`, built with `pathSegment` / `guidSegment`: starts with `/`. */
  readonly path: string;
  /** Query names and raw values; `buildQuery` sorts and percent-encodes them. */
  readonly query?: Readonly<Record<string, string>>;
  readonly json?: unknown;
  /** A POST that may be repeated (a read that uses POST, such as `checkMemberGroups`). */
  readonly idempotent?: boolean;
  /** `x-ms-throttle-priority`: `high` for a user waiting, `low` for background work. */
  readonly priority?: 'high' | 'low';
  /** Default `interactive`. */
  readonly budget?: CallBudget;
  /** Cache a GET result for this long; ignored for anything but an interactive GET. */
  readonly cache?: { readonly ttlMs: number };
  /** Read around the cache (the fresh answer is stored). */
  readonly skipCache?: boolean;
  /** Ask the token source for a freshly issued token. */
  readonly freshToken?: boolean;
  /** `ConsistencyLevel: eventual` (U37 fallback). */
  readonly consistencyLevelEventual?: boolean;
  readonly signal?: AbortSignal;
}

export interface GraphResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface GraphLog {
  debug(fields: Readonly<Record<string, unknown>>, message: string): void;
  warn(fields: Readonly<Record<string, unknown>>, message: string): void;
}

export interface GraphHttpDeps {
  readonly token: GraphTokenSource;
  readonly clock: Clock;
  readonly random: RandomSource;
  readonly scheduler: Scheduler;
  readonly log?: GraphLog;
  /** For tests of the layer itself: the function that sends. Defaults to global `fetch`. */
  readonly fetch?: typeof fetch;
}

/** One page of a collection (Phase C, FR-C-103). */
export interface GraphPage {
  readonly items: readonly unknown[];
  /** The `@odata.nextLink` of the page, validated (same origin, under `/v1.0/`), or `null` at the end. */
  readonly nextLink: string | null;
  /** `@odata.count` when the answer carries one (`$count=true`), otherwise `null`. */
  readonly count: number | null;
}

export interface GraphHttp {
  /** One call; a non-2xx answer is a typed error. */
  request(request: GraphRequest): Promise<GraphResponse>;
  /**
   * One page of a collection: the first page of `request`, or, with `nextLink`, the page that link
   * names (checked by the same rule as `requestAll`; the headers of `request`, such as
   * `ConsistencyLevel`, are sent again). The link of the next page is validated before it is
   * returned, so a hostile link fails here and never reaches a caller. `$skip` is never sent
   * (R-C-01); the answer is never cached. At most one page is read.
   */
  requestPage(request: GraphRequest, nextLink?: string): Promise<GraphPage>;
  /**
   * A collection: the `value` arrays of the first page and of every `@odata.nextLink` that stays
   * under `/v1.0/` on the same origin, at most `GRAPH_MAX_PAGES` pages.
   */
  requestAll(request: GraphRequest): Promise<{ readonly items: readonly unknown[] }>;
  /** Forgets every cached answer. */
  clearCache(): void;
}

const ROUTE = /^[a-z][a-z0-9._-]{0,63}$/;

export function createGraphHttp(deps: GraphHttpDeps): GraphHttp {
  const { clock } = deps;
  const engine = createCallEngine({
    origin: GRAPH_ORIGIN,
    pathPrefix: GRAPH_PREFIX,
    maxResponseBytes: GRAPH_MAX_RESPONSE_BYTES,
    token: deps.token,
    clock,
    random: deps.random,
    scheduler: deps.scheduler,
    errors: {
      network: (clientRequestId) =>
        new GraphNetworkError(clientRequestId === undefined ? undefined : { clientRequestId }),
      refused: (clientRequestId) =>
        new GraphBadRequestError({
          graphCode: 'request_refused',
          ...(clientRequestId === undefined ? {} : { clientRequestId }),
        }),
      queueFull: () => new GraphTransientError({ status: 503 }),
      answer: (status, body, meta) => graphErrorFor(status, body, meta),
    },
    aborted: () => new GraphNetworkError(),
    // 429 waits Retry-After (or backs off without it); 503 and 504 back off for a call that may be
    // repeated; 500 and 502 and every 4xx surface at once (FR-B-312).
    retryPolicy: (answer, request) => {
      if (answer.status === 429) return 'retry_after';
      if (
        (answer.status === 503 || answer.status === 504) &&
        mayRepeatAfter5xx(request.method, request.idempotent)
      ) {
        return 'backoff';
      }
      return null;
    },
    sendClientRequestId: true,
    logMessage: 'graph_call',
    ...(deps.log === undefined ? {} : { log: deps.log }),
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
  });
  const cache = new GraphCache(clock);

  function urlOf(request: GraphRequest): { href: string; key: string } {
    if (!ROUTE.test(request.route)) throw new TypeError('route is a lower-case template name');
    return refusedAsBadRequest(() => {
      if (
        !request.path.startsWith('/') ||
        request.path.includes('?') ||
        request.path.includes('#')
      ) {
        throw new UrlRefusedError('bad_url');
      }
      const pathAndQuery = `${request.path}${buildQuery(request.query)}`;
      const url = resolveUnder(
        GRAPH_ORIGIN,
        GRAPH_PREFIX,
        `${GRAPH_ORIGIN}${GRAPH_PREFIX.slice(0, -1)}${pathAndQuery}`,
      );
      return { href: url.href, key: cacheKey(request.method, pathAndQuery) };
    });
  }

  function send(request: GraphRequest, href: string): Promise<GraphResponse> {
    return engine.send({
      method: request.method,
      route: request.route,
      href,
      headers: {
        ...(request.priority === undefined ? {} : { 'x-ms-throttle-priority': request.priority }),
        ...(request.consistencyLevelEventual === true ? { consistencylevel: 'eventual' } : {}),
      },
      ...(request.json === undefined ? {} : { json: request.json }),
      ...(request.idempotent === undefined ? {} : { idempotent: request.idempotent }),
      ...(request.budget === undefined ? {} : { budget: request.budget }),
      ...(request.freshToken === undefined ? {} : { freshToken: request.freshToken }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
  }

  function nextLinkOf(body: unknown): string | undefined {
    if (typeof body !== 'object' || body === null) return undefined;
    const link = (body as { '@odata.nextLink'?: unknown })['@odata.nextLink'];
    return typeof link === 'string' ? link : undefined;
  }

  /** A link Graph handed out (or a stored one): followed only on the origin, under /v1.0/ (FR-B-317). */
  function followable(link: string): string {
    try {
      return resolveUnder(GRAPH_ORIGIN, GRAPH_PREFIX, link).href;
    } catch (failure) {
      if (failure instanceof UrlRefusedError) {
        throw new GraphBadRequestError({ graphCode: 'invalid_next_link' });
      }
      throw failure;
    }
  }

  return {
    async request(request) {
      const { href, key } = urlOf(request);
      const cacheable =
        request.method === 'GET' &&
        request.cache !== undefined &&
        (request.budget ?? 'interactive') === 'interactive';
      if (cacheable && request.skipCache !== true) {
        const hit = cache.get(key);
        if (hit !== undefined) return { status: 200, body: hit.body };
      }
      const response = await send(request, href);
      if (cacheable) cache.set(key, response.body, request.cache.ttlMs);
      return response;
    },

    async requestPage(request, nextLink) {
      if (request.method !== 'GET') throw new TypeError('requestPage reads with GET');
      if (Object.keys(request.query ?? {}).some((name) => name.toLowerCase() === '$skip')) {
        // Graph does not support $skip on these collections (R-C-01): the product never sends it.
        throw new GraphBadRequestError({ graphCode: 'invalid_value' });
      }
      const href = nextLink === undefined ? urlOf(request).href : followable(nextLink);
      const response = await send(request, href);
      const value = (response.body as { value?: unknown } | null)?.value;
      if (!Array.isArray(value)) throw new GraphBadRequestError({ graphCode: 'unexpected_shape' });
      const link = nextLinkOf(response.body);
      const rawCount = (response.body as { '@odata.count'?: unknown })['@odata.count'];
      return {
        items: value as unknown[],
        nextLink: link === undefined ? null : followable(link),
        count:
          typeof rawCount === 'number' && Number.isSafeInteger(rawCount) && rawCount >= 0
            ? rawCount
            : null,
      };
    },

    async requestAll(request) {
      const items: unknown[] = [];
      let { href } = urlOf(request);
      for (let page = 1; page <= GRAPH_MAX_PAGES; page += 1) {
        const response = await send(request, href);
        const value = (response.body as { value?: unknown } | null)?.value;
        if (!Array.isArray(value))
          throw new GraphBadRequestError({ graphCode: 'unexpected_shape' });
        items.push(...(value as unknown[]));
        const link = nextLinkOf(response.body);
        if (link === undefined) return { items };
        // Followed only when it stays on the origin and under /v1.0/ (FR-B-317); the bearer token
        // is attached by the engine to a URL that has passed this check and to no other.
        try {
          href = resolveUnder(GRAPH_ORIGIN, GRAPH_PREFIX, link).href;
        } catch (failure) {
          if (failure instanceof UrlRefusedError) {
            throw new GraphBadRequestError({ graphCode: 'invalid_next_link' });
          }
          throw failure;
        }
      }
      throw new GraphBadRequestError({ graphCode: 'too_many_pages' });
    },

    clearCache() {
      cache.clear();
    },
  };
}

// Stage 3 of the request pipeline (plan 7.2): one line per request, at the end (FR-A-051, FR-A-024).
//
// The line holds the request id, the method, the route template, the status and the duration, and
// nothing else: no query string, no body, no header, no address, no e-mail address, no organisation
// name, no path. The route is the template the router matched (`/api/v1/things/:id`), never the path
// that was requested: a path can hold a name or an address (`/users/jane@example.com`). A request
// no route claimed is `unmatched`. The method is client input too, so only a plain upper-case token
// is written; anything else is `OTHER`.
//
// The client address lives in the audit table and nowhere else (FR-A-074, plan 8.9).
import type { Context, MiddlewareHandler } from 'hono';
import { matchedRoutes } from 'hono/route';
import { requestIdOf } from '../http/problem.js';
import type { AppEnv } from '../http/request-context.js';
import type { Logger } from './logger.js';

export const UNMATCHED_ROUTE = 'unmatched';

/** Probes that run every few seconds: logged at debug, so they do not fill the log. */
const PROBE_ROUTES: ReadonlySet<string> = new Set(['/healthz', '/readyz']);

const METHOD_TOKEN = /^[A-Z]{1,16}$/;

export interface RequestLoggerOptions {
  readonly log: Pick<Logger, 'debug' | 'info' | 'warn'>;
  /** Must be the clock `requestContext` started the request with. Default: a monotonic clock. */
  readonly now?: () => number;
  /**
   * The route template of the request, when the caller knows better than the router (the route
   * table of T-A-040 may). Return `undefined` to fall back to the router's answer.
   */
  readonly routeOf?: (c: Context<AppEnv>) => string | undefined;
}

/**
 * The template of the route that answered the request. Middleware registered with `app.use` is
 * method `ALL` and says nothing about the request, so only a route registered for a method counts:
 * the one that produced the response, or else the first one that matches.
 */
function routerTemplate(c: Context<AppEnv>): string {
  const routes = matchedRoutes(c);
  const answered = routes[c.req.routeIndex];
  if (answered !== undefined && answered.method !== 'ALL') return answered.path;
  const first = routes.find((route) => route.method !== 'ALL');
  return first?.path ?? UNMATCHED_ROUTE;
}

export function createRequestLogger(options: RequestLoggerOptions): MiddlewareHandler<AppEnv> {
  const { log } = options;
  const now = options.now ?? ((): number => performance.now());

  return async (c, next) => {
    // A thrown value that is not an Error is rethrown past every handler: the line says 500 and the
    // throw continues, so the outer layers still see what happened.
    let status = 500;
    try {
      await next();
      status = c.res.status;
    } finally {
      try {
        const route = options.routeOf?.(c) ?? routerTemplate(c);
        const started = c.get('startedAtMs') as number | undefined;
        const duration = started === undefined ? 0 : Math.max(0, Math.round(now() - started));
        const method = METHOD_TOKEN.test(c.req.method) ? c.req.method : 'OTHER';
        const fields = {
          requestId: requestIdOf(c),
          method,
          route,
          status,
          durationMs: duration,
        };
        if (PROBE_ROUTES.has(route)) log.debug(fields, 'request');
        else if (status >= 500) log.warn(fields, 'request');
        else log.info(fields, 'request');
      } catch {
        // A log that cannot be written must never take the response down with it.
      }
    }
  };
}

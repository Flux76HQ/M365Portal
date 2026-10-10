// Origin checks (plan 8.3, FR-A-044, A-31, A-32, E-14). For every write under /api/v1:
//
//   1. `Origin` must be present and equal the serialised origin of `PUBLIC_BASE_URL`, byte for byte.
//      `Origin: null` fails (it is what a sandboxed frame or a redirect chain sends). The `Host`
//      header is never consulted: it is chosen by whoever sends the request, and a DNS-rebinding
//      page has the right `Host` and the wrong `Origin`.
//   2. If `Sec-Fetch-Site` is present it must be `same-origin`. `none` is the value of a navigation
//      typed into the address bar; a write is never one.
//
// Browsers send `Origin` on every request that is not a GET or HEAD, in the serialised form with a
// lower-case scheme and host, so the exact comparison costs a legitimate client nothing. A client
// that sends something else (an upper-case host, a trailing slash, a path) is not a browser, or is
// not the browser's own origin.
//
// A GET route that writes an audit entry applies only the `Sec-Fetch-Site` half, with a wider
// allowance: absent, `same-origin` and `none` (a link followed or an address typed) pass;
// `same-site` and `cross-site` do not, so that a foreign `<img>` or form cannot make the server
// write audit rows or assemble an export. A refusal there is not audited (it is a read, PA-15).
//
// Refusals say `origin_not_allowed` with the origin the server expects and nothing about which test
// failed. The internal reason goes to the denial hook for the audit entry.
import type { MiddlewareHandler } from 'hono';
import { csrfGuard, isWriteMethod, type Csrf, type OnDenied } from './csrf.js';
import { problemResponse } from './problem.js';
import type { AppEnv } from './request-context.js';
import type { Context } from 'hono';

export { isWriteMethod, type Denial, type OnDenied } from './csrf.js';

/** Why the origin was refused. Internal: audit entries and tests, never the response. */
export type OriginFailure = 'origin_missing' | 'origin_null' | 'origin_mismatch' | 'sec_fetch_site';

export type OriginCheck =
  { readonly ok: true } | { readonly ok: false; readonly reason: OriginFailure };

export interface WriteOriginInput {
  /** The `Origin` header, or `null` when there is none. */
  readonly origin: string | null;
  /** The `Sec-Fetch-Site` header, or `null` when there is none. */
  readonly secFetchSite: string | null;
  /** The serialised origin of `PUBLIC_BASE_URL`. */
  readonly expectedOrigin: string;
}

const OK: OriginCheck = Object.freeze({ ok: true });

function refuse(reason: OriginFailure): OriginCheck {
  return { ok: false, reason };
}

/** Steps 1 and 2 of plan 8.3 for a write. */
export function checkWriteOrigin(input: WriteOriginInput): OriginCheck {
  const { origin, secFetchSite, expectedOrigin } = input;
  if (origin === null) return refuse('origin_missing');
  if (origin === 'null') return refuse('origin_null');
  if (origin !== expectedOrigin) return refuse('origin_mismatch');
  if (secFetchSite !== null && secFetchSite !== 'same-origin') return refuse('sec_fetch_site');
  return OK;
}

/** Step 5 of plan 8.3: the `Sec-Fetch-Site` rule of a GET that writes an audit entry. */
export function checkAuditedReadOrigin(secFetchSite: string | null): OriginCheck {
  if (secFetchSite === null || secFetchSite === 'same-origin' || secFetchSite === 'none') return OK;
  return refuse('sec_fetch_site');
}

export interface OriginGuardOptions {
  readonly expectedOrigin: string;
  readonly onDenied?: OnDenied;
}

function originOf(c: Context<AppEnv>): string | null {
  return c.req.header('origin') ?? null;
}

function fetchSiteOf(c: Context<AppEnv>): string | null {
  return c.req.header('sec-fetch-site') ?? null;
}

/** Reject a write whose Origin or Sec-Fetch-Site is not the panel's own: 403 `origin_not_allowed`. */
export function originGuard(options: OriginGuardOptions): MiddlewareHandler<AppEnv> {
  const { expectedOrigin } = options;
  return async (c, next) => {
    if (!isWriteMethod(c.req.method)) {
      await next();
      return;
    }
    const result = checkWriteOrigin({
      origin: originOf(c),
      secFetchSite: fetchSiteOf(c),
      expectedOrigin,
    });
    if (result.ok) {
      await next();
      return;
    }
    await options.onDenied?.(c, { code: 'origin_not_allowed', reason: result.reason });
    return problemResponse(c, 'origin_not_allowed', { expectedOrigin });
  };
}

export interface AuditedReadGuardOptions {
  readonly expectedOrigin: string;
}

/**
 * The guard of a GET route that declares an audit entry: only the `Sec-Fetch-Site` rule. No denial
 * hook: a refused read is not audited.
 */
export function auditedReadGuard(options: AuditedReadGuardOptions): MiddlewareHandler<AppEnv> {
  const { expectedOrigin } = options;
  return async (c, next) => {
    if (checkAuditedReadOrigin(fetchSiteOf(c)).ok) {
      await next();
      return;
    }
    return problemResponse(c, 'origin_not_allowed', { expectedOrigin });
  };
}

export interface OriginAndCsrfGuardOptions {
  readonly expectedOrigin: string;
  readonly csrf: Csrf;
  readonly binding?: (c: Context<AppEnv>) => string;
  readonly onDenied?: OnDenied;
}

/**
 * Plan 8.3 in one piece, in its fixed order: Origin, then the token. A request that fails both is
 * refused for its Origin, so a foreign page learns nothing about the token. The route wrapper of
 * T-A-040 places this between the content-type check and authorisation.
 */
export function originAndCsrfGuard(options: OriginAndCsrfGuardOptions): MiddlewareHandler<AppEnv> {
  const origin = originGuard({
    expectedOrigin: options.expectedOrigin,
    ...(options.onDenied === undefined ? {} : { onDenied: options.onDenied }),
  });
  const token = csrfGuard({
    csrf: options.csrf,
    ...(options.binding === undefined ? {} : { binding: options.binding }),
    ...(options.onDenied === undefined ? {} : { onDenied: options.onDenied }),
  });
  return async (c, next) =>
    await origin(c, async () => {
      // The inner guard answers by returning a response; the outer one only awaits `next`, so the
      // response is put in place here or it would be lost.
      const refusal = await token(c, next);
      if (refusal instanceof Response) c.res = refusal;
    });
}

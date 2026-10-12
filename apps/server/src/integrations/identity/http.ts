// The `fetch` wrapper of the identity clients (T-B-077, T-B-079): origin `login.microsoftonline.com`,
// any path (the callers build theirs from tenant ids), JSON answers only, `redirect: 'error'`, no
// `Origin` header. Tenant metadata, the key set and the token endpoint each get one from here; the
// wrapper itself is `http/json-fetch.ts`, the only file that calls the global `fetch`.
import type { Clock, Scheduler } from '../../ports/clock.js';
import { createJsonFetch, type JsonFetch } from '../http/json-fetch.js';
import { MICROSOFT_ORIGINS } from '../http/url-guard.js';

/** Discovery documents, key sets and token answers are small; a larger answer is not Entra's. */
export const IDENTITY_MAX_RESPONSE_BYTES = 256 * 1024;

export interface IdentityFetchDeps {
  readonly clock: Clock;
  readonly scheduler: Scheduler;
  /** For a test that supplies its own transport; the default is the global `fetch`. */
  readonly fetch?: typeof fetch;
}

export function createIdentityFetch(deps: IdentityFetchDeps): JsonFetch {
  return createJsonFetch({
    origin: MICROSOFT_ORIGINS.login,
    pathPrefix: '/',
    maxResponseBytes: IDENTITY_MAX_RESPONSE_BYTES,
    clock: deps.clock,
    scheduler: deps.scheduler,
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
  });
}

/** What the identity code logs: fixed event names and short fields, never a token or a URL query. */
export interface IdentityLog {
  debug?(fields: Readonly<Record<string, unknown>>, message: string): void;
  warn(fields: Readonly<Record<string, unknown>>, message: string): void;
}

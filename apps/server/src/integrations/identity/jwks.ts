// The key set of the tenant (T-B-077, FR-B-404, plan 8.6.4; V-B08 closes U40).
//
// Microsoft Learn, https://learn.microsoft.com/entra/identity-platform/signing-key-rollover: keys are
// found through the tenant's discovery document and cached per tenant by `kid`; the cache lives 24
// hours; the keys are refreshed at start, hourly, and when a `kid` is unknown but not more often
// than every 5 minutes; "there's always more than one valid key" during a rollover, so the order of
// the keys means nothing.
//
// `jose` 6.2.12 `createRemoteJWKSet` does the caching (V-B08): `cacheMaxAge` 24 h,
// `cooldownDuration` 5 min (the time after a successful fetch during which an unknown `kid` does
// NOT refetch), `timeoutDuration` 5 s, and the `customFetch` symbol, which is how the request goes
// through `JsonFetch` (no redirects, the injected timer, the one place that calls `fetch`). `jose`
// passes `redirect: 'manual'`; here any 3xx is a failure. Hourly `reload()` is scheduled on the
// injected `Scheduler`; the first reload at start is not awaited. A failed reload is logged by name
// and the cache is kept. A cold cache with the endpoint down makes `getKey` throw
// `KeySetUnavailableError`, which the validator maps to `IdTokenError('keys_unavailable')`: sign-in
// fails closed. Key sets are per tenant and there is exactly one tenant.
import { LIMITS } from '@m365portal/shared/limits';
import {
  createRemoteJWKSet,
  customFetch,
  errors,
  type CompactJWSHeaderParameters,
  type FlattenedJWSInput,
  type JWTVerifyGetKey,
} from 'jose';
import type { Clock, Scheduler } from '../../ports/clock.js';
import type { JsonFetch } from '../http/json-fetch.js';
import type { IdentityLog } from './http.js';
import type { TenantMetadata } from './tenant-metadata.js';

/** The key endpoint could not give a key set (down, slow, redirected, not JSON). */
export class KeySetUnavailableError extends Error {
  readonly code = 'keys_unavailable';

  constructor() {
    super('keys_unavailable');
    this.name = 'KeySetUnavailableError';
  }
}

const JWKS_CACHE_MS = LIMITS.microsoft.jwksCacheHours * 3_600_000;
const JWKS_COOLDOWN_MS = LIMITS.microsoft.jwksUnknownKidCooldownMinutes * 60_000;
const JWKS_REFRESH_MS = LIMITS.microsoft.jwksRefreshMinutes * 60_000;
const JWKS_TIMEOUT_MS = 5_000;

export interface KeySetDeps {
  readonly metadata: TenantMetadata;
  readonly jsonFetch: JsonFetch;
  readonly clock: Clock;
  readonly scheduler: Scheduler;
  readonly log?: Pick<IdentityLog, 'warn'>;
}

export type ResolvedKey = Awaited<ReturnType<JWTVerifyGetKey>>;

export interface KeySet {
  /** For `jwtVerify`: resolves the public key of a `kid`. */
  readonly getKey: (
    protectedHeader: CompactJWSHeaderParameters,
    token: FlattenedJWSInput,
  ) => Promise<ResolvedKey>;
  /** Fetches the key set now. Never throws: resolves `false` (and logs) when it failed. */
  reload(): Promise<boolean>;
  /** The first reload (not awaited) and then one every hour. Calling it twice changes nothing. */
  start(): void;
  stop(): void;
}

type RemoteSet = ReturnType<typeof createRemoteJWKSet>;

export function createKeySet(deps: KeySetDeps): KeySet {
  let current: { readonly uri: string; readonly set: RemoteSet } | undefined;
  let timer: unknown;

  async function fetchKeys(url: string, init: { signal?: AbortSignal }): Promise<Response> {
    const answer = await deps.jsonFetch({
      method: 'GET',
      url,
      timeoutMs: JWKS_TIMEOUT_MS,
      ...(init.signal === undefined ? {} : { signal: init.signal }),
    });
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    });
  }

  async function remoteSet(): Promise<RemoteSet> {
    const { jwksUri } = await deps.metadata.get();
    if (current?.uri !== jwksUri) {
      current = {
        uri: jwksUri,
        set: createRemoteJWKSet(new URL(jwksUri), {
          cacheMaxAge: JWKS_CACHE_MS,
          cooldownDuration: JWKS_COOLDOWN_MS,
          timeoutDuration: JWKS_TIMEOUT_MS,
          [customFetch]: fetchKeys,
        }),
      };
    }
    return current.set;
  }

  const getKey = async (
    protectedHeader: CompactJWSHeaderParameters,
    token: FlattenedJWSInput,
  ): Promise<ResolvedKey> => {
    try {
      const set = await remoteSet();
      return await set(protectedHeader, token);
    } catch (failure) {
      // An unknown kid and an ambiguous one are answers about the token; everything else (the
      // fetch, the timeout, a body that is not a key set) means there are no keys to judge it by.
      if (
        failure instanceof errors.JWKSNoMatchingKey ||
        failure instanceof errors.JWKSMultipleMatchingKeys
      ) {
        throw failure;
      }
      throw new KeySetUnavailableError();
    }
  };

  async function reload(): Promise<boolean> {
    try {
      const set = await remoteSet();
      await set.reload();
      return true;
    } catch {
      deps.log?.warn({ event: 'jwks_reload_failed' }, 'jwks_reload_failed');
      return false;
    }
  }

  return {
    getKey,
    reload,
    start() {
      if (timer !== undefined) return;
      void reload();
      timer = deps.scheduler.setInterval(() => {
        void reload();
      }, JWKS_REFRESH_MS);
    },
    stop() {
      if (timer === undefined) return;
      deps.scheduler.clearInterval(timer);
      timer = undefined;
    },
  };
}

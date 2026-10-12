// T-B-077, FR-B-404, V-B08, U40 (closed) (+ negative): the key set of the tenant.
//
// Learn, https://learn.microsoft.com/entra/identity-platform/signing-key-rollover: discover and cache
// the keys per tenant; cache each key by `kid`, 24 hours; refresh at start and hourly; refetch on an
// unknown `kid` but not more often than every 5 minutes; there is always more than one valid key
// during a rollover. `jose` 6.2.12 `createRemoteJWKSet` offers `cacheMaxAge`, `cooldownDuration`,
// `timeoutDuration` and the `customFetch` symbol (V-B08); jose reads `Date.now()` itself, so the
// tests move the system date together with the injected clock.
import type { FlattenedJWSInput } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIdentityFetch } from '../../../src/integrations/identity/http.js';
import { createKeySet, KeySetUnavailableError } from '../../../src/integrations/identity/jwks.js';
import { createTenantMetadata } from '../../../src/integrations/identity/tenant-metadata.js';
import { rsaKeyPair } from '../../fakes/fake-tenant/entra/jwt.js';
import { fakeGuid } from '../../fakes/fake-tenant/graph/index.js';
import { fake, testClock } from '../../support/msw.js';
import { createTime, mountScript, rejectionOf, settle, track } from '../support.js';
import { identityWorld } from './support.js';

const TENANT = fakeGuid('tenant', 1);
const KEYS_PATH = `/${TENANT}/discovery/v2.0/keys`;
const TOKEN = { payload: '', signature: '' } as FlattenedJWSInput;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(testClock.nowMs());
});
afterEach(() => {
  vi.useRealTimers();
});

interface Logged {
  readonly fields: Record<string, unknown>;
  readonly message: string;
}

function keySet() {
  const time = createTime();
  const jsonFetch = createIdentityFetch({ clock: time.clock, scheduler: time.scheduler });
  const warnings: Logged[] = [];
  const log = {
    warn: (fields: Readonly<Record<string, unknown>>, message: string) => {
      warnings.push({ fields: { ...fields }, message });
    },
  };
  const metadata = createTenantMetadata({ tenantId: TENANT, jsonFetch, clock: time.clock, log });
  const keys = createKeySet({
    metadata,
    jsonFetch,
    clock: time.clock,
    scheduler: time.scheduler,
    log,
  });
  /** Time passes for the injected clock, the scheduler and the date `jose` reads. */
  function elapse(milliseconds: number): void {
    time.elapse(milliseconds);
    vi.setSystemTime(testClock.nowMs());
  }
  return { keys, time, warnings, elapse };
}

const header = (kid: string) => ({ alg: 'RS256', kid });
const keyFetches = (): number => fake.calls.all().filter((call) => call.path === KEYS_PATH).length;

describe('resolving a key', () => {
  it('finds the key by kid in the key set of the tenant', async () => {
    const world = identityWorld();
    const { keys } = keySet();
    const [kid] = world.entra.control.keyIds();
    const key = await keys.getKey(header(kid ?? ''), TOKEN);
    expect(key).toBeDefined();
    expect(keyFetches()).toBe(1);
  });

  it('asks only the key endpoint of the tenant, with GET', async () => {
    const world = identityWorld();
    const { keys } = keySet();
    await keys.getKey(header(world.entra.control.keyIds()[0] ?? ''), TOKEN);
    const calls = fake.calls.all().filter((call) => call.path === KEYS_PATH);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ host: 'login.microsoftonline.com', method: 'GET' });
  });

  it('uses the jwks_uri of an accepted discovery document', async () => {
    // Another path on the login host, as the document may name it; the default path is never asked.
    const alternative = `/${TENANT}/discovery/v2.0/alt-keys`;
    const pair = rsaKeyPair(0);
    const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'alt-1', use: 'sig' };
    mountScript(
      'login.microsoftonline.com',
      'GET',
      `/${TENANT}/v2.0/.well-known/openid-configuration`,
      [
        {
          status: 200,
          body: {
            issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`,
            jwks_uri: `https://login.microsoftonline.com${alternative}`,
            end_session_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/logout`,
          },
        },
      ],
    );
    const keysRoute = mountScript('login.microsoftonline.com', 'GET', alternative, [
      { status: 200, body: { keys: [jwk] } },
    ]);
    const { keys } = keySet();
    await expect(keys.getKey(header('alt-1'), TOKEN)).resolves.toBeDefined();
    expect(keysRoute.calls).toHaveLength(1);
    expect(keyFetches()).toBe(0);
  });
});

describe('the cache (cacheMaxAge 24 h)', () => {
  it('serves from the cache while it is fresh and fetches again after 24 hours', async () => {
    const world = identityWorld();
    const { keys, elapse } = keySet();
    const kid = world.entra.control.keyIds()[0] ?? '';
    await keys.getKey(header(kid), TOKEN);
    elapse(23 * 3_600_000);
    await keys.getKey(header(kid), TOKEN);
    expect(keyFetches()).toBe(1);
    elapse(3_600_000 + 1_000);
    await keys.getKey(header(kid), TOKEN);
    expect(keyFetches()).toBe(2);
  });
});

describe('an unknown kid (cooldownDuration 5 minutes; rotation)', () => {
  it('refetches at most every five minutes', async () => {
    const world = identityWorld();
    const { keys, elapse } = keySet();
    const oldKid = world.entra.control.keyIds()[0] ?? '';
    await keys.getKey(header(oldKid), TOKEN);
    const added = world.entra.control.rotateKeys();

    // Inside the cooldown nothing is fetched and the new key is not found yet.
    elapse(60_000);
    const early = await rejectionOf(keys.getKey(header(added), TOKEN));
    expect((early as { code?: string }).code).toBe('ERR_JWKS_NO_MATCHING_KEY');
    expect(keyFetches()).toBe(1);

    // After it the key set is fetched once and the key is found.
    elapse(4 * 60_000 + 1_000);
    await expect(keys.getKey(header(added), TOKEN)).resolves.toBeDefined();
    expect(keyFetches()).toBe(2);
  });

  it('an unknown kid that stays unknown fails after one refetch, and again only after the cooldown', async () => {
    const world = identityWorld();
    const { keys, elapse } = keySet();
    await keys.getKey(header(world.entra.control.keyIds()[0] ?? ''), TOKEN);
    elapse(5 * 60_000 + 1_000);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failure = await rejectionOf(keys.getKey(header('no-such-kid'), TOKEN));
      expect((failure as { code?: string }).code).toBe('ERR_JWKS_NO_MATCHING_KEY');
    }
    expect(keyFetches()).toBe(2);
    elapse(5 * 60_000 + 1_000);
    await rejectionOf(keys.getKey(header('no-such-kid'), TOKEN));
    expect(keyFetches()).toBe(3);
  });

  it('keeps the old key until the key set is fetched again, then drops it (dropOldKeys)', async () => {
    const world = identityWorld();
    const { keys, elapse } = keySet();
    const oldKid = world.entra.control.keyIds()[0] ?? '';
    await keys.getKey(header(oldKid), TOKEN);
    const added = world.entra.control.rotateKeys();
    world.entra.control.dropOldKeys();
    // Cached: the old key still resolves.
    elapse(1_000);
    await expect(keys.getKey(header(oldKid), TOKEN)).resolves.toBeDefined();
    // A forced reload (the hourly one) picks up the new set.
    await keys.reload();
    await expect(keys.getKey(header(added), TOKEN)).resolves.toBeDefined();
    const gone = await rejectionOf(keys.getKey(header(oldKid), TOKEN));
    expect((gone as { code?: string }).code).toBe('ERR_JWKS_NO_MATCHING_KEY');
  });
});

describe('the key endpoint is down (fails closed)', () => {
  it('a cold start with the endpoint down is KeySetUnavailableError, and works again when it is back', async () => {
    const world = identityWorld();
    world.entra.control.failKeys('unavailable');
    const { keys, elapse } = keySet();
    const kid = world.entra.control.keyIds()[0] ?? '';
    expect(await rejectionOf(keys.getKey(header(kid), TOKEN))).toBeInstanceOf(
      KeySetUnavailableError,
    );
    world.entra.control.failKeys(null);
    elapse(1_000);
    await expect(keys.getKey(header(kid), TOKEN)).resolves.toBeDefined();
  });

  it.each(['redirect', 'not_json'] as const)(
    'a %s answer is a failure, never a key set',
    async (mode) => {
      const world = identityWorld();
      world.entra.control.failKeys(mode);
      const { keys } = keySet();
      const failure = await rejectionOf(
        keys.getKey(header(world.entra.control.keyIds()[0] ?? ''), TOKEN),
      );
      expect(failure).toBeInstanceOf(KeySetUnavailableError);
    },
  );

  it('a key set that is not a key set is a failure', async () => {
    mountScript('login.microsoftonline.com', 'GET', KEYS_PATH, [
      { status: 200, body: { keys: 'x' } },
    ]);
    const { keys } = keySet();
    expect(await rejectionOf(keys.getKey(header('k'), TOKEN))).toBeInstanceOf(
      KeySetUnavailableError,
    );
  });

  it('a hanging endpoint ends after five seconds on the injected scheduler', async () => {
    mountScript('login.microsoftonline.com', 'GET', KEYS_PATH, ['hang']);
    const { keys, time } = keySet();
    const attempt = track(keys.getKey(header('k'), TOKEN));
    await settle();
    expect(attempt.settled()).toBe(false);
    time.elapse(5_000);
    await settle();
    expect(attempt.settled()).toBe(true);
    expect(attempt.error()).toBeInstanceOf(KeySetUnavailableError);
  });

  it('a key endpoint that answers 200 after a failure leaves the cache usable', async () => {
    const world = identityWorld();
    const { keys, elapse } = keySet();
    const kid = world.entra.control.keyIds()[0] ?? '';
    await keys.getKey(header(kid), TOKEN);
    world.entra.control.failKeys('unavailable');
    elapse(60 * 60_000);
    await keys.reload();
    await expect(keys.getKey(header(kid), TOKEN)).resolves.toBeDefined();
  });
});

describe('the hourly reload (start)', () => {
  it('reloads at start without blocking, then every hour on the scheduler', async () => {
    const world = identityWorld();
    const { keys, time, elapse } = keySet();
    keys.start();
    expect(keyFetches()).toBe(0);
    await settle();
    expect(keyFetches()).toBe(1);
    time.scheduler.advance(60 * 60_000);
    elapse(0);
    await settle();
    expect(keyFetches()).toBe(2);
    time.scheduler.advance(60 * 60_000);
    await settle();
    expect(keyFetches()).toBe(3);
    // The hourly reload keeps the cache fresh: a lookup after a day does not fetch by itself.
    const before = keyFetches();
    await keys.getKey(header(world.entra.control.keyIds()[0] ?? ''), TOKEN);
    expect(keyFetches()).toBe(before);
    keys.stop();
    expect(time.scheduler.pending()).toBe(0);
  });

  it('logs a failed reload and keeps the keys it has', async () => {
    const world = identityWorld();
    const { keys, time, warnings, elapse } = keySet();
    const kid = world.entra.control.keyIds()[0] ?? '';
    await keys.getKey(header(kid), TOKEN);
    keys.start();
    await settle();
    world.entra.control.failKeys('unavailable');
    elapse(60 * 60_000);
    time.scheduler.advance(60 * 60_000);
    await settle();
    expect(warnings.some((entry) => entry.fields.event === 'jwks_reload_failed')).toBe(true);
    await expect(keys.getKey(header(kid), TOKEN)).resolves.toBeDefined();
    keys.stop();
  });

  it('a reload never throws, also when the endpoint is down at start', async () => {
    const world = identityWorld();
    world.entra.control.failKeys('unavailable');
    const { keys } = keySet();
    await expect(keys.reload()).resolves.toBe(false);
    world.entra.control.failKeys(null);
    await expect(keys.reload()).resolves.toBe(true);
  });

  it('start twice does not double the timers', async () => {
    identityWorld();
    const { keys, time } = keySet();
    keys.start();
    keys.start();
    await settle();
    expect(time.scheduler.pending()).toBe(1);
    keys.stop();
  });
});

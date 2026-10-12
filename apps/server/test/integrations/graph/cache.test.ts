// T-B-071, FR-B-313: the short-TTL cache of Graph GET results.
//
// organization 300 s, user 60 s, group 60 s; a least-recently-used store of 1,000 entries keyed by
// method, path and sorted query; errors are never cached; `checkMemberGroups`, provisioning calls and
// wizard probes are never cached; `skipCache` reads around the cache. Time is the injected clock.
import { LIMITS } from '@m365portal/shared/limits';
import { describe, expect, it } from 'vitest';
import {
  GRAPH_CACHE_ENTRIES,
  GRAPH_CACHE_TTL_MS,
  GraphCache,
  cacheKey,
} from '../../../src/integrations/graph/cache.js';
import { createGraphHttp, type GraphRequest } from '../../../src/integrations/graph/graph-http.js';
import { GraphNotFoundError } from '../../../src/ports/errors.js';
import { createFakeClock } from '../../helpers/fake-clock.js';
import { testClock } from '../../support/msw.js';
import { createTime, mountScript, rejectionOf, sequenceRandom } from '../support.js';

const GRAPH = 'graph.microsoft.com';

function http() {
  const time = createTime();
  return createGraphHttp({
    token: () => Promise.resolve('tok'),
    clock: time.clock,
    random: sequenceRandom([0]),
    scheduler: time.scheduler,
  });
}

function get(
  path: string,
  ttlMs: number | undefined,
  extra: Partial<GraphRequest> = {},
): GraphRequest {
  return {
    method: 'GET',
    route: 'test.get',
    path,
    ...(ttlMs === undefined ? {} : { cache: { ttlMs } }),
    ...extra,
  };
}

describe('the numbers of FR-B-313', () => {
  it('are organization 300 s, user 60 s, group 60 s and 1,000 entries', () => {
    expect(GRAPH_CACHE_TTL_MS).toEqual({ organization: 300_000, user: 60_000, group: 60_000 });
    expect(GRAPH_CACHE_ENTRIES).toBe(1_000);
    expect(LIMITS.microsoft.graphCacheTtlSeconds).toEqual({
      organization: 300,
      user: 60,
      group: 60,
    });
  });
});

describe('GraphCache (T-B-071)', () => {
  it('holds an entry while now is before its expiry and drops it at exactly the TTL', () => {
    const clock = createFakeClock();
    const cache = new GraphCache({ now: () => clock.nowMs() });
    cache.set('k', { a: 1 }, 60_000);
    clock.advance(59_999);
    expect(cache.get('k')?.body).toEqual({ a: 1 });
    clock.advance(1);
    expect(cache.get('k')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('measures the TTL from the moment of the last set', () => {
    const clock = createFakeClock();
    const cache = new GraphCache({ now: () => clock.nowMs() });
    cache.set('k', 1, 1_000);
    clock.advance(900);
    cache.set('k', 2, 1_000);
    clock.advance(900);
    expect(cache.get('k')?.body).toBe(2);
  });

  it('evicts the least recently used entry beyond 1,000, and a read counts as use', () => {
    const clock = createFakeClock();
    const cache = new GraphCache({ now: () => clock.nowMs() });
    for (let n = 0; n < 1_000; n += 1) cache.set(`k${String(n)}`, n, 60_000);
    expect(cache.size).toBe(1_000);
    expect(cache.get('k0')?.body).toBe(0);
    cache.set('k1000', 1000, 60_000);
    expect(cache.size).toBe(1_000);
    expect(cache.get('k1')).toBeUndefined();
    expect(cache.get('k0')?.body).toBe(0);
    expect(cache.get('k1000')?.body).toBe(1000);
    expect(cache.get('k2')?.body).toBe(2);
  });

  it('hands out copies: editing a result does not change what the next reader gets', () => {
    const clock = createFakeClock();
    const cache = new GraphCache({ now: () => clock.nowMs() });
    const original = { list: [1, 2] };
    cache.set('k', original, 1_000);
    original.list.push(3);
    const first = cache.get('k')?.body as { list: number[] };
    first.list.push(99);
    expect((cache.get('k')?.body as { list: number[] }).list).toEqual([1, 2]);
  });

  it('refuses a cache of no entries and a TTL that is not a positive whole number', () => {
    const clock = { now: () => 0 };
    expect(() => new GraphCache(clock, 0)).toThrow(RangeError);
    const cache = new GraphCache(clock);
    for (const ttl of [0, -5, 1.5, Number.NaN]) {
      expect(() => {
        cache.set('k', 1, ttl);
      }).toThrow(RangeError);
    }
  });

  it('keys by method, path and query as given (the query is sorted by the builder)', () => {
    expect(cacheKey('GET', '/users/x?$select=id')).toBe('GET /users/x?$select=id');
    expect(cacheKey('GET', '/users/x')).not.toBe(cacheKey('POST', '/users/x'));
  });
});

describe('GraphHttp and the cache (T-B-071)', () => {
  it.each([
    ['organization', '/organization', GRAPH_CACHE_TTL_MS.organization],
    ['user', '/users/u1', GRAPH_CACHE_TTL_MS.user],
    ['group', '/groups/g1', GRAPH_CACHE_TTL_MS.group],
  ])('answers a repeated %s read from the cache until the TTL ends', async (_name, path, ttl) => {
    const { calls } = mountScript(GRAPH, 'GET', `/v1.0${path}`, [
      { status: 200, body: { id: 'x' } },
    ]);
    const client = http();
    await client.request(get(path, ttl));
    testClock.advance(ttl - 1);
    await client.request(get(path, ttl));
    expect(calls).toHaveLength(1);
    testClock.advance(1);
    await client.request(get(path, ttl));
    expect(calls).toHaveLength(2);
  });

  it('shares an entry between queries that differ only in order, and not between different ones', async () => {
    const { calls } = mountScript(GRAPH, 'GET', '/v1.0/users', [
      { status: 200, body: { value: [] } },
    ]);
    const client = http();
    await client.request(get('/users', 60_000, { query: { $top: '1', $select: 'id' } }));
    await client.request(get('/users', 60_000, { query: { $select: 'id', $top: '1' } }));
    expect(calls).toHaveLength(1);
    await client.request(get('/users', 60_000, { query: { $select: 'id,mail', $top: '1' } }));
    expect(calls).toHaveLength(2);
  });

  it('never caches an error: the next call asks again', async () => {
    const { calls } = mountScript(GRAPH, 'GET', '/v1.0/users/u1', [
      { status: 404, body: { error: { code: 'Request_ResourceNotFound' } } },
      { status: 200, body: { id: 'u1' } },
    ]);
    const client = http();
    expect(await rejectionOf(client.request(get('/users/u1', 60_000)))).toBeInstanceOf(
      GraphNotFoundError,
    );
    expect((await client.request(get('/users/u1', 60_000))).status).toBe(200);
    expect(calls).toHaveLength(2);
    // And the success is cached now.
    await client.request(get('/users/u1', 60_000));
    expect(calls).toHaveLength(2);
  });

  it('never caches without a cache option, a POST, or a wizard call', async () => {
    const reads = mountScript(GRAPH, 'GET', '/v1.0/organization', [{ status: 200, body: {} }]);
    const posts = mountScript(GRAPH, 'POST', '/v1.0/users/u1/checkMemberGroups', [
      { status: 200, body: { value: [] } },
    ]);
    const client = http();
    await client.request(get('/organization', undefined));
    await client.request(get('/organization', undefined));
    expect(reads.calls).toHaveLength(2);

    await client.request(get('/organization', 300_000, { budget: 'wizard' }));
    await client.request(get('/organization', 300_000, { budget: 'wizard' }));
    expect(reads.calls).toHaveLength(4);

    const post: GraphRequest = {
      method: 'POST',
      route: 'check',
      path: '/users/u1/checkMemberGroups',
      json: { groupIds: [] },
      idempotent: true,
      cache: { ttlMs: 60_000 },
    };
    await client.request(post);
    await client.request(post);
    expect(posts.calls).toHaveLength(2);
  });

  it('reads around the cache with skipCache and stores the fresh answer', async () => {
    const { calls } = mountScript(GRAPH, 'GET', '/v1.0/users/u1', [
      { status: 200, body: { accountEnabled: true } },
      { status: 200, body: { accountEnabled: false } },
    ]);
    const client = http();
    expect(
      ((await client.request(get('/users/u1', 60_000))).body as { accountEnabled: boolean })
        .accountEnabled,
    ).toBe(true);
    const fresh = await client.request(get('/users/u1', 60_000, { skipCache: true }));
    expect((fresh.body as { accountEnabled: boolean }).accountEnabled).toBe(false);
    expect(calls).toHaveLength(2);
    const next = await client.request(get('/users/u1', 60_000));
    expect((next.body as { accountEnabled: boolean }).accountEnabled).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it('forgets everything on clearCache', async () => {
    const { calls } = mountScript(GRAPH, 'GET', '/v1.0/organization', [{ status: 200, body: {} }]);
    const client = http();
    await client.request(get('/organization', 300_000));
    client.clearCache();
    await client.request(get('/organization', 300_000));
    expect(calls).toHaveLength(2);
  });
});

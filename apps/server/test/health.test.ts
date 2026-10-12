// T-A-042: FR-A-026 (R1 and R2). `/healthz` is liveness and `/readyz` is readiness; both are public,
// `no-store`, exempt from rate limiting and CSRF, and say only what they must: a status, the
// version, and for readiness four named checks (three in Phase A, `secrets` from Phase B) with a stable failure code, never raw error text.
//
// What decides readiness (the write probe, the 2-second cache, the failure codes) is T-A-044; here
// the route is tested against the `Readiness` interface it consumes.
import { HealthzResponseSchema, ReadyzResponseSchema } from '@m365portal/shared/schemas/health';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import { healthRoutes, type Readiness } from '../src/routes/health.js';
import { createFixtureApp, SYSTEM_VERSION } from './helpers/http-app.js';
import { readJson } from './helpers/http-client.js';

const ALL_OK = {
  status: 'ready',
  checks: [
    { name: 'data_dir', ok: true },
    { name: 'database', ok: true },
    { name: 'schema', ok: true },
    { name: 'secrets', ok: true },
  ],
} as const;

const NOT_READY = {
  status: 'unavailable',
  checks: [
    { name: 'data_dir', ok: false, code: 'data_dir_not_writable' },
    { name: 'database', ok: false, code: 'database_unavailable' },
    { name: 'schema', ok: true },
    { name: 'secrets', ok: true },
  ],
} as const;

function readiness(result: Awaited<ReturnType<Readiness['check']>>): Readiness & { calls: number } {
  const state = {
    calls: 0,
    check() {
      state.calls += 1;
      return result;
    },
  };
  return state;
}

describe('GET /healthz (R1, FR-A-026)', () => {
  it('answers 200 { status: "ok", version } with the version it was built with', async () => {
    const app = await createFixtureApp({ system: {} });
    const response = await app.client.get('/healthz');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    const body = await readJson(response);
    expect(body).toEqual({ status: 'ok', version: SYSTEM_VERSION });
    expect(HealthzResponseSchema.safeParse(body).success).toBe(true);
  });

  it('is no-store, without ETag or compression', async () => {
    const app = await createFixtureApp({ system: {} });
    const response = await app.client.get('/healthz', {
      headers: { 'accept-encoding': 'br, gzip' },
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('etag')).toBeNull();
    expect(response.headers.get('content-encoding')).toBeNull();
  });

  it('answers HEAD with the headers and no body', async () => {
    const app = await createFixtureApp({ system: {} });
    const response = await app.client.request('HEAD', '/healthz');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
  });

  it('answers in degraded mode: it asks nothing of storage', async () => {
    const app = await createFixtureApp({
      system: { readiness: readiness(NOT_READY), storageAvailable: () => false },
    });
    expect((await app.client.get('/healthz')).status).toBe(200);
  });

  it('does not call readiness', async () => {
    const probe = readiness(ALL_OK);
    const app = await createFixtureApp({ system: { readiness: probe } });
    await app.client.get('/healthz');
    expect(probe.calls).toBe(0);
  });

  it('is public, and a POST is a 405 problem, not a CSRF or Origin refusal', async () => {
    const app = await createFixtureApp({ system: {} });
    const response = await app.client.post('/healthz', { origin: null, csrf: 'none' });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
  });
});

describe('GET /readyz (R2, FR-A-026)', () => {
  it('answers 200 with status ready and the four checks when everything is fine', async () => {
    const app = await createFixtureApp({ system: { readiness: readiness(ALL_OK) } });
    const response = await app.client.get('/readyz');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    const body = await readJson(response);
    expect(body).toEqual(ALL_OK);
    expect(ReadyzResponseSchema.safeParse(body).success).toBe(true);
  });

  it('answers 503 with status unavailable and the code of each failing check', async () => {
    const app = await createFixtureApp({ system: { readiness: readiness(NOT_READY) } });
    const response = await app.client.get('/readyz');
    expect(response.status).toBe(503);
    // The status document of the contract, not a problem: the probe reads the same shape either way.
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('content-type')).not.toContain('problem');
    const body = await readJson(response);
    expect(body).toEqual(NOT_READY);
    expect(ReadyzResponseSchema.safeParse(body).success).toBe(true);
  });

  it.each([
    ['data_dir', 'data_dir_not_writable'],
    ['database', 'database_unavailable'],
    ['database', 'database_corrupt'],
    ['schema', 'schema_newer_than_app'],
    ['secrets', 'app_key_missing'],
    ['secrets', 'app_key_invalid'],
    ['secrets', 'certificate_unreadable'],
  ] as const)('reports %s failing with %s', async (name, code) => {
    const checks = (['data_dir', 'database', 'schema', 'secrets'] as const).map((each) =>
      each === name ? { name: each, ok: false as const, code } : { name: each, ok: true as const },
    );
    const app = await createFixtureApp({
      system: { readiness: readiness({ status: 'unavailable', checks }) },
    });
    const response = await app.client.get('/readyz');
    expect(response.status).toBe(503);
    expect((await readJson<{ checks: unknown[] }>(response)).checks).toContainEqual({
      name,
      ok: false,
      code,
    });
  });

  it('is no-store', async () => {
    const app = await createFixtureApp({ system: { readiness: readiness(NOT_READY) } });
    for (const path of ['/readyz']) {
      const response = await app.client.get(path);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('asks readiness once per request and reflects a change at once (the cache is readiness itself)', async () => {
    let current: Awaited<ReturnType<Readiness['check']>> = ALL_OK;
    let calls = 0;
    const app = await createFixtureApp({
      system: {
        readiness: {
          check: () => {
            calls += 1;
            return current;
          },
        },
      },
    });
    expect((await app.client.get('/readyz')).status).toBe(200);
    current = NOT_READY;
    expect((await app.client.get('/readyz')).status).toBe(503);
    expect(calls).toBe(2);
  });

  it('accepts a readiness that answers asynchronously', async () => {
    const app = await createFixtureApp({
      system: { readiness: { check: () => Promise.resolve(ALL_OK) } },
    });
    expect((await app.client.get('/readyz')).status).toBe(200);
  });

  it('never carries raw error text: a readiness that throws is a generic 500', async () => {
    const canary = 'canary-secret-7f21';
    const app = await createFixtureApp({
      system: {
        readiness: {
          check: () => {
            throw new Error(`EACCES: permission denied, open '/data/${canary}'`);
          },
        },
      },
    });
    const response = await app.client.get('/readyz');
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(canary);
    expect(app.logs.text()).not.toContain(canary);
  });
});

describe('both probes are exempt from rate limiting and from the rate bucket (FR-A-026, FR-A-045)', () => {
  const ONE_READ = {
    read: { capacity: 1, refillIntervalMs: 60_000 },
    write: { capacity: 10, refillIntervalMs: 2_000 },
    upload: { capacity: 3, refillIntervalMs: 10_000 },
  } as const;

  it('answers a burst far beyond the read bucket, and leaves the bucket untouched', async () => {
    const app = await createFixtureApp({
      system: { readiness: readiness(ALL_OK) },
      rules: ONE_READ,
    });
    for (let request = 0; request < 40; request += 1) {
      expect((await app.client.get('/healthz')).status).toBe(200);
      expect((await app.client.get('/readyz')).status).toBe(200);
    }
    // The single token of the read bucket is still there for an ordinary route ...
    expect((await app.client.csrfToken()).length).toBeGreaterThan(0);
    // ... and is spent by it.
    const limited = await app.client.get('/api/v1/fixture/read');
    expect(limited.status).toBe(429);
  });

  it('does not document a 429 for them', async () => {
    const app = await createFixtureApp({ system: {} });
    const paths = app.http.document.paths as Record<
      string,
      Record<string, { responses: object; 'x-rate-limit': string }>
    >;
    for (const path of ['/healthz', '/readyz']) {
      const operation = paths[path]?.get;
      expect(operation?.['x-rate-limit']).toBe('exempt');
      expect(Object.keys(operation?.responses ?? {})).not.toContain('429');
    }
  });
});

describe('the routes are in the table and the document (R1, R2)', () => {
  it('registers health.live and health.ready as public GET routes of the exempt class', async () => {
    const app = await createFixtureApp({ system: {} });
    const byId = new Map(app.http.table.routes.map((route) => [route.id, route]));
    for (const [id, path] of [
      ['health.live', '/healthz'],
      ['health.ready', '/readyz'],
    ] as const) {
      const route = byId.get(id);
      expect(route?.methods).toEqual(['GET']);
      expect(route?.paths).toEqual([path]);
      expect(route?.access).toEqual({ public: true });
      expect(route?.rateLimit).toBe('exempt');
    }
  });

  it('negative fixture: a route table without the health routes fails the check on purpose', async () => {
    const app = await createFixtureApp({ system: {} });
    const needsHealth = (ids: readonly string[]): void => {
      for (const id of ['health.live', 'health.ready']) {
        if (!ids.includes(id)) throw new Error(`${id} is not in the route table`);
      }
    };
    needsHealth(app.http.table.routes.map((route) => route.id));
    expectGuardFails(needsHealth, ['meta.me'], { reason: 'health.live is not in the route table' });
    expect(typeof healthRoutes).toBe('function');
  });
});

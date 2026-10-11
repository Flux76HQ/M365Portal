// T-A-041: FR-A-034, FR-A-072 (denial part), FR-A-073 (detail content), SC-A-009, PD-21, PA-15.
//
// Every denied authorisation, Origin or CSRF decision on a write route appends an audit entry
// BEFORE the response is sent: outcome `denied`, the actor, the route id as the action, the reason
// code, the permission the route needed, the request id and the client address. Rate-limited
// requests, denied reads and every other refusal (404, 405, 413, 415, 422) are not audited.
//
// The audit is fail-closed: if the entry cannot be written the client gets 503 and the handler never
// ran. The detail holds a method, a route template and a permission name, never a body or a secret,
// and the log never carries the client address (it lives in the audit table only).
//
// The tests are table-driven over the route table: every write route of the application, and the
// three ways a write is denied. A route that S2 registers later is covered by the same table.
//
// Negative fixtures: an application whose denial hook writes nothing, and one that audits only
// permission denials, must fail the guard `assertDenialsAudited`.
import { join } from 'node:path';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it, onTestFinished } from 'vitest';
import { defaultPaths } from '../scripts/schema-snapshot.js';
import {
  clearAuditHeadLog,
  setAuditHeadLog,
  verifyChain,
  type ChainVerdict,
} from '../src/audit/index.js';
import {
  DATABASE_FILE_NAME,
  openDatabase,
  type AppDatabase,
  type DatabaseHandle,
} from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { createDenialAudit } from '../src/http/denial-audit.js';
import type { OnRouteDenied } from '../src/http/route.js';
import { createLogger } from '../src/logging/logger.js';
import { createFakeClock } from './helpers/fake-clock.js';
import {
  createFixtureApp,
  requestBodyFor,
  writeRoutesOf,
  type FixtureApp,
  type WriteRoute,
} from './helpers/http-app.js';
import { readJson, type HttpClient } from './helpers/http-client.js';
import { createLogCapture } from './helpers/log-capture.js';
import { createTempDataDir } from './helpers/temp-data-dir.js';

const PATHS = defaultPaths();
const FOREIGN = 'https://evil.example';

interface AuditRow {
  readonly seq: number;
  readonly ts: string;
  readonly actor_kind: string;
  readonly actor_id: string;
  readonly action: string;
  readonly outcome: string;
  readonly reason_code: string | null;
  readonly client_ip: string | null;
  readonly request_id: string | null;
  readonly detail: string;
}

interface Audited {
  readonly app: FixtureApp;
  readonly dataDir: string;
  rows(): AuditRow[];
  verdict(): ChainVerdict;
  /** A client whose socket peer has this address. */
  from(peer: string): HttpClient;
}

type Storage = 'working' | 'read-only' | 'locked' | 'absent';

interface AuditedOptions {
  readonly mode?: 'anonymous' | 'preview';
  readonly storage?: Storage;
  /** Wrap or replace the real denial audit, for the negative fixtures. */
  readonly hook?: (real: OnRouteDenied) => OnRouteDenied;
  /** Rate limit rules instead of the defaults. */
  readonly rules?: NonNullable<Parameters<typeof createFixtureApp>[0]>['rules'];
}

const ROOMY_RULES = {
  read: { capacity: 10_000, refillIntervalMs: 1 },
  write: { capacity: 10_000, refillIntervalMs: 1 },
  upload: { capacity: 10_000, refillIntervalMs: 1 },
} as const;

/** The fixture application with a migrated database behind its denial audit. */
async function audited(options: AuditedOptions = {}): Promise<Audited> {
  const storage = options.storage ?? 'working';
  const dir = await createTempDataDir();
  const path = join(dir.path, DATABASE_FILE_NAME);

  // `reader` migrates the database and reads the rows back; it is never the connection that fails.
  const reader = openDatabase({ path });
  await runMigrations(reader.sqlite, {
    migrationsFolder: PATHS.migrationsFolder,
    backupsDir: join(dir.path, 'backups'),
  });
  // The connection the audit writes through: the same one, a read-only one, or one that waits only
  // briefly for a write lock another connection holds.
  const db: AppDatabase =
    storage === 'read-only'
      ? openDatabase({ path, readonly: true })
      : storage === 'locked'
        ? openDatabase({ path, busyTimeoutMs: 20 })
        : reader;
  const blocker = storage === 'locked' ? openDatabase({ path }) : undefined;
  blocker?.sqlite.exec('BEGIN IMMEDIATE');
  onTestFinished(() => {
    blocker?.sqlite.exec('ROLLBACK');
    blocker?.close();
    for (const handle of new Set([db, reader])) if (handle.sqlite.open) handle.close();
  });

  const clock = createFakeClock();
  const real = createDenialAudit({
    database: (): DatabaseHandle | undefined => (storage === 'absent' ? undefined : db),
    now: () => clock.nowMs(),
  });
  const app = await createFixtureApp({
    env: options.mode === 'preview' ? { PREVIEW_MODE: 'true' } : {},
    clock,
    context: { dataDir: dir.path },
    // Roomy buckets: the tables below send far more writes than the real limits allow in a burst.
    rules: options.rules ?? ROOMY_RULES,
    onDenied: options.hook === undefined ? real : options.hook(real),
  });
  return {
    app,
    dataDir: dir.path,
    rows: () => reader.sqlite.prepare('SELECT * FROM audit_log ORDER BY seq').all() as AuditRow[],
    verdict: () => verifyChain(reader.sqlite),
    from: (peer) => app.clientFor({ peer }),
  };
}

// ---------------------------------------------------------------------------------------------
// The scenarios: the three ways a write is denied
// ---------------------------------------------------------------------------------------------

interface Scenario {
  readonly name: string;
  readonly code: 'permission_denied' | 'origin_not_allowed' | 'csrf_invalid';
  /** Can this scenario happen for this actor and route? */
  readonly applies: (mode: 'anonymous' | 'preview', route: WriteRoute) => boolean;
  readonly send: (client: HttpClient, route: WriteRoute) => Promise<Response>;
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: 'a missing permission',
    code: 'permission_denied',
    applies: (mode, route) => mode === 'anonymous' && route.permission !== undefined,
    send: (client, route) => client.request(route.method, route.path, requestBodyFor(route)),
  },
  {
    name: 'a foreign Origin',
    code: 'origin_not_allowed',
    applies: () => true,
    send: (client, route) =>
      client.request(route.method, route.path, { ...requestBodyFor(route), origin: FOREIGN }),
  },
  {
    name: 'a missing Origin',
    code: 'origin_not_allowed',
    applies: () => true,
    send: (client, route) =>
      client.request(route.method, route.path, { ...requestBodyFor(route), origin: null }),
  },
  {
    name: 'a missing CSRF token',
    code: 'csrf_invalid',
    applies: () => true,
    send: (client, route) =>
      client.request(route.method, route.path, { ...requestBodyFor(route), csrf: 'none' }),
  },
  {
    name: 'a forged CSRF token',
    code: 'csrf_invalid',
    applies: () => true,
    send: (client, route) =>
      client.request(route.method, route.path, {
        ...requestBodyFor(route),
        csrf: {
          token:
            'v1.1760000000.1760028800.AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        },
      }),
  },
];

function detailOf(row: AuditRow): Record<string, unknown> {
  return JSON.parse(row.detail) as Record<string, unknown>;
}

/**
 * The guard: for every write route of the table and every way to be denied, the request is refused
 * with 403 and exactly one audit row exists afterwards, with the fields of FR-A-034. Throws on the
 * first deviation, naming the route and the scenario.
 */
async function assertDenialsAudited(target: Audited, mode: 'anonymous' | 'preview'): Promise<void> {
  const routes = writeRoutesOf(target.app);
  if (routes.length === 0) throw new Error('the table has no write route');
  for (const route of routes) {
    for (const scenario of SCENARIOS.filter((candidate) => candidate.applies(mode, route))) {
      const where = `${route.id} / ${scenario.name}`;
      const before = target.rows().length;
      const response = await scenario.send(target.app.client, route);
      const body = await readJson<{ code?: string }>(response);
      if (response.status !== 403 || body.code !== scenario.code) {
        throw new Error(
          `${where}: expected 403 ${scenario.code}, got ${String(response.status)} ${String(body.code)}`,
        );
      }
      const rows = target.rows();
      if (rows.length !== before + 1) {
        throw new Error(
          `${where}: no audit row was written for the denial (${String(rows.length - before)} new)`,
        );
      }
      const row = rows[rows.length - 1];
      if (row === undefined) throw new Error(`${where}: no audit row`);
      const expected: Partial<AuditRow> = {
        actor_kind: mode,
        actor_id: mode,
        action: route.id,
        outcome: 'denied',
        reason_code: scenario.code,
        request_id: response.headers.get('x-request-id'),
        client_ip: '127.0.0.1',
      };
      for (const [field, value] of Object.entries(expected)) {
        if (row[field as keyof AuditRow] !== value) {
          throw new Error(
            `${where}: audit field ${field} is ${String(row[field as keyof AuditRow])}, expected ${String(value)}`,
          );
        }
      }
      const detail = detailOf(row);
      const wanted: Record<string, unknown> = {
        method: route.method,
        route: route.template,
        ...(route.permission === undefined ? {} : { permission: route.permission }),
      };
      if (JSON.stringify(detail) !== JSON.stringify(sortKeys(wanted))) {
        throw new Error(`${where}: audit detail is ${row.detail}`);
      }
      if (target.app.calls.of(route.id) !== 0) throw new Error(`${where}: the handler was entered`);
    }
  }
}

function sortKeys(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)));
}

// ---------------------------------------------------------------------------------------------
// Every write route, every denial
// ---------------------------------------------------------------------------------------------

describe.each(['anonymous', 'preview'] as const)(
  'every denied write is audited, actor %s (FR-A-034, SC-A-009)',
  (mode) => {
    it('writes an entry for each write route and each way to be denied, with the fields of FR-A-034', async () => {
      const target = await audited({ mode });
      await expect(assertDenialsAudited(target, mode)).resolves.toBeUndefined();
      expect(target.rows().length).toBeGreaterThanOrEqual(writeRoutesOf(target.app).length * 4);
    });

    it('leaves a chain that verifies, without a gap', async () => {
      const target = await audited({ mode });
      await assertDenialsAudited(target, mode);
      const verdict = target.verdict();
      expect(verdict.ok).toBe(true);
      expect(verdict.triggersMissing).toEqual([]);
      expect(verdict.checked).toBe(target.rows().length);
      expect(target.rows().map((row) => row.seq)).toEqual(
        target.rows().map((_row, index) => index + 1),
      );
    });
  },
);

describe('the entry of a denial (FR-A-034, FR-A-073)', () => {
  it('names the actor, the route id, the reason, the permission, the request id and the client address', async () => {
    const target = await audited();
    const response = await target.app.client.post('/api/v1/fixture/things', {
      json: { name: 'x' },
      headers: { 'x-request-id': 'request-id-0001' },
    });
    expect(response.status).toBe(403);
    const [row] = target.rows();
    expect(row).toMatchObject({
      seq: 1,
      actor_kind: 'anonymous',
      actor_id: 'anonymous',
      action: 'fixture.create',
      outcome: 'denied',
      reason_code: 'permission_denied',
      client_ip: '127.0.0.1',
      request_id: 'request-id-0001',
    });
    expect(row === undefined ? {} : detailOf(row)).toEqual({
      method: 'POST',
      permission: 'settings:branding',
      route: '/api/v1/fixture/things',
    });
  });

  it('records the route template, never the requested path (a path can hold a name)', async () => {
    const target = await audited();
    await target.app.client.put('/api/v1/fixture/things/jane-doe-4711', { json: { name: 'x' } });
    const [row] = target.rows();
    expect(row?.action).toBe('fixture.update');
    expect(row === undefined ? '' : row.detail).toContain('/api/v1/fixture/things/{id}');
    expect(JSON.stringify(row)).not.toContain('jane-doe-4711');
  });

  it('leaves out the permission for a public write route', async () => {
    const target = await audited();
    const response = await target.app.client.post('/api/v1/fixture/ping', { origin: FOREIGN });
    expect(response.status).toBe(403);
    const [row] = target.rows();
    expect(row?.action).toBe('fixture.ping');
    expect(row === undefined ? {} : detailOf(row)).toEqual({
      method: 'POST',
      route: '/api/v1/fixture/ping',
    });
  });

  it('names the preview actor when preview mode is on', async () => {
    const target = await audited({ mode: 'preview' });
    await target.app.client.post('/api/v1/fixture/things', {
      json: { name: 'x' },
      origin: FOREIGN,
    });
    const [row] = target.rows();
    expect(row).toMatchObject({
      actor_kind: 'preview',
      actor_id: 'preview',
      reason_code: 'origin_not_allowed',
    });
  });

  it('takes the time from the injected clock, a backward step included', async () => {
    const target = await audited();
    target.app.clock.set('2026-03-01T08:30:00.123Z');
    await target.app.client.post('/api/v1/fixture/things', { json: { name: 'x' } });
    target.app.clock.stepBack(60_000);
    await target.app.client.post('/api/v1/fixture/things', { json: { name: 'x' } });
    expect(target.rows().map((row) => row.ts)).toEqual([
      '2026-03-01T08:30:00.123Z',
      '2026-03-01T08:29:00.123Z',
    ]);
    expect(target.verdict().ok).toBe(true);
  });

  it('records the address of the socket peer, per client', async () => {
    const target = await audited();
    await target.from('203.0.113.7').post('/api/v1/fixture/things', { json: { name: 'x' } });
    await target.from('2001:db8::1').post('/api/v1/fixture/things', { json: { name: 'x' } });
    expect(target.rows().map((row) => row.client_ip)).toEqual(['203.0.113.7', '2001:db8::1']);
  });

  it('writes the entry before the response is sent: the response waits for the hook', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const reachedHook = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const target = await audited({
      hook: (real) => async (c, denial) => {
        entered();
        await gate;
        await real(c, denial);
      },
    });
    let settled = false;
    const pending = target.app.client
      .post('/api/v1/fixture/things', { json: { name: 'x' } })
      .then((response) => {
        settled = true;
        return response;
      });
    // The request has reached the denial hook; give the event loop several turns to answer it.
    await reachedHook;
    for (let turn = 0; turn < 10; turn += 1) {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }
    expect(settled).toBe(false);
    expect(target.rows()).toHaveLength(0);
    release();
    const response = await pending;
    expect(response.status).toBe(403);
    expect(target.rows()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// What is not audited
// ---------------------------------------------------------------------------------------------

describe('what is not audited (FR-A-034, PA-15)', () => {
  it('a rate-limited request', async () => {
    // A one-token write bucket: the first denial is audited, the second request is a 429.
    const target = await audited({
      rules: {
        read: { capacity: 120, refillIntervalMs: 500 },
        write: { capacity: 1, refillIntervalMs: 60_000 },
        upload: { capacity: 3, refillIntervalMs: 10_000 },
      },
    });
    const first = await target.app.client.post('/api/v1/fixture/things', { json: { name: 'x' } });
    const second = await target.app.client.post('/api/v1/fixture/things', { json: { name: 'x' } });
    expect(first.status).toBe(403);
    expect(second.status).toBe(429);
    expect(target.rows()).toHaveLength(1);
  });

  it('a denied read, a refused audited read and a read of a permission route', async () => {
    const target = await audited();
    expect((await target.app.client.get('/api/v1/fixture/secret')).status).toBe(403);
    expect(
      (
        await target.app.client.get('/api/v1/fixture/export', {
          headers: { 'sec-fetch-site': 'cross-site' },
        })
      ).status,
    ).toBe(403);
    expect((await target.app.client.get('/api/v1/fixture/export')).status).toBe(403);
    expect(target.rows()).toHaveLength(0);
  });

  it('a 404, a 405, an OPTIONS, a 413, a 415 and a 422', async () => {
    const target = await audited({ mode: 'preview' });
    const { client } = target.app;
    expect((await client.get('/api/v1/nowhere')).status).toBe(404);
    expect((await client.post('/api/v1/fixture/read')).status).toBe(405);
    expect((await client.request('OPTIONS', '/api/v1/fixture/things')).status).toBe(405);
    expect(
      (
        await client.post('/api/v1/fixture/things', {
          body: 'x'.repeat(262_145),
          headers: { 'content-type': 'application/json' },
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await client.post('/api/v1/fixture/things', {
          body: 'x',
          headers: { 'content-type': 'text/plain' },
        })
      ).status,
    ).toBe(415);
    expect((await client.post('/api/v1/fixture/things', { json: {} })).status).toBe(422);
    expect(target.rows()).toHaveLength(0);
  });

  it('a request that is allowed', async () => {
    const target = await audited({ mode: 'preview' });
    expect(
      (await target.app.client.post('/api/v1/fixture/things', { json: { name: 'x' } })).status,
    ).toBe(201);
    expect(target.rows()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Fail closed
// ---------------------------------------------------------------------------------------------

describe('when the audit entry cannot be written the request fails closed (FR-A-034)', () => {
  it.each([
    ['the database is read-only', 'read-only', 'storage_unavailable'],
    ['the database is locked by another writer', 'locked', 'storage_busy'],
    ['there is no database (degraded mode)', 'absent', 'storage_unavailable'],
  ] as const)('%s: 503 %s and nothing was performed', async (_name, storage, code) => {
    const target = await audited({ storage });
    const response = await target.app.client.post('/api/v1/fixture/things', {
      json: { name: 'x' },
    });
    expect(response.status).toBe(503);
    expect((await readJson<{ code: string }>(response)).code).toBe(code);
    if (code === 'storage_busy') expect(response.headers.get('retry-after')).toBe('1');
    expect(target.app.calls.of('fixture.create')).toBe(0);
    expect(target.rows()).toHaveLength(0);
  });

  it('does not let a preview-mode write through when its Origin denial cannot be written', async () => {
    const target = await audited({ mode: 'preview', storage: 'read-only' });
    const response = await target.app.client.post('/api/v1/fixture/things', {
      json: { name: 'x' },
      origin: FOREIGN,
    });
    expect(response.status).toBe(503);
    expect(target.app.calls.total()).toBe(0);
  });

  it('is a 500, not a 503, when the entry itself is invalid: that is a bug, not a storage failure', async () => {
    const target = await audited({
      hook: (real) => async (c, denial) => {
        await real(c, { ...denial, route: { ...denial.route, id: 'Not An Action' } });
      },
    });
    const response = await target.app.client.post('/api/v1/fixture/things', {
      json: { name: 'x' },
    });
    expect(response.status).toBe(500);
    expect((await readJson<{ code: string }>(response)).code).toBe('internal_error');
    expect(target.app.calls.total()).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// What the entry and the log must not hold
// ---------------------------------------------------------------------------------------------

describe('the detail and the log hold no body, no secret and no address (FR-A-073, FR-A-074)', () => {
  it('keeps a canary body, header, cookie and query string out of the audit table', async () => {
    const target = await audited();
    const canary = 'canary-5d7e21';
    await target.app.client.post(`/api/v1/fixture/things?token=${canary}`, {
      json: { name: canary },
      headers: {
        cookie: `session=${canary}`,
        authorization: `Bearer ${canary}`,
        'x-api-key': canary,
      },
    });
    await target.app.client.post('/api/v1/fixture/things', {
      json: { name: canary },
      origin: FOREIGN,
    });
    await target.app.client.post('/api/v1/fixture/things', {
      json: { name: canary },
      csrf: 'none',
    });
    expect(target.rows()).toHaveLength(3);
    expect(JSON.stringify(target.rows())).not.toContain(canary);
    for (const row of target.rows()) {
      expect(Object.keys(detailOf(row)).sort()).toEqual(['method', 'permission', 'route']);
    }
  });

  it('keeps the client address out of the log; only the head { seq, hash } is logged', async () => {
    const target = await audited();
    const logs = createLogCapture();
    setAuditHeadLog(createLogger({ level: 'debug', destination: logs, now: () => 0 }));
    onTestFinished(() => {
      clearAuditHeadLog();
    });
    await target.from('203.0.113.7').post('/api/v1/fixture/things', { json: { name: 'x' } });
    await target
      .from('203.0.113.7')
      .post('/api/v1/fixture/things', { json: { name: 'x' }, origin: FOREIGN });
    const everything = `${target.app.logs.text()}${logs.text()}`;
    expect(everything).not.toContain('203.0.113.7');
    expect(everything).not.toContain('127.0.0.1');
    const heads = logs.lines();
    expect(heads).toHaveLength(2);
    for (const line of heads) {
      expect(line.seq).toEqual(expect.any(Number));
      expect(line.hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The negative fixtures
// ---------------------------------------------------------------------------------------------

describe('negative fixtures: the guard fails on an application that does not audit its denials', () => {
  it('passes for the real denial audit', async () => {
    const target = await audited();
    await expect(assertDenialsAudited(target, 'anonymous')).resolves.toBeUndefined();
  });

  it('fails when the hook writes nothing', async () => {
    const target = await audited({ hook: () => () => undefined });
    await expectGuardFails((t: Audited) => assertDenialsAudited(t, 'anonymous'), target, {
      reason: 'no audit row was written',
    });
  });

  it('fails when only permission denials are audited (Origin and CSRF denials are lost)', async () => {
    const target = await audited({
      hook: (real) => async (c, denial) => {
        if (denial.code === 'permission_denied') await real(c, denial);
      },
    });
    await expectGuardFails((t: Audited) => assertDenialsAudited(t, 'anonymous'), target, {
      reason: /(origin_not_allowed|csrf_invalid|no audit row was written)/,
    });
  });

  it('fails when the entry names the wrong action', async () => {
    const target = await audited({
      hook: (real) => async (c, denial) => {
        await real(c, { ...denial, route: { ...denial.route, id: 'something.else' } });
      },
    });
    await expectGuardFails((t: Audited) => assertDenialsAudited(t, 'anonymous'), target, {
      reason: 'audit field action',
    });
  });

  it('fails when the entry leaves out the permission', async () => {
    const target = await audited({
      hook: (real) => async (c, denial) => {
        const route = { id: denial.route.id, method: denial.route.method, path: denial.route.path };
        await real(c, { ...denial, route });
      },
    });
    await expectGuardFails((t: Audited) => assertDenialsAudited(t, 'anonymous'), target, {
      reason: 'audit detail',
    });
  });
});

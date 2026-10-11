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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it, onTestFinished } from 'vitest';
import { defaultPaths } from '../scripts/schema-snapshot.js';
import {
  AUDIT_ACTIONS,
  AUDIT_ACTION_NAMES,
  AUDIT_ACTOR_KINDS,
  AUDIT_ACTOR_KINDS_READABLE,
  AUDIT_DETAIL_KEYS,
  AuditDetailError,
  AuditEntryError,
  DENIAL_REASON_CODES,
  appendAudit,
  buildDetail,
  clearAuditHeadLog,
  setAuditHeadLog,
  verifyChain,
  type AuditDetail,
  type ChainVerdict,
} from '../src/audit/index.js';
import {
  DATABASE_FILE_NAME,
  openDatabase,
  withTransaction,
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

// =============================================================================================
// T-B-013 (FR-B-601 writer half, SB-21, AM-04, CB3, XB10): the Phase B vocabulary of the writer
// =============================================================================================

const SPEC_B_PATH = new URL('../../../specs/002-phase-b/spec.md', import.meta.url);

interface SpecAction {
  readonly name: string;
  readonly targetType: string;
  readonly outcomes: readonly string[];
  readonly actorKinds: readonly string[];
  readonly detailKeys: readonly string[];
}

const withoutNote = (cell: string): string => cell.replace(/\([^)]*\)/g, '');

/** The rows of table 6.9.6 of the Phase B spec. */
function specActions(): SpecAction[] {
  const spec = readFileSync(SPEC_B_PATH, 'utf8');
  const start = spec.indexOf('#### 6.9.6 Audit actions and detail allow-list');
  const end = spec.indexOf('Rules. (1)', start);
  const names = (cell: string): string[] =>
    [...cell.matchAll(/`([a-z_.A-Z0-9]+)`/g)].map((m) => m[1] ?? '');
  const rows: SpecAction[] = [];
  for (const line of spec.slice(start, end).split('\n')) {
    const cells = line.split(/(?<!\\)\|/).map((cell) => cell.trim());
    const name = /^`([a-z_.]+)`$/.exec(cells[1] ?? '')?.[1];
    if (name === undefined || cells.length < 7) continue;
    rows.push({
      name,
      targetType: /`([a-z_]+)`/.exec(cells[2] ?? '')?.[1] ?? '',
      outcomes: names(cells[3] ?? ''),
      // A note in parentheses ("(SB-21: ... at `finish`)") is not part of the list.
      actorKinds: names(withoutNote(cells[4] ?? '')),
      detailKeys: names(withoutNote(cells[5] ?? '')),
    });
  }
  return rows;
}

/** A migrated database in a temporary directory, with the real writer in front of it. */
async function auditDatabase(): Promise<AppDatabase> {
  const dir = await createTempDataDir();
  const database = openDatabase({ path: join(dir.path, DATABASE_FILE_NAME) });
  await runMigrations(database.sqlite, {
    migrationsFolder: PATHS.migrationsFolder,
    backupsDir: join(dir.path, 'backups'),
  });
  onTestFinished(() => {
    if (database.sqlite.open) database.close();
  });
  return database;
}

const TS = '2026-10-10T12:00:00.000Z';

function append(
  database: AppDatabase,
  entry: Partial<Parameters<typeof appendAudit>[1]> & {
    detail?: AuditDetail | Record<string, unknown>;
  },
): void {
  withTransaction(database, (tx) =>
    appendAudit(tx, {
      ts: TS,
      actorKind: 'setup',
      actorId: 'setup',
      action: 'setup.unlock',
      targetType: 'setup',
      targetId: '',
      outcome: 'success',
      ...entry,
    }),
  );
}

describe('the actor kinds of the writer (FR-B-601, DM-05)', () => {
  it('writes anonymous, user, setup, break_glass, system and cli', () => {
    expect([...AUDIT_ACTOR_KINDS]).toEqual([
      'anonymous',
      'user',
      'setup',
      'break_glass',
      'system',
      'cli',
    ]);
  });

  it('keeps preview readable, and out of the write set', () => {
    expect(AUDIT_ACTOR_KINDS).not.toContain('preview');
    expect([...AUDIT_ACTOR_KINDS_READABLE]).toEqual([...AUDIT_ACTOR_KINDS, 'preview']);
  });

  it.each(AUDIT_ACTOR_KINDS)('accepts %s on write', async (kind) => {
    const database = await auditDatabase();
    expect(() => {
      append(database, {
        actorKind: kind,
        actorId: kind === 'user' ? '00000000-0000-4000-8000-000000000001' : kind,
      });
    }).not.toThrow();
  });

  it.each(['admin', 'USER', 'Setup', '', 'break-glass', 'root'])(
    'rejects the kind %j on write',
    async (kind) => {
      const database = await auditDatabase();
      expect(() => {
        append(database, { actorKind: kind as never });
      }).toThrow(AuditEntryError);
    },
  );

  it('still reads a Phase A row written by the preview actor, and the chain still verifies across old and new rows', async () => {
    const database = await auditDatabase();
    // A Phase A install wrote these: a preview row and an anonymous denial with permission_denied.
    append(database, {
      actorKind: 'preview',
      actorId: 'preview',
      action: 'branding.apply',
      targetType: 'branding',
      targetId: '1',
    });
    append(database, {
      actorKind: 'anonymous',
      actorId: 'anonymous',
      action: 'branding.apply',
      outcome: 'denied',
      reasonCode: 'permission_denied',
      detail: { permission: 'settings:branding', method: 'PUT' },
    });
    append(database, {
      actorKind: 'user',
      actorId: '00000000-0000-4000-8000-000000000001',
      action: 'rbac.assignment.create',
      outcome: 'success',
      targetType: 'rbac_assignment',
      targetId: '00000000-0000-4000-8000-000000000002',
    });
    const kinds = database.sqlite
      .prepare('SELECT actor_kind FROM audit_log ORDER BY seq')
      .all() as { actor_kind: string }[];
    expect(kinds.map((row) => row.actor_kind)).toEqual(['preview', 'anonymous', 'user']);
    for (const row of kinds) expect(AUDIT_ACTOR_KINDS_READABLE).toContain(row.actor_kind);
    expect(verifyChain(database.sqlite)).toMatchObject({ ok: true, checked: 3 });
  });

  // The writer still takes `preview` while the Phase A preview resolver exists (src/config/legacy-preview.ts):
  // the branding service writes it for the preview actor. `T-B-240` deletes the resolver and with it
  // the transitional allowance in `writer.ts`; that task turns this todo into the assertion.
  it.todo(
    'rejects preview on write (T-B-240 removes the transitional allowance TRANSITIONAL_WRITE_KINDS)',
  );
});

describe('the 19 actions of spec 6.9.6 (SB-21, SB-30)', () => {
  const fromSpec = specActions();

  it('are 19 in the spec table and 19 in actions.ts, each declared once', () => {
    expect(fromSpec).toHaveLength(19);
    expect(AUDIT_ACTION_NAMES).toHaveLength(19);
    expect(new Set(AUDIT_ACTION_NAMES).size).toBe(19);
    expect([...AUDIT_ACTION_NAMES].sort()).toEqual(fromSpec.map((row) => row.name).sort());
  });

  it.each(fromSpec.map((row) => [row.name, row] as const))(
    '%s: target, outcomes, actors and detail keys equal the spec row',
    (name, row) => {
      const declared = AUDIT_ACTIONS[name as keyof typeof AUDIT_ACTIONS];
      expect(declared.targetType).toBe(row.targetType);
      expect([...declared.outcomes].sort()).toEqual([...row.outcomes].sort());
      expect([...declared.actorKinds].sort()).toEqual([...row.actorKinds].sort());
      expect([...declared.detailKeys].sort()).toEqual([...row.detailKeys].sort());
    },
  );

  it('every detail key an action uses is on the allow-list, and every actor kind is a write kind', () => {
    for (const declared of Object.values(AUDIT_ACTIONS)) {
      for (const key of declared.detailKeys) expect(AUDIT_DETAIL_KEYS).toHaveProperty(key);
      for (const kind of declared.actorKinds) expect(AUDIT_ACTOR_KINDS).toContain(kind);
    }
  });

  it('every action matches the grammar of the writer and is accepted by it', async () => {
    const database = await auditDatabase();
    for (const name of AUDIT_ACTION_NAMES) {
      const declared = AUDIT_ACTIONS[name];
      expect(() => {
        append(database, {
          action: name,
          actorKind: declared.actorKinds[0],
          actorId: declared.actorKinds[0] === 'user' ? '00000000-0000-4000-8000-000000000001' : 'x',
          targetType: declared.targetType,
          targetId: '',
          outcome: declared.outcomes[0],
        });
      }, name).not.toThrow();
    }
    expect(verifyChain(database.sqlite)).toMatchObject({ ok: true, checked: 19 });
  });

  it('the denial reason codes are the Phase A three and the five of Phase B (FR-B-602)', () => {
    expect([...DENIAL_REASON_CODES].sort()).toEqual(
      [
        'csrf_invalid',
        'escalation_denied',
        'last_owner_protected',
        'origin_not_allowed',
        'permission_denied',
        'permission_missing',
        'scope_mismatch',
        'step_up_required',
      ].sort(),
    );
  });

  it.each([
    'permission_missing',
    'scope_mismatch',
    'step_up_required',
    'escalation_denied',
    'last_owner_protected',
  ])('a denial entry accepts the reason code %s', async (reasonCode) => {
    const database = await auditDatabase();
    expect(() => {
      append(database, {
        actorKind: 'user',
        actorId: '00000000-0000-4000-8000-000000000001',
        action: 'rbac.assignment.create',
        outcome: 'denied',
        reasonCode,
        detail: { method: 'POST', route: '/api/v1/rbac/assignments', permission: 'rbac:manage' },
      });
    }).not.toThrow();
  });
});

describe('the 38 new detail keys and their value rules (FR-B-601, DM-02)', () => {
  const GUID = '00000000-0000-4000-8000-0000000000ab';
  const NEW_KEYS = [
    'step',
    'subAction',
    'status',
    'attempt',
    'codes',
    'mode',
    'kind',
    'op',
    'objectId',
    'appId',
    'name',
    'confirmed',
    'tid',
    'fromState',
    'drift',
    'checks',
    'thumbprintSha1',
    'notAfter',
    'rows',
    'fromKeyId',
    'toKeyId',
    'reason',
    'check',
    'mfa',
    'groupsResolved',
    'purpose',
    'scope',
    'sessions',
    'principalType',
    'principalId',
    'role',
    'scopeTargets',
    'scopeItems',
    'expiresAt',
    'source',
    'assignmentId',
    'graphChecked',
    'lockScope',
  ] as const;

  it('are 38 on top of the 26 Phase A keys: 64 in all', () => {
    expect(NEW_KEYS).toHaveLength(38);
    for (const key of NEW_KEYS) expect(AUDIT_DETAIL_KEYS, key).toHaveProperty(key);
    expect(Object.keys(AUDIT_DETAIL_KEYS)).toHaveLength(64);
    expect(new Set(Object.keys(AUDIT_DETAIL_KEYS)).size).toBe(64);
  });

  const VALID: readonly (readonly [key: string, value: unknown])[] = [
    ['objectId', GUID],
    ['appId', GUID],
    ['tid', GUID],
    ['principalId', GUID],
    ['assignmentId', GUID],
    ['thumbprintSha1', 'ab'.repeat(20)],
    ['fromKeyId', 'c743d54d05bd4d72'],
    ['toKeyId', '0123456789abcdef'],
    ['notAfter', '2027-10-10T12:00:00.000Z'],
    ['expiresAt', '2026-12-31T23:59:59.999Z'],
    ['attempt', 3],
    ['rows', 0],
    ['sessions', 12],
    ['scopeItems', 7],
    ['confirmed', true],
    ['mfa', false],
    ['groupsResolved', true],
    ['graphChecked', false],
    ['codes', ['app_role_missing', 'time_skew_warning']],
    ['drift', []],
    ['checks', ['check_v1', 'check_v6']],
    ['scopeTargets', ['group', 'distributionList']],
    ['step', 'configure'],
    ['subAction', 'graph_permissions'],
    ['status', 'warning'],
    ['mode', 'manual'],
    ['kind', 'directory_role_assignment'],
    ['op', 'adopt'],
    ['reason', 'token_invalid'],
    ['check', 'signature'],
    ['purpose', 'signin'],
    ['scope', 'all'],
    ['lockScope', 'client'],
    ['fromState', 'completed'],
    ['source', 'break_glass'],
    ['principalType', 'group'],
    ['role', 'helpdesk'],
    ['name', 'M365Portal — Réunion'],
  ];

  it('are exactly the 38 keys, each with an example', () => {
    expect(VALID.map(([key]) => key).sort()).toEqual([...NEW_KEYS].sort());
  });

  it.each(VALID)('accepts %s = %j', (key, value) => {
    expect(() => buildDetail({ [key]: value })).not.toThrow();
    expect(JSON.parse(buildDetail({ [key]: value }))).toEqual({ [key]: value });
  });

  const INVALID: readonly (readonly [label: string, key: string, value: unknown])[] = [
    ['an upper-case GUID', 'objectId', GUID.toUpperCase()],
    ['a GUID with braces', 'appId', `{${GUID}}`],
    ['a 35-character GUID', 'tid', GUID.slice(1)],
    ['a number for a GUID', 'principalId', 5],
    [
      'a non-GUID id (grants have none, the key is omitted instead)',
      'assignmentId',
      'directory-role-assignment-1',
    ],
    ['an upper-case thumbprint', 'thumbprintSha1', 'AB'.repeat(20)],
    ['a 39-character thumbprint', 'thumbprintSha1', 'ab'.repeat(20).slice(1)],
    ['a SHA-256 in the SHA-1 key', 'thumbprintSha1', 'ab'.repeat(32)],
    ['a 15-character key id', 'fromKeyId', 'c743d54d05bd4d7'],
    ['an upper-case key id', 'toKeyId', 'C743D54D05BD4D72'],
    ['a 32-byte key in the key id', 'fromKeyId', 'ab'.repeat(32)],
    ['an instant without milliseconds', 'notAfter', '2027-10-10T12:00:00Z'],
    ['an instant with an offset', 'expiresAt', '2027-10-10T12:00:00.000+02:00'],
    ['a text for an integer', 'attempt', '3'],
    ['a fraction for an integer', 'rows', 1.5],
    ['a number beyond the safe range', 'sessions', 2 ** 60],
    ['a number for a boolean', 'confirmed', 1],
    ['a text for a boolean', 'mfa', 'true'],
    ['a text for an array', 'codes', 'app_role_missing'],
    ['17 items in an array are cut, not refused (see below)', 'drift', 'x'],
    ['a number in an array', 'checks', [1]],
    ['an enumeration value with upper case', 'reason', 'Token_Invalid'],
    ['an enumeration value with a space', 'op', 'a b'],
    ['an enumeration value of 65 characters', 'purpose', 'a'.repeat(65)],
    ['an empty enumeration value', 'scope', ''],
    ['an enumeration value that starts with a digit', 'lockScope', '1client'],
    ['a step that is not one', 'step', 'launch'],
    ['a sub-action that is not one', 'subAction', 'make_coffee'],
    ['a mode that is not one', 'mode', 'semi'],
    ['a setup state that is not one', 'fromState', 'finished'],
    ['a source that is not one', 'source', 'import'],
    ['a principal type that is not one', 'principalType', 'service'],
    ['a sign-in check that is not one', 'check', 'vibes'],
    ['a name that is not NFC', 'name', 'Réunion'],
    ['a name with a control character', 'name', 'Re\u0007union'],
    ['a name with a newline', 'name', 'line\nbreak'],
    ['a number for a name', 'name', 7],
  ];

  it.each(INVALID.filter(([label]) => !label.includes('are cut')))(
    'rejects %s',
    (_label, key, value) => {
      expect(() => buildDetail({ [key]: value })).toThrow(AuditDetailError);
    },
  );

  it('cuts an array to 16 items of 64 bytes (DM-02) and a name to 256 bytes on a code point', () => {
    const items = Array.from({ length: 20 }, (_, index) => `${'x'.repeat(70)}${String(index)}`);
    const detail = JSON.parse(buildDetail({ codes: items })) as { codes: string[] };
    expect(detail.codes).toHaveLength(16);
    for (const item of detail.codes) expect(Buffer.byteLength(item)).toBeLessThanOrEqual(64);
    const name = JSON.parse(buildDetail({ name: 'é'.repeat(200) })) as { name: string };
    expect(Buffer.byteLength(name.name)).toBeLessThanOrEqual(256);
    expect(name.name).toBe('é'.repeat(128));
  });

  it('never repeats a refused value in the message', () => {
    const canary = 'CANARY-NOT-A-GUID-7f3a';
    let thrown: unknown;
    try {
      buildDetail({ objectId: canary });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AuditDetailError);
    expect((thrown as Error).message).not.toContain('CANARY');
  });

  it('rejects an unknown key, and a key that is named like a secret, by name', () => {
    expect(() => buildDetail({ unknownField: 'x' } as never)).toThrow('is not on the allow-list');
    for (const key of [
      'secret',
      'clientSecret',
      'accessToken',
      'password',
      'apiKey',
      'assertion',
      'privatePem',
      'credential',
      'Token',
      'KEY',
    ]) {
      expect(() => buildDetail({ [key]: 'x' }), key).toThrow(AuditDetailError);
    }
    expect(() => buildDetail({ apiKey: 'x' } as never)).toThrow('named like a secret');
  });

  it('has no secret-named key on the allow-list except the two key ids, by exact name', () => {
    const SECRET_LIKE = /secret|token|key|password|assertion|pem|credential/i;
    const named = Object.keys(AUDIT_DETAIL_KEYS).filter((key) => SECRET_LIKE.test(key));
    expect(named.sort()).toEqual(['fromKeyId', 'toKeyId']);
  });

  it('an unknown key or a wrong value type fails the surrounding transaction and rolls the change back', async () => {
    const database = await auditDatabase();
    for (const detail of [{ unknownField: 'x' }, { objectId: 'not-a-guid' }, { attempt: 'many' }]) {
      expect(() => {
        withTransaction(database, (tx) => {
          tx.sqlite.prepare('UPDATE rbac_epoch SET epoch = 99 WHERE id = 1').run();
          appendAudit(tx, {
            ts: TS,
            actorKind: 'setup',
            actorId: 'setup',
            action: 'setup.step.run',
            outcome: 'success',
            detail: detail as never,
          });
        });
      }).toThrow();
      expect(database.sqlite.prepare('SELECT epoch FROM rbac_epoch').get()).toEqual({ epoch: 0 });
      expect(database.sqlite.prepare('SELECT count(*) AS n FROM audit_log').get()).toEqual({
        n: 0,
      });
    }
  });

  it('keeps a detail within 4,096 bytes (Phase A) with the new keys', () => {
    const many = Array.from({ length: 16 }, (_, index) => `code_${String(index)}`);
    const detail = buildDetail({
      codes: many,
      drift: many,
      checks: many,
      scopeTargets: many,
      name: 'n'.repeat(256),
    });
    expect(Buffer.byteLength(detail)).toBeLessThanOrEqual(4_096);
    expect(JSON.parse(detail)).toHaveProperty('codes');
  });

  // Negative fixtures: the table above is run through a guard, and builders that are wrong in one
  // way each must fail it (tasks.md section 0.3).
  function assertDetailRules(build: (detail: Record<string, unknown>) => string): void {
    for (const [key, value] of VALID) {
      try {
        build({ [key]: value });
      } catch {
        throw new Error(`${key} was refused though it is valid`);
      }
    }
    for (const [label, key, value] of INVALID) {
      if (label.includes('are cut')) continue;
      let refused = false;
      try {
        build({ [key]: value });
      } catch {
        refused = true;
      }
      if (!refused) throw new Error(`${key} was let through: ${label}`);
    }
  }

  it('passes the real builder through the guard', () => {
    expect(() => {
      assertDetailRules((detail) => buildDetail(detail));
    }).not.toThrow();
  });

  it('fails a builder that checks no shape (every value passes)', () => {
    expectGuardFails(assertDetailRules, () => '{}', {
      name: 'detail rules',
      reason: 'was let through',
    });
  });

  it('fails a builder that refuses a valid value', () => {
    const strict = (detail: Record<string, unknown>): string => {
      if ('notAfter' in detail) throw new Error('no instants');
      return buildDetail(detail);
    };
    expectGuardFails(assertDetailRules, strict, {
      name: 'detail rules',
      reason: 'notAfter was refused though it is valid',
    });
  });

  it('fails a builder that accepts an upper-case GUID', () => {
    const loose = (detail: Record<string, unknown>): string => {
      const lowered = Object.fromEntries(
        Object.entries(detail).map(([key, value]) => [
          key,
          typeof value === 'string' && /^[0-9A-F-]{36}$/.test(value) ? value.toLowerCase() : value,
        ]),
      );
      return buildDetail(lowered);
    };
    expectGuardFails(assertDetailRules, loose, {
      name: 'detail rules',
      reason: 'was let through: an upper-case GUID',
    });
  });
});

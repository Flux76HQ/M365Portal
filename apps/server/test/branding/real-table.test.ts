// T-A-092 (s1e-6, s1f-4): the table-driven tests of S1 over the REAL table, with the branding module
// registered. `policy.test.ts` and `audit-integration.test.ts` iterate over the fixture application;
// these tests run the same checks over `buildApp` with the branding module, plus the checks of
// `route-table.test.ts` and `openapi.test.ts` (parity of table, router and document).
//
//   policy        every write route of the table refuses the anonymous actor with 403
//                 `permission_denied` and a handler that is never entered; no write route is public;
//                 the preview actor gets past authorisation on the same routes
//   audit         for every write route and every way to be denied (permission, foreign Origin,
//                 missing Origin, missing token, forged token) exactly one audit row with the fields
//                 of FR-A-034; the chain verifies without a gap
//   route table   the table passes `assertRouteTable`, the router holds exactly what the table says,
//                 and R6 to R15 are all there
//   openapi       the document validates against the 3.1 meta-schema, every route is documented and
//                 every documented route registered; R6 to R15 are in it
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Validator } from '@seriousme/openapi-schema-validator';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it, onTestFinished } from 'vitest';
import { clearAuditHeadLog, setAuditHeadLog, verifyChain } from '../../src/audit/index.js';
import { buildApp, type BuiltApp } from '../../src/app.js';
import { brandingModule } from '../../src/branding/index.js';
import { loadConfigOrThrow } from '../../src/config/index.js';
import { withLegacyPreview } from '../helpers/legacy-preview.js';
import { DATABASE_FILE_NAME, openDatabase, type AppDatabase } from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrate.js';
import { assertOpenApiParity } from '../../src/http/openapi.js';
import {
  assertRouteTable,
  assertRouterMatchesTable,
  registeredRoutesOf,
} from '../../src/http/route-table.js';
import { createReadiness } from '../../src/lifecycle/readiness.js';
import { createStorageProbe } from '../../src/lifecycle/storage-probe.js';
import { createSweeperRegistry } from '../../src/lifecycle/sweepers.js';
import { createLogger } from '../../src/logging/logger.js';
import { requireDatabaseOf, type ModuleDeps } from '../../src/module.js';
import { createFakeClock } from '../helpers/fake-clock.js';
import { requestBodyFor, writeRoutesOf, type WriteRoute } from '../helpers/http-app.js';
import { createHttpClient, readJson, type HttpClient } from '../helpers/http-client.js';
import { createLogCapture } from '../helpers/log-capture.js';
import { createTempDataDir } from '../helpers/temp-data-dir.js';
import { inProcessImages } from './branding-fixture.js';

const SERVER_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WEB = join(SERVER_ROOT, 'test', 'fixtures', 'web-dist');
const MIGRATIONS = join(SERVER_ROOT, 'drizzle');
const ORIGIN = 'http://localhost:9300';
const FOREIGN = 'https://evil.example';

/** What `@hono/node-server` hands the application for a socket peer (see `test-app.ts`). */
const PEER = {
  incoming: {
    socket: { remoteAddress: '127.0.0.1', remotePort: 54_321, remoteFamily: 'IPv4' },
  },
  outgoing: {},
};

interface AuditRow {
  readonly seq: number;
  readonly actor_kind: string;
  readonly actor_id: string;
  readonly action: string;
  readonly outcome: string;
  readonly reason_code: string | null;
  readonly client_ip: string | null;
  readonly request_id: string | null;
  readonly detail: string;
}

interface Real {
  readonly built: BuiltApp;
  readonly client: HttpClient;
  readonly database: AppDatabase;
  rows(): AuditRow[];
}

/** The real `buildApp` with the branding module, started as `startServer` would start it. */
async function buildReal(mode: 'anonymous' | 'preview' = 'anonymous'): Promise<Real> {
  const dir = await createTempDataDir();
  const clock = createFakeClock();
  // Every call a long way after the last one: the rate limiter never runs dry in a long table.
  let monotonic = 0;
  const logs = createLogCapture();
  const log = createLogger({ level: 'debug', destination: logs, now: () => clock.nowMs() });
  const database = openDatabase({ path: join(dir.path, DATABASE_FILE_NAME) });
  await runMigrations(database.sqlite, {
    migrationsFolder: MIGRATIONS,
    backupsDir: join(dir.path, 'backups'),
  });
  setAuditHeadLog(log);
  onTestFinished(() => {
    clearAuditHeadLog();
    if (database.sqlite.open) database.close();
  });
  const readiness = createReadiness({
    now: () => clock.nowMs(),
    probe: createStorageProbe(dir.path),
    database: () => database,
    startFailure: () => undefined,
    migrationsFolder: MIGRATIONS,
  });
  const env = {
    PUBLIC_BASE_URL: ORIGIN,
    DATA_DIR: dir.path,
    ...(mode === 'preview' ? { PREVIEW_MODE: 'true' } : {}),
  };
  const config = withLegacyPreview(loadConfigOrThrow(env), env);
  const handle = (): AppDatabase | undefined => database;
  const shellTemplate = await readFile(join(WEB, 'index.html'), 'utf8');
  const moduleDeps: ModuleDeps = {
    config,
    log,
    now: () => clock.nowMs(),
    database: handle,
    requireDatabase: requireDatabaseOf(handle),
    storageAvailable: () => readiness.storageAvailable(),
    webRoot: WEB,
    shellTemplate,
    sweepers: createSweeperRegistry({ log }),
    isShuttingDown: () => false,
  };
  const module = brandingModule(moduleDeps, {
    images: {
      ...inProcessImages(),
      shutdown: () => Promise.resolve(),
      stats: () => ({ running: 0, queued: 0, started: 0, peakRunning: 0 }),
    },
  });
  await module.start?.(moduleDeps);
  const built = buildApp({
    config,
    log,
    clock: {
      now: () => clock.nowMs(),
      monotonic: () => {
        monotonic += 60_000;
        return monotonic;
      },
    },
    readiness,
    database: handle,
    modules: [module],
    moduleDeps,
    webRoot: WEB,
    shellTemplate,
    shutdown: { isShuttingDown: () => false },
  });
  return {
    built,
    database,
    client: createHttpClient({
      fetch: (request) => built.fetch(request, PEER),
      baseUrl: ORIGIN,
      origin: ORIGIN,
    }),
    rows: () => database.sqlite.prepare('SELECT * FROM audit_log ORDER BY seq').all() as AuditRow[],
  };
}

const BRANDING_WRITE_IDS = [
  'branding.apply',
  'branding.asset.stage',
  'branding.import',
  'branding.reset',
];

describe('the real table (T-A-092): the routes of R6 to R15', () => {
  it('holds the branding routes and exactly the four write routes of the module', async () => {
    const { built } = await buildReal();
    const ids = built.http.table.routes.map((route) => route.id);
    for (const id of [
      'branding.get',
      'branding.apply',
      'branding.reset',
      'branding.asset.stage',
      'branding.export',
      'branding.import',
      'assets.serve',
      'pwa.manifest',
      'pwa.favicon',
      'pwa.appleTouchIcon',
    ]) {
      expect(ids, id).toContain(id);
    }
    expect(
      writeRoutesOf(built)
        .map((route) => route.id)
        .sort(),
    ).toEqual(BRANDING_WRITE_IDS);
  });

  it('the table, the router and the document agree (route-table.test.ts and openapi.test.ts, real table)', async () => {
    const { built } = await buildReal();
    expect(() => {
      assertRouteTable(built.http.table.entries);
    }).not.toThrow();
    expect(() => {
      assertRouterMatchesTable(built.http.table, registeredRoutesOf(built.http.app));
    }).not.toThrow();
    expect(() => {
      assertOpenApiParity({
        document: built.http.document,
        table: built.http.table,
        registered: registeredRoutesOf(built.http.app),
      });
    }).not.toThrow();
    const result = await new Validator().validate(built.http.document as never);
    expect(result.valid).toBe(true);
    const paths = Object.keys(built.http.document.paths ?? {});
    for (const path of [
      '/api/v1/branding',
      '/api/v1/branding/assets',
      '/api/v1/branding/export',
      '/api/v1/branding/import',
      '/branding/{file}',
      '/manifest.webmanifest',
      '/favicon.ico',
      '/apple-touch-icon.png',
    ]) {
      expect(paths, path).toContain(path);
    }
  });

  // Contract sections 4 and 5, status by status: the document must say what the routes answer.
  const CONTRACT_STATUSES: readonly (readonly [string, string, readonly string[]])[] = [
    ['get', '/api/v1/branding', ['200', '429', '503']],
    [
      'post',
      '/api/v1/branding/assets',
      ['200', '201', '403', '409', '413', '415', '422', '429', '503'],
    ],
    ['put', '/api/v1/branding', ['200', '403', '412', '413', '415', '422', '428', '429', '503']],
    ['delete', '/api/v1/branding', ['200', '403', '412', '422', '428', '429', '503']],
    ['get', '/api/v1/branding/export', ['200', '403', '429', '503']],
    [
      'post',
      '/api/v1/branding/import',
      ['200', '403', '412', '413', '415', '422', '428', '429', '503'],
    ],
    ['get', '/branding/{file}', ['200', '304', '404', '429', '503']],
    ['get', '/manifest.webmanifest', ['200', '429']],
    ['get', '/favicon.ico', ['307', '404', '429']],
    ['get', '/apple-touch-icon.png', ['307', '404', '429']],
  ];

  it.each(CONTRACT_STATUSES)(
    'documents every status of the contract for %s %s',
    async (method, path, statuses) => {
      const { built } = await buildReal();
      const item = built.http.document.paths?.[path] as Record<string, { responses: object }>;
      const documented = Object.keys(item[method]?.responses ?? {});
      expect(statuses.filter((status) => !documented.includes(status))).toEqual([]);
    },
  );

  it('negative: a document without the branding upload is found by the parity check', async () => {
    const { built } = await buildReal();
    const trimmed = structuredClone(built.http.document);
    delete (trimmed.paths as Record<string, unknown>)['/api/v1/branding/assets'];
    expectGuardFails(assertOpenApiParity, {
      document: trimmed,
      table: built.http.table,
      registered: registeredRoutesOf(built.http.app),
    });
  });
});

describe('policy over the real table (FR-A-033)', () => {
  it('has no public write route, and refuses each write with 403 permission_denied', async () => {
    const real = await buildReal();
    const routes = writeRoutesOf(real.built);
    expect(routes.filter((route) => route.permission === undefined)).toEqual([]);
    for (const route of routes) {
      const response = await real.client.request(route.method, route.path, requestBodyFor(route));
      expect(response.status, route.id).toBe(403);
      expect((await readJson<{ code?: string }>(response)).code, route.id).toBe(
        'permission_denied',
      );
    }
    // Nothing but denials: the default row's `branding.init` and one denied row per route.
    expect(real.rows().filter((row) => row.outcome === 'denied')).toHaveLength(routes.length);
    expect(
      real.rows().filter((row) => row.action.startsWith('branding.') && row.outcome === 'success'),
    ).toHaveLength(1);
  });

  it('lets the preview actor past authorisation on the same routes (no 403, no denial row)', async () => {
    const real = await buildReal('preview');
    for (const route of writeRoutesOf(real.built)) {
      const response = await real.client.request(route.method, route.path, requestBodyFor(route));
      expect(response.status, route.id).not.toBe(403);
    }
    expect(real.rows().filter((row) => row.outcome === 'denied')).toEqual([]);
  });

  it('negative: a table with a public write route is found by the same check', async () => {
    const real = await buildReal();
    const routes = writeRoutesOf(real.built);
    const publicWrite: WriteRoute = { ...routes[0]!, permission: undefined };
    expectGuardFails(
      (candidate: readonly WriteRoute[]) => {
        const open = candidate.filter((route) => route.permission === undefined);
        if (open.length > 0)
          throw new Error(`public write routes: ${open.map((r) => r.id).join()}`);
      },
      [publicWrite, ...routes.slice(1)],
    );
  });
});

interface Scenario {
  readonly name: string;
  readonly code: 'permission_denied' | 'origin_not_allowed' | 'csrf_invalid';
  readonly applies: (mode: 'anonymous' | 'preview') => boolean;
  readonly options: (route: WriteRoute) => Parameters<HttpClient['request']>[2];
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: 'a missing permission',
    code: 'permission_denied',
    applies: (mode) => mode === 'anonymous',
    options: (route) => requestBodyFor(route),
  },
  {
    name: 'a foreign Origin',
    code: 'origin_not_allowed',
    applies: () => true,
    options: (route) => ({ ...requestBodyFor(route), origin: FOREIGN }),
  },
  {
    name: 'a missing Origin',
    code: 'origin_not_allowed',
    applies: () => true,
    options: (route) => ({ ...requestBodyFor(route), origin: null }),
  },
  {
    name: 'a missing CSRF token',
    code: 'csrf_invalid',
    applies: () => true,
    options: (route) => ({ ...requestBodyFor(route), csrf: 'none' }),
  },
  {
    name: 'a forged CSRF token',
    code: 'csrf_invalid',
    applies: () => true,
    options: (route) => ({
      ...requestBodyFor(route),
      csrf: {
        token:
          'v1.1760000000.1760028800.AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      },
    }),
  },
];

/** The guard of `audit-integration.test.ts`, over a real application. Throws on the first deviation. */
async function assertDenialsAudited(real: Real, mode: 'anonymous' | 'preview'): Promise<void> {
  const routes = writeRoutesOf(real.built);
  if (routes.length === 0) throw new Error('the table has no write route');
  for (const route of routes) {
    for (const scenario of SCENARIOS.filter((candidate) => candidate.applies(mode))) {
      const where = `${route.id} / ${scenario.name}`;
      const before = real.rows().length;
      const response = await real.client.request(route.method, route.path, scenario.options(route));
      const body = await readJson<{ code?: string }>(response);
      if (response.status !== 403 || body.code !== scenario.code) {
        throw new Error(
          `${where}: expected 403 ${scenario.code}, got ${String(response.status)} ${String(body.code)}`,
        );
      }
      const rows = real.rows();
      if (rows.length !== before + 1)
        throw new Error(`${where}: ${String(rows.length - before)} new rows`);
      const row = rows[rows.length - 1]!;
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
            `${where}: audit field ${field} is ${String(row[field as keyof AuditRow])}`,
          );
        }
      }
      const detail = JSON.parse(row.detail) as Record<string, unknown>;
      const wanted = { method: route.method, route: route.template, permission: route.permission };
      if (
        JSON.stringify(Object.entries(detail).sort()) !==
        JSON.stringify(Object.entries(wanted).sort())
      ) {
        throw new Error(`${where}: audit detail is ${row.detail}`);
      }
    }
  }
}

describe.each(['anonymous', 'preview'] as const)(
  'audit integration over the real table, actor %s (FR-A-034, SC-A-009)',
  (mode) => {
    it('audits every denial of every write route, with the fields of FR-A-034', async () => {
      const real = await buildReal(mode);
      await expect(assertDenialsAudited(real, mode)).resolves.toBeUndefined();
    });

    it('leaves a chain that verifies, without a gap, branding.init first', async () => {
      const real = await buildReal(mode);
      await assertDenialsAudited(real, mode);
      const verdict = verifyChain(real.database.sqlite);
      expect(verdict.ok).toBe(true);
      expect(verdict.checked).toBe(real.rows().length);
      expect(real.rows().map((row) => row.seq)).toEqual(
        real.rows().map((_row, index) => index + 1),
      );
      expect(real.rows()[0]?.action).toBe('branding.init');
    });
  },
);

describe('negative: the audit guard fails on a real application that audits nothing', () => {
  it('fails when the denial rows are removed after the fact (a missing row is found)', async () => {
    const real = await buildReal();
    const hidden: Real = { ...real, rows: () => real.rows().slice(0, 1) };
    await expect(assertDenialsAudited(hidden, 'anonymous')).rejects.toThrow(/new rows/);
  });
});

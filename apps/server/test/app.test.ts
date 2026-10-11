// T-A-045: the composition root `buildApp(deps)` (plan 7.2, contract C5 and C6) on the real pieces:
// a migrated database in a temporary data directory, the real readiness, the real routes of the core
// and a fixture module that stands in for the branding module until `T-A-092` registers it.
//
// What is proven here:
//   - the table of the real application: the core routes, the module's routes, the fallbacks in
//     their order, and no write route of the core (Phase A has none: FR-A-033)
//   - the table-driven tests of `policy.test.ts` and `audit-integration.test.ts` over the REAL table
//     (s1e-6): every write route refuses the anonymous actor with 403 and leaves a denial row that
//     verifies, written by the denial audit that `buildApp` wired to the database of the moment
//   - degraded mode (no database): the same denial is the 503 of storage, fail closed
//   - the shell: the module's renderer replaces the placeholder
//   - during shutdown every answer says `Connection: close`
//   - a storage failure that the error handler answers reaches readiness
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished } from 'vitest';
import { z } from 'zod';
import { clearAuditHeadLog, setAuditHeadLog, verifyChain } from '../src/audit/index.js';
import { buildApp, type BuildAppDeps, type BuiltApp } from '../src/app.js';
import { loadConfigOrThrow } from '../src/config/index.js';
import { DATABASE_FILE_NAME, openDatabase, type AppDatabase } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';
import { defineRoute, type RouteDefinition } from '../src/http/route.js';
import { createReadiness } from '../src/lifecycle/readiness.js';
import { createStorageProbe } from '../src/lifecycle/storage-probe.js';
import { createSweeperRegistry } from '../src/lifecycle/sweepers.js';
import { createLogger } from '../src/logging/logger.js';
import { requireDatabaseOf, type AppModule, type ModuleDeps } from '../src/module.js';
import { createPlaceholderShell, type ShellRenderer } from '../src/shell-port.js';
import { createFakeClock } from './helpers/fake-clock.js';
import { requestBodyFor, writeRoutesOf } from './helpers/http-app.js';
import { createHttpClient, readJson } from './helpers/http-client.js';
import { createLogCapture } from './helpers/log-capture.js';
import { createTempDataDir } from './helpers/temp-data-dir.js';

const SERVER_ROOT = fileURLToPath(new URL('../', import.meta.url));
const WEB = join(SERVER_ROOT, 'test', 'fixtures', 'web-dist');
const MIGRATIONS = join(SERVER_ROOT, 'drizzle');
const ORIGIN = 'http://localhost:8080';

const Ok = z.strictObject({ ok: z.literal(true) }).meta({ id: 'AppTestOk' });
const ok = {
  200: { description: 'Done', content: { 'application/json': { schema: Ok } } },
} as const;

/** The routes the branding module will bring, in the shapes it will bring them (contract section 2). */
function fixtureRoutes(): RouteDefinition[] {
  return [
    defineRoute({
      id: 'fixture.thing.create',
      method: 'POST',
      path: '/api/v1/fixture/things',
      access: { permission: 'settings:branding' },
      rateLimit: 'write',
      responses: ok,
      handler: (c) => c.json({ ok: true as const }, 200),
    }),
    defineRoute({
      id: 'fixture.thing.remove',
      method: 'DELETE',
      path: '/api/v1/fixture/things/{id}',
      access: { permission: 'settings:branding' },
      rateLimit: 'write',
      request: { params: z.object({ id: z.string() }) },
      responses: ok,
      handler: (c) => c.json({ ok: true as const }, 200),
    }),
    defineRoute({
      id: 'fixture.thing.read',
      method: 'GET',
      path: '/api/v1/fixture/things',
      access: { public: true },
      rateLimit: 'read',
      responses: ok,
      handler: (c) => c.json({ ok: true as const }, 200),
    }),
  ];
}

interface Built {
  readonly built: BuiltApp;
  readonly database: AppDatabase | undefined;
  readonly dataDir: string;
  readonly shutdown: { current: boolean };
  readonly readiness: ReturnType<typeof createReadiness>;
  readonly clock: ReturnType<typeof createFakeClock>;
  readonly logs: ReturnType<typeof createLogCapture>;
  fetchAs(path: string, init?: RequestInit): Promise<Response>;
}

async function build(
  options: { degraded?: boolean; modules?: readonly AppModule[] } = {},
): Promise<Built> {
  const dir = await createTempDataDir();
  const clock = createFakeClock();
  const logs = createLogCapture();
  const log = createLogger({ level: 'debug', destination: logs, now: () => clock.nowMs() });
  let database: AppDatabase | undefined;
  if (options.degraded !== true) {
    database = openDatabase({ path: join(dir.path, DATABASE_FILE_NAME) });
    await runMigrations(database.sqlite, {
      migrationsFolder: MIGRATIONS,
      backupsDir: join(dir.path, 'backups'),
    });
    setAuditHeadLog(log);
    onTestFinished(() => {
      clearAuditHeadLog();
      if (database?.sqlite.open === true) database.close();
    });
  }
  const readiness = createReadiness({
    now: () => clock.nowMs(),
    probe: createStorageProbe(dir.path),
    database: () => database,
    startFailure: () => (database === undefined ? 'database_unavailable' : undefined),
    migrationsFolder: MIGRATIONS,
  });
  const shutdown = { current: false };
  const config = loadConfigOrThrow({ PUBLIC_BASE_URL: ORIGIN, DATA_DIR: dir.path });
  const handle = (): AppDatabase | undefined => database;
  const moduleDeps: ModuleDeps = {
    config,
    log,
    now: () => clock.nowMs(),
    database: handle,
    requireDatabase: requireDatabaseOf(handle),
    storageAvailable: () => readiness.storageAvailable(),
    webRoot: WEB,
    shellTemplate: '',
    sweepers: createSweeperRegistry({ log }),
    isShuttingDown: () => shutdown.current,
  };
  const modules = options.modules ?? [{ id: 'fixture', routes: fixtureRoutes }];
  const deps: BuildAppDeps = {
    config,
    log,
    clock: { now: () => clock.nowMs(), monotonic: () => clock.nowMs() },
    readiness,
    database: handle,
    modules,
    moduleDeps,
    webRoot: WEB,
    shellTemplate: await readFile(join(WEB, 'index.html'), 'utf8'),
    shutdown: { isShuttingDown: () => shutdown.current },
  };
  const built = buildApp(deps);
  return {
    built,
    database,
    dataDir: dir.path,
    shutdown,
    readiness,
    clock,
    logs,
    fetchAs: (path, init) => Promise.resolve(built.fetch(new Request(new URL(path, ORIGIN), init))),
  };
}

function clientOf(app: Built) {
  return createHttpClient({
    fetch: (request) => app.built.fetch(request),
    baseUrl: ORIGIN,
    origin: ORIGIN,
  });
}

describe('buildApp: the real table', () => {
  it('holds the core routes, the module routes and the two fallbacks, and no core write route', async () => {
    const { built } = await build({ modules: [] });
    const ids = built.http.table.routes.map((route) => route.id).sort();
    expect(ids).toEqual(
      [
        'health.live',
        'health.ready',
        'meta.openapi',
        'meta.me',
        'meta.csrf',
        'meta.robots',
        'pwa.serviceWorker',
      ].sort(),
    );
    expect(built.http.table.fallbacks.map((fallback) => fallback.id)).toEqual([
      'static.assets',
      'shell.html',
      'fallback.notFound',
    ]);
    // FR-A-033: Phase A has no write route in the core; the branding module brings them.
    expect(writeRoutesOf(built)).toEqual([]);
  });

  it('adds the routes of the modules to the table and to the OpenAPI document', async () => {
    const { built } = await build();
    expect(built.http.table.routes.map((route) => route.id)).toContain('fixture.thing.create');
    expect(Object.keys(built.http.document.paths ?? {})).toContain('/api/v1/fixture/things');
  });

  it('answers /healthz with the version, a missing path with a 404 problem and a wrong method with 405', async () => {
    const app = await build();
    const client = clientOf(app);
    const health = await client.get('/healthz');
    expect(health.status).toBe(200);
    expect(await readJson(health)).toMatchObject({ status: 'ok' });
    const missing = await client.get('/api/v1/nope');
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type')).toContain('application/problem+json');
    const wrong = await client.post('/healthz', {});
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get('allow')).toContain('GET');
  });

  it('refuses two modules with one id', async () => {
    await expect(
      build({
        modules: [
          { id: 'x', routes: () => [] },
          { id: 'x', routes: () => [] },
        ],
      }),
    ).rejects.toThrow('two modules are named "x"');
  });

  it('refuses a table that does not hold: a module route that repeats a core id', async () => {
    const clash = defineRoute({
      id: 'health.live',
      method: 'GET',
      path: '/api/v1/clash',
      access: { public: true },
      rateLimit: 'read',
      responses: ok,
      handler: (c) => c.json({ ok: true as const }, 200),
    });
    await expect(build({ modules: [{ id: 'clash', routes: () => [clash] }] })).rejects.toThrow(
      /route table refused/,
    );
  });
});

describe('buildApp: the table-driven checks over the real application (s1e-6)', () => {
  it('every write route refuses the anonymous actor with 403 and audits the denial', async () => {
    const app = await build();
    const routes = writeRoutesOf(app.built);
    expect(routes.map((route) => route.id).sort()).toEqual([
      'fixture.thing.create',
      'fixture.thing.remove',
    ]);
    const client = clientOf(app);
    for (const route of routes) {
      const response = await client.request(route.method, route.path, requestBodyFor(route));
      expect(response.status, route.id).toBe(403);
      expect((await readJson<{ code: string }>(response)).code, route.id).toBe('permission_denied');
    }
    const rows = app.database?.sqlite
      .prepare('SELECT action, outcome, reason_code AS reason FROM audit_log ORDER BY seq')
      .all();
    expect(rows).toEqual(
      routes.map((route) => ({ action: route.id, outcome: 'denied', reason: 'permission_denied' })),
    );
    expect(verifyChain(app.database?.sqlite as never)).toMatchObject({ ok: true, checked: 2 });
  });

  it('a denial written to the log head carries seq and hash and nothing of the request', async () => {
    const app = await build();
    const route = writeRoutesOf(app.built)[0];
    if (route === undefined) throw new Error('no write route');
    await clientOf(app).request(route.method, route.path, requestBodyFor(route));
    const heads = app.logs.lines().filter((line) => line.msg === 'audit_head');
    expect(heads).toHaveLength(1);
    expect(Object.keys(heads[0] ?? {}).sort()).toEqual(['hash', 'level', 'msg', 'seq', 'time']);
  });

  it('in degraded mode the same denial is the 503 of storage, and nothing is written (fail closed)', async () => {
    const app = await build({ degraded: true });
    const route = writeRoutesOf(app.built)[0];
    if (route === undefined) throw new Error('no write route');
    const response = await clientOf(app).request(route.method, route.path, requestBodyFor(route));
    expect(response.status).toBe(503);
    expect((await readJson<{ code: string }>(response)).code).toBe('storage_unavailable');
  });
});

describe('buildApp: shell, shutdown and storage', () => {
  it('serves the placeholder shell, and the shell of a module in its place', async () => {
    const plain = await build({ modules: [] });
    const page = await plain.fetchAs('/', { headers: { accept: 'text/html' } });
    expect(page.status).toBe(200);
    expect(await page.text()).not.toContain('__M365_NONCE__');
    expect(plain.built.shell).toBeDefined();
    expect(createPlaceholderShell('')).toBeDefined();

    const shell: ShellRenderer = {
      render: ({ nonce }) => Promise.resolve(`<!doctype html><b>custom ${nonce}</b>`),
    };
    const custom = await build({ modules: [{ id: 'shell', routes: () => [], shell }] });
    const customPage = await custom.fetchAs('/', { headers: { accept: 'text/html' } });
    expect(await customPage.text()).toContain('<b>custom ');
  });

  it('adds Connection: close to every answer once shutdown has begun, and not before', async () => {
    const app = await build();
    expect((await app.fetchAs('/healthz')).headers.get('connection')).toBeNull();
    app.shutdown.current = true;
    for (const path of ['/healthz', '/readyz', '/api/v1/nope', '/robots.txt']) {
      expect((await app.fetchAs(path)).headers.get('connection'), path).toBe('close');
    }
  });

  it('/api/v1/me follows readiness: storageAvailable turns false when the data directory goes', async () => {
    const app = await build();
    const before = await readJson<{ storageAvailable: boolean }>(await app.fetchAs('/api/v1/me'));
    expect(before.storageAvailable).toBe(true);
    await rm(app.dataDir, { recursive: true });
    app.clock.advance(2000);
    const after = await readJson<{ storageAvailable: boolean }>(await app.fetchAs('/api/v1/me'));
    expect(after.storageAvailable).toBe(false);
    expect((await app.fetchAs('/readyz')).status).toBe(503);
  });
});

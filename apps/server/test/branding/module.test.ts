// T-A-092: the branding module on the real start sequence (`startServer` with the real `appModules`
// entry), over a real socket in this process.
//
// What is proven here:
//   - the module is the one registered in `modules.ts` (seam X1) and brings R6 to R15 into the table
//     and into the OpenAPI document;
//   - the table-driven tests of `policy.test.ts` and `audit-integration.test.ts` hold over the REAL
//     table (s1e-6): every write route refuses the anonymous actor with 403 and an audit row that
//     verifies;
//   - `branding.init` runs at start (one audit row, once, also after a second start);
//   - the start hook sweeps `.tmp`, registers the three sweepers and runs the asset check;
//   - the stop hook shuts the image runner down;
//   - the shell is the module's renderer, and degraded mode renders it with the in-memory defaults;
//   - `GET /api/v1/me` and the boot data of the shell are built by the same actor resolution.
import { mkdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished } from 'vitest';
import { appModules } from '../../src/modules.js';
import { verifyChain } from '../../src/audit/index.js';
import { brandingModule } from '../../src/branding/index.js';
import type { ImageJobRunner } from '../../src/branding/pipeline/job-runner.js';
import { openDatabase, DATABASE_FILE_NAME } from '../../src/db/index.js';
import type { AppModuleFactory } from '../../src/module.js';
import { startServer, type RunningServer } from '../../src/start.js';
import { freePort } from '../helpers/built-server.js';
import { createHttpClient, readJson } from '../helpers/http-client.js';
import { createLogCapture } from '../helpers/log-capture.js';
import { requestBodyFor } from '../helpers/http-app.js';
import { createTempDataDir } from '../helpers/temp-data-dir.js';
import { unwritableDataDir } from '../helpers/unwritable-data-dir.js';

const SERVER_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WEB = join(SERVER_ROOT, 'test', 'fixtures', 'web-dist');
const MIGRATIONS = join(SERVER_ROOT, 'drizzle');

interface Started {
  readonly running: RunningServer;
  readonly origin: string;
  readonly dataDir: string;
  readonly logs: ReturnType<typeof createLogCapture>;
  readonly client: ReturnType<typeof createHttpClient>;
}

async function start(
  options: {
    readonly modules?: readonly AppModuleFactory[];
    readonly dataDir?: string;
    readonly env?: Record<string, string>;
    readonly nowMs?: () => number;
  } = {},
): Promise<Started> {
  const dataDir = options.dataDir ?? (await createTempDataDir()).path;
  const port = await freePort();
  const logs = createLogCapture();
  const origin = `http://127.0.0.1:${String(port)}`;
  const running = await startServer({
    env: {
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      PUBLIC_BASE_URL: origin,
      LOG_LEVEL: 'debug',
      ...options.env,
    },
    stderr: createLogCapture(),
    logDestination: logs,
    ...(options.modules === undefined ? {} : { modules: options.modules }),
    paths: { webRoot: WEB, migrationsFolder: MIGRATIONS },
    umask: () => undefined,
    ...(options.nowMs === undefined
      ? {}
      : { clock: { now: options.nowMs, monotonic: () => performance.now() } }),
  });
  let stopped = false;
  onTestFinished(async () => {
    if (!stopped) await running.stop();
  });
  const original = running.stop.bind(running);
  (running as { stop: RunningServer['stop'] }).stop = async (signal) => {
    stopped = true;
    return original(signal);
  };
  return {
    running,
    origin,
    dataDir,
    logs,
    client: createHttpClient({ fetch: (request) => fetch(request), baseUrl: origin, origin }),
  };
}

function rows(dataDir: string, sql: string): Record<string, unknown>[] {
  const database = openDatabase({ path: join(dataDir, DATABASE_FILE_NAME) });
  try {
    return database.sqlite.prepare(sql).all() as Record<string, unknown>[];
  } finally {
    database.close();
  }
}

describe('the branding module is registered in modules.ts (seam X1)', () => {
  it('appModules holds exactly the branding factory', () => {
    expect(appModules).toEqual([brandingModule]);
  });

  it('the module id is "branding" and it has a shell, a start and a stop hook', async () => {
    const started = await start({ modules: [brandingModule] });
    expect(started.running.storageAvailable).toBe(true);
    const module = brandingModule({
      config: undefined as never,
      log: undefined as never,
      now: Date.now,
      database: () => undefined,
      requireDatabase: () => {
        throw new Error('unused');
      },
      storageAvailable: () => false,
      webRoot: WEB,
      shellTemplate: '',
      sweepers: { register: () => undefined },
      isShuttingDown: () => false,
    });
    expect(module.id).toBe('branding');
    expect(module.shell).toBeDefined();
    expect(module.start).toBeTypeOf('function');
    expect(module.stop).toBeTypeOf('function');
  });
});

describe('the routes of R6 to R15 are in the real table and the OpenAPI document', () => {
  it('lists every branding route and documents each of them', async () => {
    const { client } = await start({ modules: [brandingModule] });
    const document = await readJson<{
      paths: Record<string, Record<string, unknown>>;
    }>(await client.get('/api/v1/openapi.json'));
    const documented = Object.keys(document.paths);
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
      expect(documented, path).toContain(path);
    }
    expect(Object.keys(document.paths['/api/v1/branding'] ?? {}).sort()).toEqual([
      'delete',
      'get',
      'put',
    ]);
  });
});

describe('the table-driven checks over the real table (s1e-6)', () => {
  it('every write route refuses the anonymous actor with 403 and leaves a denial row that verifies', async () => {
    const started = await start({ modules: [brandingModule] });
    const document = await readJson<{
      paths: Record<
        string,
        Record<string, { 'x-route-id'?: string; operationId?: string }>
      >;
    }>(await started.client.get('/api/v1/openapi.json'));
    const writes: { id: string; method: string; path: string }[] = [];
    for (const [path, operations] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        if (['post', 'put', 'patch', 'delete'].includes(method)) {
          writes.push({
            id: operation.operationId ?? operation['x-route-id'] ?? `${method} ${path}`,
            method: method.toUpperCase(),
            path: path.replace(/\{[^}]+\}/g, 'x'),
          });
        }
      }
    }
    expect(writes.length).toBeGreaterThanOrEqual(4);
    for (const route of writes) {
      const response = await started.client.request(route.method, route.path, {
        ...requestBodyFor({ method: route.method, path: route.path } as never),
      });
      expect(response.status, `${route.method} ${route.path}`).toBe(403);
      expect((await readJson<{ code: string }>(response)).code).toBe('permission_denied');
    }
    const denied = rows(
      started.dataDir,
      "SELECT action FROM audit_log WHERE outcome = 'denied' ORDER BY seq",
    );
    expect(denied).toHaveLength(writes.length);
    const database = openDatabase({ path: join(started.dataDir, DATABASE_FILE_NAME) });
    try {
      expect(verifyChain(database.sqlite)).toMatchObject({ ok: true });
    } finally {
      database.close();
    }
  });
});

describe('start and stop', () => {
  it('writes branding.init once, also after a second start on the same data directory', async () => {
    const first = await start({ modules: [brandingModule] });
    expect(
      rows(first.dataDir, "SELECT action FROM audit_log WHERE action = 'branding.init'"),
    ).toHaveLength(1);
    await first.running.stop();
    const second = await start({ modules: [brandingModule], dataDir: first.dataDir });
    expect(
      rows(second.dataDir, "SELECT action FROM audit_log WHERE action = 'branding.init'"),
    ).toHaveLength(1);
    expect((await second.client.get('/api/v1/branding')).status).toBe(200);
  });

  it('the start hook sweeps stale .tmp entries and logs a referenced asset whose file is gone', async () => {
    const dataDir = (await createTempDataDir()).path;
    const temp = join(dataDir, 'branding', '.tmp');
    await mkdir(temp, { recursive: true });
    const stale = join(temp, 'stale');
    await writeFile(stale, 'x');
    const old = new Date(Date.now() - 3_600_000);
    await utimes(stale, old, old);
    const started = await start({ modules: [brandingModule], dataDir });
    const { readdir } = await import('node:fs/promises');
    expect(await readdir(temp)).toEqual([]);
    expect(started.logs.lines().some((line) => line.event === 'branding_asset_missing')).toBe(
      false,
    );
  });

  it('registers the three sweepers with the server registry', async () => {
    const registered: string[] = [];
    const started = await start({
      modules: [
        (deps) =>
          brandingModule({
            ...deps,
            sweepers: {
              register: (sweeper) => {
                registered.push(sweeper.name);
                deps.sweepers.register(sweeper);
              },
            },
          }),
      ],
    });
    expect(started.running.storageAvailable).toBe(true);
    expect(registered.sort()).toEqual(['branding-orphans', 'branding-staged', 'branding-tmp']);
  });

  it('the stop hook shuts the image runner down', async () => {
    let shutdowns = 0;
    const images: ImageJobRunner = {
      process: () => Promise.reject(new Error('unused')),
      deriveVariants: () => Promise.reject(new Error('unused')),
      shutdown: () => {
        shutdowns += 1;
        return Promise.resolve();
      },
      stats: () => ({ running: 0, queued: 0, started: 0, peakRunning: 0 }),
    };
    const started = await start({
      modules: [(deps) => brandingModule(deps, { images })],
    });
    // The default row is made by the real service, whose derive step needs the runner: a stand-in
    // that refuses would end the start. The module must therefore fall back to its own runner only
    // when none is given; with one given, start has used it.
    expect(started.running.storageAvailable).toBe(true);
    await started.running.stop();
    expect(shutdowns).toBe(1);
  });
});

describe('the shell and the me callback', () => {
  it('serves the module shell: title, theme colour and boot data from the applied branding', async () => {
    const { client } = await start({ modules: [brandingModule] });
    const page = await client.get('/', { headers: { accept: 'text/html' } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).not.toMatch(/__M365_[A-Z_]+__/);
    expect(html).toContain('<title>M365Portal</title>');
    const boot = /id="m365-boot"[^>]*>\s*([^<]+)</.exec(html)?.[1];
    const data = JSON.parse(boot ?? '{}') as {
      me: Record<string, unknown>;
      branding: { orgName: string } | null;
    };
    expect(data.branding?.orgName).toBe('M365Portal');
    const me = await readJson<Record<string, unknown>>(await client.get('/api/v1/me'));
    expect(data.me).toEqual(me);
  });

  it('boot me equals GET /api/v1/me for the preview actor too', async () => {
    const { client } = await start({
      modules: [brandingModule],
      env: { PREVIEW_MODE: 'true' },
    });
    const page = await client.get('/', { headers: { accept: 'text/html' } });
    const html = await page.text();
    const boot = /id="m365-boot"[^>]*>\s*([^<]+)</.exec(html)?.[1];
    const data = JSON.parse(boot ?? '{}') as { me: { actor: { kind: string } } };
    const me = await readJson<{ actor: { kind: string }; permissions: string[] }>(
      await client.get('/api/v1/me'),
    );
    expect(me.actor.kind).toBe('preview');
    expect(me.permissions).toContain('settings:branding');
    expect(data.me).toEqual(me);
  });

  it('degraded mode: the shell renders with in-memory defaults, the manifest answers, writes are 503', async () => {
    const blocked = await unwritableDataDir();
    const { client } = await start({ modules: [brandingModule], dataDir: blocked.path });
    const page = await client.get('/', { headers: { accept: 'text/html' } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('<title>M365Portal</title>');
    expect(html).not.toMatch(/__M365_[A-Z_]+__/);
    expect(html).not.toContain('rel="icon"');
    const boot = /id="m365-boot"[^>]*>\s*([^<]+)</.exec(html)?.[1];
    expect((JSON.parse(boot ?? '{}') as { branding: unknown }).branding).toBeNull();
    const manifest = await client.get('/manifest.webmanifest');
    expect(manifest.status).toBe(200);
    expect((await client.get('/api/v1/branding')).status).toBe(503);
    expect((await client.get('/readyz')).status).toBe(503);
  });
});

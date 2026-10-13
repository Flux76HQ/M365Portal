// T-A-092: the branding module on the real start sequence (`startServer` with the real `appModules`
// entry), over a real socket in this process.
//
// What is proven here:
//   - the module is the one registered in `modules.ts` (seam X1) and brings R6 to R15 into the table
//     and into the OpenAPI document;
//   (the table-driven policy and audit checks over the real table are in `real-table.test.ts`);
//   - `branding.init` runs at start (one audit row, once, also after a second start);
//   - the start hook sweeps `.tmp`, registers the three sweepers and runs the asset check;
//   - the stop hook shuts the image runner down;
//   - the shell is the module's renderer, and degraded mode renders it with the in-memory defaults;
//   - `GET /api/v1/me` and the boot data of the shell are built by the same actor resolution.
//   The writes are made by a signed-in user (rows written to the live database), not by a preview actor.
import { mkdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished } from 'vitest';
import { appModules } from '../../src/modules.js';
import { rbacModule } from '../../src/rbac/module.js';
import { brandingModule } from '../../src/branding/index.js';
import {
  createImageJobRunner,
  type ImageJobRunner,
} from '../../src/branding/pipeline/job-runner.js';
import { openDatabase, DATABASE_FILE_NAME } from '../../src/db/index.js';
import type { AppModule, AppModuleFactory } from '../../src/module.js';
import { startServer, type RunningServer } from '../../src/start.js';
import { freePort } from '../helpers/built-server.js';
import { createHttpClient, readJson } from '../helpers/http-client.js';
import { createLogCapture } from '../helpers/log-capture.js';
import { seedSession, type SeedSessionOptions } from '../helpers/signed-in.js';
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
    /** Sign a user in (rows in the database, a cookie on the client), as the sign-in would. */
    readonly signedIn?: SeedSessionOptions;
  } = {},
): Promise<Started> {
  const dataDir = options.dataDir ?? (await createTempDataDir()).path;
  const port = await freePort();
  const logs = createLogCapture();
  const socket = `http://127.0.0.1:${String(port)}`;
  // Phase B: PUBLIC_BASE_URL is https or http://localhost (FR-B-103); the socket stays on 127.0.0.1.
  const origin = `http://localhost:${String(port)}`;
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
  // The session of a signed-in user is a row the server reads on every request, so it can be written
  // to the live database through a second connection.
  let headers: Record<string, string> = {};
  if (options.signedIn !== undefined && running.storageAvailable) {
    const database = openDatabase({ path: join(dataDir, DATABASE_FILE_NAME) });
    try {
      headers = { ...seedSession(database, origin, options.signedIn).headers };
    } finally {
      database.close();
    }
  }
  return {
    running,
    origin,
    dataDir,
    logs,
    client: createHttpClient({
      fetch: (request) => fetch(request),
      baseUrl: socket,
      origin,
      headers,
    }),
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
  it('appModules holds the branding factory first, then the Phase B modules in their fixed order, directory (Phase C), then the three modules of Phase D step D1', () => {
    expect(appModules[0]).toBe(brandingModule);
    expect(appModules).toHaveLength(10);
  });

  it('the module id is "branding" and it has a shell, a start and a stop hook', async () => {
    let built: AppModule | undefined;
    await start({
      modules: [
        (deps) => {
          built = brandingModule(deps);
          return built;
        },
      ],
    });
    expect(built?.id).toBe('branding');
    expect(built?.shell).toBeDefined();
    expect(built?.start).toBeTypeOf('function');
    expect(built?.stop).toBeTypeOf('function');
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

  it('the start hook logs a referenced file that is gone and still starts (branding_asset_missing)', async () => {
    const first = await start({ modules: [brandingModule] });
    await first.running.stop();
    const { readdir, rm } = await import('node:fs/promises');
    const files = (await readdir(join(first.dataDir, 'branding'))).filter((name) =>
      name.endsWith('.png'),
    );
    expect(files.length).toBeGreaterThan(0);
    await rm(join(first.dataDir, 'branding', files[0] ?? ''));
    const second = await start({ modules: [brandingModule], dataDir: first.dataDir });
    expect(
      second.logs.lines().filter((line) => line.event === 'branding_asset_missing'),
    ).toHaveLength(1);
    expect((await second.client.get('/readyz')).status).toBe(200);
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
    const real = createImageJobRunner();
    let shutdowns = 0;
    const images: ImageJobRunner = {
      process: (input) => real.process(input),
      deriveVariants: (input) => real.deriveVariants(input),
      shutdown: async () => {
        shutdowns += 1;
        await real.shutdown();
      },
      stats: () => real.stats(),
    };
    const started = await start({ modules: [(deps) => brandingModule(deps, { images })] });
    expect(shutdowns).toBe(0);
    expect(real.stats().started).toBeGreaterThan(0); // the default row was derived by the runner
    await started.running.stop();
    expect(shutdowns).toBe(1);
  });
});

describe('the ETag of the revision stays strong over a real connection that accepts gzip', () => {
  // The compression layer makes any strong ETag weak when it compresses the body. A client that
  // reads `W/"1"` and sends it back in If-Match is refused (422): the contract says the tag is strong.
  // The branding documents are over 1 KiB, so they would be compressed; they are marked no-transform.
  it('GET, PUT and DELETE answer a strong tag, without a content coding', async () => {
    const { client } = await start({
      modules: [brandingModule, rbacModule],
      signedIn: { roles: ['admin'] },
    });
    const headers = { 'accept-encoding': 'gzip, br' };
    const read = await client.get('/api/v1/branding', { headers });
    expect(read.headers.get('content-encoding')).toBeNull();
    expect(read.headers.get('etag')).toBe('"1"');
    expect(read.headers.get('cache-control')).toBe('no-store, no-transform');
    const body = (await readJson<Record<string, unknown>>(read)) as {
      orgName: string;
      accent: string;
    };
    const request = { orgName: 'Strong Tag', accent: body.accent, logos: {} as unknown };
    request.logos = { light: null, dark: null, compact: null };
    const put = await client.put('/api/v1/branding', {
      headers: { ...headers, 'if-match': read.headers.get('etag') ?? '' },
      json: request,
    });
    expect(put.status).toBe(200);
    expect(put.headers.get('etag')).toBe('"2"');
    expect(put.headers.get('content-encoding')).toBeNull();
    const del = await client.request('DELETE', '/api/v1/branding', {
      headers: { ...headers, 'if-match': put.headers.get('etag') ?? '' },
    });
    expect(del.status).toBe(200);
    expect(del.headers.get('etag')).toBe('"3"');
    expect(del.headers.get('content-encoding')).toBeNull();
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

  it('boot me equals GET /api/v1/me for a signed-in user too', async () => {
    const { client } = await start({
      modules: [brandingModule, rbacModule],
      signedIn: { roles: ['admin'] },
    });
    const page = await client.get('/', { headers: { accept: 'text/html' } });
    const html = await page.text();
    const boot = /id="m365-boot"[^>]*>\s*([^<]+)</.exec(html)?.[1];
    const data = JSON.parse(boot ?? '{}') as { me: { actor: { kind: string } } };
    const me = await readJson<{ actor: { kind: string }; permissions: string[] }>(
      await client.get('/api/v1/me'),
    );
    expect(me.actor.kind).toBe('user');
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

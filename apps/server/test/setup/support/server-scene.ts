// The wizard behind a real server (T-B-139, T-B-140): `startServer` with the real modules (branding,
// secrets, setup, connection, auth, rbac), a throwaway data directory and APP_KEY, the fake tenant behind
// MSW (shared `fake` and `testClock`), a fake scheduler, and an HTTP client that behaves like the web
// app (Origin and CSRF on writes). Everything the server asks the time is `testClock`.
//
// Time: MSAL polls with the global timers. A test that runs the device sign-in calls `useWizardTimers()`
// in `beforeEach`, and `drive()` lets time pass in one-second steps (the clock, the scheduler and the
// timers together) while the run is active. A test that only calls routes needs no fake timers.
//
// Test support: nothing under `src/` imports it.
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cookieNames } from '@m365portal/shared/auth/cookies';
import { onTestFinished, vi } from 'vitest';
import { databasePathOf, openDatabase, type AppDatabase } from '../../../src/db/index.js';
import type { ModuleDeps } from '../../../src/module.js';
import { startServer, type RunningServer } from '../../../src/start.js';
import { installFakeEntra, type FakeEntra } from '../../fakes/fake-tenant/entra/index.js';
import { installFakeExchange, type FakeExchange } from '../../fakes/fake-tenant/exchange/index.js';
import { installFakeGraph, type FakeGraph } from '../../fakes/fake-tenant/graph/index.js';
import { freePort } from '../../helpers/built-server.js';
import { createFakeScheduler, type FakeScheduler } from '../../helpers/fake-scheduler.js';
import { createHttpClient, type HttpClient } from '../../helpers/http-client.js';
import { createLogCapture, type LogCapture } from '../../helpers/log-capture.js';
import { createTempDataDir } from '../../helpers/temp-data-dir.js';
import { fake, testClock } from '../../support/msw.js';

const SERVER_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const WEB = join(SERVER_ROOT, 'test', 'fixtures', 'web-dist');
const MIGRATIONS = join(SERVER_ROOT, 'drizzle');

export interface WizardServerOptions {
  readonly env?: Record<string, string>;
  /** Default true: the Exchange service principal exists in the fake tenant. */
  readonly exchange?: boolean;
  /** Called with the fake tenant before the server starts. */
  readonly beforeStart?: (world: { graph: FakeGraph; entra: FakeEntra; exchange: FakeExchange }) => void;
  /** A data directory to reuse (a restart over the same data). */
  readonly dataDir?: string;
  /** Default true. Fake timers are the test file's business (`useWizardTimers`). */
  readonly keepRunningAfterTest?: boolean;
}

export interface WizardServer {
  readonly running: RunningServer;
  readonly origin: string;
  readonly socket: string;
  readonly dataDir: string;
  readonly logs: LogCapture;
  readonly scheduler: FakeScheduler;
  readonly world: {
    readonly graph: FakeGraph;
    readonly entra: FakeEntra;
    readonly exchange: FakeExchange;
    readonly tenantId: string;
    readonly admin: { readonly id: string; readonly userPrincipalName: string };
  };
  readonly deps: () => ModuleDeps;
  /** The setup token the server wrote (or `undefined`). Read from the file, as the CLI does. */
  token(): string | undefined;
  /** A client that sends these headers (a `cookie`), with Origin and CSRF handled for writes. */
  client(headers?: Readonly<Record<string, string>>): HttpClient;
  /** Unlock with the file token: the cookie headers of the new setup session. */
  unlock(): Promise<{ headers: Record<string, string>; client: HttpClient; value: string }>;
  /** Read the database through a connection of the test. */
  query<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[];
  /** Run a statement through a connection of the test. */
  exec(sql: string, ...params: unknown[]): void;
  database(): AppDatabase;
  /** Let `ms` pass: the clock, the scheduler and (when faked) the global timers. */
  advance(ms: number): Promise<void>;
  /**
   * Drive the current run to its end: approve the device sign-in when the panel shows it, then let one
   * second pass at a time (at most `maxSeconds`) until no run is active or `until` says stop.
   */
  drive(options?: { maxSeconds?: number; until?: () => boolean; approve?: boolean }): Promise<void>;
  auditRows(): { seq: number; actor_kind: string; actor_id: string; action: string; outcome: string; reason_code: string | null; detail: string }[];
}

async function settle(rounds = 6): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

export async function startWizardServer(options: WizardServerOptions = {}): Promise<WizardServer> {
  const port = await freePort();
  const origin = `http://localhost:${String(port)}`;
  const socket = `http://127.0.0.1:${String(port)}`;
  const dataDir = options.dataDir ?? (await createTempDataDir()).path;

  const graph = installFakeGraph(fake);
  const entra = installFakeEntra(fake, graph.world);
  const exchange = installFakeExchange(fake, graph.world);
  if (options.exchange === false) graph.directory.removeExchangeServicePrincipal();
  const admin = graph.directory.addUser({ userPrincipalName: 'admin@contoso-fake.example' });
  entra.control.device.interval(1);
  options.beforeStart?.({ graph, entra, exchange });

  const logs = createLogCapture();
  const scheduler = createFakeScheduler();
  let captured: ModuleDeps | undefined;
  const running = await startServer({
    env: {
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      PUBLIC_BASE_URL: origin,
      APP_KEY: randomBytes(32).toString('base64'),
      LOG_LEVEL: 'debug',
      ...options.env,
    },
    stderr: createLogCapture(),
    logDestination: logs,
    modules: (await import('../../../src/modules.js')).appModules.map((factory) => (deps: ModuleDeps) => {
      captured = deps;
      return factory(deps);
    }),
    paths: { webRoot: WEB, migrationsFolder: MIGRATIONS },
    umask: () => undefined,
    scheduler,
    clock: { now: () => testClock.nowMs(), monotonic: () => performance.now() },
  });
  if (options.keepRunningAfterTest !== true) {
    onTestFinished(async () => {
      await running.stop();
    });
  }

  const handles: AppDatabase[] = [];
  const open = (): AppDatabase => {
    const handle = openDatabase({ path: databasePathOf(dataDir) });
    handles.push(handle);
    return handle;
  };
  onTestFinished(() => {
    for (const handle of handles) if (handle.sqlite.open) handle.close();
  });
  let readerHandle: AppDatabase | undefined;
  const reader = (): AppDatabase => (readerHandle ??= open());

  const client = (headers: Readonly<Record<string, string>> = {}): HttpClient =>
    createHttpClient({ fetch: (request) => fetch(request), baseUrl: socket, origin, headers });
  const deps = (): ModuleDeps => {
    if (captured === undefined) throw new Error('the server has not been built');
    return captured;
  };

  const server: WizardServer = {
    running,
    origin,
    socket,
    dataDir,
    logs,
    scheduler,
    world: { graph, entra, exchange, tenantId: graph.directory.tenantId, admin: { id: admin.id, userPrincipalName: admin.userPrincipalName } },
    deps,
    token: () => {
      try {
        return readFileSync(join(dataDir, 'setup-token'), 'utf8').trim();
      } catch {
        return undefined;
      }
    },
    client,
    unlock: async () => {
      const token = server.token();
      if (token === undefined) throw new Error('there is no setup token');
      const response = await client().post('/api/v1/setup/unlock', { json: { token } });
      if (response.status !== 200) throw new Error(`unlock answered ${String(response.status)}`);
      const setCookie = response.headers.get('set-cookie') ?? '';
      const name = cookieNames(origin).setup;
      const match = new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=([A-Za-z0-9_-]+)`).exec(setCookie);
      const value = match?.[1] ?? '';
      const headers = { cookie: `${name}=${value}` };
      return { headers, client: client(headers), value };
    },
    query: <T>(sql: string, ...params: unknown[]) => reader().sqlite.prepare(sql).all(...params) as T[],
    exec: (sql, ...params) => {
      reader().sqlite.prepare(sql).run(...params);
    },
    database: open,
    advance: async (ms) => {
      testClock.advance(ms);
      scheduler.advance(ms);
      if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(ms);
      await settle(4);
    },
    drive: async (driveOptions = {}) => {
      const max = driveOptions.maxSeconds ?? 1_500;
      let approved = driveOptions.approve === false;
      const runtimeServices = async () => (await import('../../../src/setup/runtime.js')).setupRuntimeOf(deps());
      const runtime = await runtimeServices();
      await settle(8);
      for (let second = 0; second < max; second += 1) {
        if (!runtime.engine.busy()) break;
        if (driveOptions.until?.() === true) break;
        if (!approved && runtime.services.bootstrap.panel()?.state === 'waiting_for_user') {
          entra.control.device.approve({ user: admin.id });
          approved = true;
        }
        await settle(40);
        await server.advance(1_000);
      }
      await settle(8);
    },
    auditRows: () =>
      reader()
        .sqlite.prepare('SELECT seq, actor_kind, actor_id, action, outcome, reason_code, detail FROM audit_log ORDER BY seq')
        .all() as ReturnType<WizardServer['auditRows']>,
  };
  return server;
}

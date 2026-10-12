// The scene of the sign-in tests (T-B-182 and after): a started server (the real `startServer`) with
// the auth and rbac modules, a stub secrets module that publishes the certificate holder of the
// seeded application, the fake tenant behind MSW (shared `fake` and `testClock`), a pinned tenant, a
// chosen setup state, and a scripted browser. Everything the server asks the time is `testClock`,
// the same clock the fake Entra mints its tokens with, so an ID token and the server agree on "now".
//
// Test support: nothing under `src/` imports it. No token or key outlives the test process.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { onTestFinished } from 'vitest';
import { redirectUris } from '@m365portal/shared/auth/redirect-uri';
import { authModule } from '../../../src/auth/module.js';
import { databasePathOf, openDatabase, type AppDatabase } from '../../../src/db/index.js';
import { runMigrations } from '../../../src/db/migrate.js';
import type { AppModuleFactory, ModuleDeps } from '../../../src/module.js';
import { rbacModule } from '../../../src/rbac/module.js';
import type { SecretsState } from '../../../src/ports/secrets.js';
import { startServer, type RunningServer } from '../../../src/start.js';
import { freePort } from '../../helpers/built-server.js';
import { createFakeScheduler, type FakeScheduler } from '../../helpers/fake-scheduler.js';
import { createHttpClient, type HttpClient } from '../../helpers/http-client.js';
import { createLogCapture, type LogCapture } from '../../helpers/log-capture.js';
import { assign } from '../../helpers/rbac-db.js';
import { createTempDataDir } from '../../helpers/temp-data-dir.js';
import { identityWorld, type IdentityWorld } from '../../integrations/identity/support.js';
import { testClock } from '../../support/msw.js';
import { FakeBrowser } from './fake-browser.js';

const SERVER_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const WEB = join(SERVER_ROOT, 'test', 'fixtures', 'web-dist');
const MIGRATIONS = join(SERVER_ROOT, 'drizzle');
const INSTALL_ID = '0123456789abcdef0123456789abcdef';

export type SceneSetupState = 'unconfigured' | 'in_progress' | 'awaiting_first_signin' | 'completed';

export interface SceneOptions {
  /** Default `completed`. */
  readonly state?: SceneSetupState;
  /** Default true: the tenant and the application are pinned. */
  readonly pinned?: boolean;
  /** Default `holder`: the secrets module publishes the certificate holder. */
  readonly secrets?: SecretsState | 'holder';
  /** Give the world's user a role at once. Default `owner`; `false` gives none. */
  readonly role?: string | false;
  readonly env?: Record<string, string>;
  /** More modules after auth and rbac (a test route, a setup stand-in). */
  readonly modules?: readonly AppModuleFactory[];
  /** Default true: the application holds the Graph roles of the sign-in (`User.Read.All`, `GroupMember.Read.All`). */
  readonly grantGraph?: boolean;
  /** Runs before the server starts, with the world (a fault that must exist at the cold start). */
  readonly beforeStart?: (world: IdentityWorld) => void;
  /** Designated Owner of the setup state (an `oid`). */
  readonly designatedOwnerOid?: string;
  /** Called with the migrated database before the server starts. */
  readonly seed?: (db: AppDatabase, world: IdentityWorld) => void;
}

export interface SignInScene {
  readonly running: RunningServer;
  readonly port: number;
  /** `http://localhost:<port>`: the origin the panel believes it has. */
  readonly origin: string;
  readonly dataDir: string;
  readonly world: IdentityWorld;
  readonly scheduler: FakeScheduler;
  readonly logs: LogCapture;
  readonly deps: () => ModuleDeps;
  /** The user of the world, who can sign in. */
  readonly userId: string;
  browser(options?: { readonly forwardedFor?: string }): FakeBrowser;
  /** Read the database through a connection of the test. */
  query<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[];
  /** Run a statement that changes the database through a connection of the test. */
  exec(sql: string, ...params: unknown[]): void;
  /** Open a handle for a helper that needs one; closed after the test. */
  database(): AppDatabase;
  auditRows(): {
    seq: number;
    actor_kind: string;
    actor_id: string;
    action: string;
    outcome: string;
    reason_code: string | null;
    target_id: string | null;
    detail: string;
  }[];
  sessionCount(): number;
  /** An HTTP client that sends these headers (a `cookie`), with Origin and CSRF handled for writes. */
  client(headers?: Readonly<Record<string, string>>): HttpClient;
  /**
   * A full sign-in through the fake Entra for `user` (default: the world's user): returns the browser
   * that holds the session and the headers that carry its cookie.
   */
  signIn(options?: { readonly user?: string; readonly forwardedFor?: string }): Promise<{
    readonly browser: FakeBrowser;
    readonly headers: Record<string, string>;
    readonly sessionId: string;
  }>;
  /** Let `ms` pass on the fake clock, the scheduler and the cookie lifetimes alike. */
  advance(ms: number): void;
}

export async function startSignInScene(options: SceneOptions = {}): Promise<SignInScene> {
  const port = await freePort();
  const origin = `http://localhost:${String(port)}`;
  const uris = redirectUris(origin);
  const world = identityWorld({ redirectUris: [uris.callback, uris.loggedOut] });
  if (options.grantGraph !== false) {
    world.app.grantGraphRole('User.Read.All');
    world.app.grantGraphRole('GroupMember.Read.All');
    world.app.grantGraphRole('Organization.Read.All');
  }
  options.beforeStart?.(world);

  const dir = await createTempDataDir();
  const dbPath = databasePathOf(dir.path);
  const seedDb = openDatabase({ path: dbPath });
  try {
    await runMigrations(seedDb.sqlite, {
      migrationsFolder: MIGRATIONS,
      backupsDir: join(dir.path, 'backups'),
    });
    const state = options.state ?? 'completed';
    seedDb.sqlite
      .prepare(
        `INSERT INTO setup_state (id, state, mode, install_id, designated_owner_oid, completed_at, updated_at)
         VALUES (1, ?, 'automatic', ?, ?, ?, '2026-10-10T12:00:00.000Z')`,
      )
      .run(
        state,
        INSTALL_ID,
        options.designatedOwnerOid ?? null,
        state === 'completed' ? '2026-10-10T12:00:00.000Z' : null,
      );
    if (options.pinned !== false) {
      seedDb.sqlite
        .prepare(
          'INSERT INTO tenant_connection (id, tenant_id, app_id, updated_at) VALUES (1, ?, ?, ?)',
        )
        .run(world.tenantId, world.app.appId, '2026-10-10T12:00:00.000Z');
    }
    if (options.role !== false) {
      assign(seedDb, { principalId: world.user.id, role: options.role ?? 'owner' });
    }
    options.seed?.(seedDb, world);
  } finally {
    seedDb.close();
  }

  const scheduler = createFakeScheduler();
  const logs = createLogCapture();
  let captured: ModuleDeps | undefined;
  const initial: SecretsState =
    options.secrets === undefined || options.secrets === 'holder'
      ? { status: 'ok', holder: world.holder }
      : options.secrets;
  const secretsStub: AppModuleFactory = (deps) => {
    captured = deps;
    return {
      id: 'secrets',
      routes: () => [],
      start: () => {
        deps.secrets.publish(initial);
        return Promise.resolve();
      },
    };
  };
  const running = await startServer({
    env: {
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: dir.path,
      PUBLIC_BASE_URL: origin,
      LOG_LEVEL: 'debug',
      ...options.env,
    },
    stderr: createLogCapture(),
    logDestination: logs,
    modules: [secretsStub, authModule, rbacModule, ...(options.modules ?? [])],
    paths: { webRoot: WEB, migrationsFolder: MIGRATIONS },
    umask: () => undefined,
    scheduler,
    clock: { now: () => testClock.nowMs(), monotonic: () => performance.now() },
  });
  onTestFinished(async () => {
    await running.stop();
  });

  const handles: AppDatabase[] = [];
  const open = (): AppDatabase => {
    const handle = openDatabase({ path: dbPath });
    handles.push(handle);
    return handle;
  };
  onTestFinished(() => {
    for (const handle of handles) if (handle.sqlite.open) handle.close();
  });
  const reader = open();

  const scene: SignInScene = {
    running,
    port,
    origin,
    dataDir: dir.path,
    world,
    scheduler,
    logs,
    deps: () => {
      if (captured === undefined) throw new Error('the server has not been built');
      return captured;
    },
    userId: world.user.id,
    browser: (browserOptions) =>
      new FakeBrowser({
        origin,
        socket: `http://127.0.0.1:${String(port)}`,
        ...(browserOptions?.forwardedFor === undefined
          ? {}
          : { headers: { 'x-forwarded-for': browserOptions.forwardedFor } }),
      }),
    query: <T>(sql: string, ...params: unknown[]) => reader.sqlite.prepare(sql).all(...params) as T[],
    exec: (sql, ...params) => {
      reader.sqlite.prepare(sql).run(...params);
    },
    database: open,
    auditRows: () =>
      reader.sqlite
        .prepare(
          'SELECT seq, actor_kind, actor_id, action, outcome, reason_code, target_id, detail FROM audit_log ORDER BY seq',
        )
        .all() as ReturnType<SignInScene['auditRows']>,
    sessionCount: () =>
      (reader.sqlite.prepare('SELECT count(*) AS n FROM session').get() as { n: number }).n,
    client: (headers = {}) =>
      createHttpClient({
        fetch: (request) => fetch(request),
        baseUrl: `http://127.0.0.1:${String(port)}`,
        origin,
        headers,
      }),
    signIn: async (signInOptions = {}) => {
      if (signInOptions.user !== undefined) world.entra.control.nextSignIn({ user: signInOptions.user });
      const browser = scene.browser(
        signInOptions.forwardedFor === undefined ? {} : { forwardedFor: signInOptions.forwardedFor },
      );
      const login = await browser.navigate('/auth/login', { stopBeforePanel: true });
      const callback = await browser.request(new URL(login.headers.get('location') ?? ''), {
        from: 'microsoft',
      });
      if (callback.status !== 200) {
        throw new Error(`the sign-in did not complete (${callback.headers.get('location') ?? String(callback.status)})`);
      }
      const sessionId = browser.cookie('m365portal_session') ?? '';
      return { browser, headers: { cookie: `m365portal_session=${sessionId}` }, sessionId };
    },
    advance: (ms) => {
      testClock.advance(ms);
      scheduler.advance(ms);
    },
  };
  return scene;
}

/**
 * Runs the server's timers while a request is in flight (the 1 s retry delay and the 10 s timeout of
 * the token endpoint): whenever the server has armed a timer that was not there before the request,
 * one second passes on the fake scheduler. Nothing waits on a wall clock; the loop only yields.
 */
export async function pump<T>(scene: SignInScene, work: Promise<T>, maxSeconds = 15): Promise<T> {
  const baseline = scene.scheduler.pending();
  let done = false;
  const tracked = work.finally(() => {
    done = true;
  });
  let advanced = 0;
  while (!done && advanced < maxSeconds) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (!done && scene.scheduler.pending() > baseline) {
      scene.scheduler.advance(1000);
      advanced += 1;
    }
  }
  return await tracked;
}


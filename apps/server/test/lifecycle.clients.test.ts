// T-B-023, FR-B-714, FR-B-404 (reload), FR-B-108, XB12, CB11: composition part 2 - the clients registry
// on `ModuleDeps`, the JWKS reload at start and every hour, the certificate swap, the sweepers and the
// shutdown. Plan 6.1 step 8: "with secrets available and a pinned `tenant_connection`, build the
// identity, Graph and Exchange clients (`ClientsRegistry`); schedule the hourly JWKS reload and a
// best-effort first reload that never blocks listening."
//
// The secrets module of the product is replaced by a stub that publishes a state (the real one has its
// own tests, `test/secrets/*`); the tenant is the fake tenant behind MSW. Nothing in `app.ts`,
// `index.ts` or `start.ts` builds a concrete Microsoft client: the scan at the end proves it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXCHANGE_ROLES } from '@m365portal/shared/setup/graph-roles';
import { expectGuardFails } from '@m365portal/shared/testing';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { openDatabase, databasePathOf } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate.js';
import type { AppModuleFactory, ModuleDeps } from '../src/module.js';
import { NotConnectedError, SecretsUnavailableError } from '../src/ports/errors.js';
import type { SecretsState } from '../src/ports/secrets.js';
import { startServer, type RunningServer } from '../src/start.js';
import { installFakeExchange } from './fakes/fake-tenant/exchange/index.js';
import { freePort, httpRequest } from './helpers/built-server.js';
import { createFakeScheduler } from './helpers/fake-scheduler.js';
import { createLogCapture } from './helpers/log-capture.js';
import { createTempDataDir } from './helpers/temp-data-dir.js';
import { holderFor, identityWorld, type IdentityWorld } from './integrations/identity/support.js';
import { mountScript, rejectionOf, settle } from './integrations/support.js';
import { createTestCertificate } from './support/test-certificate.js';
import { fake, testClock } from './support/msw.js';

const SERVER_ROOT = fileURLToPath(new URL('../', import.meta.url));
const WEB = join(SERVER_ROOT, 'test', 'fixtures', 'web-dist');
const MIGRATIONS = join(SERVER_ROOT, 'drizzle');
const HOUR = 3_600_000;
const MINUTE = 60_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(testClock.nowMs());
});
afterEach(() => {
  vi.useRealTimers();
});

const keyFetches = (): number =>
  fake.calls.all().filter((call) => call.path.endsWith('/discovery/v2.0/keys')).length;

interface Scene {
  readonly running: RunningServer;
  readonly port: number;
  readonly deps: () => ModuleDeps;
  readonly scheduler: ReturnType<typeof createFakeScheduler>;
  readonly world: IdentityWorld;
  /** What the secrets module "publishes": change it with `swap`. */
  readonly publish: (state: SecretsState) => void;
}

interface SceneOptions {
  readonly secrets?: SecretsState | 'holder';
  readonly pinned?: boolean;
  readonly modules?: readonly AppModuleFactory[];
}

/** A started server over a migrated data directory, with the stub secrets module and the fake tenant. */
async function scene(options: SceneOptions = {}): Promise<Scene> {
  const world = identityWorld();
  world.app.grantGraphRole('Organization.Read.All');
  world.app.grantExchangeRole('Exchange.ManageAsAppV2');
  world.app.assignEntraRole(EXCHANGE_ROLES.exchange_administrator.templateId);
  installFakeExchange(fake, world.graph.world);

  const dir = await createTempDataDir();
  const database = openDatabase({ path: databasePathOf(dir.path) });
  try {
    await runMigrations(database.sqlite, {
      migrationsFolder: MIGRATIONS,
      backupsDir: join(dir.path, 'backups'),
    });
    if (options.pinned !== false) {
      database.sqlite
        .prepare(
          'INSERT INTO tenant_connection (id, tenant_id, app_id, updated_at) VALUES (1, ?, ?, ?)',
        )
        .run(world.tenantId, world.app.appId, '2026-10-10T12:00:00.000Z');
    }
  } finally {
    database.close();
  }

  const scheduler = createFakeScheduler();
  const port = await freePort();
  let captured: ModuleDeps | undefined;
  const initial: SecretsState =
    options.secrets === undefined || options.secrets === 'holder'
      ? { status: 'ok', holder: world.holder }
      : options.secrets;
  const modules: AppModuleFactory[] = [
    (deps) => {
      captured = deps;
      return {
        id: 'secrets',
        routes: () => [],
        start: () => {
          deps.secrets.publish(initial);
          return Promise.resolve();
        },
      };
    },
    ...(options.modules ?? []),
  ];
  const running = await startServer({
    env: {
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: dir.path,
      PUBLIC_BASE_URL: `http://localhost:${String(port)}`,
      LOG_LEVEL: 'debug',
    },
    stderr: createLogCapture(),
    logDestination: createLogCapture(),
    modules,
    paths: { webRoot: WEB, migrationsFolder: MIGRATIONS },
    umask: () => undefined,
    scheduler,
  });
  let stopped = false;
  onTestFinished(async () => {
    if (!stopped) await running.stop();
  });
  return {
    running: {
      ...running,
      stop: async (signal?: string) => {
        stopped = true;
        return running.stop(signal);
      },
    },
    port,
    scheduler,
    world,
    deps: () => {
      if (captured === undefined) throw new Error('the stub module was not built');
      return captured;
    },
    publish: (state) => {
      captured?.secrets.publish(state);
    },
  };
}

describe('the clients registry on ModuleDeps (CB11)', () => {
  it('is there for every module, and builds the Graph, Exchange and identity clients for the pinned tenant', async () => {
    const s = await scene();
    const { clients } = s.deps();
    await expect(clients.graph().getOrganization()).resolves.toMatchObject({
      id: s.world.tenantId,
    });
    await expect(clients.exchange().probe()).resolves.toMatchObject({ status: 'ok' });
    const url = clients.oidc().buildAuthorizeUrl({ state: 's', nonce: 'n', codeChallenge: 'c' });
    expect(url.pathname).toBe(`/${s.world.tenantId}/oauth2/v2.0/authorize`);
    expect(url.searchParams.get('redirect_uri')).toBe(
      `http://localhost:${String(s.port)}/auth/callback`,
    );
    await expect(clients.appTokens().get('graph')).resolves.toBeDefined();
  });

  it('says NotConnectedError for a tenant that is not pinned, and builds nothing at start', async () => {
    const s = await scene({ pinned: false });
    await settle();
    expect(fake.calls.length).toBe(0);
    expect(() => s.deps().clients.graph()).toThrow(NotConnectedError);
    expect(() => s.deps().clients.oidc()).toThrow(NotConnectedError);
  });

  it('says SecretsUnavailableError while the secrets are not usable, and the server still runs (FR-B-108)', async () => {
    const s = await scene({ secrets: { status: 'key_missing' } });
    await settle();
    expect(fake.calls.length).toBe(0);
    expect(() => s.deps().clients.graph()).toThrow(SecretsUnavailableError);
    expect((await httpRequest(s.port, '/healthz')).status).toBe(200);
  });
});

describe('the key set at start and every hour (plan 6.1 step 8, FR-B-404)', () => {
  it('reloads once at start and then every hour on the scheduler of the start', async () => {
    const s = await scene();
    await vi.waitFor(() => {
      expect(keyFetches()).toBe(1);
    });
    s.scheduler.advance(HOUR);
    await vi.waitFor(() => {
      expect(keyFetches()).toBe(2);
    });
    s.scheduler.advance(HOUR);
    await vi.waitFor(() => {
      expect(keyFetches()).toBe(3);
    });
  });

  it('never blocks listening: a key endpoint that does not answer leaves the port open', async () => {
    // The route is mounted first, so it wins over the fake Entra's: the request never gets an answer.
    mountScript('login.microsoftonline.com', 'GET', /\/discovery\/v2\.0\/keys$/, ['hang']);
    const s = await scene();
    expect((await httpRequest(s.port, '/healthz')).status).toBe(200);
    expect(s.running.isShuttingDown()).toBe(false);
  });

  it('a failing reload is logged and does not stop the next one', async () => {
    const s = await scene();
    await vi.waitFor(() => {
      expect(keyFetches()).toBe(1);
    });
    s.world.entra.control.failKeys('unavailable');
    s.scheduler.advance(HOUR);
    await vi.waitFor(() => {
      expect(keyFetches()).toBe(2);
    });
    s.world.entra.control.failKeys(null);
    s.scheduler.advance(HOUR);
    await vi.waitFor(() => {
      expect(keyFetches()).toBe(3);
    });
  });

  it('no timer and no request for a tenant that is not pinned', async () => {
    const s = await scene({ pinned: false });
    s.scheduler.advance(3 * HOUR);
    await settle();
    expect(keyFetches()).toBe(0);
  });
});

describe('a certificate swap (repair, rotation)', () => {
  it('calls reload() when the secrets module publishes a new state: the old token provider is closed at once', async () => {
    const s = await scene();
    const { clients } = s.deps();
    const old = clients.appTokens();
    await old.get('graph');

    const next = createTestCertificate({
      commonName: 'swap',
      notBefore: new Date(testClock.nowMs() - 60_000),
      notAfter: new Date(testClock.nowMs() + 300 * 86_400_000),
      serial: 5,
      keyName: 'lifecycle-swap',
    });
    const application = s.world.graph.directory.applications.get(s.world.app.objectId);
    if (application === undefined) throw new Error('no application');
    application.keyCredentials = [
      s.world.graph.directory.credentialFromUpload({
        key: next.derBase64,
        type: 'AsymmetricX509Cert',
        usage: 'Verify',
        endDateTime: next.notAfter.toISOString(),
      }),
    ];
    s.publish({ status: 'ok', holder: holderFor({ ...s.world.app, certificate: next }) });

    // No accessor was called since the swap: the registry itself dropped the old provider.
    expect(await rejectionOf(old.get('graph', { skipCache: true }))).toBeInstanceOf(
      NotConnectedError,
    );
    const fresh = clients.appTokens();
    expect(fresh).not.toBe(old);
    await expect(fresh.get('graph', { skipCache: true })).resolves.toBeDefined();
  });

  it('goes to "unavailable" when the state turns bad, and back when it is good again', async () => {
    const s = await scene();
    s.publish({ status: 'key_invalid' });
    expect(() => s.deps().clients.graph()).toThrow(SecretsUnavailableError);
    s.publish({ status: 'ok', holder: s.world.holder });
    await expect(s.deps().clients.graph().getOrganization()).resolves.toBeDefined();
  });
});

describe('sweepers and shutdown', () => {
  it('modules register sweepers of their own cadence through ModuleDeps; each runs at its own interval', async () => {
    const runs = { hourly: 0, minute: 0, window: 0 };
    const s = await scene({
      modules: [
        (deps) => ({
          id: 'sweeping',
          routes: () => [],
          start: () => {
            deps.sweepers.register({
              name: 'sessions.expired',
              run: () => void (runs.hourly += 1),
            });
            deps.sweepers.register({
              name: 'login.transactions',
              intervalMs: MINUTE,
              run: () => void (runs.minute += 1),
            });
            deps.sweepers.register({
              name: 'unlock.window',
              intervalMs: 15 * MINUTE,
              run: () => void (runs.window += 1),
            });
            return Promise.resolve();
          },
        }),
      ],
    });
    await settle();
    expect(runs).toEqual({ hourly: 1, minute: 1, window: 1 });
    // A run is asynchronous, so each minute is advanced and settled on its own, as time would pass.
    for (let minute = 1; minute <= 15; minute += 1) {
      s.scheduler.advance(MINUTE);
      await settle();
    }
    expect(runs.minute).toBe(16);
    expect(runs.window).toBe(2);
    expect(runs.hourly).toBe(1);
    for (let minute = 16; minute <= 60; minute += 1) {
      s.scheduler.advance(MINUTE);
      await settle();
    }
    expect(runs.hourly).toBe(2);
  });

  it('shutdown stops the sweepers, the key reload and the token provider', async () => {
    const s = await scene();
    await vi.waitFor(() => {
      expect(keyFetches()).toBe(1);
    });
    const provider = s.deps().clients.appTokens();
    expect(s.scheduler.pending()).toBeGreaterThan(0);
    const code = await s.running.stop();
    expect(code).toBe(0);
    await settle();
    expect(s.scheduler.pending()).toBe(0);
    s.scheduler.advance(5 * HOUR);
    await settle();
    expect(keyFetches()).toBe(1);
    expect(await rejectionOf(provider.get('graph'))).toBeInstanceOf(NotConnectedError);
  });
});

// ---- nothing in the composition root builds a concrete client ----------------------------------------------

function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const CONCRETE =
  /\b(?:createHttpGraphClient|AdminApiExchangeClient|createMsalAppTokenProvider|createTenantProvisioner|createBootstrapAuthenticator|createOidcClient|createTokenEndpoint|createIdTokenValidator)\b/;

function builders(files: readonly { name: string; text: string }[]): string[] {
  return files.filter((file) => CONCRETE.test(code(file.text))).map((file) => file.name);
}

describe('app.ts, index.ts and start.ts build no concrete client (T-B-023)', () => {
  const files = ['app.ts', 'index.ts', 'start.ts'].map((name) => ({
    name,
    text: readFileSync(join(SERVER_ROOT, 'src', name), 'utf8'),
  }));

  it('only the registry is created there', () => {
    expect(builders(files)).toEqual([]);
    expect(code(files.find((file) => file.name === 'start.ts')?.text ?? '')).toContain(
      'createClientsRegistry',
    );
  });

  it('negative: a composition root that builds a Graph client itself is reported', () => {
    expectGuardFails(
      (list: { name: string; text: string }[]) => {
        const found = builders(list);
        if (found.length > 0) throw new Error(`concrete client in ${found.join(', ')}`);
      },
      [{ name: 'app.ts', text: 'const graph = createHttpGraphClient({ appTokens });' }],
      { name: 'composition scan', reason: 'app.ts' },
    );
  });
});

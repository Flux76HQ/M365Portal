// The setup engine over the fake tenant (T-B-131 and after): a migrated in-memory database, the REAL
// secrets module with a throwaway APP_KEY, the REAL clients registry behind MSW, the real sub-actions,
// and a fake Entra/Graph/Exchange world with no application in it yet (the wizard creates it).
//
// Time: the server clock is the shared `testClock` of the fake tenant, the engine's waits run on a fake
// scheduler, and MSAL polls with the global timers, which the test file fakes with Vitest
// (`vi.useFakeTimers({ toFake: [...] })`, see `useWizardTimers`). `elapse` moves all three together.
import { randomBytes } from 'node:crypto';
import { vi } from 'vitest';
import { loadConfig } from '../../../src/config/index.js';
import { withTransaction } from '../../../src/db/tx.js';
import type { AppDatabase } from '../../../src/db/open.js';
import { createClientsRegistry, type ClientsRegistry } from '../../../src/integrations/registry.js';
import { readTenantPin } from '../../../src/integrations/tenant-pin.js';
import { createLogger } from '../../../src/logging/logger.js';
import type { ModuleDeps } from '../../../src/module.js';
import { secretsModule } from '../../../src/secrets/module.js';
import { SecretsRuntime } from '../../../src/secrets/state.js';
import type { SetupServices, SubActionDefinition } from '../../../src/setup/context.js';
import { createSetupEngine, type SetupEngine } from '../../../src/setup/runner.js';
import { createSetupServices } from '../../../src/setup/services.js';
import { subActionRegistry } from '../../../src/setup/steps/index.js';
import { systemRandom } from '../../../src/system-random.js';
import { installFakeEntra, type FakeEntra } from '../../fakes/fake-tenant/entra/index.js';
import { installFakeGraph, type FakeGraph } from '../../fakes/fake-tenant/graph/index.js';
import { installFakeExchange, type FakeExchange } from '../../fakes/fake-tenant/exchange/index.js';
import { createFakeScheduler, type FakeScheduler } from '../../helpers/fake-scheduler.js';
import { createLogCapture, type LogCapture } from '../../helpers/log-capture.js';
import { createMigratedDatabase } from '../../helpers/rbac-db.js';
import { fake, testClock } from '../../support/msw.js';
import { SETUP_ACTOR } from './engine-harness.js';

/** The timers MSAL uses; call in `beforeEach` and `vi.useRealTimers()` in `afterEach`. */
export function useWizardTimers(): void {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
  vi.setSystemTime(testClock.nowMs());
}

async function settle(rounds = 6): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

export interface TenantScene {
  readonly db: AppDatabase;
  readonly deps: ModuleDeps;
  readonly services: SetupServices;
  readonly engine: SetupEngine;
  readonly clients: ClientsRegistry;
  readonly scheduler: FakeScheduler;
  readonly logs: LogCapture;
  readonly world: {
    readonly graph: FakeGraph;
    readonly entra: FakeEntra;
    readonly exchange: FakeExchange;
    readonly tenantId: string;
    readonly admin: { readonly id: string; readonly userPrincipalName: string };
  };
  /** Time passes for the clock, the engine's scheduler and MSAL's timers. */
  elapse(milliseconds: number): Promise<void>;
  /** Start a run as the setup actor. */
  startRun(
    steps: readonly ('connect' | 'configure' | 'verify')[],
    options?: { mode?: 'continue' | 'reconcile'; kind?: 'setup' | 'repair'; exchangeRole?: 'exchange_administrator' | 'exchange_recipient_administrator'; tenantHint?: string; applicationName?: string },
  ): ReturnType<SetupEngine['start']>;
  /**
   * Drive a started run to its end: approve the device sign-in when it is shown, then let time pass in
   * one-second steps (at most `maxSeconds`) until the run is over or `until` says stop.
   */
  drive(options?: { stepMs?: number; approve?: boolean; maxSeconds?: number; until?: () => boolean; user?: string }): Promise<void>;
  /** Start a run and drive it to its end. */
  run(
    steps: readonly ('connect' | 'configure' | 'verify')[],
    options?: Parameters<TenantScene['startRun']>[1] & { approve?: boolean; maxSeconds?: number },
  ): Promise<ReturnType<SetupEngine['current']>>;
  /** Rows of a table, for assertions. */
  rows<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[];
  auditActions(): string[];
}

export async function tenantScene(
  options: {
    exchange?: boolean;
    registry?: readonly SubActionDefinition[];
    env?: Record<string, string>;
    db?: AppDatabase;
    /** Keep the step rows and the state of an earlier scene over the same database. */
    skipInit?: boolean;
  } = {},
): Promise<TenantScene> {
  const db = options.db ?? (await createMigratedDatabase());
  const scheduler = createFakeScheduler();
  const logs = createLogCapture();
  const loaded = loadConfig({
    DATA_DIR: '/tmp/m365portal-tenant-scene',
    PUBLIC_BASE_URL: 'http://localhost:9300',
    APP_KEY: randomBytes(32).toString('base64'),
    ...options.env,
  });
  if (!loaded.ok) throw new Error('the scene configuration is invalid');
  const { config } = loaded;

  const graph = installFakeGraph(fake);
  const entra = installFakeEntra(fake, graph.world);
  const exchange = installFakeExchange(fake, graph.world);
  if (options.exchange === false) graph.directory.removeExchangeServicePrincipal();
  const admin = graph.directory.addUser({ userPrincipalName: 'admin@contoso-fake.example' });
  entra.control.device.interval(1);

  const secrets = new SecretsRuntime(() => db);
  const clients = createClientsRegistry({
    secrets,
    pin: () => readTenantPin(db),
    publicBaseUrl: config.publicOrigin,
    bootstrapClientId: config.bootstrapClientId,
    clock: { now: () => testClock.nowMs() },
    random: systemRandom,
    scheduler,
  });
  secrets.onChange(() => {
    clients.reload();
  });
  const log = createLogger({ level: 'debug', now: () => testClock.nowMs(), destination: logs });
  const deps = {
    config,
    log,
    now: () => testClock.nowMs(),
    database: () => db,
    requireDatabase: () => db,
    storageAvailable: () => true,
    random: systemRandom,
    scheduler,
    secrets,
    clients,
    sweepers: { register: () => undefined },
  } as unknown as ModuleDeps;

  await secretsModule(deps).start?.(deps);
  const holder: { engine?: SetupEngine } = {};
  const services = createSetupServices(deps, {
    onSessionsEmpty: () => {
      holder.engine?.sessionsEnded();
    },
  });
  if (options.skipInit !== true) {
    services.state.ensure(db);
    withTransaction(db, (tx) => {
      services.state.apply(tx, 'unlock');
      services.steps.ensureRows(tx, 'automatic');
    });
  }
  const engine = createSetupEngine({ services, registry: options.registry ?? subActionRegistry() });
  holder.engine = engine;

  const elapse = async (milliseconds: number): Promise<void> => {
    testClock.advance(milliseconds);
    scheduler.advance(milliseconds);
    await vi.advanceTimersByTimeAsync(milliseconds);
    await settle(4);
  };

  const scene: TenantScene = {
    db,
    deps,
    services,
    engine,
    clients,
    scheduler,
    logs,
    world: { graph, entra, exchange, tenantId: graph.directory.tenantId, admin },
    elapse,
    startRun(steps, runOptions = {}) {
      return engine.start(
        {
          steps,
          kind: runOptions.kind ?? 'setup',
          mode: runOptions.mode ?? 'continue',
          ...(runOptions.exchangeRole === undefined ? {} : { exchangeRole: runOptions.exchangeRole }),
          ...(runOptions.tenantHint === undefined ? {} : { tenantHint: runOptions.tenantHint }),
          ...(runOptions.applicationName === undefined ? {} : { applicationName: runOptions.applicationName }),
        },
        SETUP_ACTOR,
      );
    },
    async drive(driveOptions = {}) {
      const stepMs = driveOptions.stepMs ?? 1_000;
      const max = ((driveOptions.maxSeconds ?? 1_500) * 1_000) / stepMs;
      let approved = driveOptions.approve === false;
      await settle(8);
      for (let second = 0; second < max; second += 1) {
        if (!engine.busy()) break;
        if (driveOptions.until?.() === true) break;
        if (!approved && services.bootstrap.panel()?.state === 'waiting_for_user') {
          entra.control.device.approve({ user: driveOptions.user ?? admin.id });
          approved = true;
        }
        // Let the requests in flight finish before the next fake second: the run's pace must not
        // depend on how many macrotasks a fake round trip takes.
        await settle(40);
        if (driveOptions.until?.() === true) break;
        await elapse(driveOptions.stepMs ?? 1_000);
      }
      await settle(8);
    },
    async run(steps, runOptions = {}) {
      scene.startRun(steps, runOptions);
      await scene.drive({
        ...(runOptions.approve === undefined ? {} : { approve: runOptions.approve }),
        ...(runOptions.maxSeconds === undefined ? {} : { maxSeconds: runOptions.maxSeconds }),
      });
      await engine.idle();
      return engine.current();
    },
    rows: <T>(sql: string, ...params: unknown[]) => db.sqlite.prepare(sql).all(...params) as T[],
    auditActions: () =>
      (db.sqlite.prepare('SELECT action FROM audit_log ORDER BY seq').all() as { action: string }[]).map(
        (row) => row.action,
      ),
  };
  return scene;
}

// A setup engine over an in-memory migrated database, a fake clock and a fake scheduler, with the
// sub-actions a test scripts (T-B-129). No Microsoft, no HTTP: the runner's own behaviour.
import type { SetupMode } from '@m365portal/shared/setup/steps';
import { STEPS } from '@m365portal/shared/setup/steps';
import { loadConfig } from '../../../src/config/index.js';
import { withTransaction } from '../../../src/db/tx.js';
import type { AppDatabase } from '../../../src/db/open.js';
import type { SubActionDefinition, SubActionOutcome } from '../../../src/setup/context.js';
import type { ModuleDeps } from '../../../src/module.js';
import { createSetupEngine, type SetupEngine } from '../../../src/setup/runner.js';
import { createSetupServices } from '../../../src/setup/services.js';
import type { SetupServices } from '../../../src/setup/context.js';
import { SecretsRuntime } from '../../../src/secrets/state.js';
import { createFakeClock, type FakeClock } from '../../helpers/fake-clock.js';
import { createFakeScheduler, type FakeScheduler } from '../../helpers/fake-scheduler.js';
import { createLogCapture } from '../../helpers/log-capture.js';
import { createLogger } from '../../../src/logging/logger.js';
import { createMigratedDatabase } from '../../helpers/rbac-db.js';

export const seededRandom = (): { bytes(n: number): Uint8Array; float(): number } => {
  let counter = 0;
  return {
    bytes: (n) => {
      counter += 1;
      return new Uint8Array(n).map((_, i) => (counter * 37 + i * 11) % 256);
    },
    float: () => 0.5,
  };
};

export interface EngineHarness {
  readonly db: AppDatabase;
  readonly clock: FakeClock;
  readonly scheduler: FakeScheduler;
  readonly services: SetupServices;
  readonly engine: SetupEngine;
  readonly deps: ModuleDeps;
  /** Another engine on the same database (a second process). */
  another(registry: readonly SubActionDefinition[]): { engine: SetupEngine; services: SetupServices };
}

export type Script = (ctx: Parameters<SubActionDefinition['run']>[0]) => Promise<SubActionOutcome> | SubActionOutcome;

/** One scripted sub-action per registered (step, sub-action); the default succeeds at once. */
export function scripted(
  scripts: Readonly<Record<string, Script>> = {},
  calls: string[] = [],
): SubActionDefinition[] {
  return Object.values(STEPS).flatMap((definition) =>
    definition.subActions.map(
      (key): SubActionDefinition => ({
        step: definition.key,
        key,
        run: async (ctx) => {
          calls.push(`${definition.key}/${key}`);
          const script = scripts[`${definition.key}/${key}`];
          return script === undefined ? { status: 'succeeded' } : await script(ctx);
        },
      }),
    ),
  );
}

export async function engineHarness(
  options: {
    registry?: readonly SubActionDefinition[];
    mode?: SetupMode;
    state?: 'in_progress' | 'unconfigured';
    env?: Record<string, string>;
    /** Publish a stand-in for the secrets services, so a configure run passes its precondition. */
    withSecrets?: boolean;
  } = {},
): Promise<EngineHarness> {
  const db = await createMigratedDatabase();
  const clock = createFakeClock();
  const scheduler = createFakeScheduler();
  const loaded = loadConfig({
    DATA_DIR: '/tmp/m365portal-engine-harness',
    PUBLIC_BASE_URL: 'http://localhost:9300',
    ...options.env,
  });
  if (!loaded.ok) throw new Error('the harness configuration is invalid');
  const random = seededRandom();
  const logs = createLogCapture();
  const build = (): ModuleDeps => ({
    config: loaded.config,
    log: createLogger({ level: 'debug', now: () => clock.nowMs(), destination: logs }),
    now: () => clock.nowMs(),
    database: () => db,
    requireDatabase: () => db,
    storageAvailable: () => true,
    random,
    scheduler,
    secrets: new SecretsRuntime(() => db),
  } as unknown as ModuleDeps);

  const deps = build();
  if (options.withSecrets !== false) {
    deps.secrets.publish({ status: 'key_missing' }, {} as never);
  }
  const services = createSetupServices(deps);
  services.state.ensure(db);
  withTransaction(db, (tx) => {
    if (options.mode === 'manual') services.state.setMode(tx, 'manual');
    services.state.apply(tx, 'unlock');
    services.steps.ensureRows(tx, options.mode ?? 'automatic');
  });
  const engine = createSetupEngine({ services, registry: options.registry ?? scripted() });
  return {
    db,
    clock,
    scheduler,
    services,
    engine,
    deps,
    another(registry) {
      const otherDeps = build();
      const otherServices = createSetupServices(otherDeps);
      return { services: otherServices, engine: createSetupEngine({ services: otherServices, registry }) };
    },
  };
}

/** Let the microtask queue drain: a run in the background gets to its next await. */
export async function settle(times = 20): Promise<void> {
  for (let n = 0; n < times; n += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

export const SETUP_ACTOR = { kind: 'setup', id: 'setup' } as const;

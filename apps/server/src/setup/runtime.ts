// The runtime both Phase B setup modules share (T-B-139): the services, the one engine and the unlock
// limiter, built once per server (`ModuleDeps`). The setup module registers the routes of the wizard,
// the connection module those of the connection page; both talk to the same engine, so at most one run
// exists (`runner_lease`). The first module that asks builds it.
import type { ModuleDeps } from '../module.js';
import { createSetupServices } from './services.js';
import type { SetupServices } from './context.js';
import { createSetupEngine, type SetupEngine } from './runner.js';
import { subActionRegistry } from './steps/index.js';
import { createUnlockLimiter, type UnlockLimiter } from './unlock-limiter.js';

export interface SetupRuntime {
  readonly deps: ModuleDeps;
  readonly services: SetupServices;
  readonly engine: SetupEngine;
  readonly unlockLimiter: UnlockLimiter;
}

const runtimes = new WeakMap<object, SetupRuntime>();

export function setupRuntimeOf(deps: ModuleDeps): SetupRuntime {
  const existing = runtimes.get(deps);
  if (existing !== undefined) return existing;
  const holder: { engine?: SetupEngine } = {};
  const services = createSetupServices(deps, {
    onSessionsEmpty: () => {
      holder.engine?.sessionsEnded();
    },
  });
  const engine = createSetupEngine({ services, registry: subActionRegistry() });
  holder.engine = engine;
  const runtime: SetupRuntime = {
    deps,
    services,
    engine,
    unlockLimiter: createUnlockLimiter({ now: deps.now }),
  };
  runtimes.set(deps, runtime);
  return runtime;
}

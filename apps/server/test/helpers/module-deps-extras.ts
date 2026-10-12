// The Phase B fields of `ModuleDeps` (T-B-022, T-B-240) for the fixtures that build a `ModuleDeps` by
// hand: randomness, timers, the secrets holder, and the policy ports with the one actor resolver.
// Spread it into the object; a fixture that needs a seeded source, a particular holder or another
// resolver overrides the field after the spread (or passes it in `overrides`).
import type { ModuleDeps } from '../../src/module.js';
import { SecretsRuntime } from '../../src/secrets/state.js';
import { systemScheduler } from '../../src/lifecycle/sweepers.js';
import { systemRandom } from '../../src/app.js';
import { createActorResolver, createPolicyPorts } from '../../src/policy/index.js';

export interface ModuleDepsExtrasOptions {
  /** The origin of `PUBLIC_BASE_URL`, which decides the cookie names. Default `http://localhost:9300`. */
  readonly publicOrigin?: string;
  readonly now?: () => number;
  readonly idleTimeoutMs?: number;
  readonly overrides?: Partial<Pick<ModuleDeps, 'policy' | 'resolveActor'>>;
}

export function moduleDepsExtras(
  database: ModuleDeps['database'] = () => undefined,
  options: ModuleDepsExtrasOptions = {},
): Pick<ModuleDeps, 'random' | 'scheduler' | 'secrets' | 'policy' | 'resolveActor'> {
  const policy = options.overrides?.policy ?? createPolicyPorts();
  return {
    random: systemRandom,
    scheduler: systemScheduler,
    secrets: new SecretsRuntime(database),
    policy,
    resolveActor:
      options.overrides?.resolveActor ??
      createActorResolver({
        publicOrigin: options.publicOrigin ?? 'http://localhost:9300',
        now: options.now ?? ((): number => Date.now()),
        database,
        ports: policy,
        idleTimeoutMs: options.idleTimeoutMs ?? 30 * 60_000,
      }),
  };
}

// The Phase B fields of `ModuleDeps` (T-B-022, T-B-240) for the fixtures that build a `ModuleDeps` by
// hand: randomness, timers, the secrets holder, and the policy ports with the one actor resolver.
// Spread it into the object; a fixture that needs a seeded source, a particular holder or another
// resolver overrides the field after the spread (or passes it in `overrides`).
import type { ModuleDeps } from '../../src/module.js';
import { SecretsRuntime } from '../../src/secrets/state.js';
import { systemScheduler } from '../../src/lifecycle/sweepers.js';
import { systemRandom } from '../../src/app.js';
import { createActorResolver, createPolicyPorts } from '../../src/policy/index.js';
import { createClientsRegistry } from '../../src/integrations/registry.js';

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
): Pick<ModuleDeps, 'random' | 'scheduler' | 'secrets' | 'clients' | 'policy' | 'resolveActor'> {
  const policy = options.overrides?.policy ?? createPolicyPorts();
  const secrets = new SecretsRuntime(database);
  return {
    random: systemRandom,
    scheduler: systemScheduler,
    secrets,
    // No tenant is ever pinned in a fixture: every client says NotConnectedError (or SecretsUnavailableError).
    clients: createClientsRegistry({
      secrets,
      pin: () => undefined,
      publicBaseUrl: options.publicOrigin ?? 'http://localhost:9300',
      bootstrapClientId: '14d82eec-204b-4c2f-b7e8-296a70dab67e',
      clock: { now: options.now ?? ((): number => Date.now()) },
      random: systemRandom,
      scheduler: systemScheduler,
    }),
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

// The fake Entra (T-B-064). In a test:
//
//   const graph = installFakeGraph(fake);                    // the world: directory and tokens
//   const entra = installFakeEntra(fake, graph.world);       // the identity provider over it
//   const app = seedApplication(graph.world, { redirectUris: [callbackUri] });
//   entra.control.defaultSignIn({ user: graph.directory.addUser({ ... }).id });
//
// For long-lived uses (the e2e server), `createFakeEntra` returns the module to pass in
// `createFakeTenant({ modules })`.
import type { FakeTenant, FakeTenantClock } from '../types.js';
import type { FakeWorld } from '../graph/tokens.js';
import { entraModule, type FakeEntra } from './module.js';

export { buildClientAssertion, checkClientAssertion, x5tOf } from './assertion.js';
export type { AssertionRejection, BuildAssertionOptions } from './assertion.js';
export {
  DEVICE_MESSAGE_CANARY,
  HOSTILE_DESCRIPTION,
  entraModule,
  redirectUriMatches,
} from './module.js';
export type { FakeEntra } from './module.js';
export { seedApplication } from './seed.js';
export type { SeedApplicationOptions, SeededApplication } from './seed.js';
export type * from './types.js';

/** The module and its control over a world, not yet mounted. */
export function createFakeEntra(options: { clock: FakeTenantClock; world: FakeWorld }): FakeEntra {
  return entraModule(options.world, options.clock);
}

/** Creates the Entra module over `world` and mounts it on the tenant for the rest of the test. */
export function installFakeEntra(
  tenant: FakeTenant,
  world: FakeWorld,
  options: { clock?: FakeTenantClock } = {},
): FakeEntra {
  const clock = options.clock ?? { now: () => tenant.control.now() };
  const entra = createFakeEntra({ clock, world });
  tenant.mount(entra.module);
  return entra;
}

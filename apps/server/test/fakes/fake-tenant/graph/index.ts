// The fake Graph and the world it shares with the fake Entra and Exchange modules (T-B-065).
//
//   const graph = installFakeGraph(fake);          // in a test: mounts the module, fresh world
//   graph.directory.addUser({ userPrincipalName: 'a@contoso-fake.example' });
//   const token = graph.world.issueAppToken(appId, 'graph');
//
// For the e2e server and other long-lived uses, `createFakeGraph(options)` returns the module to
// pass in `createFakeTenant({ modules })`.
import type { FakeTenant, FakeTenantClock, FakeTenantModule } from '../types.js';
import { graphModule, type FakeGraphControl } from './module.js';
import { createFakeWorld } from './world.js';
import type { FakeWorld } from './tokens.js';
import type { FakeDirectory } from './directory.js';

export { FakeDirectory, ENTRA_ROLE_TEMPLATES, describeCertificate } from './directory.js';
export type * from './directory.js';
export { fakeGuid, isGuidText } from './ids.js';
export { TokenLedger } from './tokens.js';
export type { FakeWorld, IssuedToken, IssueSpec, TokenAudience } from './tokens.js';
export { createFakeWorld } from './world.js';
export { graphModule } from './module.js';
export type { DuplicateGrantMode, FailureSpec, FakeGraphControl, ThrottleSpec } from './module.js';

export interface FakeGraph {
  readonly world: FakeWorld;
  readonly directory: FakeDirectory;
  readonly control: FakeGraphControl;
  readonly module: FakeTenantModule;
}

/** A world and a Graph module over it, not yet mounted. */
export function createFakeGraph(options: {
  clock: FakeTenantClock;
  tenantId?: string;
  world?: FakeWorld;
}): FakeGraph {
  const world =
    options.world ??
    createFakeWorld({
      clock: options.clock,
      ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }),
    });
  const { module, control } = graphModule(world);
  return { world, directory: world.directory, control, module };
}

/** Creates the Graph module and mounts it on the tenant for the rest of the test. */
export function installFakeGraph(
  tenant: FakeTenant,
  options: { clock?: FakeTenantClock; tenantId?: string; world?: FakeWorld } = {},
): FakeGraph {
  const clock = options.clock ?? { now: () => tenant.control.now() };
  const graph = createFakeGraph({
    clock,
    ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }),
    ...(options.world === undefined ? {} : { world: options.world }),
  });
  tenant.mount(graph.module);
  return graph;
}

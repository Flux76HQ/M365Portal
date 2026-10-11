// STUB-MODULE (T-B-014): The secrets module: APP_KEY state, the sealed certificate key, readiness and the degraded mode (T-B-015 to T-B-020).
//
// Owner: S-B1 (Platform).
// The owner replaces this file and removes the marker on the first line; `test/modules.test.ts`
// asserts "no routes, no hooks, no availability" only for a file that still carries it. The module is
// already in `appModules` (`modules.ts`), after branding, in the order secrets, setup, connection,
// auth, rbac, which fixes the order of routes, `start` hooks and `stop` hooks.
import type { AppModule } from '../module.js';

export function secretsModule(): AppModule {
  return { id: 'secrets', routes: () => [] };
}

// STUB-MODULE (T-B-014): The setup module: the gate, unlock, the wizard steps and the runner (T-B-120 and following).
//
// Owner: S-B3 (Setup engine).
// Created by S-B1 at T-B-014 and handed over to S-B3 (Setup engine) at gate GB0 (tasks.md section 1.3).
// The owner replaces this file and removes the marker on the first line; `test/modules.test.ts`
// asserts "no routes, no hooks, no availability" only for a file that still carries it. The module is
// already in `appModules` (`modules.ts`), after branding, in the order secrets, setup, connection,
// auth, rbac, which fixes the order of routes, `start` hooks and `stop` hooks.
import type { AppModule } from '../module.js';

export function setupModule(): AppModule {
  return { id: 'setup', routes: () => [] };
}

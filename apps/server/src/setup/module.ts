// The setup module (T-B-123 to T-B-141): the gate, the unlock, the wizard routes P10 to P18, the setup
// token file, the setup sessions and the engine's lifecycle.
//
// Owner: S-B3 (Setup engine). Created by S-B1 at T-B-014 as a stub and taken over at gate GB0 (tasks.md
// section 1.3); the stub marker is gone.
//
//   factory   registers the setup sessions with the policy layer (the setup actor resolver reads them)
//             and the completion hook with the sign-in callback (`completeSetupInTx`, T-B-141)
//   start     the setup_state row, the step rows, the token file while setup is open (deleted once it is
//             `completed`; never created in degraded mode, because `start` does not run there, EB-33),
//             a sweeper for expired sessions and the unlock bookkeeping
//   stop      the run is cancelled and awaited, every setup session ends, the bootstrap object is dropped
//   gate      `availability.setupOpen` (FR-B-201, FR-B-206, FR-B-207) and the page policy of the SPA
//             fallback (seam XB20, SB-14, SB-26)
import { authHoldersOf } from '../auth/holders.js';
import { withTransaction } from '../db/index.js';
import type { AppModule, ModuleDeps } from '../module.js';
import { createSetupPagePolicy } from './page-policy.js';
import { createCompleteSetupInTx } from './complete.js';
import { setupRoutes } from './routes.js';
import { setupRuntimeOf } from './runtime.js';

export const SETUP_MODULE_ID = 'setup';
const SWEEP_INTERVAL_MS = 60_000;

export function setupModule(deps: ModuleDeps): AppModule {
  const runtime = setupRuntimeOf(deps);
  const { services, engine, unlockLimiter } = runtime;
  deps.policy.setupSessions.set(services.sessions);
  authHoldersOf(deps).completeSetupInTx.set(createCompleteSetupInTx(services));
  const log = deps.log.child({ module: SETUP_MODULE_ID });

  return {
    id: SETUP_MODULE_ID,
    routes: () => setupRoutes(runtime),
    availability: { setupOpen: (request) => services.gate.isOpen(request) },
    pages: createSetupPagePolicy(services.gate, deps),

    async start() {
      const db = deps.requireDatabase();
      services.state.ensure(db);
      const state = services.state.read(db);
      withTransaction(db, (tx) => {
        services.steps.ensureRows(tx, state.mode);
      });
      if (state.state === 'completed') {
        services.token.remove();
        if (deps.config.setupToken !== undefined) {
          log.warn({ event: 'setup_token_after_complete' }, 'setup_token_after_complete');
        }
      } else {
        services.token.ensureFile();
      }
      deps.sweepers.register({
        name: 'setup-sessions',
        intervalMs: SWEEP_INTERVAL_MS,
        run: () => {
          services.sessions.sweep();
          unlockLimiter.prune();
        },
      });
      return Promise.resolve();
    },

    async stop() {
      await engine.stop();
      services.sessions.endAll();
      services.bootstrap.discard('exit');
    },
  };
}

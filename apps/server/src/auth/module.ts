// The auth module (owner: S-B4, Sign-in and sessions; taken over from the stub at GB0): OIDC sign-in,
// sessions, step-up, logout, break-glass and `me`.
//
//   factory   the session store, registered through `ModuleDeps.policy.sessions` (the resolver reads
//             it), the login transactions and the membership port; the routes P01 to P06
//   start     the sweepers: expired login transactions every minute, expired sessions hourly (not in
//             degraded mode: it needs the database)
import { LIMITS } from '@m365portal/shared/limits';
import type { AppModule, ModuleDeps } from '../module.js';
import type { AuthContext } from './context.js';
import { createBreakGlass } from './break-glass.js';
import { authHoldersOf } from './holders.js';
import { createLoginTransactions } from './login-transactions.js';
import { createMembershipPort } from './membership.js';
import { createRevalidator } from './revalidate.js';
import { authRoutes } from './routes.js';
import { createSessions, registerSessionPurge } from './sessions.js';

export const AUTH_MODULE_ID = 'auth';

const TRANSACTION_SWEEP_MS = 60_000;

export function authModule(deps: ModuleDeps): AppModule {
  const log = deps.log.child({ module: AUTH_MODULE_ID });
  const sessions = createSessions(deps);
  const transactions = createLoginTransactions({
    clock: { now: deps.now },
    random: deps.random,
    max: LIMITS.signIn.loginTxMax,
    perClientMax: LIMITS.signIn.loginTxPerClientMax,
  });
  const membership = createMembershipPort(deps);
  const revalidator = createRevalidator({
    database: deps.database,
    now: deps.now,
    ttlMs: deps.config.rbac.groupCacheTtlMs,
    idleTimeoutMs: deps.config.session.idleTimeoutMs,
    publicOrigin: deps.config.publicOrigin,
    graph: () => deps.clients.graph(),
    membership,
    sessions,
    log,
  });
  authHoldersOf(deps).revalidate.set(revalidator.guard);
  const ctx: AuthContext = { deps, log, sessions, transactions, membership, revalidator };
  const breakGlass = createBreakGlass(ctx);
  return {
    id: AUTH_MODULE_ID,
    routes: () => authRoutes(ctx, breakGlass),
    // The break-glass route exists only when the account is configured (FR-B-521).
    availability: { breakGlass: () => breakGlass !== undefined },
    start: () => {
      registerSessionPurge(deps, sessions);
      deps.sweepers.register({
        name: 'login-transactions',
        intervalMs: TRANSACTION_SWEEP_MS,
        run: () => {
          transactions.sweep();
          breakGlass?.prune();
        },
      });
      return Promise.resolve();
    },
  };
}

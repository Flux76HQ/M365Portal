// The auth module (owner: S-B4, Sign-in and sessions; taken over from the stub at GB0): OIDC sign-in, sessions, step-up, logout, break-glass and `me` (S-B4, T-B-181 and
// following). This part: the session store is built and handed to the policy layer (T-B-184); the
// routes (T-B-196) follow with the identity client.
//
//   factory  the session store, registered through `ModuleDeps.policy.sessions` (the resolver reads it)
//   start    the hourly purge of expired sessions (not in degraded mode: it needs the database)
import type { AppModule, ModuleDeps } from '../module.js';
import { createSessions, registerSessionPurge } from './sessions.js';

export const AUTH_MODULE_ID = 'auth';

export function authModule(deps: ModuleDeps): AppModule {
  const sessions = createSessions(deps);
  return {
    id: AUTH_MODULE_ID,
    routes: () => [],
    start: () => {
      registerSessionPurge(deps, sessions);
      return Promise.resolve();
    },
  };
}

// The wiring of the session store (T-B-184, CB10, CB12): build it from the dependencies every module
// gets, hand it to the policy layer through the holder of `ModuleDeps.policy` (the actor resolver reads
// it on every request, SB-32) and register the hourly purge of expired rows. A request that arrives
// before the holder is set is anonymous; the auth module sets it when it is built, before any listens.
import { LIMITS } from '@m365portal/shared/limits';
import type { ModuleDeps } from '../module.js';
import { createSessionStore, type SessionStore } from './session-store.js';

export function createSessions(deps: ModuleDeps): SessionStore {
  const store = createSessionStore({
    database: deps.database,
    clock: { now: deps.now },
    random: deps.random,
    idleTimeoutMs: deps.config.session.idleTimeoutMs,
    absoluteTimeoutMs: deps.config.session.absoluteTimeoutMs,
  });
  deps.policy.sessions.set(store);
  return store;
}

/** Registers the purge with the sweeper registry; it runs at start and then every `SESSION_PURGE_MINUTES`. */
export function registerSessionPurge(deps: ModuleDeps, store: SessionStore): void {
  deps.sweepers.register({
    name: 'sessions',
    intervalMs: LIMITS.session.purgeMinutes * 60_000,
    run: () => {
      store.purgeExpired();
    },
  });
}

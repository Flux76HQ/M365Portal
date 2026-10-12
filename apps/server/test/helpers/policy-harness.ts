// The policy layer with real parts and a fake clock (T-B-240, the base of `signedInAs`, T-B-244): a
// migrated database, the grants service of the rbac module, the actor resolver of the application over
// the real session table, and a small in-memory stand-in for the setup sessions that the setup module
// owns (T-B-125). A test seeds a session the way the session store would write it and gets back the
// cookie a browser would send; the resolver then reads it through the production code path.
//
// This file is test code. The production code builds actors only in `policy/resolvers/`.
import { cookieNames } from '@m365portal/shared/auth/cookies';
import type { ScopeItem } from '@m365portal/shared/rbac/scope';
import type { AppDatabase } from '../../src/db/index.js';
import {
  createActorResolver,
  createPolicyPorts,
  hashSessionId,
  type ActorResolver,
  type PolicyPorts,
} from '../../src/policy/index.js';
import { createGrantsService, type GrantsService } from '../../src/rbac/grants.js';
import { createFakeClock, type FakeClock } from './fake-clock.js';
import { createFakeSetupSessions, type FakeSetupSessions } from './fake-setup-sessions.js';
import { createLogCapture, type LogCapture } from './log-capture.js';
import { createMigratedDatabase } from './rbac-db.js';
import {
  newCookieValue,
  seedSession,
  type SeedSessionOptions,
  type SeededSession,
} from './signed-in.js';
import { createLogger } from '../../src/logging/logger.js';

export const HARNESS_ORIGIN = 'http://localhost:9300';
export const IDLE_TIMEOUT_MS = 30 * 60_000;
const NAMES = cookieNames(HARNESS_ORIGIN);
export { newCookieValue };
export type { SeedSessionOptions, SeededSession };

export interface PolicyHarness {
  readonly db: AppDatabase;
  readonly clock: FakeClock;
  readonly ports: PolicyPorts;
  readonly grants: GrantsService;
  readonly setupSessions: FakeSetupSessions;
  readonly logs: LogCapture;
  readonly resolve: ActorResolver;
  /** Insert a session row (and the `app_user` row of a user) as the session store would. */
  seedSession(options?: SeedSessionOptions): SeededSession;
  /** Register a live setup session in the stand-in store. */
  seedSetupSession(): SeededSession;
  /** End a setup session (the setup completed, or it expired). */
  endSetupSessions(): void;
  /** A request that carries these cookies (and nothing else that could select an actor). */
  request(...sessions: SeededSession[]): Request;
}

export async function createPolicyHarness(
  options: {
    /** What the resolver sees as the database (`undefined`: degraded mode). Default: `db`. */
    readonly database?: () => AppDatabase | undefined;
    /** A migrated database the test already has (the branding fixtures). Default: a fresh one. */
    readonly db?: AppDatabase;
    /** A clock the test already has. Default: a new one. */
    readonly clock?: FakeClock;
  } = {},
): Promise<PolicyHarness> {
  const db = options.db ?? (await createMigratedDatabase());
  const clock = options.clock ?? createFakeClock();
  const ports = createPolicyPorts();
  const logs = createLogCapture();
  const log = createLogger({ level: 'debug', destination: logs, now: () => clock.nowMs() });
  const databaseOf = options.database ?? ((): AppDatabase => db);
  const grants = createGrantsService({ database: databaseOf, now: () => clock.nowMs() });
  ports.grants.set(grants);

  const setupSessions = createFakeSetupSessions(() => clock.iso());
  ports.setupSessions.set(setupSessions);

  const resolve = createActorResolver({
    publicOrigin: HARNESS_ORIGIN,
    now: () => clock.nowMs(),
    database: databaseOf,
    ports,
    idleTimeoutMs: IDLE_TIMEOUT_MS,
    log,
  });

  return {
    db,
    clock,
    ports,
    grants,
    setupSessions,
    logs,
    resolve,
    seedSession(seed = {}) {
      return seedSession(db, HARNESS_ORIGIN, { now: clock.nowMs(), ...seed });
    },
    seedSetupSession() {
      const value = newCookieValue();
      const idHash = hashSessionId(value);
      setupSessions.add(idHash);
      return { value, idHash, oid: '', headers: { cookie: `${NAMES.setup}=${value}` } };
    },
    endSetupSessions() {
      setupSessions.end();
    },
    request(...sessions) {
      const pairs = sessions
        .map((session) => session.headers.cookie)
        .filter((pair) => pair !== undefined);
      return new Request('http://localhost:9300/api/v1/me', {
        headers: pairs.length === 0 ? {} : { cookie: pairs.join('; ') },
      });
    },
  };
}

export type { ScopeItem };

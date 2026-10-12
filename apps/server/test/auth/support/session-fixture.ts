// Fixtures of the session tests (T-B-184 and after): the real session store over a migrated database,
// a fake clock and a seeded random source, registered in the policy ports the way the auth module
// does it, so the production resolver reads what the store wrote.
import { cookieNames } from '@m365portal/shared/auth/cookies';
import {
  createSessionStore,
  type NewSession,
  type SessionStore,
} from '../../../src/auth/session-store.js';
import { withTransaction } from '../../../src/db/tx.js';
import type { IssuedSession } from '../../../src/auth/session-store.js';
import {
  createPolicyHarness,
  HARNESS_ORIGIN,
  type PolicyHarness,
} from '../../helpers/policy-harness.js';
import { guid, TENANT } from '../../helpers/rbac-db.js';
import { countingRandom } from '../../secrets/support.js';
import type { RandomSource } from '../../../src/ports/clock.js';

export const IDLE_MS = 30 * 60_000;
export const ABSOLUTE_MS = 8 * 3_600_000;
export { TENANT, guid };

export interface SessionFixture {
  readonly harness: PolicyHarness;
  readonly store: SessionStore;
  /** A user session for `oid` (default `guid(1)`), written in its own transaction. */
  signIn(input?: Partial<NewSession>): IssuedSession;
  /** A request that carries this session id as the session cookie. */
  requestWith(id: string): Request;
  /** How many UPDATE statements hit the session table since the fixture was built. */
  updates(): number;
}

export async function createSessionFixture(
  options: {
    readonly random?: RandomSource;
    readonly writeIntervalMs?: number;
    readonly max?: number;
  } = {},
): Promise<SessionFixture> {
  const harness = await createPolicyHarness();
  const { db, clock } = harness;
  db.sqlite.exec(
    `CREATE TEMP TABLE session_updates (n INTEGER);
     CREATE TEMP TRIGGER session_update_counter AFTER UPDATE ON main.session
     BEGIN INSERT INTO session_updates VALUES (1); END;`,
  );
  const store = createSessionStore({
    database: () => db,
    clock: { now: () => clock.nowMs() },
    random: options.random ?? countingRandom(11),
    idleTimeoutMs: IDLE_MS,
    absoluteTimeoutMs: ABSOLUTE_MS,
    ...(options.writeIntervalMs === undefined ? {} : { writeIntervalMs: options.writeIntervalMs }),
    ...(options.max === undefined ? {} : { maxPerPrincipal: options.max }),
  });
  harness.ports.sessions.set(store);
  const names = cookieNames(HARNESS_ORIGIN);
  return {
    harness,
    store,
    signIn: (input = {}) =>
      withTransaction(db, (tx) =>
        store.create(tx, {
          kind: 'user',
          tid: TENANT,
          oid: guid(1),
          mfa: true,
          amr: ['pwd', 'mfa'],
          ...input,
        }),
      ),
    requestWith: (id) =>
      new Request('http://localhost:9300/api/v1/me', {
        headers: { cookie: `${names.session}=${id}` },
      }),
    updates: () =>
      (db.sqlite.prepare('SELECT count(*) AS n FROM temp.session_updates').get() as { n: number })
        .n,
  };
}

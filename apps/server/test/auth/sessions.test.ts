// T-B-184 (wiring): the auth module hands its session store to the policy layer and registers the
// hourly purge. The resolver then reads what the store wrote.
import { describe, expect, it } from 'vitest';
import { authModule } from '../../src/auth/module.js';
import { withTransaction } from '../../src/db/tx.js';
import type { Sweeper } from '../../src/lifecycle/sweepers.js';
import type { ModuleDeps } from '../../src/module.js';
import { createPolicyPorts } from '../../src/policy/index.js';
import { createFakeClock } from '../helpers/fake-clock.js';
import { createMigratedDatabase, guid, TENANT } from '../helpers/rbac-db.js';
import { countingRandom } from '../secrets/support.js';

async function build() {
  const db = await createMigratedDatabase();
  const clock = createFakeClock();
  const policy = createPolicyPorts();
  const registered: Sweeper[] = [];
  const deps = {
    database: () => db,
    now: () => clock.nowMs(),
    random: countingRandom(4),
    policy,
    config: { session: { idleTimeoutMs: 30 * 60_000, absoluteTimeoutMs: 8 * 3_600_000 } },
    sweepers: { register: (sweeper: Sweeper) => registered.push(sweeper) },
  } as unknown as ModuleDeps;
  return { db, clock, policy, registered, deps, module: authModule(deps) };
}

describe('server/auth/sessions: the auth module wiring', () => {
  it('registers the session store through the policy holder when the module is built', async () => {
    const { policy } = await build();
    expect(policy.sessions.get()).toBeDefined();
  });

  it('registers one hourly purge at start that deletes expired rows', async () => {
    const { module, registered, policy, db, clock } = await build();
    await module.start?.({} as ModuleDeps);
    expect(registered.map((sweeper) => [sweeper.name, sweeper.intervalMs])).toEqual([
      ['sessions', 3_600_000],
    ]);
    const store = policy.sessions.get() as unknown as {
      create: (tx: unknown, input: unknown) => unknown;
    };
    withTransaction(db, (tx) =>
      store.create(tx, { kind: 'user', tid: TENANT, oid: guid(1), mfa: true, amr: [] }),
    );
    clock.advance(9 * 3_600_000);
    await registered[0]?.run();
    expect((db.sqlite.prepare('SELECT count(*) AS n FROM session').get() as { n: number }).n).toBe(
      0,
    );
  });

  it('has no routes yet (the sign-in routes follow with the identity client)', async () => {
    const { module, deps } = await build();
    expect(module.routes(deps)).toEqual([]);
  });
});

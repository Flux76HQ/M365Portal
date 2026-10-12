// What the composition root does to the database after the migrations and before any module starts
// (plan 6.1 steps 5 and 7, SB-35, FR-B-714):
//
//   ensureSingletons          `INSERT OR IGNORE` of the `setup_state` row: state `unconfigured`, mode
//                             `automatic`, a fresh 128-bit `install_id` from the injected random source.
//                             A second start keeps the row, and so the id.
//   recoverInterruptedSetup   a process that died in the middle of a run left `running` and `waiting`
//                             steps and a lease behind. Both go back: the steps to `pending`, and, while
//                             the setup is not completed and automatic, the `connect` steps as well (the
//                             bootstrap token lived in memory only); the runner lease is released.
//   releaseRunnerLease        the same release at shutdown, after the modules stopped.
//
// The comparison of the built-in roles with `BUILTIN_ROLES` (plan 6.1 step 5, `builtin_roles_mismatch`)
// is not here: it is the `start` hook of the rbac module (`rbac/builtin-check.ts`, T-B-238, SB-35), one
// implementation, and the module hooks run right after this step and before anything listens.
import { withTransaction, type DatabaseHandle } from '../db/index.js';
import type { RandomSource } from '../ports/clock.js';

export interface SingletonDeps {
  readonly now: () => number;
  readonly random: RandomSource;
}

const iso = (milliseconds: number): string => new Date(milliseconds).toISOString();

export function ensureSingletons(db: DatabaseHandle, deps: SingletonDeps): void {
  const installId = Buffer.from(deps.random.bytes(16)).toString('hex');
  db.sqlite
    .prepare(
      "INSERT OR IGNORE INTO setup_state (id, state, mode, install_id, updated_at) VALUES (1, 'unconfigured', 'automatic', ?, ?)",
    )
    .run(installId, iso(deps.now()));
}

export function recoverInterruptedSetup(
  db: DatabaseHandle,
  deps: Pick<SingletonDeps, 'now'>,
): void {
  const now = iso(deps.now());
  withTransaction(db, (tx) => {
    tx.sqlite
      .prepare(
        "UPDATE setup_step SET status = 'pending', updated_at = ? WHERE status IN ('running', 'waiting')",
      )
      .run(now);
    const state = tx.sqlite.prepare('SELECT state, mode FROM setup_state WHERE id = 1').get() as
      { state: string; mode: string } | undefined;
    if (state !== undefined && state.state !== 'completed' && state.mode === 'automatic') {
      tx.sqlite
        .prepare(
          "UPDATE setup_step SET status = 'pending', updated_at = ? WHERE step = 'connect' AND status != 'pending'",
        )
        .run(now);
    }
    tx.sqlite.prepare('DELETE FROM runner_lease').run();
  });
}

export function releaseRunnerLease(db: DatabaseHandle): void {
  db.sqlite.prepare('DELETE FROM runner_lease').run();
}

/** The setup state as a name, or `unknown` without a database or a row. */
export function setupStateName(db: DatabaseHandle | undefined): string {
  if (db === undefined) return 'unknown';
  try {
    const row = db.sqlite.prepare('SELECT state FROM setup_state WHERE id = 1').get() as
      { state: string } | undefined;
    return row?.state ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

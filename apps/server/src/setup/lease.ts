// The runner lease (T-B-129, FR-B-209, plan 9.6): one row, `runner_lease`, that says which process runs
// the wizard right now. The holder is the run id; the heartbeat is written every 15 seconds from the
// injected scheduler and the lease expires 120 seconds after the last one. A second request, a second
// browser or a restart that races a live lease is refused (409 `setup_step_busy`); a lease past its
// expiry is taken over in the same transaction that writes the new holder. A crash releases nothing
// early: the row stays until it expires, or until the next start removes it (`recoverInterruptedSetup`).
import { LIMITS } from '@m365portal/shared/limits';
import { withTransaction, type DatabaseHandle } from '../db/index.js';
import type { Scheduler } from '../lifecycle/sweepers.js';

const SECOND_MS = 1000;

export interface RunnerLease {
  /** Take the lease for `holder`. False when another holder has a live one. */
  acquire(holder: string): boolean;
  /** Start the heartbeat of the lease this object holds. */
  startHeartbeat(): void;
  /** Delete the lease if this holder has it, and stop the heartbeat. */
  release(): void;
  /** Is a live lease held by someone other than this object? */
  heldByOther(): boolean;
  /** The holder of the live lease, if any. */
  currentHolder(): string | undefined;
}

export interface RunnerLeaseOptions {
  readonly database: () => DatabaseHandle;
  readonly now: () => number;
  readonly scheduler: Scheduler;
  /** Called when a heartbeat cannot be written (the database is gone): the run must stop. */
  readonly onLost?: () => void;
}

const iso = (milliseconds: number): string => new Date(milliseconds).toISOString();

export function createRunnerLease(options: RunnerLeaseOptions): RunnerLease {
  const expiryMs = LIMITS.setup.leaseExpirySeconds * SECOND_MS;
  const heartbeatMs = LIMITS.setup.leaseHeartbeatSeconds * SECOND_MS;
  let mine: string | undefined;
  let timer: unknown;

  interface Row {
    holder: string;
    expires_at: string;
  }
  const read = (db: DatabaseHandle): Row | undefined =>
    db.sqlite.prepare('SELECT holder, expires_at FROM runner_lease WHERE id = 1').get() as
      | Row
      | undefined;
  const live = (row: Row | undefined, now: number): row is Row =>
    row !== undefined && Date.parse(row.expires_at) > now;

  function stopTimer(): void {
    if (timer !== undefined) options.scheduler.clearInterval(timer);
    timer = undefined;
  }

  return {
    acquire(holder) {
      const db = options.database();
      return withTransaction(db, (tx) => {
        const now = options.now();
        const row = read(tx);
        if (live(row, now) && row.holder !== holder) return false;
        tx.sqlite
          .prepare(
            'INSERT INTO runner_lease (id, holder, heartbeat_at, expires_at) VALUES (1, ?, ?, ?) ' +
              'ON CONFLICT(id) DO UPDATE SET holder = excluded.holder, heartbeat_at = excluded.heartbeat_at, expires_at = excluded.expires_at',
          )
          .run(holder, iso(now), iso(now + expiryMs));
        mine = holder;
        return true;
      });
    },

    startHeartbeat() {
      stopTimer();
      timer = options.scheduler.setInterval(() => {
        if (mine === undefined) return;
        try {
          const now = options.now();
          const changed = options
            .database()
            .sqlite.prepare('UPDATE runner_lease SET heartbeat_at = ?, expires_at = ? WHERE id = 1 AND holder = ?')
            .run(iso(now), iso(now + expiryMs), mine).changes;
          if (changed === 0) options.onLost?.();
        } catch {
          options.onLost?.();
        }
      }, heartbeatMs);
    },

    release() {
      stopTimer();
      const holder = mine;
      mine = undefined;
      if (holder === undefined) return;
      try {
        options
          .database()
          .sqlite.prepare('DELETE FROM runner_lease WHERE id = 1 AND holder = ?')
          .run(holder);
      } catch {
        // The database is going away; the next start removes a lease that stays.
      }
    },

    heldByOther() {
      const row = read(options.database());
      return live(row, options.now()) && row.holder !== mine;
    },

    currentHolder() {
      const row = read(options.database());
      return live(row, options.now()) ? row.holder : undefined;
    },
  };
}

// T-B-249, EB-23, SC-B-007: two Owners remove each other at the same time, on two connections in two
// threads, 100 times: exactly one remains, every time. One removal wins; the other either finds the
// last-Owner rule in the way or has just lost its own right (a revocation between request and write
// wins), and in no repetition are both gone.
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { describe, expect, it, onTestFinished } from 'vitest';
import { openDatabase } from '../../src/db/open.js';
import { runMigrations } from '../../src/db/migrate.js';
import { defaultPaths } from '../../scripts/schema-snapshot.js';
import { assign, guid, TENANT } from '../helpers/rbac-db.js';
import { createTempDataDir } from '../helpers/temp-data-dir.js';
import type { RemoveReply, RemoveRequest, WorkerJob } from './last-owner-worker.js';

const ROUNDS = 100;

function startWorker(path: string): Promise<Worker> {
  const worker = new Worker(new URL('./last-owner-worker-entry.mjs', import.meta.url), {
    workerData: { path } satisfies WorkerJob,
  });
  onTestFinished(async () => {
    await worker.terminate();
  });
  return new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.once('message', () => {
      resolve(worker);
    });
  });
}

function ask(worker: Worker, request: RemoveRequest): Promise<RemoveReply> {
  return new Promise((resolve) => {
    const onMessage = (reply: RemoveReply): void => {
      if (reply.round !== request.round) return;
      worker.off('message', onMessage);
      resolve(reply);
    };
    worker.on('message', onMessage);
    worker.postMessage(request);
  });
}

describe('two Owners remove each other in parallel (SC-B-007)', () => {
  it(`leave exactly one Owner in each of ${String(ROUNDS)} repetitions`, async () => {
    const dir = await createTempDataDir();
    const path = join(dir.path, 'rbac.sqlite');
    const main = openDatabase({ path });
    onTestFinished(() => {
      main.close();
    });
    await runMigrations(main.sqlite, {
      migrationsFolder: defaultPaths().migrationsFolder,
      backupsDir: join(dir.path, 'backups'),
    });
    const [one, two] = await Promise.all([startWorker(path), startWorker(path)]);

    const countOwners = (): number =>
      (
        main.sqlite
          .prepare(
            `SELECT count(*) AS n FROM rbac_assignment a JOIN rbac_role r ON r.id = a.role_id
             WHERE r.key = 'owner' AND a.principal_type = 'user'`,
          )
          .get() as { n: number }
      ).n;
    const insertUser = main.sqlite.prepare(
      `INSERT OR IGNORE INTO app_user (tid, oid, upn_label, name_label, first_seen_at, last_signin_at, groups_resolved_at)
       VALUES (?, ?, NULL, NULL, '2026-10-10T11:00:00.000Z', '2026-10-10T11:00:00.000Z', NULL)`,
    );

    const outcomes: string[] = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      const a = guid(10_000 + round * 2);
      const b = guid(10_001 + round * 2);
      insertUser.run(TENANT, a);
      insertUser.run(TENANT, b);
      const assignmentA = assign(main, { principalId: a, role: 'owner' });
      const assignmentB = assign(main, { principalId: b, role: 'owner' });
      // Only this round's pair holds owner: the survivor of the last round goes (others exist).
      main.sqlite
        .prepare(
          `DELETE FROM rbac_assignment WHERE id NOT IN (?, ?)
           AND role_id = (SELECT id FROM rbac_role WHERE key = 'owner')`,
        )
        .run(assignmentA, assignmentB);
      expect(countOwners()).toBe(2);

      const [first, second] = await Promise.all([
        ask(one, { round, actorOid: a, assignmentId: assignmentB }),
        ask(two, { round, actorOid: b, assignmentId: assignmentA }),
      ]);
      const results = [first.result, second.result].sort();
      outcomes.push(results.join('+'));
      expect(countOwners(), `round ${String(round)}: ${results.join(', ')}`).toBe(1);
      expect(
        results.filter((result) => result === 'removed'),
        `round ${String(round)}`,
      ).toHaveLength(1);
      expect(
        results.find((result) => result !== 'removed'),
        `round ${String(round)}`,
      ).toMatch(/^(last_owner_protected|escalation_denied)$/);
    }
    expect(outcomes).toHaveLength(ROUNDS);
  }, 120_000);
});

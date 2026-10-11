// A writer in a worker thread, for the concurrency test of the audit store (`audit.test.ts`).
//
// better-sqlite3 is synchronous, so connections opened in ONE thread never overlap: each append
// finishes before the next starts and nothing is contended. A worker thread has its own connection,
// its own event loop and a real chance of asking for the write lock while another thread holds it,
// which is the situation the app can get into if a second process ever opens the volume, and the one
// `BEGIN IMMEDIATE` and the busy timeout exist for.
//
// The worker appends `count` entries, each in its own `withTransaction`, then reports. A failure is
// reported by its name and SQLite code only.
import { parentPort, workerData } from 'node:worker_threads';
import { appendAudit } from '../../src/audit/writer.js';
import { openDatabase } from '../../src/db/open.js';
import { withTransaction } from '../../src/db/tx.js';

export interface AuditWorkerJob {
  readonly path: string;
  readonly writer: number;
  readonly count: number;
}

export type AuditWorkerMessage =
  | { readonly done: true; readonly appended: number }
  | { readonly done: false; readonly error: string };

const job = workerData as AuditWorkerJob;
const database = openDatabase({ path: job.path });
let message: AuditWorkerMessage;
try {
  let appended = 0;
  for (let n = 0; n < job.count; n += 1) {
    withTransaction(database, (tx) => {
      appendAudit(tx, {
        ts: new Date(Date.UTC(2026, 9, 10, 12, 0, 0, job.writer * 1000 + n)).toISOString(),
        actorKind: 'system',
        actorId: 'system',
        action: 'test.concurrent',
        targetType: 'test',
        targetId: `${String(job.writer)}-${String(n)}`,
        outcome: 'success',
        detail: { bytes: n },
      });
    });
    appended += 1;
  }
  message = { done: true, appended };
} catch (error) {
  const { name, code } = error as { name?: unknown; code?: unknown };
  message = {
    done: false,
    error:
      `${typeof name === 'string' ? name : 'Error'} ${typeof code === 'string' ? code : ''}`.trim(),
  };
} finally {
  database.close();
}
parentPort?.postMessage(message);

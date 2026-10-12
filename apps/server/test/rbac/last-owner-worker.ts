// An Owner who removes another Owner, in a worker thread with a connection of its own (the
// concurrency test of the last-Owner rule, T-B-249, SC-B-007). better-sqlite3 is synchronous, so two
// connections in ONE thread never overlap; two threads do, which is the situation `BEGIN IMMEDIATE`
// exists for.
import { parentPort, workerData } from 'node:worker_threads';
import { openDatabase } from '../../src/db/open.js';
import { createAssignmentService } from '../../src/rbac/assignment-service.js';
import { createGrantsService } from '../../src/rbac/grants.js';

export interface WorkerJob {
  readonly path: string;
}

export interface RemoveRequest {
  readonly round: number;
  readonly actorOid: string;
  readonly assignmentId: string;
}

export interface RemoveReply {
  readonly round: number;
  /** `removed`, or the reason of the denial, or the error name and code. */
  readonly result: string;
}

const NOW = Date.parse('2026-10-10T12:00:00.000Z');
const job = workerData as WorkerJob;
const database = openDatabase({ path: job.path });
const grants = createGrantsService({ database: () => database, now: () => NOW });
const service = createAssignmentService({
  database: () => database,
  graph: () => {
    throw new Error('a removal needs no Graph');
  },
  now: () => NOW,
  random: { bytes: (length) => new Uint8Array(length), float: () => 0 },
  grantsOf: (actor) => grants.grantsFor({ oid: actor.id, groupsResolvedAt: null }),
});

parentPort?.on('message', (request: RemoveRequest | 'close') => {
  if (request === 'close') {
    database.close();
    return;
  }
  void (async () => {
    let result: string;
    try {
      const actorGrants = grants.grantsFor({ oid: request.actorOid, groupsResolvedAt: null });
      await service.remove(
        { kind: 'user', id: request.actorOid, grants: actorGrants },
        request.assignmentId,
        { requestId: `req-worker-${String(request.round).padStart(4, '0')}` },
      );
      result = 'removed';
    } catch (error) {
      const { reason, code, name } = error as { reason?: unknown; code?: unknown; name?: unknown };
      result = String(reason ?? code ?? name);
    }
    parentPort?.postMessage({ round: request.round, result } satisfies RemoveReply);
  })();
});
parentPort?.postMessage({ round: -1, result: 'ready' } satisfies RemoveReply);

// Denial auditing (FR-A-034, FR-A-072 denial part, FR-A-073 detail content, SC-A-009, PD-21, PA-15).
//
// Every denied authorisation, Origin or CSRF decision on a write route appends an audit entry before
// the response is built: `outcome = denied`, `action` = the route id, the actor, `reason_code` one of
// `permission_denied`, `origin_not_allowed`, `csrf_invalid`, the request id and the client address,
// and a detail of exactly `method`, the route TEMPLATE (never the requested path, which can hold a
// name) and, when the route needs one, the permission. A body, a header, a cookie or a query string
// never reaches the table (the detail is built from the allow-list of the audit store).
//
// The route wrapper (`route.ts`) calls this hook only for writes and only for these three denials:
// a denied read, a refused audited GET, a rate-limited request (429) and every other refusal (404,
// 405, 413, 415, 422) are not audited.
//
// Fail closed. The entry is written in a transaction of its own and awaited by the guard, so a
// failure here is a failure of the request: the error handler turns a storage failure into 503
// `storage_unavailable` or `storage_busy` and the handler is never reached. No database at all
// (degraded mode, the storage probe failed at start) is the same 503. An entry that is itself invalid
// is a bug in this file or in a route definition and stays a 500: it is not a storage failure.
import { appendAudit } from '../audit/index.js';
import { withTransaction, type DatabaseHandle } from '../db/index.js';
import { ProblemError } from './problem.js';
import type { OnRouteDenied } from './route.js';

export interface DenialAuditOptions {
  /**
   * The database the entry goes to, looked up per denial. `undefined` means there is none (degraded
   * mode): the denial then fails closed with 503 `storage_unavailable`.
   */
  readonly database: () => DatabaseHandle | undefined;
  /** The clock, in milliseconds since the epoch. Injected: the entry's time comes from it. */
  readonly now: () => number;
}

/** The hook `createHttpApp` calls for a denied write. */
export function createDenialAudit(options: DenialAuditOptions): OnRouteDenied {
  return (c, denial) => {
    const database = options.database();
    if (database === undefined) throw new ProblemError('storage_unavailable');

    const actor = c.get('actor');
    const { address } = c.get('client');
    const { route } = denial;
    withTransaction(database, (tx) =>
      appendAudit(tx, {
        ts: new Date(options.now()).toISOString(),
        actorKind: actor.kind,
        actorId: actor.id,
        action: route.id,
        outcome: 'denied',
        reasonCode: denial.code,
        ...(address === undefined ? {} : { clientIp: address }),
        requestId: c.get('requestId'),
        detail: {
          method: route.method,
          route: route.path,
          ...(route.permission === undefined ? {} : { permission: route.permission }),
        },
      }),
    );
  };
}

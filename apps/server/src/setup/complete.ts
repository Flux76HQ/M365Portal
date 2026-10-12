// The setup completes on the first sign-in of the designated Owner (T-B-141, FR-B-219 g): the hook the
// sign-in callback (auth/callback.ts) calls INSIDE the session transaction whenever the state is
// `awaiting_first_signin`. It is called for any `oid` that signs in at that time, so it decides itself:
//
//   - only the designated Owner completes; anyone else changes nothing (and is not bounced);
//   - in the caller's transaction: the state edge `awaiting_first_signin -> completed` (with
//     `completed_at`), the audit entry `setup.complete` (actor `user`, the `oid`), and the proof list
//     stays as the last verification stored it (the final snapshot: nothing after this writes it
//     except `POST /connection/verify`);
//   - after the commit and only then: the setup token file is deleted, every setup session ends, and
//     the bootstrap object is dropped. A rollback of the session transaction undoes the state change
//     and none of these happen.
// The hook is synchronous: it makes no network call.
import { appendAudit } from '../audit/index.js';
import type { CompleteSetupInTx } from '../auth/holders.js';
import type { Tx } from '../db/tx.js';
import type { SetupServices } from './context.js';

export function createCompleteSetupInTx(services: SetupServices): CompleteSetupInTx {
  return (tx: Tx, oid: string): void => {
    const state = services.state.read(tx);
    if (state.state !== 'awaiting_first_signin') return;
    if (state.designatedOwnerOid?.toLowerCase() !== oid.toLowerCase()) return;
    services.state.apply(tx, 'complete');
    appendAudit(tx, {
      ts: new Date(services.deps.now()).toISOString(),
      actorKind: 'user',
      actorId: oid.toLowerCase(),
      action: 'setup.complete',
      targetType: 'setup',
      targetId: 'setup',
      outcome: 'success',
      detail: { mode: state.mode },
    });
    tx.afterCommit(() => {
      services.token.remove();
      services.sessions.endAll();
      services.bootstrap.discard('finish');
    });
  };
}

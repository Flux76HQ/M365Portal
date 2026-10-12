// The two seams other modules reach the auth module through, without importing its internals
// (CB12, SB-32). `ModuleDeps` is one object shared by every module, so a small holder keyed by it is
// the neutral place both sides can find:
//
//   completeSetupInTx   the hook the sign-in callback calls INSIDE the session transaction when the
//                       state is `awaiting_first_signin` and the signed-in `oid` is the designated
//                       Owner (FR-B-219, T-B-141). The setup module sets it from its factory or its
//                       `start` hook. The default is a no-op: until it is set, signing in completes
//                       nothing. The hook runs in the caller's transaction, so the state change,
//                       the audit entry `setup.complete` and the session commit together or not at all.
//   revalidate          the request guard of the revalidation (T-B-189, FR-B-409): the auth module
//                       sets it, the composition root hands it to the route wrapper, which runs it
//                       before authorisation on every request that carries a session cookie.
import type { Context } from 'hono';
import type { Tx } from '../db/tx.js';
import type { AppEnv } from '../http/request-context.js';
import type { ModuleDeps } from '../module.js';
import { createHolder, type Holder } from '../policy/ports.js';

/** Called inside the session transaction of the designated Owner's first sign-in. Synchronous. */
export type CompleteSetupInTx = (tx: Tx, oid: string) => void;

/** `undefined` lets the request go on; a response ends it (a revoked session answers 401). */
export type RevalidationGuard = (c: Context<AppEnv>) => Promise<Response | undefined>;

export interface AuthHolders {
  readonly completeSetupInTx: Holder<CompleteSetupInTx>;
  readonly revalidate: Holder<RevalidationGuard>;
}

const holders = new WeakMap<object, AuthHolders>();

/** The holders of one server (one `ModuleDeps`). Created on first use. */
export function authHoldersOf(deps: ModuleDeps): AuthHolders {
  let found = holders.get(deps);
  if (found === undefined) {
    found = { completeSetupInTx: createHolder(), revalidate: createHolder() };
    holders.set(deps, found);
  }
  return found;
}

/** The hook to call: the one the setup module set, else a no-op. */
export function completeSetupInTxOf(deps: ModuleDeps): CompleteSetupInTx {
  return authHoldersOf(deps).completeSetupInTx.get() ?? (() => undefined);
}

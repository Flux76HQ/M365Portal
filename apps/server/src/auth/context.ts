// What the sign-in routes share (T-B-196): one object, built once by the module factory from the
// dependencies every module gets. Routes take it as an argument; none of them reaches for a global.
import type { ModuleDeps } from '../module.js';
import type { Logger } from '../logging/logger.js';
import type { LoginTransactions } from './login-transactions.js';
import type { MembershipPort } from './membership.js';
import type { Revalidator } from './revalidate.js';
import type { SessionStore } from './session-store.js';

export interface AuthContext {
  readonly deps: ModuleDeps;
  readonly log: Logger;
  readonly sessions: SessionStore;
  readonly transactions: LoginTransactions;
  /** The group memberships of a user: the seam to the rbac module's membership service (T-B-247). */
  readonly membership: MembershipPort;
  /** The revalidation of sessions; a sign-in tells it the person was just checked. */
  readonly revalidator: Revalidator;
}

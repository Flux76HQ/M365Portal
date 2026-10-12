// The two guards of the assignment service (T-B-249, FR-B-509, FR-B-510): nobody grants or removes
// what they could not grant, and the last Owner stays. Both end in a `PolicyDenied`, which the route
// wrapper audits as a denial (route id as the action, the reason as `reason_code`) and answers with
// the problem of the same code.
import type { Grant } from '@m365portal/shared/rbac/effective';
import type { RolePermission } from '@m365portal/shared/rbac/roles';
import type { ScopeItem } from '@m365portal/shared/rbac/scope';
import type { DatabaseHandle } from '../db/index.js';
import { canGrant } from '../policy/can-grant.js';
import { PolicyDenied } from '../policy/denied.js';
import { countUserOwnersExcept, type AssignmentRecord } from './repository.js';

/** Throws `escalation_denied` unless an actor holding `grants` could hand out this role with this scope. */
export function assertMayGrant(
  grants: readonly Grant[],
  role: readonly RolePermission[],
  scope: readonly ScopeItem[],
): void {
  if (!canGrant({ grants }, role, scope)) throw new PolicyDenied('escalation_denied');
}

/**
 * Throws `last_owner_protected` when deleting this assignment would leave no user with `owner`. Runs
 * inside the write transaction, so the count and the delete cannot be separated by another writer; the
 * SQL trigger repeats the rule for anything that bypasses the service.
 */
export function assertNotLastOwner(db: DatabaseHandle, assignment: AssignmentRecord): void {
  if (assignment.roleKey !== 'owner' || assignment.principalType !== 'user') return;
  if (countUserOwnersExcept(db, assignment.id) === 0)
    throw new PolicyDenied('last_owner_protected');
}

/**
 * The abort of the trigger `rbac_assignment_last_owner_*` as the same denial, or `undefined` for any
 * other error. The trigger raises `last_owner_protected` as its message (data-model section 8).
 */
export function lastOwnerAbort(error: unknown): PolicyDenied | undefined {
  if (!(error instanceof Error)) return undefined;
  return error.message.includes('last_owner_protected')
    ? new PolicyDenied('last_owner_protected')
    : undefined;
}

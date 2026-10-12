// `canGrant` (plan 11.2, FR-B-509): may this actor hand out this role with this scope? Nobody grants,
// or removes, what they could not grant themselves. The decision is the pure `canGrantCore` of the
// shared package applied to the grants of the actor; the assignment service calls it twice, once early
// for a cheap refusal and once inside the write transaction with the grants reloaded (a revocation
// between the request and the write wins).
import type { Grant } from '@m365portal/shared/rbac/effective';
import { canGrantCore } from '@m365portal/shared/rbac/covers';
import type { RolePermission } from '@m365portal/shared/rbac/roles';
import type { ScopeItem } from '@m365portal/shared/rbac/scope';
import type { Actor } from './actor.js';

export function canGrant(
  actor: Pick<Actor, 'grants'> | { readonly grants: readonly Grant[] },
  role: readonly RolePermission[],
  targetScope: readonly ScopeItem[],
): boolean {
  return canGrantCore(actor.grants, role, targetScope);
}

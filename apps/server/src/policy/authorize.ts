// `authorize` (plan 8.8, 11.2, FR-A-030, FR-B-505): the one question the policy layer answers. Deny by
// default: there is no allow branch that is not a grant.
//
//   authorize(actor, permission)            the route-level gate: does the actor hold the permission
//                                           at all? The qualifier is `full` if any full grant exists.
//   authorize(actor, permission, resource)  does a grant cover THIS resource? A grant covers it when its
//                                           scope is `all` or one of its items `matchScope`s the
//                                           resource; the qualifier is `full` when a matching grant is.
//
// A permission outside the catalogue (a typo, a wildcard, a value that is not a string) is a refusal
// even for an actor whose grants, by mistake, contain the string. A resource whose type is not the
// type of the permission, or any resource for a global-only permission, is a programming error and
// throws `PolicyUsageError`; the wrapper turns the throw into a fail-closed 500 (never an allow).
import { PERMISSIONS, PERMISSION_RESOURCE, type Permission } from '@m365portal/shared/permissions';
import type { Grant } from '@m365portal/shared/rbac/effective';
import type { Qualifier, ResourceAttrs } from '@m365portal/shared/rbac/resources';
import { matchScope } from '@m365portal/shared/rbac/scope';
import type { Actor } from './actor.js';

/** The answer. The reason is what the audit entry of a denial records (FR-B-602). */
export type Decision =
  | { readonly allow: true; readonly qualifier: Qualifier }
  | { readonly allow: false; readonly reason: 'permission_missing' | 'scope_mismatch' };

export class PolicyUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyUsageError';
  }
}

const CATALOGUE: ReadonlySet<string> = new Set(PERMISSIONS);

const FULL: Decision = Object.freeze({ allow: true, qualifier: 'full' });
const BASIC: Decision = Object.freeze({ allow: true, qualifier: 'basic' });
const MISSING: Decision = Object.freeze({ allow: false, reason: 'permission_missing' });
const MISMATCH: Decision = Object.freeze({ allow: false, reason: 'scope_mismatch' });

function qualifierOf(grants: readonly Grant[]): Decision {
  return grants.some((grant) => grant.qualifier === 'full') ? FULL : BASIC;
}

export function authorize(
  actor: Actor,
  permission: Permission,
  resource?: ResourceAttrs,
): Decision {
  const name: unknown = permission;
  if (typeof name !== 'string' || !CATALOGUE.has(name)) return MISSING;
  const held = actor.grants.filter((grant) => grant.permission === permission);
  if (held.length === 0) return MISSING;
  if (resource === undefined) return qualifierOf(held);

  const expected = PERMISSION_RESOURCE[permission];
  if (expected === null) {
    throw new PolicyUsageError(`${permission} is global-only: it takes no resource`);
  }
  if (resource.type !== expected) {
    throw new PolicyUsageError(
      `${permission} applies to ${expected}, not to ${resource.type as string}`,
    );
  }
  const covering = held.filter(
    (grant) => grant.scope === 'all' || grant.scope.some((item) => matchScope(item, resource)),
  );
  return covering.length === 0 ? MISMATCH : qualifierOf(covering);
}

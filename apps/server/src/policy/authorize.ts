// `authorize` (plan 8.8, FR-A-030): the one question the policy layer answers. Deny by default.
//
// Two things must both be true for an allow: the permission is in the catalogue of the brief, and
// the actor holds it. The first makes a typo, a wildcard or a permission from a later phase a
// refusal even for an actor whose set (by mistake) contains the string; the second is the policy.
// Anything else, including a value that is not a string, is a refusal. There is no "admin" shortcut
// and no kind of actor that skips the check: the preview actor is allowed because its set holds
// every permission, not because it is the preview actor.
import { PERMISSIONS, type Permission } from '@m365portal/shared/permissions';
import type { Actor, ResourceRef } from './actor.js';

/** The answer. The reason is what the audit entry of a denial records (FR-A-034). */
export type Decision =
  { readonly allow: true } | { readonly allow: false; readonly reason: 'permission_missing' };

const CATALOGUE: ReadonlySet<string> = new Set(PERMISSIONS);

const ALLOW: Decision = Object.freeze({ allow: true });
const DENY: Decision = Object.freeze({ allow: false, reason: 'permission_missing' });

/**
 * May `actor` do what `permission` names? `resource` is accepted and not read: Phases B and D scope
 * permissions to a resource, and the callers are written for that now.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- accepted and unused in Phase A on purpose
export function authorize(actor: Actor, permission: Permission, _resource?: ResourceRef): Decision {
  const name: unknown = permission;
  if (typeof name !== 'string' || !CATALOGUE.has(name)) return DENY;
  return actor.permissions.has(permission) ? ALLOW : DENY;
}

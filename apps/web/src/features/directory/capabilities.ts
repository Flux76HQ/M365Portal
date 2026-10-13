// What the actor may do, as far as the UI shows it (FR-D-903): the buttons that change something are offered
// only to an actor who holds the permission somewhere. Gating is cosmetic; the server checks the permission on
// the object (its scope) and answers 403 `permission_denied` when the actor may not, which the page shows as a
// translated message.
import type { Permission } from '@m365portal/shared/permissions';
import { hasAccess } from '../../lib/gating';
import { useMe } from '../../lib/router-context';

/** Does the actor hold this permission (at any scope)? */
export function useCan(permission: Permission): boolean {
  return hasAccess(useMe(), [permission]);
}

// The two fixed grant sets (T-B-240, FR-B-202, FR-B-521, plan 11.7): the permissions of the setup
// actor and of the break-glass actor are constants, not rows, in this one file. They are asserted
// equal to the table of the spec by `server/policy.test.ts`; a permission added here is a change of
// the security model and needs the spec, the table and an ADR first.
//
//   setup        `settings:branding` (the Appearance form runs in step 5 of the wizard) and
//                `settings:connection` (the connection routes), both for everything, in full
//   break_glass  `rbac:manage` only, in full: the one account that can restore an Owner
import type { Grant } from '@m365portal/shared/rbac/effective';
import type { GlobalOnlyPermission } from '@m365portal/shared/rbac/resources';

function everything(permission: GlobalOnlyPermission): Grant {
  return Object.freeze({ permission, qualifier: 'full', scope: 'all' });
}

export const SETUP_GRANTS: readonly Grant[] = Object.freeze([
  everything('settings:branding'),
  everything('settings:connection'),
]);

export const BREAK_GLASS_GRANTS: readonly Grant[] = Object.freeze([everything('rbac:manage')]);

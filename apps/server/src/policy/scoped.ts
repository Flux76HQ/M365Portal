// `visibleScopes` (plan 11.2, FR-B-505): which resources of a permission's type an actor may see, and in
// which form. A list, a search, a bulk action, an export and the command palette take their object set
// from here, so a scoped actor never sees a row it could not open.
//
//   full    the scope of the grants with qualifier `full`
//   basic   the scope of the grants with qualifier `basic` (only `users:read` has one)
//
// Each is `'none'` (no such grant), `'all'` (every resource of the type) or the scope items. A
// resource in `full` is shown in full; one that is only in `basic` is projected (`projectUser`).
import type { Permission } from '@m365portal/shared/permissions';
import type { Grant } from '@m365portal/shared/rbac/effective';
import { dedupeScopeItems, type ScopeItem } from '@m365portal/shared/rbac/scope';
import type { Actor } from './actor.js';

export type VisibleSet = 'none' | 'all' | readonly ScopeItem[];

export interface VisibleScopes {
  readonly full: VisibleSet;
  readonly basic: VisibleSet;
}

const NOTHING: VisibleScopes = Object.freeze({ full: 'none', basic: 'none' });

function setOf(grants: readonly Grant[]): VisibleSet {
  if (grants.length === 0) return 'none';
  if (grants.some((grant) => grant.scope === 'all')) return 'all';
  const items = grants.flatMap((grant) => (grant.scope === 'all' ? [] : grant.scope));
  return Object.freeze(dedupeScopeItems(items));
}

export function visibleScopes(actor: Actor, permission: Permission): VisibleScopes {
  const held = actor.grants.filter((grant) => grant.permission === permission);
  if (held.length === 0) return NOTHING;
  return Object.freeze({
    full: setOf(held.filter((grant) => grant.qualifier === 'full')),
    basic: setOf(held.filter((grant) => grant.qualifier === 'basic')),
  });
}

// Covering and the anti-escalation core (T-B-234, FR-B-509 pure half, SC-B-006). Nobody can grant (or
// remove) what they could not grant themselves, and "could not" is decided here, as a pure function:
//
//   covers(a, b)        does the actor's scope item `a` cover the target's item `b`?
//   scopesCover(A, B)   does the actor's scope set cover the target's?
//   canGrantCore(...)   may an actor holding these grants hand out this role with this scope?
//
// The property, asserted with 20,000 seeded cases in `shared/rbac-covers.property.test.ts`: if
// `canGrantCore` holds, every resource the target's grants allow for a permission is a resource the
// actor is allowed on for that permission, with at least that qualifier. A cover is therefore only
// ever claimed when it is certain: equal items, prefixes that continue the actor's prefix, equal
// departments. An id item is covered only by the same id (an actor with filter scopes never covers an
// id item: the id's attributes are unknown), and anything unreadable covers nothing (fail closed).
//
// Pure and platform-neutral: no clock, no I/O, no randomness, no work at import.
import { PERMISSION_RESOURCE } from '../permissions.js';
import type { Grant, GrantScope } from './effective.js';
import { permissionAllowsQualifier, qualifierAtLeast } from './qualifier.js';
import { isGlobalOnly } from './resources.js';
import type { RolePermission } from './roles.js';
import { fold, scopeItemKey, type ScopeItem } from './scope.js';

function coversUnsafe(a: ScopeItem, b: ScopeItem): boolean {
  if (a.target !== b.target) return false;
  if (a.match.by === 'id' || b.match.by === 'id') {
    // An id item is covered only by the equal id item.
    return a.match.by === 'id' && b.match.by === 'id' && scopeItemKey(a) === scopeItemKey(b);
  }
  if (typeof a.match.value !== 'string' || typeof b.match.value !== 'string') return false;
  const actorValue = fold(a.match.value);
  const targetValue = fold(b.match.value);
  // An empty value selects nothing; it must not be read as "everything" nor cover anything.
  if (actorValue === '' || targetValue === '') return false;
  if (a.match.by === 'prefix' && b.match.by === 'prefix')
    return a.match.attr === b.match.attr && targetValue.startsWith(actorValue);
  if (a.match.by === 'department' && b.match.by === 'department') return actorValue === targetValue;
  return false;
}

/**
 * Does the actor's item `a` cover the target's item `b`? True for equal items (whatever the spelling
 * of the text), for two `prefix` items on the same target and attribute when the folded target value
 * starts with the folded actor value, and for equal `department` items. An `id` item is covered only
 * by an equal `id` item. Never throws; a malformed item covers nothing.
 */
export function covers(a: ScopeItem, b: ScopeItem): boolean {
  try {
    return coversUnsafe(a, b);
  } catch {
    return false;
  }
}

/**
 * Does the actor's scope cover the target's? An actor `all` covers everything; a target `all` needs
 * actor `all`; otherwise every target item must be covered by some actor item.
 */
export function scopesCover(actor: GrantScope, target: GrantScope): boolean {
  if (actor === 'all') return true;
  if (target === 'all') return false;
  return target.every((item) => actor.some((held) => covers(held, item)));
}

/**
 * May an actor holding `actorGrants` hand out `role` with `targetScope`? For every `(p, q)` of the role:
 * a global-only `p` needs an empty target scope and an actor grant for `p` with scope `all` and a
 * qualifier of at least `q`; any other `p` compares the target's items for the type of `p` (or `all`
 * when it names none) with the union of the actor's grants for `p` whose qualifier is at least `q`
 * (`full` covers `basic`, not the reverse). A role with a permission or qualifier it cannot read is
 * not grantable (fail closed). Never changes its arguments.
 */
export function canGrantCore(
  actorGrants: readonly Grant[],
  role: readonly RolePermission[],
  targetScope: readonly ScopeItem[],
): boolean {
  for (const { permission, qualifier } of role) {
    if (!permissionAllowsQualifier(permission, qualifier)) return false;
    const usable = actorGrants.filter(
      (g) => g.permission === permission && qualifierAtLeast(g.qualifier, qualifier),
    );
    if (isGlobalOnly(permission)) {
      if (targetScope.length > 0 || !usable.some((g) => g.scope === 'all')) return false;
      continue;
    }
    if (usable.length === 0) return false;
    const type = PERMISSION_RESOURCE[permission];
    const targetItems = targetScope.filter((item) => item.target === type);
    const target: GrantScope = targetItems.length > 0 ? targetItems : 'all';
    const actor: GrantScope = usable.some((g) => g.scope === 'all')
      ? 'all'
      : usable.flatMap((g) => (g.scope === 'all' ? [] : g.scope));
    if (!scopesCover(actor, target)) return false;
  }
  return true;
}

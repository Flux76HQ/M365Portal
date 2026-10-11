// Effective permissions: ONE pure function (T-B-233, FR-B-504, FR-B-515 pure half, B-11, SB-13, EB-38).
// The server enforces with it and, in Phase D, the web "view as" screen computes with the same code.
//
// `computeGrants(assignments, now)` takes the assignments whose principal is the user or one of the
// user's resolved bound groups (membership is the caller's business, FR-B-507) and returns the grants:
//
//   1. an assignment counts while its expiry is empty or later than `now` (the exact instant is
//      expired; an expiry that cannot be read counts as expired);
//   2. for each role permission `(p, q)` of a counted assignment:
//        - an assignment whose principal is a group contributes neither `rbac:manage` nor
//          `settings:connection` (`GROUP_FORBIDDEN_PERMISSIONS`, FR-B-515): the pure function holds
//          even for a row written around the API;
//        - a global-only `p` gives `(p, q, all)` only when the assignment has no scope items at all;
//        - otherwise, with `T` the resource type of `p`, the grant is `(p, q, items)` where `items` are
//          the scope items of the assignment whose target is `T`, or `all` when it has none for `T`
//          (scopes restrict only the resource types they name, BCB-09);
//   3. grants merge per `(p, q)`: `all` absorbs the rest, otherwise the items are united and
//      de-duplicated. A `full` and a `basic` grant of the same permission stay separate (SB-13):
//      merging them would hand `full` to resources only a scoped full grant covers.
//
// Pure and platform-neutral: no clock (the caller passes `now`), no I/O, no randomness.
import { PERMISSIONS, PERMISSION_RESOURCE, type Permission } from '../permissions.js';
import { permissionAllowsQualifier } from './qualifier.js';
import { isGlobalOnly, type Qualifier } from './resources.js';
import type { RolePermission } from './roles.js';
import { dedupeScopeItems, type ScopeItem } from './scope.js';

/**
 * Roles that hold either of these cannot be assigned to an Entra group, and `computeGrants` ignores
 * them for every group-derived assignment: whoever controls an Entra group would otherwise control the
 * panel without an audit entry in the panel (FR-B-515, owner decision ODB-16). Frozen.
 */
export const GROUP_FORBIDDEN_PERMISSIONS = Object.freeze([
  'rbac:manage',
  'settings:connection',
] as const);

/** What a grant covers: every resource of the permission's type, or the resources some item selects. */
export type GrantScope = 'all' | readonly ScopeItem[];

/** One effective grant. For a global-only permission the scope is always `all`. */
export interface Grant {
  readonly permission: Permission;
  readonly qualifier: Qualifier;
  readonly scope: GrantScope;
}

/** An assignment as `computeGrants` needs it: who holds it, what the role gives, its scope and expiry. */
export interface GrantAssignment {
  /** `user` when the assignment names the user, `group` when it came through a bound group. */
  readonly principalType: 'user' | 'group';
  readonly permissions: readonly RolePermission[];
  /** Empty for an unscoped assignment. */
  readonly scope: readonly ScopeItem[];
  /** A UTC ISO-8601 timestamp, or null for no expiry. */
  readonly expiresAt: string | null;
}

/** Is an assignment with this expiry active at `now`? Empty or later than `now`; unreadable is expired. */
export function isAssignmentActive(expiresAt: string | null, now: Date): boolean {
  if (expiresAt === null) return true;
  return Date.parse(expiresAt) > now.getTime();
}

/**
 * The earliest expiry among the assignments that are active at `now`, or null when none of them
 * expires. The grants memo (FR-B-511) is valid until then, by the same rule as `computeGrants`.
 */
export function earliestExpiry(
  assignments: readonly Pick<GrantAssignment, 'expiresAt'>[],
  now: Date,
): string | null {
  let earliest: { readonly text: string; readonly time: number } | null = null;
  for (const { expiresAt } of assignments) {
    if (expiresAt === null || !isAssignmentActive(expiresAt, now)) continue;
    const time = Date.parse(expiresAt);
    if (earliest === null || time < earliest.time) earliest = { text: expiresAt, time };
  }
  return earliest === null ? null : earliest.text;
}

const QUALIFIER_ORDER: Readonly<Record<Qualifier, number>> = { full: 0, basic: 1 };

interface Accumulator {
  all: boolean;
  readonly items: Set<ScopeItem>;
}

/** Computes the effective grants (see the header). Never changes its arguments. */
export function computeGrants(
  assignments: readonly GrantAssignment[],
  now: Date,
): readonly Grant[] {
  const merged = new Map<
    string,
    { permission: Permission; qualifier: Qualifier; acc: Accumulator }
  >();

  for (const assignment of assignments) {
    // The type is data from a row: anything but the two known principals counts for nothing.
    const principalType: string = assignment.principalType;
    if (principalType !== 'user' && principalType !== 'group') continue;
    if (!isAssignmentActive(assignment.expiresAt, now)) continue;
    const viaGroup = principalType === 'group';

    for (const { permission, qualifier } of assignment.permissions) {
      if (!PERMISSIONS.includes(permission)) continue;
      if (!permissionAllowsQualifier(permission, qualifier)) continue;
      if (viaGroup && (GROUP_FORBIDDEN_PERMISSIONS as readonly string[]).includes(permission))
        continue;

      let items: readonly ScopeItem[] = [];
      if (isGlobalOnly(permission)) {
        if (assignment.scope.length > 0) continue;
      } else {
        const type = PERMISSION_RESOURCE[permission];
        items = assignment.scope.filter((item) => item.target === type);
      }

      const key = `${permission}\u{0}${qualifier}`;
      let entry = merged.get(key);
      if (entry === undefined) {
        entry = { permission, qualifier, acc: { all: false, items: new Set() } };
        merged.set(key, entry);
      }
      if (items.length === 0) entry.acc.all = true;
      else if (!entry.acc.all) for (const item of items) entry.acc.items.add(item);
    }
  }

  const grants = [...merged.values()]
    .sort(
      (a, b) =>
        PERMISSIONS.indexOf(a.permission) - PERMISSIONS.indexOf(b.permission) ||
        QUALIFIER_ORDER[a.qualifier] - QUALIFIER_ORDER[b.qualifier],
    )
    .map(({ permission, qualifier, acc }): Grant => {
      const scope: GrantScope = acc.all
        ? 'all'
        : Object.freeze(dedupeScopeItems([...acc.items.values()]));
      return Object.freeze({ permission, qualifier, scope });
    });
  return Object.freeze(grants);
}

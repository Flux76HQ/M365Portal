// The permission catalogue (contract C1, FR-A-030): the fifteen permissions of brief section 2a, as
// one typed list. Every other statement of a permission (the `Permission` type, the schema, the
// `/api/v1/me` response, the route table, the navigation gating of the web app) is derived from this
// list. A second list anywhere else is a defect: `single-implementation.test.ts` fails on it
// (FR-A-008), and `docs/permissions.md` is compared with this list by `docs-contract.test.ts`.
//
// Phase A gives the panel no way to hold a permission other than the preview actor (all of them) and
// the anonymous actor (none). The catalogue is complete from the start so that Phases B and D change
// no signature.
import { z } from 'zod';

/** Brief section 2a, in the order the brief lists them. Frozen: nothing can add or reorder at runtime. */
export const PERMISSIONS = Object.freeze([
  'users:read',
  'groups:read',
  'groups:members:write',
  'distributionlists:read',
  'distributionlists:members:write',
  'distributionlists:export',
  'contacts:read',
  'contacts:create',
  'contacts:update',
  'contacts:delete',
  'audit:read',
  'audit:export',
  'settings:branding',
  'settings:connection',
  'rbac:manage',
] as const);

/** One of the catalogue entries; the union of the strings in `PERMISSIONS`. */
export type Permission = (typeof PERMISSIONS)[number];

/** A permission on the wire. Case-sensitive: `Users:Read`, `*` and `users:write` are all rejected. */
export const PermissionSchema = z.enum(PERMISSIONS).meta({ id: 'Permission' });

/**
 * True when `held` contains at least one of the permissions in `anyOf`.
 *
 * Deny by default: an empty `held` set never satisfies a requirement, and neither does an empty
 * `anyOf` ("any of nothing" is not satisfiable). A caller that has no requirement at all (a public
 * page) must say so itself instead of passing an empty list.
 *
 * `held` is the actor's `ReadonlySet` on the server and the `permissions` array of `/api/v1/me` in
 * the web app; both are accepted. Neither argument is changed.
 */
export function hasAnyPermission(
  held: ReadonlySet<Permission> | readonly Permission[],
  anyOf: readonly Permission[],
): boolean {
  return anyOf.some((permission) =>
    'has' in held ? held.has(permission) : held.includes(permission),
  );
}

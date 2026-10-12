// Resource types and the global-only class (T-B-230, FR-B-505, CB8). The pure vocabulary of the RBAC
// algorithms: which kind of object a permission is about, which permissions are about none, and the
// attributes a scope item can look at. `PERMISSION_RESOURCE` itself sits beside the catalogue in
// `permissions.ts` (seam XB6), so there is no second permission list anywhere (T-B-393).
//
// Pure and platform-neutral: no clock, no I/O, no randomness, no work at import.
import { PERMISSION_RESOURCE, type Permission } from '../permissions.js';

/** The four kinds of tenant object a scope can restrict (spec 6.5.1). Frozen. */
export const RESOURCE_TYPES = Object.freeze([
  'user',
  'group',
  'distributionList',
  'contact',
] as const);

/** `user`, `group`, `distributionList` or `contact`. */
export type ResourceType = (typeof RESOURCE_TYPES)[number];

/**
 * How much of a permission a grant gives. Only `users:read` has a `basic` form (FR-B-512): `id`,
 * `displayName` and `mail`. `full` covers `basic`, never the reverse. In the database `full` is stored
 * as the empty string.
 */
export const QUALIFIERS = Object.freeze(['full', 'basic'] as const);

/** `full` or `basic`. */
export type Qualifier = (typeof QUALIFIERS)[number];

/** A lower-case canonical GUID. A plain alias: the wire schema is `GuidSchema` in `schemas/common.ts`. */
export type Guid = string;

/**
 * The permissions that have no resource type (`audit:*`, `settings:*`, `rbac:manage`). They come only
 * from unscoped assignments, and `authorize` takes no resource for them.
 */
export const GLOBAL_ONLY_PERMISSIONS = Object.freeze([
  'audit:read',
  'audit:export',
  'settings:branding',
  'settings:connection',
  'rbac:manage',
] as const);

/** One of the five global-only permissions. */
export type GlobalOnlyPermission = (typeof GLOBAL_ONLY_PERMISSIONS)[number];

/** A permission that is about a resource type (all the others). */
export type ResourcePermission = Exclude<Permission, GlobalOnlyPermission>;

/**
 * Is this a global-only permission? Derived from `PERMISSION_RESOURCE`, so the two cannot disagree.
 * A string that is not in the catalogue is not global-only: it is not a permission, and every caller
 * refuses it before it asks (an own-property test, so `constructor` and `__proto__` are not found).
 */
export function isGlobalOnly(permission: Permission): permission is GlobalOnlyPermission {
  return Object.hasOwn(PERMISSION_RESOURCE, permission) && PERMISSION_RESOURCE[permission] === null;
}

/**
 * What a scope item can look at on a resource. `type` is always present; the rest is optional and a
 * missing or null attribute never matches (fail closed, FR-B-513).
 */
export interface ResourceAttrs {
  readonly type: ResourceType;
  readonly id?: Guid;
  readonly displayName?: string | null;
  readonly alias?: string | null;
  readonly mail?: string | null;
  readonly department?: string | null;
}

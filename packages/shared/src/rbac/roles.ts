// The five built-in roles and the template *Bestuur*, as ONE constant each (T-B-231, FR-B-501 constant,
// FR-B-502, FR-B-503, I-B1, CB8). The matrix of spec 6.9.4 is normative; `docs/permissions.md` repeats
// it and is compared with this file by `server/docs-contract.test.ts`, and the database rows seeded by
// migration `0001` are compared with it by `server/rbac/builtin-roles.test.ts`. A change here needs a
// new migration and an ADR (FR-B-501).
//
// Role keys are English identifiers. Display names (nl: Eigenaar, Beheerder, Operator, Helpdesk, Lezer,
// Bestuur) come from the catalogue by key, never from this file (FR-B-716).
//
// Pure and platform-neutral: no clock, no I/O, no randomness, no work at import beyond freezing.
import type { Permission } from '../permissions.js';
import type { Qualifier, ResourceType } from './resources.js';

/** One permission of a role, with its qualifier. `basic` exists only on `users:read` (FR-B-512). */
export interface RolePermission {
  readonly permission: Permission;
  readonly qualifier: Qualifier;
}

/** The keys of the five built-in roles, in the order of the spec table. */
export const BUILTIN_ROLE_KEYS = Object.freeze([
  'owner',
  'admin',
  'operator',
  'helpdesk',
  'reader',
] as const);

/** `owner`, `admin`, `operator`, `helpdesk` or `reader`. */
export type BuiltinRoleKey = (typeof BUILTIN_ROLE_KEYS)[number];

/** A built-in role: unscoped, immutable, assignable (a scope belongs to an assignment, spec 6.5.1). */
export interface RoleDefinition {
  readonly key: BuiltinRoleKey;
  readonly builtin: true;
  readonly assignable: true;
  readonly permissions: readonly RolePermission[];
}

/** A template prefills a role and a scope target (Phase D); it is data, not a role, and not assignable. */
export interface RoleTemplate {
  readonly key: string;
  readonly assignable: false;
  readonly permissions: readonly RolePermission[];
  readonly scopeTarget: ResourceType | null;
}

const full = (permission: Permission): RolePermission =>
  Object.freeze({ permission, qualifier: 'full' as const });

function role(key: BuiltinRoleKey, permissions: readonly Permission[]): RoleDefinition {
  return Object.freeze({
    key,
    builtin: true as const,
    assignable: true as const,
    permissions: Object.freeze(permissions.map(full)),
  });
}

/**
 * The built-in roles (spec 6.9.4): *Eigenaar* 15 permissions, *Beheerder* 13 (all but `rbac:manage` and
 * `settings:connection`), *Operator* 9 (no settings, audit, `rbac:manage` or export), *Helpdesk* 6 (the
 * reader's four plus the two member-write permissions), *Lezer* 4 (read only). 47 rows in all. Every
 * qualifier is `full`; each role lists its permissions in catalogue order.
 */
export const BUILTIN_ROLES: readonly RoleDefinition[] = Object.freeze([
  role('owner', [
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
  ]),
  role('admin', [
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
  ]),
  role('operator', [
    'users:read',
    'groups:read',
    'groups:members:write',
    'distributionlists:read',
    'distributionlists:members:write',
    'contacts:read',
    'contacts:create',
    'contacts:update',
    'contacts:delete',
  ]),
  role('helpdesk', [
    'users:read',
    'groups:read',
    'groups:members:write',
    'distributionlists:read',
    'distributionlists:members:write',
    'contacts:read',
  ]),
  role('reader', ['users:read', 'groups:read', 'distributionlists:read', 'contacts:read']),
]);

/**
 * The template *Bestuur* (key `board`, FR-B-503): create and read contacts, read lists and change their
 * members, and read users with the qualifier `basic`; the suggested scope target is `distributionList`.
 * The order is that of the seed row in migration `0001`. Not assignable, and not an input to effective
 * permissions: Phase D instantiates it as a custom role.
 */
export const TEMPLATES: readonly RoleTemplate[] = Object.freeze([
  Object.freeze({
    key: 'board',
    assignable: false as const,
    permissions: Object.freeze([
      full('contacts:create'),
      full('contacts:read'),
      full('distributionlists:read'),
      full('distributionlists:members:write'),
      Object.freeze({ permission: 'users:read' as const, qualifier: 'basic' as const }),
    ]),
    scopeTarget: 'distributionList' as const,
  }),
]);

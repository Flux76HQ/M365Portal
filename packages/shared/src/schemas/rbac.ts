// Wire schemas of the RBAC routes (tasks T-B-236, CB14; contract sections 7, 11 and 12.1; P27 to P32).
// `GET /api/v1/me/access` (P09) is `MyAccessResponseSchema` in `schemas/auth.ts`, which reuses the
// `ScopeItemSchema` and `GrantSchema` of this file.
//
// Rules of this folder: Zod only, no transform, every schema has `.meta({ id })` (the id is the
// constant name without `Schema`), request schemas are strict (the responses are strict too: a field
// nobody declared is an error, not a silent drop). Normalisation happens in the services through the
// shared normalisers (`rbac/scope.ts`); a scope item here is checked against `SCOPE_MATRIX` and the
// character rules through `normalizeScopeItem`, so the wire accepts exactly what the service can
// store. A query string is text and a route schema has no coercion, so `limit` is the text of a whole
// number (see `PageQuerySchema`).
//
// Importable lazily from the web package (the Phase D assignment screen is a route chunk).
//
// Inferred types drop the `Schema` suffix, except where `rbac/` already exports a pure type of that
// name (`ScopeItem`, `Grant`, `RoleTemplate`): use `z.infer<typeof ...Schema>` or the `rbac/` type.
import { z } from 'zod';
import { LIMITS } from '../limits.js';
import { PermissionSchema } from '../permissions.js';
import { permissionAllowsQualifier } from '../rbac/qualifier.js';
import { QUALIFIERS, RESOURCE_TYPES } from '../rbac/resources.js';
import { normalizeScopeItem } from '../rbac/scope.js';
import {
  CursorSchema,
  GuidSchema,
  IsoTimestampSchema,
  PAGE_LIMIT_MAX,
  PageQuerySchema,
} from './common.js';

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).length;

// ---------------------------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------------------------

/** `user`, `group`, `distributionList` or `contact`. */
export const ResourceTypeSchema = z.enum(RESOURCE_TYPES).meta({ id: 'ResourceType' });

/** `full` or `basic` (`basic` exists only on `users:read`, FR-B-512). */
export const QualifierSchema = z.enum(QUALIFIERS).meta({ id: 'Qualifier' });

/** Who an assignment names: an Entra user or an Entra group. */
export const PrincipalTypeSchema = z.enum(['user', 'group']).meta({ id: 'PrincipalType' });

/** Where an assignment came from. */
export const AssignmentSourceSchema = z
  .enum(['wizard', 'api', 'break_glass'])
  .meta({ id: 'AssignmentSource' });

/** A role or template key: the `rbac_role_key` CHECK (2 to 32 characters, `a-z`, digits, underscore, a letter first). */
export const RoleKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{1,31}$/)
  .meta({ id: 'RoleKey' });

// ---------------------------------------------------------------------------------------------
// Scope items and grants
// ---------------------------------------------------------------------------------------------

const ScopeMatchSchema = z.discriminatedUnion('by', [
  z.strictObject({ by: z.literal('id'), id: GuidSchema }),
  z.strictObject({
    by: z.literal('prefix'),
    attr: z.enum(['displayName', 'alias', 'mail']),
    value: z.string(),
  }),
  z.strictObject({ by: z.literal('department'), value: z.string() }),
]);

/**
 * A scope item (FR-B-513): a target and a match, the combination one the `SCOPE_MATRIX` allows, the
 * value 1 to 64 code points without control, bidi or invisible characters. The value is not changed
 * here (no transform); the service normalises it with `normalizeScopeItem`.
 */
export const ScopeItemSchema = z
  .strictObject({ target: ResourceTypeSchema, match: ScopeMatchSchema })
  .refine((item) => normalizeScopeItem(item).ok, {
    error: 'not a scope item the scope matrix allows',
  })
  .meta({ id: 'ScopeItem' });

/** A permission of a role with its qualifier; `basic` only on `users:read`. */
export const RolePermissionSchema = z
  .strictObject({ permission: PermissionSchema, qualifier: QualifierSchema })
  .refine((entry) => permissionAllowsQualifier(entry.permission, entry.qualifier), {
    error: 'the qualifier basic exists only on users:read',
  })
  .meta({ id: 'RolePermission' });

/**
 * One effective grant (contract section 7): `scope` is `all`, or a non-empty list of scope items that
 * the permission is limited to. A global-only permission is always `all`.
 */
export const GrantSchema = z
  .strictObject({
    permission: PermissionSchema,
    qualifier: QualifierSchema,
    scope: z.union([z.literal('all'), z.array(ScopeItemSchema).min(1)]),
  })
  .refine((grant) => permissionAllowsQualifier(grant.permission, grant.qualifier), {
    error: 'the qualifier basic exists only on users:read',
  })
  .meta({ id: 'Grant' });

// ---------------------------------------------------------------------------------------------
// Roles and templates (P27)
// ---------------------------------------------------------------------------------------------

const permissionsOfRole = z
  .array(RolePermissionSchema)
  .max(15)
  .refine((entries) => new Set(entries.map((entry) => entry.permission)).size === entries.length, {
    error: 'a role lists a permission once',
  });

/** A role as the role list sends it. Display names come from the catalogue by key (FR-B-716). */
export const RoleSchema = z
  .strictObject({
    key: RoleKeySchema,
    builtin: z.boolean(),
    assignable: z.boolean(),
    permissions: permissionsOfRole,
  })
  .meta({ id: 'Role' });

/** A template (*Bestuur*): data that prefills a role and a scope in Phase D; not assignable. */
export const RoleTemplateSchema = z
  .strictObject({
    key: RoleKeySchema,
    permissions: permissionsOfRole,
    scopeTarget: ResourceTypeSchema.nullable(),
  })
  .meta({ id: 'RoleTemplate' });

/** `200` of `GET /api/v1/rbac/roles`. */
export const RoleListResponseSchema = z
  .strictObject({
    roles: z.array(RoleSchema).max(LIMITS.rbac.rolesMax),
    templates: z.array(RoleTemplateSchema).max(32),
  })
  .meta({ id: 'RoleListResponse' });

// ---------------------------------------------------------------------------------------------
// Assignments (P28 to P30)
// ---------------------------------------------------------------------------------------------

/** An assignment as the API sends it. An empty `scope` is an unscoped assignment. */
export const AssignmentSchema = z
  .strictObject({
    id: GuidSchema,
    principalType: PrincipalTypeSchema,
    principalId: GuidSchema,
    role: z.strictObject({ key: RoleKeySchema, builtin: z.boolean() }),
    scope: z.array(ScopeItemSchema).max(LIMITS.rbac.scopeItemsPerAssignmentMax),
    expiresAt: IsoTimestampSchema.nullable(),
    source: AssignmentSourceSchema,
    createdAt: IsoTimestampSchema,
    createdBy: z
      .string()
      .min(1)
      .refine((value) => utf8Bytes(value) <= 64, { error: 'at most 64 bytes' }),
  })
  .meta({ id: 'Assignment' });

/** `GET /api/v1/rbac/assignments?principalId=&role=&limit=&cursor=` (all optional). */
export const AssignmentListQuerySchema = PageQuerySchema.extend({
  principalId: GuidSchema.optional(),
  role: RoleKeySchema.optional(),
}).meta({ id: 'AssignmentListQuery' });

/** `200` of `GET /api/v1/rbac/assignments`; `unresolvable` lists the group ids Graph rejected (U38). */
export const AssignmentListResponseSchema = z
  .strictObject({
    assignments: z.array(AssignmentSchema).max(PAGE_LIMIT_MAX),
    unresolvable: z.array(GuidSchema).max(LIMITS.rbac.groupsBoundMax),
    total: z.int().min(0).max(LIMITS.rbac.assignmentsMax),
    nextCursor: CursorSchema.nullable(),
  })
  .meta({ id: 'AssignmentListResponse' });

/**
 * `POST /api/v1/rbac/assignments`. Strict: the source and the creator are the server's to set. At most
 * 50 scope items; the role is a key; `expiresAt` is validated by the service (future, 730 days).
 */
export const CreateAssignmentRequestSchema = z
  .strictObject({
    principalType: PrincipalTypeSchema,
    principalId: GuidSchema,
    role: RoleKeySchema,
    scope: z.array(ScopeItemSchema).max(LIMITS.rbac.scopeItemsPerAssignmentMax).optional(),
    expiresAt: IsoTimestampSchema.nullable().optional(),
  })
  .meta({ id: 'CreateAssignmentRequest' });

// ---------------------------------------------------------------------------------------------
// Effective permissions (P31) and restore-owner (P32)
// ---------------------------------------------------------------------------------------------

/** `GET /api/v1/rbac/effective?principal=&principalType=`; an absent type means `user`. */
export const EffectiveQuerySchema = z
  .strictObject({ principal: GuidSchema, principalType: PrincipalTypeSchema.optional() })
  .meta({ id: 'EffectiveQuery' });

/** `200` of `GET /api/v1/rbac/effective`. `groupsResolved` is false when Graph could not be asked. */
export const EffectiveResponseSchema = z
  .strictObject({
    principal: z.strictObject({
      type: PrincipalTypeSchema,
      id: GuidSchema,
      label: z
        .string()
        .refine((value) => utf8Bytes(value) <= 256, { error: 'at most 256 bytes' })
        .nullable(),
    }),
    assignments: z
      .array(
        z.strictObject({
          assignment: AssignmentSchema,
          origin: z.discriminatedUnion('type', [
            z.strictObject({ type: z.literal('direct') }),
            z.strictObject({ type: z.literal('group'), groupId: GuidSchema }),
          ]),
        }),
      )
      .max(LIMITS.rbac.assignmentsMax),
    grants: z.array(GrantSchema),
    groupsResolved: z.boolean(),
    resolvedAt: IsoTimestampSchema.nullable(),
  })
  .meta({ id: 'EffectiveResponse' });

/** `POST /api/v1/rbac/restore-owner` (break-glass only). `confirmUnverified` accepts the id as typed when Graph is down. */
export const RestoreOwnerRequestSchema = z
  .strictObject({ userId: GuidSchema, confirmUnverified: z.boolean().optional() })
  .meta({ id: 'RestoreOwnerRequest' });

export type Assignment = z.infer<typeof AssignmentSchema>;
export type Role = z.infer<typeof RoleSchema>;
export type RoleListResponse = z.infer<typeof RoleListResponseSchema>;
export type AssignmentListQuery = z.infer<typeof AssignmentListQuerySchema>;
export type AssignmentListResponse = z.infer<typeof AssignmentListResponseSchema>;
export type CreateAssignmentRequest = z.infer<typeof CreateAssignmentRequestSchema>;
export type EffectiveQuery = z.infer<typeof EffectiveQuerySchema>;
export type EffectiveResponse = z.infer<typeof EffectiveResponseSchema>;
export type RestoreOwnerRequest = z.infer<typeof RestoreOwnerRequestSchema>;

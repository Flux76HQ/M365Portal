// The RBAC repository (T-B-238, FR-B-501, FR-B-503, FR-B-508 rows): every statement that reads or
// writes `rbac_role`, `rbac_role_permission`, `rbac_role_template`, `rbac_assignment`,
// `rbac_assignment_scope`, `rbac_group_member_cache` and `rbac_epoch`, and nothing else. Typed Drizzle
// queries only; no SQL is assembled from strings (FR-A-060).
//
// Every function takes a `DatabaseHandle`. A caller that needs several of them to be all-or-nothing
// (an assignment and its audit entry) passes the `Tx` of its `withTransaction`; a write function takes
// a `Tx` and nothing less, so it cannot run outside `BEGIN IMMEDIATE`. Nothing here opens a
// transaction of its own, so nothing here decides what belongs together.
//
// What the database enforces and this file does not repeat: built-in roles and their permissions are
// immutable (triggers), an `owner` assignment has no expiry, the last user-Owner is protected, every
// change bumps `rbac_epoch`, and a group assignment clears the membership cache. The repository only
// maps the rows to the shapes of `@m365portal/shared/rbac`.
import { createHash } from 'node:crypto';
import { PERMISSIONS, type Permission } from '@m365portal/shared/permissions';
import type { Qualifier, ResourceType } from '@m365portal/shared/rbac/resources';
import type { RolePermission } from '@m365portal/shared/rbac/roles';
import { canonicalScopeKey, type ScopeItem } from '@m365portal/shared/rbac/scope';
import { and, asc, count, eq, gt, inArray, ne, or } from 'drizzle-orm';
import {
  appUser,
  rbacAssignment,
  rbacAssignmentScope,
  rbacEpoch,
  rbacGroupMemberCache,
  rbacRole,
  rbacRoleGrant,
  rbacRoleTemplate,
  type DatabaseHandle,
  type Tx,
} from '../db/index.js';

// ---------------------------------------------------------------------------------------------
// Roles and templates
// ---------------------------------------------------------------------------------------------

export interface RoleRecord {
  readonly id: number;
  readonly key: string;
  readonly builtin: boolean;
  readonly assignable: boolean;
  readonly createdAt: string;
  /** In catalogue order. */
  readonly grants: readonly RolePermission[];
}

export interface TemplateRecord {
  readonly key: string;
  /** A template is data: it is not a role and it is never assignable (FR-B-503). */
  readonly assignable: false;
  readonly grants: readonly RolePermission[];
  readonly scopeTarget: ResourceType | null;
}

const CATALOGUE_ORDER: ReadonlyMap<string, number> = new Map(
  PERMISSIONS.map((permission, index) => [permission, index]),
);

/** The column stores `''` for a full permission and `basic` for the one narrowed form (data-model 5). */
function qualifierOf(stored: string): Qualifier {
  return stored === 'basic' ? 'basic' : 'full';
}

function storedQualifier(qualifier: Qualifier): string {
  return qualifier === 'basic' ? 'basic' : '';
}

function byCatalogue(a: RolePermission, b: RolePermission): number {
  return (CATALOGUE_ORDER.get(a.permission) ?? 999) - (CATALOGUE_ORDER.get(b.permission) ?? 999);
}

function recordsOf(
  roles: readonly (typeof rbacRole.$inferSelect)[],
  grants: readonly (typeof rbacRoleGrant.$inferSelect)[],
): RoleRecord[] {
  const byRole = new Map<number, RolePermission[]>();
  for (const grant of grants) {
    // A row whose permission is not in the catalogue is data the build does not know: it grants nothing.
    if (!CATALOGUE_ORDER.has(grant.permission)) continue;
    const list = byRole.get(grant.roleId) ?? [];
    list.push({
      permission: grant.permission as Permission,
      qualifier: qualifierOf(grant.qualifier),
    });
    byRole.set(grant.roleId, list);
  }
  return roles.map((role) => ({
    id: role.id,
    key: role.key,
    builtin: role.builtin === 1,
    assignable: role.assignable === 1,
    createdAt: role.createdAt,
    grants: (byRole.get(role.id) ?? []).sort(byCatalogue),
  }));
}

/** Every role, built-in first (by id), with its permissions. */
export function listRoles(db: DatabaseHandle): RoleRecord[] {
  const roles = db.orm.select().from(rbacRole).orderBy(asc(rbacRole.id)).all();
  const grants = db.orm.select().from(rbacRoleGrant).all();
  return recordsOf(roles, grants);
}

export function findRoleByKey(db: DatabaseHandle, key: string): RoleRecord | undefined {
  const role = db.orm.select().from(rbacRole).where(eq(rbacRole.key, key)).get();
  if (role === undefined) return undefined;
  const grants = db.orm.select().from(rbacRoleGrant).where(eq(rbacRoleGrant.roleId, role.id)).all();
  return recordsOf([role], grants)[0];
}

export function findRoleById(db: DatabaseHandle, id: number): RoleRecord | undefined {
  const role = db.orm.select().from(rbacRole).where(eq(rbacRole.id, id)).get();
  if (role === undefined) return undefined;
  const grants = db.orm.select().from(rbacRoleGrant).where(eq(rbacRoleGrant.roleId, id)).all();
  return recordsOf([role], grants)[0];
}

/** The role of this key if it exists and may be assigned: a template key is not a role. */
export function findAssignableRole(db: DatabaseHandle, key: string): RoleRecord | undefined {
  const role = findRoleByKey(db, key);
  return role?.assignable === true ? role : undefined;
}

/** The templates, as data. They are never read to compute permissions. */
export function listTemplates(db: DatabaseHandle): TemplateRecord[] {
  return db.orm
    .select()
    .from(rbacRoleTemplate)
    .orderBy(asc(rbacRoleTemplate.key))
    .all()
    .map((row) => {
      const parsed = JSON.parse(row.permissions) as {
        permission: Permission;
        qualifier?: Qualifier;
      }[];
      return {
        key: row.key,
        assignable: false as const,
        grants: parsed.map((entry) => ({
          permission: entry.permission,
          qualifier: entry.qualifier ?? 'full',
        })),
        scopeTarget: (row.scopeTarget as ResourceType | null) ?? null,
      };
    });
}

export interface NewRole {
  readonly key: string;
  readonly createdAt: string;
  readonly grants: readonly RolePermission[];
}

/** A custom role (never built-in, assignable). The built-in five exist only through migration 0001. */
export function insertRole(tx: Tx, role: NewRole): RoleRecord {
  const inserted = tx.orm
    .insert(rbacRole)
    .values({ key: role.key, builtin: 0, assignable: 1, createdAt: role.createdAt })
    .returning({ id: rbacRole.id })
    .get();
  replaceRoleGrants(tx, inserted.id, role.grants);
  const stored = findRoleById(tx, inserted.id);
  if (stored === undefined) throw new Error('the role that was just inserted is missing');
  return stored;
}

/** Replace the grants of a role. A built-in role is refused by the database (immutable). */
export function replaceRoleGrants(tx: Tx, roleId: number, grants: readonly RolePermission[]): void {
  tx.orm.delete(rbacRoleGrant).where(eq(rbacRoleGrant.roleId, roleId)).run();
  const rows = grants.map((entry) => ({
    roleId,
    permission: entry.permission,
    qualifier: storedQualifier(entry.qualifier),
  }));
  if (rows.length > 0) tx.orm.insert(rbacRoleGrant).values(rows).run();
}

/** Delete a custom role. A role with assignments is refused by the foreign key (`restrict`). */
export function deleteRole(tx: Tx, roleId: number): void {
  tx.orm.delete(rbacRole).where(eq(rbacRole.id, roleId)).run();
}

// ---------------------------------------------------------------------------------------------
// The epoch
// ---------------------------------------------------------------------------------------------

/** The counter that every change to roles, permissions, assignments and scopes bumps (FR-B-511). */
export function readEpoch(db: DatabaseHandle): number {
  return (
    db.orm.select({ epoch: rbacEpoch.epoch }).from(rbacEpoch).where(eq(rbacEpoch.id, 1)).get()
      ?.epoch ?? 0
  );
}

// ---------------------------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------------------------

export type PrincipalType = 'user' | 'group';
export type AssignmentSource = 'wizard' | 'api' | 'break_glass';

export interface AssignmentRecord {
  readonly id: string;
  readonly principalType: PrincipalType;
  readonly principalId: string;
  readonly roleId: number;
  readonly roleKey: string;
  readonly scopeHash: string;
  readonly expiresAt: string | null;
  readonly source: AssignmentSource;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly scope: readonly ScopeItem[];
}

/** SHA-256 hex of the canonical key of a scope: the value of `rbac_assignment.scope_hash`. */
export function scopeHashOf(items: readonly ScopeItem[]): string {
  return createHash('sha256').update(canonicalScopeKey(items)).digest('hex');
}

function itemOf(row: typeof rbacAssignmentScope.$inferSelect): ScopeItem {
  const target = row.target as ResourceType;
  if (row.matchBy === 'id') return { target, match: { by: 'id', id: row.value } };
  if (row.matchBy === 'department')
    return { target, match: { by: 'department', value: row.value } };
  return {
    target,
    match: { by: 'prefix', attr: row.attr as 'displayName' | 'alias' | 'mail', value: row.value },
  };
}

function rowOfItem(
  assignmentId: string,
  position: number,
  item: ScopeItem,
): typeof rbacAssignmentScope.$inferInsert {
  const { match } = item;
  return {
    assignmentId,
    position,
    target: item.target,
    matchBy: match.by,
    attr: match.by === 'prefix' ? match.attr : '',
    value: match.by === 'id' ? match.id : match.value,
  };
}

function assignmentsOf(
  db: DatabaseHandle,
  rows: readonly {
    assignment: typeof rbacAssignment.$inferSelect;
    roleKey: string;
  }[],
): AssignmentRecord[] {
  if (rows.length === 0) return [];
  const scopes = db.orm
    .select()
    .from(rbacAssignmentScope)
    .where(
      inArray(
        rbacAssignmentScope.assignmentId,
        rows.map((row) => row.assignment.id),
      ),
    )
    .orderBy(asc(rbacAssignmentScope.assignmentId), asc(rbacAssignmentScope.position))
    .all();
  const byAssignment = new Map<string, ScopeItem[]>();
  for (const scope of scopes) {
    const list = byAssignment.get(scope.assignmentId) ?? [];
    list.push(itemOf(scope));
    byAssignment.set(scope.assignmentId, list);
  }
  return rows.map(({ assignment, roleKey }) => ({
    id: assignment.id,
    principalType: assignment.principalType as PrincipalType,
    principalId: assignment.principalId,
    roleId: assignment.roleId,
    roleKey,
    scopeHash: assignment.scopeHash,
    expiresAt: assignment.expiresAt,
    source: assignment.source as AssignmentSource,
    createdAt: assignment.createdAt,
    createdBy: assignment.createdBy,
    scope: byAssignment.get(assignment.id) ?? [],
  }));
}

/**
 * The assignments that name this user or one of these groups, expired or not (the caller applies
 * `computeGrants`, which decides what is active at its instant).
 */
export function listAssignmentsOf(
  db: DatabaseHandle,
  principals: { readonly userOid: string; readonly groupIds: readonly string[] },
): AssignmentRecord[] {
  const userRow = and(
    eq(rbacAssignment.principalType, 'user'),
    eq(rbacAssignment.principalId, principals.userOid.toLowerCase()),
  );
  const rows = db.orm
    .select({ assignment: rbacAssignment, roleKey: rbacRole.key })
    .from(rbacAssignment)
    .innerJoin(rbacRole, eq(rbacRole.id, rbacAssignment.roleId))
    .where(
      principals.groupIds.length === 0
        ? userRow
        : or(
            userRow,
            and(
              eq(rbacAssignment.principalType, 'group'),
              inArray(
                rbacAssignment.principalId,
                principals.groupIds.map((id) => id.toLowerCase()),
              ),
            ),
          ),
    )
    .orderBy(asc(rbacAssignment.createdAt), asc(rbacAssignment.id))
    .all();
  return assignmentsOf(db, rows);
}

export function findAssignment(db: DatabaseHandle, id: string): AssignmentRecord | undefined {
  const rows = db.orm
    .select({ assignment: rbacAssignment, roleKey: rbacRole.key })
    .from(rbacAssignment)
    .innerJoin(rbacRole, eq(rbacRole.id, rbacAssignment.roleId))
    .where(eq(rbacAssignment.id, id.toLowerCase()))
    .all();
  return assignmentsOf(db, rows)[0];
}

export interface NewAssignment {
  readonly id: string;
  readonly principalType: PrincipalType;
  readonly principalId: string;
  readonly roleId: number;
  readonly expiresAt: string | null;
  readonly source: AssignmentSource;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly scope: readonly ScopeItem[];
}

/** Insert an assignment and its scope rows. The caller has validated everything (assignment service). */
export function insertAssignment(tx: Tx, assignment: NewAssignment): void {
  tx.orm
    .insert(rbacAssignment)
    .values({
      id: assignment.id.toLowerCase(),
      principalType: assignment.principalType,
      principalId: assignment.principalId.toLowerCase(),
      roleId: assignment.roleId,
      scopeHash: scopeHashOf(assignment.scope),
      expiresAt: assignment.expiresAt,
      source: assignment.source,
      createdAt: assignment.createdAt,
      createdBy: assignment.createdBy,
    })
    .run();
  const rows = assignment.scope.map((item, position) =>
    rowOfItem(assignment.id.toLowerCase(), position, item),
  );
  if (rows.length > 0) tx.orm.insert(rbacAssignmentScope).values(rows).run();
}

/** Delete an assignment (its scope rows cascade). The last user-Owner is protected by a trigger. */
export function deleteAssignment(tx: Tx, id: string): boolean {
  return (
    tx.orm.delete(rbacAssignment).where(eq(rbacAssignment.id, id.toLowerCase())).run().changes > 0
  );
}

// ---------------------------------------------------------------------------------------------
// Resolved group membership (the cache)
// ---------------------------------------------------------------------------------------------

/** The groups the cache holds for a user: what the last refresh found (FR-B-507). */
export function listCachedGroupIds(db: DatabaseHandle, userOid: string): string[] {
  return db.orm
    .select({ groupId: rbacGroupMemberCache.groupId })
    .from(rbacGroupMemberCache)
    .where(eq(rbacGroupMemberCache.userOid, userOid.toLowerCase()))
    .orderBy(asc(rbacGroupMemberCache.groupId))
    .all()
    .map((row) => row.groupId);
}

/** The distinct Entra groups some assignment names, in id order (the groups to resolve, FR-B-507). */
export function listBoundGroupIds(db: DatabaseHandle): string[] {
  return db.orm
    .selectDistinct({ id: rbacAssignment.principalId })
    .from(rbacAssignment)
    .where(eq(rbacAssignment.principalType, 'group'))
    .orderBy(asc(rbacAssignment.principalId))
    .all()
    .map((row) => row.id);
}

/**
 * Replace what the cache holds for a user with the groups just found, and stamp the resolution time on
 * the user (`app_user.groups_resolved_at`), in the caller's transaction. A user the sign-in has not
 * written yet has no `app_user` row: the cache rows are still stored, and the time stays unset.
 */
export function replaceMemberCache(
  tx: Tx,
  userOid: string,
  groupIds: readonly string[],
  resolvedAt: string,
): void {
  const oid = userOid.toLowerCase();
  tx.orm.delete(rbacGroupMemberCache).where(eq(rbacGroupMemberCache.userOid, oid)).run();
  const rows = groupIds.map((groupId) => ({
    userOid: oid,
    groupId: groupId.toLowerCase(),
    resolvedAt,
  }));
  if (rows.length > 0) tx.orm.insert(rbacGroupMemberCache).values(rows).run();
  tx.orm.update(appUser).set({ groupsResolvedAt: resolvedAt }).where(eq(appUser.oid, oid)).run();
}

/** Forget what the cache holds for a user and mark the groups as not resolved (rights from groups end). */
export function dropMemberCache(tx: Tx, userOid: string): void {
  const oid = userOid.toLowerCase();
  tx.orm.delete(rbacGroupMemberCache).where(eq(rbacGroupMemberCache.userOid, oid)).run();
  tx.orm.update(appUser).set({ groupsResolvedAt: null }).where(eq(appUser.oid, oid)).run();
}

/** `app_user.groups_resolved_at` of a user, or `null` when never resolved or unknown. */
export function readGroupsResolvedAt(db: DatabaseHandle, userOid: string): string | null {
  return (
    db.orm
      .select({ at: appUser.groupsResolvedAt })
      .from(appUser)
      .where(eq(appUser.oid, userOid.toLowerCase()))
      .get()?.at ?? null
  );
}

// ---------------------------------------------------------------------------------------------
// Counts and lookups for the assignment service (limits, duplicates, the last Owner)
// ---------------------------------------------------------------------------------------------

export function countAssignments(db: DatabaseHandle): number {
  return db.orm.select({ n: count() }).from(rbacAssignment).get()?.n ?? 0;
}

export function countRoles(db: DatabaseHandle): number {
  return db.orm.select({ n: count() }).from(rbacRole).get()?.n ?? 0;
}

/** Does some assignment already name this group? */
export function isGroupBound(db: DatabaseHandle, groupId: string): boolean {
  return (
    db.orm
      .select({ n: count() })
      .from(rbacAssignment)
      .where(
        and(
          eq(rbacAssignment.principalType, 'group'),
          eq(rbacAssignment.principalId, groupId.toLowerCase()),
        ),
      )
      .get()?.n !== 0
  );
}

/** The id of the assignment with the same principal, role and scope set, if there is one. */
export function findDuplicateAssignment(
  db: DatabaseHandle,
  key: {
    readonly principalType: PrincipalType;
    readonly principalId: string;
    readonly roleId: number;
    readonly scope: readonly ScopeItem[];
  },
): string | undefined {
  return db.orm
    .select({ id: rbacAssignment.id })
    .from(rbacAssignment)
    .where(
      and(
        eq(rbacAssignment.principalType, key.principalType),
        eq(rbacAssignment.principalId, key.principalId.toLowerCase()),
        eq(rbacAssignment.roleId, key.roleId),
        eq(rbacAssignment.scopeHash, scopeHashOf(key.scope)),
      ),
    )
    .get()?.id;
}

/** How many assignments of `owner` to a USER exist, not counting `excludingId` (groups never count). */
export function countUserOwnersExcept(db: DatabaseHandle, excludingId: string): number {
  return (
    db.orm
      .select({ n: count() })
      .from(rbacAssignment)
      .innerJoin(rbacRole, eq(rbacRole.id, rbacAssignment.roleId))
      .where(
        and(
          eq(rbacRole.key, 'owner'),
          eq(rbacAssignment.principalType, 'user'),
          ne(rbacAssignment.id, excludingId.toLowerCase()),
        ),
      )
      .get()?.n ?? 0
  );
}

/** A page of assignments in the order of the API: `createdAt`, then `id`. */
export function listAssignmentsPage(
  db: DatabaseHandle,
  filter: {
    readonly principalId?: string | undefined;
    readonly roleKey?: string | undefined;
    readonly after?: { readonly createdAt: string; readonly id: string } | undefined;
    readonly limit: number;
  },
): { readonly records: AssignmentRecord[]; readonly total: number } {
  const matches = and(
    filter.principalId === undefined
      ? undefined
      : eq(rbacAssignment.principalId, filter.principalId.toLowerCase()),
    filter.roleKey === undefined ? undefined : eq(rbacRole.key, filter.roleKey),
  );
  const total =
    db.orm
      .select({ n: count() })
      .from(rbacAssignment)
      .innerJoin(rbacRole, eq(rbacRole.id, rbacAssignment.roleId))
      .where(matches)
      .get()?.n ?? 0;
  const afterClause =
    filter.after === undefined
      ? undefined
      : or(
          gt(rbacAssignment.createdAt, filter.after.createdAt),
          and(
            eq(rbacAssignment.createdAt, filter.after.createdAt),
            gt(rbacAssignment.id, filter.after.id),
          ),
        );
  const rows = db.orm
    .select({ assignment: rbacAssignment, roleKey: rbacRole.key })
    .from(rbacAssignment)
    .innerJoin(rbacRole, eq(rbacRole.id, rbacAssignment.roleId))
    .where(and(matches, afterClause))
    .orderBy(asc(rbacAssignment.createdAt), asc(rbacAssignment.id))
    .limit(filter.limit)
    .all();
  return { records: assignmentsOf(db, rows), total };
}

/** The assignments that name exactly this principal (a user, or a group on its own), expired or not. */
export function listAssignmentsOfPrincipal(
  db: DatabaseHandle,
  principalType: PrincipalType,
  principalId: string,
): AssignmentRecord[] {
  const rows = db.orm
    .select({ assignment: rbacAssignment, roleKey: rbacRole.key })
    .from(rbacAssignment)
    .innerJoin(rbacRole, eq(rbacRole.id, rbacAssignment.roleId))
    .where(
      and(
        eq(rbacAssignment.principalType, principalType),
        eq(rbacAssignment.principalId, principalId.toLowerCase()),
      ),
    )
    .orderBy(asc(rbacAssignment.createdAt), asc(rbacAssignment.id))
    .all();
  return assignmentsOf(db, rows);
}

/** The last-known display label of a user (name, else UPN), or `null` when the user never signed in. */
export function readUserLabel(db: DatabaseHandle, userOid: string): string | null {
  const row = db.orm
    .select({ name: appUser.nameLabel, upn: appUser.upnLabel })
    .from(appUser)
    .where(eq(appUser.oid, userOid.toLowerCase()))
    .get();
  return row?.name ?? row?.upn ?? null;
}

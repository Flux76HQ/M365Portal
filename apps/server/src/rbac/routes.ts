// The RBAC routes P27 to P31 (T-B-250, FR-B-508, contract section 7). All need `rbac:manage`, a
// global-only permission, so no scope applies (`unscopedReason`). Reads need no step-up; creating and
// deleting need it from a user, and accept the actor kind `user` only (SB-03), so a break-glass
// session never reaches them, even with a custom role that holds only `rbac:manage` (FR-B-523).
//
//   P27 rbac.roles.list          GET    /api/v1/rbac/roles
//   P28 rbac.assignments.list    GET    /api/v1/rbac/assignments
//   P29 rbac.assignments.create  POST   /api/v1/rbac/assignments           audit rbac.assignment.create
//   P30 rbac.assignments.delete  DELETE /api/v1/rbac/assignments/{id}      audit rbac.assignment.delete
//   P31 rbac.effective           GET    /api/v1/rbac/effective?principal=
//
// The success audit entry is written by the assignment service in the transaction of the change; the
// denial audit entry (permission, step-up, escalation, last Owner) is the wrapper's.
import { computeGrants, isAssignmentActive } from '@m365portal/shared/rbac/effective';
import { roleToWire, templateToWire } from '@m365portal/shared/rbac/roles';
import { GuidSchema, pageLimitOf } from '@m365portal/shared/schemas/common';
import {
  AssignmentListQuerySchema,
  AssignmentListResponseSchema,
  AssignmentSchema,
  CreateAssignmentRequestSchema,
  EffectiveQuerySchema,
  EffectiveResponseSchema,
  RoleListResponseSchema,
  type EffectiveResponse,
} from '@m365portal/shared/schemas/rbac';
import { z } from 'zod';
import { ProblemError } from '../http/problem.js';
import { defineRoute, type RouteDefinition } from '../http/route.js';
import { problemAnswer, auditContextOf, serviceActorOf, type RbacContext } from './context.js';
import {
  listAssignmentsOf,
  listAssignmentsOfPrincipal,
  listAssignmentsPage,
  listCachedGroupIds,
  listRoles,
  listTemplates,
  readGroupsResolvedAt,
  readUserLabel,
  type AssignmentRecord,
  type RoleRecord,
} from './repository.js';
import { assignmentToWire, decodeCursor, encodeCursor } from './wire.js';

const UNSCOPED_REASON =
  'rbac:manage is a global-only permission: it has no resource type, so no scope applies';

const PathParams = z.object({ id: z.string() });

export function rbacRoutes(ctx: RbacContext): RouteDefinition[] {
  const { deps } = ctx;

  const builtinKeys = (roles: readonly RoleRecord[]): ReadonlySet<string> =>
    new Set(roles.filter((role) => role.builtin).map((role) => role.key));

  /** The display name of a group, best effort: the label is for people, never for decisions. */
  async function groupLabel(id: string): Promise<string | null> {
    try {
      return (await deps.clients.graph().getGroup(id))?.displayName ?? null;
    } catch {
      return null;
    }
  }

  return [
    defineRoute({
      id: 'rbac.roles.list',
      method: 'GET',
      path: '/api/v1/rbac/roles',
      access: { permission: 'rbac:manage', unscopedReason: UNSCOPED_REASON },
      rateLimit: 'read',
      summary: 'The roles and templates',
      description:
        'Every role with its permissions and qualifiers, and the templates. Display names come from the catalogue by key. A template is not assignable.',
      responses: {
        200: {
          description: 'The roles and templates.',
          content: { 'application/json': { schema: RoleListResponseSchema } },
        },
        503: problemAnswer('Storage is unavailable.'),
      },
      handler: (c) => {
        const db = deps.requireDatabase();
        return c.json(
          {
            roles: listRoles(db).map((role) => roleToWire(role)),
            templates: listTemplates(db).map((template) => templateToWire(template)),
          },
          200,
        );
      },
    }),

    defineRoute({
      id: 'rbac.assignments.list',
      method: 'GET',
      path: '/api/v1/rbac/assignments',
      access: { permission: 'rbac:manage', unscopedReason: UNSCOPED_REASON },
      rateLimit: 'read',
      summary: 'The assignments',
      description:
        'Assignments in the order createdAt, then id, filtered by principal and role. `unresolvable` lists the bound group ids that Graph rejected during the last membership refresh.',
      request: { query: AssignmentListQuerySchema },
      responses: {
        200: {
          description: 'A page of assignments.',
          content: { 'application/json': { schema: AssignmentListResponseSchema } },
        },
        422: problemAnswer('The query is not valid.'),
        503: problemAnswer('Storage is unavailable.'),
      },
      handler: (c, input) => {
        const db = deps.requireDatabase();
        const limit = pageLimitOf(input.query);
        const page = listAssignmentsPage(db, {
          principalId: input.query.principalId,
          roleKey: input.query.role,
          after: input.query.cursor === undefined ? undefined : decodeCursor(input.query.cursor),
          limit: limit + 1,
        });
        const records = page.records.slice(0, limit);
        const last = records.at(-1);
        const builtin = builtinKeys(listRoles(db));
        const bound = new Set(
          (
            db.sqlite
              .prepare(
                "SELECT DISTINCT principal_id FROM rbac_assignment WHERE principal_type = 'group'",
              )
              .all() as { principal_id: string }[]
          ).map((row) => row.principal_id),
        );
        return c.json(
          {
            assignments: records.map((record) => assignmentToWire(record, builtin)),
            unresolvable: ctx.membership.unresolvable().filter((id) => bound.has(id)),
            total: page.total,
            nextCursor:
              page.records.length > limit && last !== undefined
                ? encodeCursor({ createdAt: last.createdAt, id: last.id })
                : null,
          },
          200,
        );
      },
    }),

    defineRoute({
      id: 'rbac.assignments.create',
      method: 'POST',
      path: '/api/v1/rbac/assignments',
      access: {
        permission: 'rbac:manage',
        stepUp: true,
        actorKinds: ['user'],
        unscopedReason: UNSCOPED_REASON,
      },
      rateLimit: 'write',
      audit: 'rbac.assignment.create',
      summary: 'Assign a role',
      description:
        'Gives a user or an Entra group a role, optionally scoped and expiring. The caller must be able to grant the role with that scope (no privilege escalation). Validation order: role, owner rules, group rule, scope, expiry, escalation, principal in the directory, then the write with the limits.',
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: CreateAssignmentRequestSchema } },
        },
      },
      responses: {
        201: {
          description: 'The assignment.',
          content: { 'application/json': { schema: AssignmentSchema } },
        },
        403: problemAnswer('Not allowed: permission, step-up or escalation.'),
        409: problemAnswer('The assignment exists.'),
        422: problemAnswer('The assignment or the principal is not valid.'),
        503: problemAnswer('Graph or storage is unavailable.'),
      },
      handler: async (c, input) => {
        const record = await ctx.assignments.create(
          serviceActorOf(c),
          input.body,
          auditContextOf(c),
        );
        const builtin = builtinKeys(listRoles(deps.requireDatabase()));
        return c.json(assignmentToWire(record, builtin), 201, {
          Location: `/api/v1/rbac/assignments/${record.id}`,
        });
      },
    }),

    defineRoute({
      id: 'rbac.assignments.delete',
      method: 'DELETE',
      path: '/api/v1/rbac/assignments/{id}',
      access: {
        permission: 'rbac:manage',
        stepUp: true,
        actorKinds: ['user'],
        unscopedReason: UNSCOPED_REASON,
      },
      rateLimit: 'write',
      audit: 'rbac.assignment.delete',
      summary: 'Remove an assignment',
      description:
        'Nobody removes what they could not grant. The last user Owner cannot be removed (the check runs in the write transaction, the SQL trigger is the backstop).',
      request: { params: PathParams },
      responses: {
        204: { description: 'Removed.' },
        403: problemAnswer('Not allowed: permission, step-up or escalation.'),
        404: problemAnswer('No such assignment.'),
        409: problemAnswer('The change would leave no Owner.'),
        503: problemAnswer('Storage is unavailable.'),
      },
      handler: async (c, input) => {
        // An id that is not a GUID is the standard 404, the same answer as an unknown one.
        if (!GuidSchema.safeParse(input.params.id).success) throw new ProblemError('not_found');
        await ctx.assignments.remove(serviceActorOf(c), input.params.id, auditContextOf(c));
        return c.body(null, 204);
      },
    }),

    defineRoute({
      id: 'rbac.effective',
      method: 'GET',
      path: '/api/v1/rbac/effective',
      access: { permission: 'rbac:manage', unscopedReason: UNSCOPED_REASON },
      rateLimit: 'read',
      summary: 'The effective permissions of a principal',
      description:
        'The active assignments of a user (direct, and through bound groups) or of a group, and the grants they give. Group memberships come from the cache while it is inside the TTL, otherwise from a live check that is not stored. When Graph fails the answer holds the direct assignments only and `groupsResolved` is false.',
      request: { query: EffectiveQuerySchema },
      responses: {
        200: {
          description: 'The effective permissions.',
          content: { 'application/json': { schema: EffectiveResponseSchema } },
        },
        422: problemAnswer('The query is not valid.'),
        503: problemAnswer('Storage is unavailable.'),
      },
      handler: async (c, input) => {
        const db = deps.requireDatabase();
        const now = new Date(deps.now());
        const type = input.query.principalType ?? 'user';
        const principalId = input.query.principal.toLowerCase();
        const roles = listRoles(db);
        const builtin = builtinKeys(roles);
        const grantsOfRole = new Map(roles.map((role) => [role.key, role.grants]));

        let records: AssignmentRecord[];
        let groupsResolved = true;
        let resolvedAt: string | null = null;
        let label: string | null;
        let groupIds: readonly string[] = [];

        if (type === 'group') {
          records = listAssignmentsOfPrincipal(db, 'group', principalId);
          label = await groupLabel(principalId);
        } else {
          const cached = readGroupsResolvedAt(db, principalId);
          if (ctx.membership.isFresh(cached)) {
            groupIds = listCachedGroupIds(db, principalId);
            resolvedAt = cached;
          } else {
            // Live, and not written: a view must not change what the sign-in relies on (CD-06).
            let live;
            try {
              live = await ctx.membership.live(principalId);
            } catch {
              live = undefined;
            }
            if (live?.ok === true) {
              groupIds = live.groupIds;
              resolvedAt = live.resolvedAt;
            } else {
              groupsResolved = false;
            }
          }
          records = listAssignmentsOf(db, { userOid: principalId, groupIds });
          label = readUserLabel(db, principalId);
        }

        const active = records.filter((record) => isAssignmentActive(record.expiresAt, now));
        const grants = computeGrants(
          active.map((record) => ({
            principalType: record.principalType,
            permissions: grantsOfRole.get(record.roleKey) ?? [],
            scope: record.scope,
            expiresAt: record.expiresAt,
          })),
          now,
        );
        const body: EffectiveResponse = {
          principal: { type, id: principalId, label },
          assignments: active.map((record) => ({
            assignment: assignmentToWire(record, builtin),
            origin:
              record.principalType === 'group'
                ? ({ type: 'group', groupId: record.principalId } as const)
                : ({ type: 'direct' } as const),
          })),
          grants: grants.map((grant) => ({
            permission: grant.permission,
            qualifier: grant.qualifier,
            scope: grant.scope === 'all' ? 'all' : grant.scope.map((item) => structuredClone(item)),
          })),
          groupsResolved,
          resolvedAt,
        };
        return c.json(body, 200);
      },
    }),
  ];
}

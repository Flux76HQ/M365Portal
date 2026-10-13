// The groups routes P36 to P39 (T-C-023, FR-C-301, FR-C-304 to FR-C-306, FR-C-108, EC-C7 to EC-C10).
// All are GET, class `read`, access `permission` with `scoped: 'group'`.
//
//   P36 groups.list     GET /api/v1/groups                  the groups the caller may see, paged, no total
//   P37 groups.get      GET /api/v1/groups/{id}             404 unknown, 403 out of scope (ODB-11)
//   P38 groups.owners   GET /api/v1/groups/{id}/owners      rows cut to restricted rows by the caller's scopes
//   P39 groups.members  GET /api/v1/groups/{id}/members     a hidden membership makes no Graph call
//
// The members and owners of a group are cut by the scopes of the caller to users and groups
// (`restricted-rows.ts`): the caller needs groups:read for the group (the route's permission) and gets
// the objects in it in full only where users:read or groups:read covers them (FR-C-307).
import {
  DirectoryPageQuerySchema,
  GroupDetailSchema,
  GroupIdParamsSchema,
  GroupListQuerySchema,
  GroupListResponseSchema,
  MembersResponseSchema,
  OwnersResponseSchema,
} from '@m365portal/shared/schemas/directory';
import { ProblemError } from '../http/problem.js';
import { defineRoute, type RouteDefinition } from '../http/route.js';
import type { PolicyContext } from '../policy/index.js';
import { problemAnswer, type DirectoryContext } from './context.js';
import { groupResource } from './mappers.js';

export function groupsRoutes(directory: DirectoryContext): RouteDefinition[] {
  const { groups } = directory;

  /** Reads the group, 404 when unknown, then asks whether the caller may see this one (403 if not). */
  async function authorizedGroup(ctx: PolicyContext, id: string) {
    const group = await groups.find(id);
    if (group === null) throw new ProblemError('not_found');
    return { group, authorized: ctx.authorizeResource('groups:read', groupResource(group)) };
  }

  return [
    defineRoute({
      id: 'groups.list',
      method: 'GET',
      path: '/api/v1/groups',
      access: { permission: 'groups:read', scoped: 'group' },
      rateLimit: 'read',
      summary: 'The groups',
      description:
        'Groups the caller may see, sorted by display name, with a prefix search on name, mail and mail nickname and a filter on kind (Microsoft 365, security, mail-enabled security, distribution). Dynamic distribution groups are not returned by Graph. Paged with a cursor; there is no total.',
      request: { query: GroupListQuerySchema },
      responses: {
        200: {
          description: 'A page of groups and the cursor of the next one.',
          content: { 'application/json': { schema: GroupListResponseSchema } },
        },
        400: problemAnswer('The cursor is unknown, expired or not the caller’s (cursor_invalid).'),
        422: problemAnswer('The query is not valid.'),
        503: problemAnswer('Graph is unavailable, throttled or lacks a permission.'),
      },
      handler: async (c, input, ctx) => {
        const scope = ctx.visibleScopes('groups:read');
        return c.json(
          await groups.list({ scope, actorId: c.get('actor').id, query: input.query }),
          200,
        );
      },
    }),

    defineRoute({
      id: 'groups.get',
      method: 'GET',
      path: '/api/v1/groups/{id}',
      access: { permission: 'groups:read', scoped: 'group' },
      rateLimit: 'read',
      summary: 'A group',
      description:
        'Core properties, the kind, the visibility and the membership type. A group outside the caller’s scope is 403, an unknown id 404.',
      request: { params: GroupIdParamsSchema },
      responses: {
        200: {
          description: 'The group.',
          content: { 'application/json': { schema: GroupDetailSchema } },
        },
        403: problemAnswer('The group is outside the caller’s scope (permission_denied).'),
        404: problemAnswer('No such group.'),
        503: problemAnswer('Graph is unavailable, throttled or lacks a permission.'),
      },
      handler: async (c, input, ctx) => {
        const { group, authorized } = await authorizedGroup(ctx, input.params.id);
        return c.json(await groups.detail({ authorized, group }), 200);
      },
    }),

    defineRoute({
      id: 'groups.owners',
      method: 'GET',
      path: '/api/v1/groups/{id}/owners',
      access: { permission: 'groups:read', scoped: 'group' },
      rateLimit: 'read',
      summary: 'The owners of a group',
      description:
        'Owners, paged. An owner the caller may not see is a restricted row without id, name or address. For distribution, mail-enabled security and synced groups Graph has no owners and the answer says so (ownersState not_available).',
      request: { params: GroupIdParamsSchema, query: DirectoryPageQuerySchema },
      responses: {
        200: {
          description: 'A page of owners and the cursor of the next one.',
          content: { 'application/json': { schema: OwnersResponseSchema } },
        },
        400: problemAnswer('The cursor is unknown, expired or not the caller’s (cursor_invalid).'),
        403: problemAnswer('The group is outside the caller’s scope (permission_denied).'),
        404: problemAnswer('No such group.'),
        503: problemAnswer('Graph is unavailable, throttled or lacks a permission.'),
      },
      handler: async (c, input, ctx) => {
        const { group, authorized } = await authorizedGroup(ctx, input.params.id);
        const body = await groups.owners({
          authorized,
          group,
          users: ctx.visibleScopes('users:read'),
          groups: ctx.visibleScopes('groups:read'),
          actorId: c.get('actor').id,
          query: input.query,
        });
        return c.json(body, 200);
      },
    }),

    defineRoute({
      id: 'groups.members',
      method: 'GET',
      path: '/api/v1/groups/{id}/members',
      access: { permission: 'groups:read', scoped: 'group' },
      rateLimit: 'read',
      summary: 'The members of a group',
      description:
        'Direct members, paged. A member the caller may not see is a restricted row without id, name or address. A group with a hidden membership answers membersState hidden and Graph is not asked.',
      request: { params: GroupIdParamsSchema, query: DirectoryPageQuerySchema },
      responses: {
        200: {
          description: 'A page of members and the cursor of the next one.',
          content: { 'application/json': { schema: MembersResponseSchema } },
        },
        400: problemAnswer('The cursor is unknown, expired or not the caller’s (cursor_invalid).'),
        403: problemAnswer('The group is outside the caller’s scope (permission_denied).'),
        404: problemAnswer('No such group.'),
        503: problemAnswer('Graph is unavailable, throttled or lacks a permission.'),
      },
      handler: async (c, input, ctx) => {
        const { group, authorized } = await authorizedGroup(ctx, input.params.id);
        const body = await groups.members({
          authorized,
          group,
          users: ctx.visibleScopes('users:read'),
          groups: ctx.visibleScopes('groups:read'),
          actorId: c.get('actor').id,
          query: input.query,
        });
        return c.json(body, 200);
      },
    }),
  ];
}

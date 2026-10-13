// The users routes P33 to P35 (T-C-022, FR-C-201, FR-C-205, FR-C-206, EC-C1 to EC-C6, EC-C15). All are
// GET, class `read`, access `permission` with `scoped: 'user'`; every handler asks the policy layer
// (`ctx.visibleScopes` or `ctx.authorizeResource`) or the wrapper answers 500 `policy_not_applied`.
//
//   P33 users.list    GET /api/v1/users                 the users the actor may see, paged, no total
//   P34 users.get     GET /api/v1/users/{id}            404 for an unknown id, 403 for one out of scope (ODB-11)
//   P35 users.groups  GET /api/v1/users/{id}/groups     needs users:read on the user AND groups:read
//
// Successful reads are not audited; a denial is (the wrapper, FR-B-602). Nothing is written.
import {
  DirectoryPageQuerySchema,
  UserDetailSchema,
  UserGroupsResponseSchema,
  UserIdParamsSchema,
  UserListQuerySchema,
  UserListResponseSchema,
} from '@m365portal/shared/schemas/directory';
import { ProblemError } from '../http/problem.js';
import { defineRoute, type RouteDefinition } from '../http/route.js';
import { ResourceDenied } from '../policy/index.js';
import { problemAnswer, type DirectoryContext } from './context.js';
import { userResource } from './mappers.js';
import { seesNothing } from './scoped-list.js';

export function usersRoutes(directory: DirectoryContext): RouteDefinition[] {
  const { users } = directory;

  return [
    defineRoute({
      id: 'users.list',
      method: 'GET',
      path: '/api/v1/users',
      access: { permission: 'users:read', scoped: 'user' },
      rateLimit: 'read',
      summary: 'The users',
      description:
        'Users the caller may see, sorted by display name, with a prefix search on name, mail and principal name and filters on state and type. Paged with a cursor; there is no total. A user the caller sees only through a basic grant has id, display name and mail only, and the state and type filters are refused then.',
      request: { query: UserListQuerySchema },
      responses: {
        200: {
          description: 'A page of users and the cursor of the next one.',
          content: { 'application/json': { schema: UserListResponseSchema } },
        },
        400: problemAnswer('The cursor is unknown, expired or not the caller’s (cursor_invalid).'),
        422: problemAnswer('The query is not valid, or a filter is not allowed for a basic grant.'),
        503: problemAnswer('Graph is unavailable, throttled or lacks a permission.'),
      },
      handler: async (c, input, ctx) => {
        const scope = ctx.visibleScopes('users:read');
        const body = await users.list({ scope, actorId: c.get('actor').id, query: input.query });
        return c.json(body, 200);
      },
    }),

    defineRoute({
      id: 'users.get',
      method: 'GET',
      path: '/api/v1/users/{id}',
      access: { permission: 'users:read', scoped: 'user' },
      rateLimit: 'read',
      summary: 'A user',
      description:
        'Core properties, the manager (present, none or not available). A user outside the caller’s scope is 403, an unknown id 404. A basic grant gives id, display name and mail only.',
      request: { params: UserIdParamsSchema },
      responses: {
        200: {
          description: 'The user.',
          content: { 'application/json': { schema: UserDetailSchema } },
        },
        403: problemAnswer('The user is outside the caller’s scope (permission_denied).'),
        404: problemAnswer('No such user.'),
        503: problemAnswer('Graph is unavailable, throttled or lacks a permission.'),
      },
      handler: async (c, input, ctx) => {
        const user = await users.find(input.params.id);
        if (user === null) throw new ProblemError('not_found');
        const authorized = ctx.authorizeResource('users:read', userResource(user));
        const scope = ctx.visibleScopes('users:read');
        return c.json(await users.detail({ authorized, scope, user }), 200);
      },
    }),

    defineRoute({
      id: 'users.groups',
      method: 'GET',
      path: '/api/v1/users/{id}/groups',
      access: { permission: 'users:read', scoped: 'user' },
      rateLimit: 'read',
      summary: 'The groups of a user',
      description:
        'The groups the user belongs to, nested groups included, cut to the groups the caller may see (a group the caller may not see is left out, never shown as restricted). Needs users:read on the user in full and groups:read. A group with a hidden membership may be missing.',
      request: { params: UserIdParamsSchema, query: DirectoryPageQuerySchema },
      responses: {
        200: {
          description: 'A page of groups and the cursor of the next one.',
          content: { 'application/json': { schema: UserGroupsResponseSchema } },
        },
        400: problemAnswer('The cursor is unknown, expired or not the caller’s (cursor_invalid).'),
        403: problemAnswer(
          'The user is outside the scope, or the caller reads no groups, or only basic.',
        ),
        404: problemAnswer('No such user.'),
        503: problemAnswer('Graph is unavailable, throttled or lacks a permission.'),
      },
      handler: async (c, input, ctx) => {
        const user = await users.find(input.params.id);
        if (user === null) throw new ProblemError('not_found');
        const authorized = ctx.authorizeResource('users:read', userResource(user));
        const groups = ctx.visibleScopes('groups:read');
        // The route declares users:read; the second permission is asked here (FR-C-206).
        if (seesNothing(groups.scopes))
          throw new ResourceDenied('groups:read', 'permission_missing');
        // Memberships are not part of a basic grant (FR-C-204).
        if (authorized.qualifier !== 'full')
          throw new ResourceDenied('users:read', 'permission_missing');
        const body = await users.groups({
          authorized,
          groups,
          actorId: c.get('actor').id,
          query: input.query,
        });
        return c.json(body, 200);
      },
    }),
  ];
}

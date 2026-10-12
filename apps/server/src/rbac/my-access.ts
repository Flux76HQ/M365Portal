// `GET /api/v1/me/access`, "Mijn toegang" (T-B-251, FR-B-514 server half, P09, US-B12). Open to a user and
// to a break-glass session (the setup actor is not authenticated in this sense and gets 401). Read-only.
//
//   user         the active assignments of the user, direct or through a group of the cached
//                membership, with scope items, expiry and the name of the group (best effort: the
//                60-second cached `getGroup`, else `null`); the grants the resolver computed for this
//                request; whether the group part may be out of date and when it was resolved
//   break_glass  no assignments and the single grant `rbac:manage`, `full`, `all`
import { isAssignmentActive } from '@m365portal/shared/rbac/effective';
import { MyAccessResponseSchema } from '@m365portal/shared/schemas/auth';
import type { z } from 'zod';
import { defineRoute, type RouteDefinition } from '../http/route.js';
import { problemAnswer, type RbacContext } from './context.js';
import { listAssignmentsOf, listCachedGroupIds, listRoles } from './repository.js';

type MyAccessResponse = z.infer<typeof MyAccessResponseSchema>;

export function myAccessRoutes(ctx: RbacContext): RouteDefinition[] {
  const { deps } = ctx;

  /** The names of these groups, best effort and in parallel; a group Graph cannot name stays `null`. */
  async function groupNames(ids: readonly string[]): Promise<Map<string, string | null>> {
    const names = new Map<string, string | null>();
    await Promise.all(
      ids.map(async (id) => {
        try {
          names.set(id, (await deps.clients.graph().getGroup(id))?.displayName ?? null);
        } catch {
          names.set(id, null);
        }
      }),
    );
    return names;
  }

  return [
    defineRoute({
      id: 'me.access',
      method: 'GET',
      path: '/api/v1/me/access',
      access: { authenticated: true },
      rateLimit: 'read',
      summary: 'My access',
      description:
        "The signed-in user's active assignments (direct, or through a named group), their scope and expiry, and the effective permissions. Read-only. A break-glass session has no assignments and the single grant rbac:manage.",
      responses: {
        200: {
          description: 'The access of the caller.',
          content: { 'application/json': { schema: MyAccessResponseSchema } },
        },
        401: problemAnswer('No session.'),
        503: problemAnswer('Storage is unavailable.'),
      },
      handler: async (c) => {
        const actor = c.get('actor');
        const grants = actor.grants.map((grant) => ({
          permission: grant.permission,
          qualifier: grant.qualifier,
          scope:
            grant.scope === 'all'
              ? ('all' as const)
              : grant.scope.map((item) => structuredClone(item)),
        }));
        const session = actor.session;

        // The kind of the principal as the response names it. The actor itself is built only in
        // `policy/resolvers/`; this is a word of the wire format.
        if (actor.kind !== 'user') {
          const kind = 'break_glass' as const;
          const body: MyAccessResponse = {
            principal: { kind, id: 'break_glass', label: actor.label },
            assignments: [],
            grants,
            groupsStale: false,
            groupsResolvedAt: null,
          };
          return c.json(body, 200);
        }

        const kind = 'user' as const;
        const db = deps.requireDatabase();
        const now = new Date(deps.now());
        const records = listAssignmentsOf(db, {
          userOid: actor.id,
          groupIds: listCachedGroupIds(db, actor.id),
        }).filter((record) => isAssignmentActive(record.expiresAt, now));
        const names = await groupNames([
          ...new Set(
            records.filter((record) => record.principalType === 'group').map((r) => r.principalId),
          ),
        ]);
        const builtin = new Set(
          listRoles(db)
            .filter((role) => role.builtin)
            .map((role) => role.key),
        );
        const body: MyAccessResponse = {
          principal: { kind, id: actor.id, label: actor.label },
          assignments: records.map((record) => ({
            id: record.id,
            role: { key: record.roleKey, builtin: builtin.has(record.roleKey) },
            origin:
              record.principalType === 'group'
                ? {
                    type: 'group' as const,
                    groupId: record.principalId,
                    groupName: names.get(record.principalId) ?? null,
                  }
                : { type: 'direct' as const },
            scope: record.scope.map((item) => structuredClone(item)),
            expiresAt: record.expiresAt,
          })),
          grants,
          groupsStale: session?.groupsStale ?? false,
          groupsResolvedAt: session?.groupsResolvedAt ?? null,
        };
        return c.json(body, 200);
      },
    }),
  ];
}

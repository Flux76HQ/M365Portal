// The group member write routes P53 and P54 (T-D-123, FR-D-352 to FR-D-354, spec 6.11.1).
//
//   P53 groups.members.add     POST   /api/v1/groups/{id}/members   audit group.member.add
//   P54 groups.members.remove  DELETE /api/v1/groups/{id}/members   audit group.member.remove
//
// Both need `groups:members:write` on that group (scoped; 403 outside it, 404 for an unknown id). A dynamic,
// synchronised, distribution or mail-enabled security group is 409 `read_only_object`. Above
// `LIMITS.groupMembers.stepUpAbove` members a fresh step-up is needed (the handler asks, because the count
// is in the body). The success entries are written by the service next to the change, a denial by the
// wrapper under the route id.
import { LIMITS } from '@m365portal/shared/limits';
import { GroupIdParamsSchema } from '@m365portal/shared/schemas/directory';
import {
  GroupMemberWriteRequestSchema,
  GroupMemberWriteResponseSchema,
} from '@m365portal/shared/schemas/member-writes';
import { groupResource } from '../directory/mappers.js';
import { requireStepUpAbove } from '../directory/step-up.js';
import { memberAuditOf, problemAnswer } from '../distribution-lists/context.js';
import { ProblemError } from '../http/problem.js';
import { defineRoute, type RouteDefinition } from '../http/route.js';
import type { DirectoryGroup } from '../ports/graph.js';
import type { GroupMemberWrites } from './members-write.js';

export interface GroupMemberRoutesDeps {
  readonly find: (id: string) => Promise<DirectoryGroup | null>;
  readonly writes: GroupMemberWrites;
}

export function groupMemberWriteRoutes(deps: GroupMemberRoutesDeps): RouteDefinition[] {
  function writeRoute(mode: 'add' | 'remove'): RouteDefinition {
    const verb = mode === 'add' ? 'Add' : 'Remove';
    return defineRoute({
      id: `groups.members.${mode}`,
      method: mode === 'add' ? 'POST' : 'DELETE',
      path: '/api/v1/groups/{id}/members',
      access: { permission: 'groups:members:write', scoped: 'group' },
      rateLimit: 'write',
      audit: `group.member.${mode}`,
      summary: `${verb} members of a group`,
      description: `${verb}s users of a Microsoft 365 or security group, 1 to ${String(LIMITS.groupMembers.bulkMax)} object ids, one call per member in chunks of ${String(LIMITS.groupMembers.bulkChunk)}, one result per member (${mode === 'add' ? 'added' : 'removed'}, already, failed with a reason). Membership is read first. Above ${String(LIMITS.groupMembers.stepUpAbove)} members a fresh step-up is needed. A dynamic, synchronised, distribution or mail-enabled security group answers 409 read_only_object.`,
      request: {
        params: GroupIdParamsSchema,
        body: {
          required: true,
          content: { 'application/json': { schema: GroupMemberWriteRequestSchema } },
        },
      },
      responses: {
        200: {
          description: 'One result per member and the counts.',
          content: { 'application/json': { schema: GroupMemberWriteResponseSchema } },
        },
        403: problemAnswer('Not allowed: permission, scope or step-up (above the bulk threshold).'),
        404: problemAnswer('No such group.'),
        409: problemAnswer('The group is read-only here (read_only_object).'),
        422: problemAnswer('The members are not valid.'),
        503: problemAnswer('Graph is unavailable, throttled or lacks a permission.'),
      },
      handler: async (c, input, ctx) => {
        const group = await deps.find(input.params.id);
        if (group === null) throw new ProblemError('not_found');
        const authorized = ctx.authorizeResource('groups:members:write', groupResource(group));
        requireStepUpAbove(
          c.get('actor'),
          input.body.members.length,
          LIMITS.groupMembers.stepUpAbove,
        );
        const body = await deps.writes.apply({
          mode,
          authorized,
          group,
          members: input.body.members,
          audit: memberAuditOf(c),
        });
        return c.json(body, 200);
      },
    });
  }

  return [writeRoute('add'), writeRoute('remove')];
}

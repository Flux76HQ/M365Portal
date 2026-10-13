// The distribution list routes P40 to P45 (T-D-120, FR-D-201, FR-D-204, FR-D-205, spec 6.11.1).
//
//   P40 distributionlists.list           GET    /api/v1/distribution-lists                 scoped, paged, no total
//   P41 distributionlists.get            GET    /api/v1/distribution-lists/{id}            404 unknown, 403 out of scope (ODB-11)
//   P42 distributionlists.members        GET    /api/v1/distribution-lists/{id}/members    rows cut to restricted rows
//   P43 distributionlists.members.add    POST   /api/v1/distribution-lists/{id}/members    audit dl.member.add
//   P44 distributionlists.members.remove DELETE /api/v1/distribution-lists/{id}/members    audit dl.member.remove
//   P45 distributionlists.search         GET    /api/v1/distribution-lists/{id}/candidates users and contacts to add
//
// The ids are lower case, all six: the id of a route is the `action` of its denial entries, and the audit
// writer's action grammar has no capital letter (`audit/writer.ts`, `route-table.ts`); the spec spells
// them `distributionLists.*` (amendment recorded in GD1-server-b). The OpenAPI tag stays `distributionLists`.
// Reads are not audited (ODC-01); the success entries of the writes are written by the service next to
// the change, a denial by the wrapper. Every handler asks the policy layer (`ctx`), or the wrapper
// answers 500 `policy_not_applied`.
import { LIMITS } from '@m365portal/shared/limits';
import {
  DistributionListCandidatesQuerySchema,
  DistributionListCandidatesResponseSchema,
  DistributionListDetailSchema,
  DistributionListIdParamsSchema,
  DistributionListListQuerySchema,
  DistributionListListResponseSchema,
  DistributionListMembersQuerySchema,
  DistributionListMembersResponseSchema,
} from '@m365portal/shared/schemas/distribution-lists';
import {
  DistributionListMemberWriteRequestSchema,
  DistributionListMemberWriteResponseSchema,
} from '@m365portal/shared/schemas/member-writes';
import { requireStepUpAbove } from '../directory/step-up.js';
import { ProblemError } from '../http/problem.js';
import { defineRoute, type RouteContext, type RouteDefinition } from '../http/route.js';
import type { PolicyContext } from '../policy/index.js';
import type { ExchangeDistributionGroup } from '../ports/exchange.js';
import { memberAuditOf, problemAnswer, type DistributionListsContext } from './context.js';
import { listResource } from './mappers.js';

const TAGS = ['distributionLists'] as const;

export function distributionListsRoutes(context: DistributionListsContext): RouteDefinition[] {
  const { lists, writes } = context;

  /** Reads the list, 404 when unknown, then asks whether the caller may do `permission` to this one (403 if not). */
  async function found(id: string): Promise<ExchangeDistributionGroup> {
    const group = await lists.find(id);
    if (group === null) throw new ProblemError('not_found');
    return group;
  }

  async function authorizedRead(ctx: PolicyContext, id: string) {
    const group = await found(id);
    return {
      group,
      authorized: ctx.authorizeResource('distributionlists:read', listResource(group)),
    };
  }

  async function authorizedWrite(ctx: PolicyContext, id: string) {
    const group = await found(id);
    return {
      group,
      authorized: ctx.authorizeResource('distributionlists:members:write', listResource(group)),
    };
  }

  const memberVisibility = (ctx: PolicyContext) => ({
    users: ctx.visibleScopes('users:read'),
    contacts: ctx.visibleScopes('contacts:read'),
    groups: ctx.visibleScopes('groups:read'),
  });

  const writeResponses = {
    200: {
      description: 'One result per member, the counts, and whether the read-back is still stale.',
      content: { 'application/json': { schema: DistributionListMemberWriteResponseSchema } },
    },
    403: problemAnswer('Not allowed: permission, scope or step-up (above the bulk threshold).'),
    404: problemAnswer('No such list.'),
    409: problemAnswer('The list is dynamic or synchronised from on-premises (read_only_object).'),
    422: problemAnswer('The members are not valid.'),
    503: problemAnswer('Exchange is unavailable, throttled, or refused the application.'),
  } as const;

  function writeRoute(mode: 'add' | 'remove'): RouteDefinition {
    const verb = mode === 'add' ? 'Add' : 'Remove';
    return defineRoute({
      id: `distributionlists.members.${mode}`,
      method: mode === 'add' ? 'POST' : 'DELETE',
      path: '/api/v1/distribution-lists/{id}/members',
      access: { permission: 'distributionlists:members:write', scoped: 'distributionList' },
      rateLimit: 'write',
      audit: `dl.member.${mode}`,
      tags: TAGS,
      summary: `${verb} members of a distribution list`,
      description: `${verb}s users and contacts, 1 to ${String(LIMITS.distributionLists.bulkMax)} object ids, in chunks of ${String(LIMITS.distributionLists.bulkChunk)}, one result per member (${mode === 'add' ? 'added' : 'removed'}, already, failed with a reason). Membership is read first, so a member already in the state asked for is "already". Above ${String(LIMITS.distributionLists.stepUpAbove)} members a fresh step-up is needed. A dynamic or synchronised list answers 409 read_only_object. The list is read back after the write; readBackPending says it does not show the change yet.`,
      request: {
        params: DistributionListIdParamsSchema,
        body: {
          required: true,
          content: { 'application/json': { schema: DistributionListMemberWriteRequestSchema } },
        },
      },
      responses: writeResponses,
      handler: async (c: RouteContext, input, ctx) => {
        const { group, authorized } = await authorizedWrite(ctx, input.params.id);
        requireStepUpAbove(
          c.get('actor'),
          input.body.members.length,
          LIMITS.distributionLists.stepUpAbove,
        );
        const body = await writes.apply({
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

  return [
    defineRoute({
      id: 'distributionlists.list',
      method: 'GET',
      path: '/api/v1/distribution-lists',
      access: { permission: 'distributionlists:read', scoped: 'distributionList' },
      rateLimit: 'read',
      tags: TAGS,
      summary: 'The distribution lists',
      description:
        'Lists the caller may see, sorted by display name, with a prefix search on name and address and a filter on kind (standard, dynamic, synchronised). Paged with a cursor; there is no total. A result larger than the list buffer answers 422 with the detail code narrow_search.',
      request: { query: DistributionListListQuerySchema },
      responses: {
        200: {
          description: 'A page of lists and the cursor of the next one.',
          content: { 'application/json': { schema: DistributionListListResponseSchema } },
        },
        400: problemAnswer('The cursor is unknown, expired or not the caller’s (cursor_invalid).'),
        422: problemAnswer('The query is not valid, or the search matches too many lists.'),
        503: problemAnswer('Exchange is unavailable, throttled, or refused the application.'),
      },
      handler: async (c, input, ctx) => {
        const scope = ctx.visibleScopes('distributionlists:read');
        const body = await lists.list({
          scope,
          users: ctx.visibleScopes('users:read'),
          actorId: c.get('actor').id,
          query: input.query,
        });
        return c.json(body, 200);
      },
    }),

    defineRoute({
      id: 'distributionlists.get',
      method: 'GET',
      path: '/api/v1/distribution-lists/{id}',
      access: { permission: 'distributionlists:read', scoped: 'distributionList' },
      rateLimit: 'read',
      tags: TAGS,
      summary: 'A distribution list',
      description:
        'Core properties, the kind, the member count where Exchange lets it be counted, and the managers for a caller who sees every user. A list outside the caller’s scope is 403, an unknown id 404.',
      request: { params: DistributionListIdParamsSchema },
      responses: {
        200: {
          description: 'The list.',
          content: { 'application/json': { schema: DistributionListDetailSchema } },
        },
        403: problemAnswer('The list is outside the caller’s scope (permission_denied).'),
        404: problemAnswer('No such list.'),
        503: problemAnswer('Exchange is unavailable, throttled, or refused the application.'),
      },
      handler: async (c, input, ctx) => {
        const { group, authorized } = await authorizedRead(ctx, input.params.id);
        const body = await lists.detail({
          authorized,
          group,
          users: ctx.visibleScopes('users:read'),
        });
        return c.json(body, 200);
      },
    }),

    defineRoute({
      id: 'distributionlists.members',
      method: 'GET',
      path: '/api/v1/distribution-lists/{id}/members',
      access: { permission: 'distributionlists:read', scoped: 'distributionList' },
      rateLimit: 'read',
      tags: TAGS,
      summary: 'The members of a distribution list',
      description:
        'Members, paged. A member the caller may not see is a restricted row without id, name or address. A dynamic list has no member list (its cmdlet is not allowed to the worker) and answers an empty page.',
      request: {
        params: DistributionListIdParamsSchema,
        query: DistributionListMembersQuerySchema,
      },
      responses: {
        200: {
          description: 'A page of members and the cursor of the next one.',
          content: { 'application/json': { schema: DistributionListMembersResponseSchema } },
        },
        400: problemAnswer('The cursor is unknown, expired or not the caller’s (cursor_invalid).'),
        403: problemAnswer('The list is outside the caller’s scope (permission_denied).'),
        404: problemAnswer('No such list.'),
        503: problemAnswer('Exchange is unavailable, throttled, or refused the application.'),
      },
      handler: async (c, input, ctx) => {
        const { group, authorized } = await authorizedRead(ctx, input.params.id);
        const body = await lists.members({
          authorized,
          group,
          visibility: memberVisibility(ctx),
          actorId: c.get('actor').id,
          query: input.query,
        });
        return c.json(body, 200);
      },
    }),

    writeRoute('add'),
    writeRoute('remove'),

    defineRoute({
      id: 'distributionlists.search',
      method: 'GET',
      path: '/api/v1/distribution-lists/{id}/candidates',
      access: { permission: 'distributionlists:members:write', scoped: 'distributionList' },
      rateLimit: 'read',
      tags: TAGS,
      summary: 'Who can be added to a distribution list',
      description:
        'Users and contacts that match the search text, cut to what the caller may see (users:read and contacts:read), each with whether it is a member already. A user without a mailbox address is not offered. No cursor is issued; the first page is the answer. A dynamic or synchronised list answers 409.',
      request: {
        params: DistributionListIdParamsSchema,
        query: DistributionListCandidatesQuerySchema,
      },
      responses: {
        200: {
          description: 'The candidates.',
          content: { 'application/json': { schema: DistributionListCandidatesResponseSchema } },
        },
        400: problemAnswer('A cursor was sent; this route issues none (cursor_invalid).'),
        403: problemAnswer('The list is outside the caller’s scope (permission_denied).'),
        404: problemAnswer('No such list.'),
        409: problemAnswer(
          'The list is dynamic or synchronised from on-premises (read_only_object).',
        ),
        503: problemAnswer(
          'Exchange or Graph is unavailable, throttled, or refused the application.',
        ),
      },
      handler: async (c, input, ctx) => {
        const { group, authorized } = await authorizedWrite(ctx, input.params.id);
        if (group.kind !== 'standard') throw new ProblemError('read_only_object');
        const body = await lists.candidates({
          authorized,
          group,
          users: ctx.visibleScopes('users:read'),
          contacts: ctx.visibleScopes('contacts:read'),
          actorId: c.get('actor').id,
          q: input.query.q,
          query: input.query,
        });
        return c.json(body, 200);
      },
    }),
  ];
}

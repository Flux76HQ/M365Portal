// What the distribution list routes share (T-D-120): the two services in one object, the problem answers
// for the OpenAPI document, and the audit context of a request.
import { ProblemSchema } from '@m365portal/shared/problem';
import type { RouteContext } from '../http/route.js';
import type { MemberAuditContext } from '../audit/member-writes.js';
import type { DistributionListMemberWrites } from './members-write.js';
import type { DistributionListsService } from './service.js';

export interface DistributionListsContext {
  readonly lists: DistributionListsService;
  readonly writes: DistributionListMemberWrites;
}

const PROBLEM_CONTENT = { 'application/problem+json': { schema: ProblemSchema } } as const;

/** A problem answer of a route, for the OpenAPI document. */
export function problemAnswer(description: string): {
  readonly description: string;
  readonly content: typeof PROBLEM_CONTENT;
} {
  return { description, content: PROBLEM_CONTENT };
}

/** Who acts and from where: what the entries of a member write record about the request. */
export function memberAuditOf(c: RouteContext): MemberAuditContext {
  const actor = c.get('actor');
  const { address } = c.get('client');
  return {
    actorKind: actor.kind,
    actorId: actor.id,
    requestId: c.get('requestId'),
    ...(address === undefined ? {} : { clientIp: address }),
  };
}

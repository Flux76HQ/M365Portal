// What the RBAC routes share (T-B-250 to T-B-253): the module's dependencies and the services built
// from them, in one object, plus the two things every handler of the module reads out of a request.
import { ProblemSchema } from '@m365portal/shared/problem';
import type { RouteContext } from '../http/route.js';
import type { ModuleDeps } from '../module.js';
import type { AssignmentService, AuditContext, ServiceActor } from './assignment-service.js';
import type { MembershipService } from './membership.js';

export interface RbacContext {
  readonly deps: ModuleDeps;
  readonly assignments: AssignmentService;
  readonly membership: MembershipService;
}

/** Who is acting, as the services need it. */
export function serviceActorOf(c: RouteContext): ServiceActor {
  const actor = c.get('actor');
  return { kind: actor.kind, id: actor.id, grants: actor.grants };
}

/** The request id and client address that the audit entry of a success records. */
export function auditContextOf(c: RouteContext): AuditContext {
  const { address } = c.get('client');
  return { requestId: c.get('requestId'), ...(address === undefined ? {} : { clientIp: address }) };
}

const PROBLEM_CONTENT = { 'application/problem+json': { schema: ProblemSchema } } as const;

/** Problem answers of the RBAC routes, for the OpenAPI document. */
export function problemAnswer(description: string): {
  readonly description: string;
  readonly content: typeof PROBLEM_CONTENT;
} {
  return { description, content: PROBLEM_CONTENT };
}

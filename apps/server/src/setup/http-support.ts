// What the setup and connection routes share (T-B-139): the problem answers for the OpenAPI document,
// the actor and client address of a request as the services want them, and the one way a response gets
// a header the problem builder does not set (`Retry-After` of the codes whose delay is data).
import { ProblemSchema } from '@m365portal/shared/problem';
import type { RouteContext } from '../http/route.js';
import type { RunActor } from './run-context.js';

const PROBLEM_CONTENT = { 'application/problem+json': { schema: ProblemSchema } } as const;

/** A problem answer of a route, for the OpenAPI document. */
export function problemAnswer(description: string): {
  readonly description: string;
  readonly content: typeof PROBLEM_CONTENT;
} {
  return { description, content: PROBLEM_CONTENT };
}

/** The actor of a setup or connection request as the engine records it: the wizard or a signed-in user. */
export function runActorOf(c: RouteContext): RunActor {
  const actor = c.get('actor');
  // The kind is carried over from the resolved actor, never written here: only the resolvers decide it.
  // Only the two kinds that hold setup or connection permissions reach these routes.
  if (actor.kind === 'user' || actor.kind === 'setup') return { kind: actor.kind, id: actor.id };
  throw new Error(`no run can be started by an actor of kind ${actor.kind}`);
}

/** The request id and client address, for an audit entry. */
export function auditContextOf(c: RouteContext): { requestId: string; clientIp?: string } {
  const { address } = c.get('client');
  return { requestId: c.get('requestId'), ...(address === undefined ? {} : { clientIp: address }) };
}

/** The same response with one more header. */
export function withHeader(response: Response, name: string, value: string): Response {
  const headers = new Headers(response.headers);
  headers.set(name, value);
  return new Response(response.body, { status: response.status, headers });
}

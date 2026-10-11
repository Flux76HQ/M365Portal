// What the branding routes read out of a request (T-A-086, T-A-087): who is acting and the revision
// the client says it is changing. Shared by the upload, apply, reset and import routes, so the
// spelling of `If-Match` handling exists once.
import { parseRevisionEtag } from '@m365portal/shared/schemas/branding';
import { ProblemError } from '../../http/problem.js';
import type { RouteContext } from '../../http/route.js';
import type { ChangeContext } from '../service.js';

/** The actor, the request id and the client address of this request, as data for the service. */
export function changeContextOf(c: RouteContext): ChangeContext {
  const actor = c.get('actor');
  const { address } = c.get('client');
  return {
    actor: { kind: actor.kind, id: actor.id },
    requestId: c.get('requestId'),
    ...(address === undefined ? {} : { clientIp: address }),
  };
}

/**
 * The revision named by `If-Match` (FR-A-083): a strong validator that is a quoted integer. Missing
 * is 428 `precondition_required`; anything else that is not `"<integer>"` is 422 `validation_failed`
 * with the pointer `header/If-Match`. Whether the revision is the current one is the service's
 * question (412 `branding_conflict`).
 */
export function ifMatchRevisionOf(c: RouteContext): number {
  const header = c.req.header('if-match');
  if (header === undefined) throw new ProblemError('precondition_required');
  const revision = parseRevisionEtag(header);
  if (revision === null) {
    throw new ProblemError('validation_failed', {
      errors: [{ pointer: 'header/If-Match', code: 'invalid_etag' }],
    });
  }
  return revision;
}

// What the branding routes read out of a request (T-A-086, T-A-087): who is acting and the revision
// the client says it is changing. Shared by the upload, apply, reset and import routes, so the
// spelling of `If-Match` handling exists once.
import { ProblemSchema } from '@m365portal/shared/problem';
import { parseRevisionEtag, revisionEtag } from '@m365portal/shared/schemas/branding';
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

/**
 * The headers of an answer that names a revision: the strong `ETag` the client sends back in
 * `If-Match`, and `no-transform`. The compression layer turns every strong tag into a weak one when
 * it compresses a body (the tag no longer names those bytes), and a client that reads `W/"3"` and
 * sends it back is refused (`If-Match` takes a strong tag only). The documents are small and are
 * read when the page loads and after a change; they are therefore not compressed (open point s2g-1).
 */
export function revisionHeaders(revision: number): Record<string, string> {
  return { ETag: revisionEtag(revision), 'Cache-Control': 'no-store, no-transform' };
}

const PROBLEM_CONTENT = { 'application/problem+json': { schema: ProblemSchema } } as const;

/** Problem answers a branding route can give that the wrapper does not know about (contract 4, 5). */
export const PROBLEM_ANSWERS = {
  notFound: { description: 'No such image, or not for this actor.', content: PROBLEM_CONTENT },
  conflict: { description: 'The staging quota is full.', content: PROBLEM_CONTENT },
  stale: {
    description: 'If-Match names a revision that is not the current one.',
    content: PROBLEM_CONTENT,
  },
  required: { description: 'If-Match is missing.', content: PROBLEM_CONTENT },
  storage: {
    description: 'Storage is unavailable or busy, or the server is shutting down.',
    content: PROBLEM_CONTENT,
  },
} as const;

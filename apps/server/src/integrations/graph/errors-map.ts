// From a Graph answer to the typed errors of the ports (plan 8.2, SB-05). The only things taken from
// an answer are its status, the Graph error `code` (kept only when it looks like one), `Retry-After`
// and the two correlation ids. The message, the inner error and every other field are dropped.
import {
  GraphBadRequestError,
  GraphConflictError,
  GraphError,
  GraphForbiddenError,
  GraphNotFoundError,
  GraphThrottledError,
  GraphTransientError,
  GraphUnauthorizedError,
} from '../../ports/errors.js';
import type { ErrorMeta } from '../http/call-engine.js';
import { UrlRefusedError } from '../http/url-guard.js';

/** `error.code` of a Graph error body when it is a string; the error classes validate its shape. */
export function graphCodeOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** The error for a non-2xx answer. 3xx never gets here: the wrapper refuses a redirect. */
export function graphErrorFor(status: number, body: unknown, meta: ErrorMeta): GraphError {
  const details = {
    ...(meta.retryAfterMs === null ? {} : { retryAfterMs: meta.retryAfterMs }),
    ...(meta.requestId === null ? {} : { requestId: meta.requestId }),
    ...(meta.clientRequestId === null ? {} : { clientRequestId: meta.clientRequestId }),
    graphCode: graphCodeOf(body),
  };
  switch (status) {
    case 401:
      return new GraphUnauthorizedError(details);
    case 403:
      return new GraphForbiddenError(details);
    case 404:
      return new GraphNotFoundError(details);
    case 409:
      return new GraphConflictError(details);
    case 429:
      return new GraphThrottledError(details);
    default:
      if (status >= 500) return new GraphTransientError({ ...details, status });
      // 400 and every other 4xx (405, 410, 412, 422 ...): the request was wrong, not the service.
      return new GraphBadRequestError(details);
  }
}

/**
 * Runs the code that builds a path or a query and turns a refused value (url-guard.ts) into the
 * typed error, so a hostile identifier is a `graph_bad_request` with the code `invalid_value`, and
 * never reaches the network.
 */
export function refusedAsBadRequest<T>(build: () => T): T {
  try {
    return build();
  } catch (failure) {
    if (failure instanceof UrlRefusedError) {
      throw new GraphBadRequestError({ graphCode: 'invalid_value' });
    }
    throw failure;
  }
}

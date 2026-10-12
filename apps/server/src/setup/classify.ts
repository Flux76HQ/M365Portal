// Failure classification (T-B-128, FR-B-212, plan 9.7, SB-06): which of the three classes a failure of
// a Microsoft call belongs to, so the runner knows whether to wait, wait for replication or stop.
//
//   transient    429, 5xx (the taxonomy's `retryable` flag: 503 and 504 as the spec names them, and
//                500 and 502, which Graph also uses for a passing fault), and a network failure
//   replication  404 on an id the run created or received within the window; 400 on an object the run
//                just created; 401 or 403 from Graph or Exchange inside the propagation window after a
//                grant or role assignment; `invalid_client` from the token endpoint inside the window
//                after a certificate upload
//   permanent    everything else, validation and policy refusals included
//
// The exact error codes Microsoft uses for replication are not documented (U32); the fake models the
// status classes only, and so does this function.
import type { FailureClass } from '@m365portal/shared/setup/backoff-constants';
import {
  ExchangeError,
  ExchangeForbiddenError,
  ExchangeUnauthorizedError,
  GraphBadRequestError,
  GraphError,
  GraphForbiddenError,
  GraphNotFoundError,
  GraphUnauthorizedError,
  TokenEndpointError,
} from '../ports/errors.js';

/** What the sub-action knows about the call that failed. */
export interface FailureContext {
  /** The object the call touched was created or received by this run, inside its window. */
  readonly justCreated?: boolean;
  /** A grant or role assignment was made inside the propagation window. */
  readonly afterGrant?: boolean;
  /** A certificate was uploaded inside the propagation window. */
  readonly afterCertificateUpload?: boolean;
}

export interface FailureVerdict {
  readonly klass: FailureClass;
  /** `Retry-After` of the response, for the transient class. */
  readonly retryAfterMs?: number;
  /** The allow-listed Graph error code (`^[A-Za-z0-9_.]{1,64}$`), never free text. */
  readonly graphCode?: string;
}

export function classifyFailure(error: unknown, context: FailureContext): FailureVerdict {
  if (error instanceof GraphError || error instanceof ExchangeError) {
    const carried: { retryAfterMs?: number; graphCode?: string } = {};
    if (error.retryAfterMs !== undefined) carried.retryAfterMs = error.retryAfterMs;
    if (error.graphCode !== undefined) carried.graphCode = error.graphCode;

    if (error.retryable) return { klass: 'transient', ...carried };

    if (context.justCreated === true && error instanceof GraphNotFoundError) {
      return { klass: 'replication', ...carried };
    }
    if (context.justCreated === true && error instanceof GraphBadRequestError) {
      return { klass: 'replication', ...carried };
    }
    if (
      context.afterGrant === true &&
      (error instanceof GraphForbiddenError ||
        error instanceof GraphUnauthorizedError ||
        error instanceof ExchangeForbiddenError ||
        error instanceof ExchangeUnauthorizedError)
    ) {
      return { klass: 'replication', ...carried };
    }
    return {
      klass: 'permanent',
      ...(error.graphCode === undefined ? {} : { graphCode: error.graphCode }),
    };
  }

  if (
    error instanceof TokenEndpointError &&
    error.error === 'invalid_client' &&
    context.afterCertificateUpload === true
  ) {
    return { klass: 'replication' };
  }
  return { klass: 'permanent' };
}

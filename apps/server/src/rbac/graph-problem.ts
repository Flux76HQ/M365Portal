// A failure of the Microsoft client as the problem an RBAC route answers (contract 9.1): Graph or the
// connection unavailable is 503 `graph_unavailable` (with `Retry-After: 30`), a wait of more than 60
// seconds is 503 `graph_throttled`, an unusable secrets state is 503 `secrets_unavailable`. A value that
// is not one of the client errors is a bug, not a Graph failure, and is thrown again.
import { ProblemError } from '../http/problem.js';
import {
  GraphThrottledError,
  IntegrationError,
  NotConnectedError,
  SecretsUnavailableError,
} from '../ports/errors.js';

/** A Graph wait longer than this is `graph_throttled`, not `graph_unavailable`. */
const LONG_WAIT_MS = 60_000;

export function graphProblem(error: unknown): ProblemError {
  if (error instanceof SecretsUnavailableError) return new ProblemError('secrets_unavailable');
  if (error instanceof GraphThrottledError && (error.retryAfterMs ?? 0) > LONG_WAIT_MS) {
    return new ProblemError('graph_throttled');
  }
  if (error instanceof IntegrationError || error instanceof NotConnectedError) {
    return new ProblemError('graph_unavailable');
  }
  throw error;
}

// Graph failures as the problem a directory route answers (T-C-027, FR-C-106, EC-C13, EC-C14):
//
//   Graph 403 for the panel's own application   503 `graph_unavailable` with the detail code
//                                               `graph_permission_missing` (the page points to Settings,
//                                               Connection: repair)
//   Graph 404 on an object that was there a      404 `not_found`
//   moment ago
//   429 that outlasts the budget                503 `graph_throttled` (a wait of more than 60 s)
//   5xx, a network failure, an unexpected shape  503 `graph_unavailable`
//   an unusable secrets state                    503 `secrets_unavailable`
//
// No text of Graph, no id, no name reaches the response: `ProblemError` carries a registry code and a
// fixed detail code, nothing else (FR-A-023).
import { ProblemError } from '../http/problem.js';
import { GraphForbiddenError, GraphNotFoundError } from '../ports/errors.js';
import { graphProblem } from '../rbac/graph-problem.js';

/** The problem for a failure of the Graph client; a value that is not a client error is a bug and is thrown again. */
export function directoryProblem(error: unknown): ProblemError {
  if (error instanceof GraphForbiddenError) {
    return new ProblemError('graph_unavailable', {
      errors: [{ pointer: '', code: 'graph_permission_missing' }],
    });
  }
  if (error instanceof GraphNotFoundError) return new ProblemError('not_found');
  return graphProblem(error);
}

/** Runs a Graph read; whatever it throws leaves as a problem (a `ProblemError` of the service passes). */
export async function viaGraph<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (failure) {
    if (failure instanceof ProblemError) throw failure;
    throw directoryProblem(failure);
  }
}

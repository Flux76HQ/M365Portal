// The Entra group for the role Beheerder (T-B-137, FR-B-219 c, BCB-01): chosen by search or entered as
// an object id and checked with `GET /groups/{id}`. No group is ever created here. Both calls are
// app-only (FR-B-311) and run before the finish transaction, never inside it.
import { ProblemError } from '../http/problem.js';
import { graphProblem } from '../rbac/graph-problem.js';
import type { GraphClient, Guid } from '../ports/graph.js';

export interface GroupChoice {
  readonly id: string;
  readonly displayName: string | null;
}

/** The groups whose name starts with `prefix`, at most `top`. Graph down is 503 `graph_unavailable`. */
export async function searchBeheerderGroups(
  graph: GraphClient,
  prefix: string,
  top: number,
): Promise<GroupChoice[]> {
  try {
    const found = await graph.searchGroups(prefix, top);
    return found.map((group) => ({ id: group.id, displayName: group.displayName }));
  } catch (error) {
    throw graphProblem(error);
  }
}

/**
 * The group exists. A 404 is 422 `validation_failed` with `/beheerderGroupId` `group_unknown`; Graph
 * unavailable is 503 (the group could not be checked).
 */
export async function requireExistingGroup(graph: GraphClient, id: Guid): Promise<GroupChoice> {
  let group;
  try {
    group = await graph.getGroup(id);
  } catch (error) {
    throw graphProblem(error);
  }
  if (group === null) {
    throw new ProblemError('validation_failed', {
      errors: [{ pointer: '/beheerderGroupId', code: 'group_unknown' }],
    });
  }
  return { id: group.id, displayName: group.displayName };
}

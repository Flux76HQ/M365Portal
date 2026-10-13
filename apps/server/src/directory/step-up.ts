// The step-up above a bulk threshold (T-D-119, T-D-123, FR-D-204, FR-D-354): a route declares `stepUp` for
// all or nothing, but the member writes ask for it only above `LIMITS.<list|groupMembers>.stepUpAbove`
// members, and the count is a property of the body. The handler therefore asks here, after it has
// authorised the object: a user whose step-up is stale gets 403 `step_up_required`, audited by the route
// wrapper as a denial under the route id (the same answer and the same entry as the declared step-up).
// The setup actor and break-glass are exempt, as everywhere (FR-B-411); they hold no member permission.
import { PolicyDenied, type Actor } from '../policy/index.js';

/** Throws `PolicyDenied('step_up_required')` for a user with a stale step-up and `count` above `threshold`. */
export function requireStepUpAbove(
  actor: Pick<Actor, 'kind' | 'stepUpFresh'>,
  count: number,
  threshold: number,
): void {
  if (count > threshold && actor.kind === 'user' && !actor.stepUpFresh) {
    throw new PolicyDenied('step_up_required');
  }
}

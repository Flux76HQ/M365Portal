// The one builder of the member write paths (Phase D, T-D-116, FR-D-351, R-D-08). Both end in `/$ref`:
//
//   add     POST   /groups/{group}/members/$ref
//   remove  DELETE /groups/{group}/members/{member}/$ref
//
// The suffix is not a detail. `DELETE /groups/{id}/members/{id}` WITHOUT `/$ref` deletes the member
// object itself (a user!) from Entra ID when the application may manage that object type (Learn,
// group-delete-members, the caution on the page). So there is exactly one function that builds these
// paths, it cannot return a path without the suffix, `graph-member-writes.test.ts` runs a property test
// over it and scans `graph-client.ts` for any other way of writing "/members", and the fake Graph
// deletes the user when a request arrives without `/$ref`.
//
// An id becomes a path segment through `guidSegment` only: anything that is not a GUID is a
// `GraphBadRequestError` (`invalid_value`) and nothing is sent.
import { guidSegment } from '../http/url-guard.js';
import { refusedAsBadRequest } from './errors-map.js';

/** The path below `/v1.0`: the members collection of the group, or one member of it. Always ends in `/$ref`. */
export function memberRefPath(groupId: string, memberId?: string): string {
  return refusedAsBadRequest(() => {
    const group = guidSegment(groupId);
    if (memberId === undefined) return `/groups/${group}/members/$ref`;
    return `/groups/${group}/members/${guidSegment(memberId)}/$ref`;
  });
}

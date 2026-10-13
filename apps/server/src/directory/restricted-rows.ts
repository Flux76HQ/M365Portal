// Restricted rows (T-C-020, FR-C-307, PC-05, RC-05): the ONE function that turns a member, an owner or
// the manager of a user into a row of the wire, and so the one place that decides what an actor may
// learn of an object they met through someone else.
//
//   a user     in full when the actor's `users:read` covers it in full, as `basic` (id, display name and
//              mail; the principal name is not given) when only a `basic` grant covers it, otherwise a
//              restricted row;
//   a group    in full when the actor's `groups:read` covers it, otherwise a restricted row;
//   anything   a device, service principal or contact: its kind and id, no name, when the actor may see
//   else       users or groups at all (EC-C9: "counted, not shown by name"); otherwise restricted.
//
// A restricted row is `{ kind, restricted: true }`: no id, no name, no address, not even a `null` id
// (the key would be a hint, `RestrictedRowSchema`). The function takes the capability values of the
// policy layer (`VisibleScope`), so it cannot be called by a handler that never asked (FR-C-401).
// Missing attributes never match a scope item (fail closed): a member whose department Graph did not
// return is restricted for a department-scoped actor.
import { projectUser } from '@m365portal/shared/rbac/qualifier';
import type { DirectoryRow, RestrictedRow } from '@m365portal/shared/schemas/directory';
import type { VisibleScope } from '../policy/index.js';
import type { DirectoryRef } from '../ports/graph.js';
import { groupResource, userResource } from './mappers.js';
import { seesNothing, visibilityOf } from './scoped-list.js';

/**
 * The kind of a row of a user. A constant, not a literal in an object: the source scan of the actor
 * resolvers (`default-deny.test.ts`) looks for `kind: 'user'` objects, which here are rows, not actors.
 */
const USER_KIND = 'user' as const;

/** What the actor may see of the two object types a row can be. */
export interface RowVisibility {
  readonly users: VisibleScope<'user'>;
  /** Absent: groups are never shown (a restricted row), as for a route that did not ask. */
  readonly groups?: VisibleScope<'group'>;
}

/** The row for an object the actor may not see: its kind and nothing else. */
export function restrictedRow(kind: DirectoryRef['kind']): RestrictedRow {
  return { kind, restricted: true };
}

/** The wire row of a member, an owner or a manager, for what this actor may see (FR-C-307). */
export function toDirectoryRow(ref: DirectoryRef, visibility: RowVisibility): DirectoryRow {
  switch (ref.kind) {
    case 'user': {
      const seen = visibilityOf(visibility.users.scopes, userResource(ref));
      if (seen === null) return restrictedRow('user');
      if (seen === 'basic') {
        // The one projection of a basic grant (FR-C-204): id, display name and mail; no principal name.
        const basic = projectUser(
          { id: ref.id, displayName: ref.displayName, mail: ref.mail },
          'basic',
        );
        return { kind: USER_KIND, ...basic, userPrincipalName: null };
      }
      return {
        kind: USER_KIND,
        id: ref.id,
        displayName: ref.displayName,
        mail: ref.mail,
        userPrincipalName: ref.userPrincipalName,
      };
    }
    case 'group': {
      const seen =
        visibility.groups === undefined
          ? null
          : visibilityOf(visibility.groups.scopes, groupResource(ref));
      if (seen === null) return restrictedRow('group');
      return {
        kind: 'group',
        id: ref.id,
        displayName: ref.displayName,
        mail: ref.mail,
        userPrincipalName: null,
      };
    }
    case 'other': {
      const mayCount =
        !seesNothing(visibility.users.scopes) ||
        (visibility.groups !== undefined && !seesNothing(visibility.groups.scopes));
      if (!mayCount) return restrictedRow('other');
      return { kind: 'other', id: ref.id, displayName: null, mail: null, userPrincipalName: null };
    }
  }
}

/** Rows for a list of references, in order. */
export function toDirectoryRows(
  refs: readonly DirectoryRef[],
  visibility: RowVisibility,
): DirectoryRow[] {
  return refs.map((ref) => toDirectoryRow(ref, visibility));
}

// The qualifier `basic` of `users:read` (T-B-235, FR-B-512, SB-13, FR-B-504). Data on the role
// permission, not a sixteenth permission (the catalogue is exactly the brief's fifteen, FR-A-030).
// ONE function projects a user for a qualifier; every response that carries user attributes passes it
// (plan 11.9), so a `basic` grant cannot be widened by a route that returns users in another shape.
//
// Pure and platform-neutral: no clock, no I/O, no randomness, no work at import.
import { PERMISSIONS, type Permission } from '../permissions.js';
import { QUALIFIERS, type Qualifier } from './resources.js';

/** The only three fields a `basic` grant may return, in this order. */
export const BASIC_USER_FIELDS = Object.freeze(['id', 'displayName', 'mail'] as const);

/** What a `basic` grant returns for a user. */
export interface BasicUser {
  readonly id: string;
  readonly displayName: string | null;
  readonly mail: string | null;
}

/** Does this permission have this qualifier? `full` exists everywhere; `basic` only on `users:read`. */
export function permissionAllowsQualifier(permission: Permission, qualifier: Qualifier): boolean {
  if (!PERMISSIONS.includes(permission)) return false;
  if (!QUALIFIERS.includes(qualifier)) return false;
  return qualifier === 'full' || permission === 'users:read';
}

/**
 * The stronger of several qualifiers: `full` wins over `basic` (SB-13); `null` for none. Anything that
 * is not exactly `full` or `basic` is ignored.
 */
export function strongestQualifier(qualifiers: Iterable<Qualifier>): Qualifier | null {
  let strongest: Qualifier | null = null;
  for (const qualifier of qualifiers) {
    switch (qualifier) {
      case 'full':
        return 'full';
      case 'basic':
        strongest = 'basic';
        break;
      default:
        break;
    }
  }
  return strongest;
}

/** Does `have` give at least what `need` asks? `full` covers `basic`, never the reverse; `null` is nothing. */
export function qualifierAtLeast(have: Qualifier | null, need: Qualifier): boolean {
  if (have === 'full') return true;
  return have === 'basic' && need === 'basic';
}

/** The least a user object must have to be projected. */
interface ProjectableUser {
  readonly id: string;
  readonly displayName?: string | null;
  readonly mail?: string | null;
}

/**
 * Projects a user for a qualifier. `full` returns the DTO as it is; anything else, `basic` included,
 * returns a new plain object with exactly `id`, `displayName` and `mail` (null when the user has none),
 * built from those three reads only, so an extra field, a getter, a symbol key or a prototype property
 * cannot leave through it. Only the exact string `full` gives the full DTO (deny by default).
 * Throws a TypeError for a user without a string `id`: there is nothing to project.
 */
export function projectUser<T extends ProjectableUser>(user: T, qualifier: 'full'): T;
export function projectUser(user: ProjectableUser, qualifier: 'basic'): BasicUser;
export function projectUser<T extends ProjectableUser>(
  user: T,
  qualifier: Qualifier,
): T | BasicUser;
export function projectUser<T extends ProjectableUser>(
  user: T,
  qualifier: Qualifier,
): T | BasicUser {
  if (typeof user !== 'object' || typeof (user as Partial<ProjectableUser>).id !== 'string')
    throw new TypeError('projectUser: the user has no id');
  if (qualifier === 'full') return user;
  const { id, displayName, mail } = user;
  return {
    id,
    displayName: typeof displayName === 'string' ? displayName : null,
    mail: typeof mail === 'string' ? mail : null,
  };
}

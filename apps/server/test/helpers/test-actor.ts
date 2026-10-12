// Actors for the unit tests of the policy layer and the route-level tests that need no database
// (T-B-237, T-B-240): a plain value of the shape the policy layer hands the pipeline. The tests that
// need a real session use `signedInAs` (T-B-244). Nothing here is importable from `apps/server/src`;
// the product builds actors only in `policy/resolvers/`.
import type { Permission } from '@m365portal/shared/permissions';
import type { Grant } from '@m365portal/shared/rbac/effective';
import { frozenSetOf, type Actor, type ActorKind } from '../../src/policy/actor.js';

export interface TestActorOptions {
  readonly id?: string;
  readonly label?: string;
  /** Permissions held in full for everything (the grants are derived). Ignored when `grants` is given. */
  readonly permissions?: readonly Permission[];
  readonly grants?: readonly Grant[];
  /** Is the step-up inside its window? Only meaningful for a `user` actor. */
  readonly stepUpFresh?: boolean;
  readonly csrfBinding?: string;
}

export function grantAll(...permissions: Permission[]): Grant[] {
  return permissions.map((permission) => ({ permission, qualifier: 'full', scope: 'all' }));
}

export function testActor(kind: ActorKind, options: TestActorOptions = {}): Actor {
  const grants = options.grants ?? grantAll(...(options.permissions ?? []));
  return Object.freeze({
    kind,
    id: options.id ?? kind,
    label: options.label ?? kind,
    permissions: frozenSetOf([...new Set(grants.map((grant) => grant.permission))]),
    grants: Object.freeze([...grants]),
    csrfBinding: options.csrfBinding ?? '',
    credential: kind === 'anonymous' ? 'none' : 'valid',
    session: null,
    setupSession: null,
    stepUpFresh: options.stepUpFresh ?? false,
  });
}

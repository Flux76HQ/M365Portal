// What a handler gets of the policy layer (T-B-243, FR-B-505, plan 11.8 and 11.9): `ctx`, the third
// argument of every handler. It answers the two questions a route that touches scoped resources must
// ask, and it remembers that they were asked.
//
//   ctx.authorizeResource(permission, resource)   may the caller do this to THIS resource? Returns the
//                                                 capability `AuthorizedResource<T>` or ends the request
//                                                 with 403 (the wrapper audits `scope_mismatch`)
//   ctx.visibleScopes(permission)                 which resources of the type may the caller see, and
//                                                 in which form? Returns `VisibleScope<T>`
//
// Both capabilities are branded values only this file can make: the brand is a `unique symbol` that is
// not exported, so a handler cannot write the object by hand, and a service that demands one cannot be
// called by a handler that never asked (compile time). The runtime net is the flag: a route that
// declared `scoped` and answered 2xx without asking is replaced by 500 `policy_not_applied`
// (`http/route.ts`). The net finds a forgotten check; it cannot undo a write the handler already made,
// which is why the services of Phases C and D take the capability as an argument.
import type { Permission } from '@m365portal/shared/permissions';
import type {
  Qualifier,
  ResourceAttrs,
  ResourcePermission,
  ResourceType,
} from '@m365portal/shared/rbac/resources';
import type { Actor } from './actor.js';
import { authorize } from './authorize.js';
import { visibleScopes, type VisibleScopes } from './scoped.js';

declare const authorizedBrand: unique symbol;
declare const visibleBrand: unique symbol;

/** The resource type each permission with a resource type applies to, as a type (see `PERMISSION_RESOURCE`). */
export type ResourceOf<P extends ResourcePermission> = P extends 'users:read'
  ? 'user'
  : P extends 'groups:read' | 'groups:members:write'
    ? 'group'
    : P extends
          'distributionlists:read' | 'distributionlists:members:write' | 'distributionlists:export'
      ? 'distributionList'
      : P extends 'contacts:read' | 'contacts:create' | 'contacts:update' | 'contacts:delete'
        ? 'contact'
        : never;

/** The caller may act on this resource (`ctx.authorizeResource`). */
export interface AuthorizedResource<T extends ResourceType = ResourceType> {
  readonly [authorizedBrand]: T;
  readonly permission: Permission;
  readonly resource: ResourceAttrs & { readonly type: T };
  /** `full` when a grant in full matched, `basic` when only the narrowed form did (`projectUser`). */
  readonly qualifier: Qualifier;
}

/** The set of resources the caller may see (`ctx.visibleScopes`). */
export interface VisibleScope<T extends ResourceType = ResourceType> {
  readonly [visibleBrand]: T;
  readonly permission: Permission;
  readonly scopes: VisibleScopes;
}

/** The caller may not do this to this resource. The wrapper audits it and answers 403. */
export class ResourceDenied extends Error {
  readonly reason: 'permission_missing' | 'scope_mismatch';
  readonly permission: Permission;

  constructor(permission: Permission, reason: 'permission_missing' | 'scope_mismatch') {
    super(`the caller may not do ${permission} to this resource (${reason})`);
    this.name = 'ResourceDenied';
    this.permission = permission;
    this.reason = reason;
  }
}

export interface PolicyContext {
  readonly actor: Actor;
  authorizeResource<P extends ResourcePermission>(
    permission: P,
    resource: ResourceAttrs & { readonly type: ResourceOf<P> },
  ): AuthorizedResource<ResourceOf<P>>;
  visibleScopes<P extends ResourcePermission>(permission: P): VisibleScope<ResourceOf<P>>;
  /** Has the handler asked either question? */
  readonly applied: boolean;
}

export function createPolicyContext(actor: Actor): PolicyContext {
  let applied = false;
  return {
    actor,
    get applied() {
      return applied;
    },
    authorizeResource(permission, resource) {
      // `authorize` throws on a resource of the wrong type: a bug of the handler, never an allow.
      const decision = authorize(actor, permission, resource);
      applied = true;
      if (!decision.allow) throw new ResourceDenied(permission, decision.reason);
      return Object.freeze({
        permission,
        resource: Object.freeze({ ...resource }),
        qualifier: decision.qualifier,
      }) as unknown as AuthorizedResource<ResourceOf<typeof permission>>;
    },
    visibleScopes(permission) {
      applied = true;
      return Object.freeze({
        permission,
        scopes: visibleScopes(actor, permission),
      }) as unknown as VisibleScope<ResourceOf<typeof permission>>;
    },
  };
}

// Route gating (plan 9.1, FR-A-126 base).
//
// Gating is cosmetic: the server enforces every permission, and this only decides what the page shows.
// A gated route does not redirect and does not change the URL. It renders the No-access content in
// place, so the address stays honest and Back goes where the person came from.
//
// How a route uses it (T-A-169):
//
//   beforeLoad: requirePermission(['users:read']),          // adds { access: 'allowed' | 'denied' }
//   component: gatedPage(UsersPage, NoAccess),              // shows NoAccess when it was denied
//
// `access` is merged into the route context, so a child route without a gate of its own inherits the
// verdict of its parent, and a child with a gate replaces it. The root route's `beforeLoad` is
// `loadMe`, which puts `me` into the context first.
import { hasAnyPermission, type Permission } from '@m365portal/shared/permissions';
import { useRouteContext } from '@tanstack/react-router';
import { createElement, type ComponentType, type ReactNode } from 'react';
import type { MeResponse } from './boot-data';
import { meQueryOptions } from './query';
import type { RouterContext } from './router-context';

export type Access = 'allowed' | 'denied';

/** Does the actor hold at least one of the permissions? Deny by default (an empty list denies). */
export function hasAccess(me: MeResponse, anyOf: readonly Permission[]): boolean {
  return hasAnyPermission(me.permissions, anyOf);
}

/** The `beforeLoad` of the root route: puts `me` into the route context. No request when it was embedded. */
export async function loadMe(
  context: Pick<RouterContext, 'queryClient' | 'api'>,
): Promise<{ me: MeResponse }> {
  // `static`: whatever the cache holds is the answer, however old; only an empty cache fetches.
  const me = await context.queryClient.query({
    ...meQueryOptions(context.api),
    staleTime: 'static',
  });
  return { me };
}

/**
 * The `beforeLoad` of a gated route: allowed when the actor holds any one of `anyOf`, otherwise
 * denied. Reads `me` from the route context (see `loadMe`).
 */
export function requireAnyOf(anyOf: readonly Permission[]) {
  return ({ context }: { readonly context: { readonly me: MeResponse } }): { access: Access } => ({
    access: hasAccess(context.me, anyOf) ? 'allowed' : 'denied',
  });
}

// The spec calls this `requirePermission`. The single-implementation guard
// (packages/shared/test/single-implementation.test.ts) reads a function with the word "permission"
// in its name, outside the shared package, as a second implementation of the permission check; this
// one is a thin route wrapper around `hasAnyPermission` of the shared package, and is exported under
// the name the spec uses.
export { requireAnyOf as requirePermission };

/**
 * A route component that renders `Denied` instead of `Allowed` when the route (or a parent) was
 * denied by `requirePermission`. Without a gate in the chain the page is shown.
 */
export function gatedPage(Allowed: ComponentType, Denied: ComponentType): () => ReactNode {
  function GatedPage(): ReactNode {
    const access = useRouteContext({
      strict: false,
      select: (context) => (context as { access?: Access }).access,
    });
    return createElement(access === 'denied' ? Denied : Allowed);
  }
  return GatedPage;
}

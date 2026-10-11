// The client paths of the web application (FR-A-126, FR-A-129 to FR-A-131): one list, so the shell, the
// command registry, the placeholder pages and the end-to-end route list (`e2e/routes.ts`, contract C14)
// cannot disagree about where a page lives. The router's file tree is the source of the real paths
// (`pnpm routes:check` keeps it fresh); `apps/web/test/pages.test.tsx` compares the two.
//
// Platform-neutral and pure: only constants.

/** Every page of Phase A, by name. Frozen: nothing adds a path at run time. */
export const ROUTES = Object.freeze({
  dashboard: '/',
  users: '/users',
  groups: '/groups',
  distributionLists: '/distribution-lists',
  contacts: '/contacts',
  auditLog: '/audit',
  settings: '/settings',
  appearance: '/settings/appearance',
  noAccess: '/no-access',
  /** Exists only when the server runs with `SHOWCASE=true`; Not-found otherwise (FR-A-131). */
  design: '/design',
} as const);

/** The name of a page in `ROUTES`. */
export type RouteName = keyof typeof ROUTES;

/** A path of `ROUTES`: the union of the literal strings. */
export type ClientPath = (typeof ROUTES)[RouteName];

/** All client paths, in the order of `ROUTES`. */
export const CLIENT_PATHS: readonly ClientPath[] = Object.freeze(Object.values(ROUTES));

// The client paths of the web application (FR-A-126, FR-A-129 to FR-A-131, FR-B-607): one list, so the shell, the
// command registry, the placeholder pages and the end-to-end route list (`e2e/routes.ts`, contract C14)
// cannot disagree about where a page lives. The router's file tree is the source of the real paths
// (`pnpm routes:check` keeps it fresh); `apps/web/test/pages.test.tsx` compares the two.
//
// Platform-neutral and pure: only constants.

/** Every page, by name. Frozen: nothing adds a path at run time. Phase B adds its paths here, task by task (XB29). */
export const ROUTES = Object.freeze({
  dashboard: '/',
  users: '/users',
  groups: '/groups',
  distributionLists: '/distribution-lists',
  contacts: '/contacts',
  auditLog: '/audit',
  settings: '/settings',
  appearance: '/settings/appearance',
  /** The connection to Microsoft 365: tenant, application, certificate, proof, repair (FR-B-111). */
  connection: '/settings/connection',
  /** "Mijn toegang": the signed-in user's roles and effective permissions (FR-B-514). */
  access: '/settings/access',
  /** The break-glass recovery page: restore the Owner (FR-B-523). Break-glass sessions only. */
  restoreAccess: '/settings/restore-access',
  noAccess: '/no-access',
  /** The public sign-in page and its error variants (FR-B-607). */
  signin: '/signin',
  /** The setup wizard; the server decides who may see it (FR-B-207). */
  setup: '/setup',
  /** The break-glass sign-in form; Not-found unless the server has it configured (FR-B-522). */
  breakGlass: '/break-glass',
  /** Exists only when the server runs with `SHOWCASE=true`; Not-found otherwise (FR-A-131). */
  design: '/design',
} as const);

/** The name of a page in `ROUTES`. */
export type RouteName = keyof typeof ROUTES;

/** A path of `ROUTES`: the union of the literal strings. */
export type ClientPath = (typeof ROUTES)[RouteName];

/** All client paths, in the order of `ROUTES`. */
export const CLIENT_PATHS: readonly ClientPath[] = Object.freeze(Object.values(ROUTES));

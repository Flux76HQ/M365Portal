// The client paths of the application, as the end-to-end tests see them (contract C14, FR-A-151).
// One list for axe, visual regression and Lighthouse. `apps/web/test/routes-coverage.test.ts`
// compares it with the router's route tree in both directions, so a page that is added to the app
// without being added here (or the other way round) fails a unit test, not a missed audit.
//
// Pure data and no imports: the web package reads this file from a Vitest test.

/** Every page the router knows, in navigation order. */
export const CLIENT_ROUTES = [
  '/',
  '/users',
  '/groups',
  '/distribution-lists',
  '/contacts',
  '/audit',
  '/settings',
  '/settings/appearance',
  '/no-access',
  '/signin',
  '/design',
] as const;

/** A path no route matches: the Not-found page. The route-tree comparison skips it on purpose. */
export const UNKNOWN_ROUTE = '/this-page-does-not-exist';

/** What axe, the visual specs and Lighthouse walk over. */
export const ROUTES: readonly string[] = [...CLIENT_ROUTES, UNKNOWN_ROUTE];

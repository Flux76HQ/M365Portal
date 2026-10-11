// THE E2E ROUTE LIST AND THE ROUTER'S ROUTE TREE ARE THE SAME SET (FR-A-151, TA-07).
//
// `e2e/routes.ts` is the single route list used by axe, visual regression and Lighthouse. A page that
// is added to the router without being added there escapes every one of those audits; a path listed
// there that the router does not have audits a Not-found page by accident. Both directions fail.
// The one deliberate extra entry is `UNKNOWN_ROUTE`, which must NOT be a route (it is the Not-found
// page's own address).
import { expectGuardFails } from '@m365portal/shared/testing';
import { createMemoryHistory } from '@tanstack/react-router';
import { describe, expect, it } from 'vitest';
import { CLIENT_ROUTES, ROUTES, UNKNOWN_ROUTE } from '../../../e2e/routes';
import { createAppRouter } from '../src/router';

/** `/settings/` and `/settings` are the same page. */
const normalise = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, '') : path);

/** The paths of the real route tree. */
function routerPaths(): string[] {
  const router = createAppRouter(createMemoryHistory({ initialEntries: ['/'] }));
  return [...new Set(Object.keys(router.routesByPath).map(normalise))].sort();
}

/** Throws, naming every difference, unless the two sets are equal. */
function assertSameRoutes(listed: readonly string[], tree: readonly string[]): void {
  const inList = new Set(listed.map(normalise));
  const inTree = new Set(tree.map(normalise));
  const missing = [...inTree].filter((path) => !inList.has(path)).sort();
  const extra = [...inList].filter((path) => !inTree.has(path)).sort();
  const problems = [
    ...missing.map((path) => `the router has ${path}, e2e/routes.ts does not list it`),
    ...extra.map((path) => `e2e/routes.ts lists ${path}, the router has no such route`),
  ];
  if (problems.length > 0) throw new Error(problems.join('; '));
}

describe('e2e/routes.ts against the route tree', () => {
  it('the router has routes at all (the comparison is not vacuous)', () => {
    expect(routerPaths().length).toBeGreaterThanOrEqual(10);
  });

  it('lists exactly the routes of the router', () => {
    assertSameRoutes(CLIENT_ROUTES, routerPaths());
  });

  it('ROUTES is the client routes plus the one unknown path, and the unknown path is no route', () => {
    expect(ROUTES).toEqual([...CLIENT_ROUTES, UNKNOWN_ROUTE]);
    expect(routerPaths()).not.toContain(UNKNOWN_ROUTE);
    expect(new Set(ROUTES).size).toBe(ROUTES.length);
  });

  it('every listed path is absolute and without a trailing slash', () => {
    for (const path of ROUTES) {
      expect(path).toMatch(/^\/([^/\s]+(\/[^/\s]+)*)?$/);
    }
  });

  describe('negative fixtures', () => {
    it('a route the router has but the list lacks fails', () => {
      const withoutAudit = CLIENT_ROUTES.filter((path) => path !== '/audit');
      expectGuardFails(() => assertSameRoutes(withoutAudit, routerPaths()), {
        name: 'assertSameRoutes (missing entry)',
        reason: 'the router has /audit, e2e/routes.ts does not list it',
      });
    });

    it('a listed route the router does not have fails', () => {
      expectGuardFails(() => assertSameRoutes([...CLIENT_ROUTES, '/ghost'], routerPaths()), {
        name: 'assertSameRoutes (listed route does not exist)',
        reason: 'e2e/routes.ts lists /ghost, the router has no such route',
      });
    });

    it('the unknown path listed as a route fails', () => {
      expectGuardFails(() => assertSameRoutes([...CLIENT_ROUTES, UNKNOWN_ROUTE], routerPaths()), {
        name: 'assertSameRoutes (unknown path)',
        reason: UNKNOWN_ROUTE,
      });
    });
  });
});

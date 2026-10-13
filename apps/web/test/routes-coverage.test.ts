// THE E2E ROUTE LIST AND THE ROUTER'S ROUTE TREE ARE THE SAME SET (FR-A-151, TA-07).
//
// `e2e/routes.ts` is the single route list used by axe, visual regression and Lighthouse. A page that
// is added to the router without being added there escapes every one of those audits; a path listed
// there that the router does not have audits a Not-found page by accident. Both directions fail.
// The one deliberate extra entry is `UNKNOWN_ROUTE`, which must NOT be a route (it is the Not-found
// page's own address).
//
// PARAMETERISED ROUTES (Phase C, D): `/users/$id`, `/groups/$id`, `/distribution-lists/$id` and `/contacts/$id` are pages of one user and one group. A
// parameter has no value in a path list, so such a route needs no entry of its own; the test knows them by
// name (`PARAMETERISED_ROUTES`), a parameterised route it does not know fails, and a listed path that
// is a concrete address of one (`/users/<guid>`) is accepted instead of being called an unknown page.
import { expectGuardFails } from '@m365portal/shared/testing';
import { createMemoryHistory } from '@tanstack/react-router';
import { describe, expect, it } from 'vitest';
import { CLIENT_ROUTES, ROUTES, SETTINGS_STATES, UNKNOWN_ROUTE } from '../../../e2e/routes';
import { createAppRouter } from '../src/router';

/** `/settings/` and `/settings` are the same page. */
const normalise = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, '') : path);

/** The paths of the real route tree. */
function routerPaths(): string[] {
  const router = createAppRouter(createMemoryHistory({ initialEntries: ['/'] }));
  return [...new Set(Object.keys(router.routesByPath).map(normalise))].sort();
}

/** The pages of one object (Phase C). The path of such a page has a `$` segment, the id of the object. */
const PARAMETERISED_ROUTES: readonly string[] = [
  '/contacts/$id',
  '/distribution-lists/$id',
  '/groups/$id',
  '/users/$id',
];

/** Does the listed path name a page of one of these routes (`/users/<anything>` for `/users/$id`)? */
function isConcreteAddressOf(path: string, pattern: string): boolean {
  const listed = path.split('/');
  const parts = pattern.split('/');
  return (
    listed.length === parts.length &&
    parts.every((part, index) => part.startsWith('$') || part === listed[index])
  );
}

/** Throws, naming every difference, unless the two sets are equal (parameterised routes aside, see above). */
function assertSameRoutes(listed: readonly string[], tree: readonly string[]): void {
  const treePaths = tree.map(normalise);
  const parameterised = treePaths.filter((path) => path.includes('$'));
  const inList = new Set(listed.map(normalise));
  const inTree = new Set(treePaths.filter((path) => !path.includes('$')));
  const missing = [...inTree].filter((path) => !inList.has(path)).sort();
  const extra = [...inList]
    .filter((path) => !inTree.has(path))
    .filter((path) => !parameterised.some((pattern) => isConcreteAddressOf(path, pattern)))
    .sort();
  const unknown = parameterised.filter((path) => !PARAMETERISED_ROUTES.includes(path)).sort();
  const problems = [
    ...missing.map((path) => `the router has ${path}, e2e/routes.ts does not list it`),
    ...extra.map((path) => `e2e/routes.ts lists ${path}, the router has no such route`),
    ...unknown.map(
      (path) => `the router has the parameterised route ${path}, this test does not know it`,
    ),
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

  it('knows the two parameterised routes of Phase C, and they are in the router', () => {
    const paths = routerPaths();
    for (const path of PARAMETERISED_ROUTES) expect(paths, path).toContain(path);
    expect(paths.filter((path) => path.includes('$')).sort()).toEqual([...PARAMETERISED_ROUTES]);
  });

  it('the Phase B routes are in the router and in the list (T-B-381)', () => {
    const phaseB = [
      '/signin',
      '/no-access',
      '/setup',
      '/break-glass',
      '/settings/connection',
      '/settings/access',
      '/settings/restore-access',
    ];
    for (const path of phaseB) {
      expect(routerPaths(), `the router has ${path}`).toContain(path);
      expect(CLIENT_ROUTES, `e2e/routes.ts lists ${path}`).toContain(path);
    }
  });

  it('every page of the state lists is a listed route', () => {
    for (const path of SETTINGS_STATES) expect(CLIENT_ROUTES).toContain(path);
  });

  it('every listed path is absolute and without a trailing slash', () => {
    for (const path of ROUTES) {
      expect(path).toMatch(/^\/([^/\s]+(\/[^/\s]+)*)?$/);
    }
  });

  describe('negative fixtures', () => {
    it('a route the router has but the list lacks fails', () => {
      const withoutAudit = CLIENT_ROUTES.filter((path) => path !== '/audit');
      expectGuardFails(
        () => {
          assertSameRoutes(withoutAudit, routerPaths());
        },
        {
          name: 'assertSameRoutes (missing entry)',
          reason: 'the router has /audit, e2e/routes.ts does not list it',
        },
      );
    });

    it('a listed route the router does not have fails', () => {
      expectGuardFails(
        () => {
          assertSameRoutes([...CLIENT_ROUTES, '/ghost'], routerPaths());
        },
        {
          name: 'assertSameRoutes (listed route does not exist)',
          reason: 'e2e/routes.ts lists /ghost, the router has no such route',
        },
      );
    });

    it('a Phase B route missing from the list fails, naming it', () => {
      expectGuardFails(
        () => {
          assertSameRoutes(
            CLIENT_ROUTES.filter((path) => path !== '/break-glass'),
            routerPaths(),
          );
        },
        {
          name: 'assertSameRoutes (missing Phase B entry)',
          reason: 'the router has /break-glass, e2e/routes.ts does not list it',
        },
      );
    });

    it('a parameterised route the test does not know fails', () => {
      expectGuardFails(
        () => {
          assertSameRoutes(CLIENT_ROUTES, [...routerPaths(), '/audit/$entry']);
        },
        {
          name: 'assertSameRoutes (unknown parameterised route)',
          reason:
            'the router has the parameterised route /audit/$entry, this test does not know it',
        },
      );
    });

    it('a listed address that is no page of a parameterised route fails, one that is passes', () => {
      expectGuardFails(
        () => {
          assertSameRoutes([...CLIENT_ROUTES, '/users/abc/extra'], routerPaths());
        },
        {
          name: 'assertSameRoutes (too long an address)',
          reason: 'e2e/routes.ts lists /users/abc/extra, the router has no such route',
        },
      );
      expect(() => {
        assertSameRoutes(
          [...CLIENT_ROUTES, '/users/00000000-0000-4000-8000-000000001001'],
          routerPaths(),
        );
      }).not.toThrow();
    });

    it('the unknown path listed as a route fails', () => {
      expectGuardFails(
        () => {
          assertSameRoutes([...CLIENT_ROUTES, UNKNOWN_ROUTE], routerPaths());
        },
        {
          name: 'assertSameRoutes (unknown path)',
          reason: UNKNOWN_ROUTE,
        },
      );
    });
  });
});

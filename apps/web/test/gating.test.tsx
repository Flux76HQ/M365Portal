//
// PROVIDERS, ROUTER AND ROUTE GATING (FR-A-113, FR-A-126 base; plan 9.1; T-A-166).
//
// What this proves:
//   1. the providers are mounted in the order Query, language, Motion (with the nonce), Router, Toast;
//   2. `requirePermission(anyOf)` allows or denies from `me.permissions`, deny by default;
//   3. a denied route shows the No-access content at the same URL: the history is not touched, so the
//      address stays honest and Back works (plan 9.1);
//   4. `document.title` becomes `<page> - <organisation name>` after navigation, with the page part
//      translated and the organisation name never translated.
// The route trees are small, code-based ones: the real file-based tree arrives with T-A-169. The page
// titles use keys that exist in the catalogue today (problem.not_found, problem.permission_denied);
// the real titles are the `nav` keys of T-A-167.
import { createTranslator } from '@m365portal/shared/i18n';
import type { Permission } from '@m365portal/shared/permissions';
import {
  Outlet,
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  type AnyRouter,
  type RouterHistory,
} from '@tanstack/react-router';
import { act, render, screen, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { RootProviders } from '../src/components/pages/root-providers';
import { renderApp } from './helpers/render-shell';
import { useToast } from '../src/components/ui/toast';
import { createApiClient, type ApiClient } from '../src/lib/api';
import {
  gatedPage,
  hasAccess,
  isPublicPath,
  loadMe,
  requireAnyOf,
  requirePermission,
} from '../src/lib/gating';
import { createLanguageController } from '../src/lib/locale';
import { createAppQueryClient, seedQueryClient } from '../src/lib/query';
import { baseRouterOptions, createAppRouter } from '../src/router';
import { createStorage } from '../src/lib/storage';
import type { RouterContext } from '../src/lib/router-context';
import { sampleBranding, sampleMe, sampleSignedInMe } from './helpers/boot-fixtures';

// ---------------------------------------------------------------------------------------------
// Spies on the providers, to record the order in which they render. They call through.
// ---------------------------------------------------------------------------------------------

const rendered = vi.hoisted(() => ({
  order: [] as string[],
  motion: [] as Record<string, unknown>[],
}));

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    QueryClientProvider: (props: Parameters<typeof actual.QueryClientProvider>[0]) => {
      rendered.order.push('query');
      return createElement(actual.QueryClientProvider, props);
    },
  };
});

vi.mock('../src/lib/locale', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/locale')>();
  return {
    ...actual,
    LanguageProvider: (props: Parameters<typeof actual.LanguageProvider>[0]) => {
      rendered.order.push('language');
      return createElement(actual.LanguageProvider, props);
    },
  };
});

vi.mock('../src/components/ui/motion-provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/components/ui/motion-provider')>();
  return {
    ...actual,
    MotionProvider: (props: Parameters<typeof actual.MotionProvider>[0]) => {
      rendered.order.push('motion');
      rendered.motion.push({ ...props });
      return createElement(actual.MotionProvider, props);
    },
  };
});

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>();
  return {
    ...actual,
    RouterProvider: (props: Parameters<typeof actual.RouterProvider>[0]) => {
      rendered.order.push('router');
      return createElement(actual.RouterProvider, props);
    },
  };
});

vi.mock('../src/components/ui/toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/components/ui/toast')>();
  return {
    ...actual,
    ToastProvider: (props: Parameters<typeof actual.ToastProvider>[0]) => {
      rendered.order.push('toast');
      return createElement(actual.ToastProvider, props);
    },
  };
});

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

function freshApi(): ApiClient {
  return createApiClient({
    buildVersion: null,
    fetch: () => Promise.reject(new TypeError('the test has no network')),
  });
}

interface Setup {
  readonly queryClient: ReturnType<typeof createAppQueryClient>;
  readonly context: RouterContext;
}

function setup(permissions: readonly Permission[], orgName = 'Acme'): Setup {
  const api = freshApi();
  const queryClient = createAppQueryClient();
  seedQueryClient(
    queryClient,
    { me: sampleMe({ permissions }), branding: sampleBranding(orgName) },
    api,
  );
  return { queryClient, context: { queryClient, api } };
}

function languageController(language: 'en' | 'nl' = 'en') {
  return createLanguageController({
    storage: createStorage(null),
    languages: [language],
    root: document.createElement('html'),
  });
}

const root = () =>
  createRootRouteWithContext<RouterContext>()({
    beforeLoad: ({ context }) => loadMe(context),
    component: Outlet,
  });

function NoAccess(): ReactNode {
  return <p>No access content</p>;
}

/** `/` is open, `/users` needs users:read, `/settings` needs any settings permission. */
function testTree() {
  const rootRoute = root();
  const index = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    staticData: { titleKey: 'problem.not_found' },
    component: () => <p>Dashboard page</p>,
  });
  const users = createRoute({
    getParentRoute: () => rootRoute,
    path: '/users',
    staticData: { titleKey: 'problem.permission_denied' },
    beforeLoad: requirePermission(['users:read']),
    component: gatedPage(() => <p>Users page</p>, NoAccess),
  });
  const settings = createRoute({
    getParentRoute: () => rootRoute,
    path: '/settings',
    beforeLoad: requireAnyOf(['settings:branding', 'settings:connection']),
    component: gatedPage(() => <p>Settings page</p>, NoAccess),
  });
  return rootRoute.addChildren([index, users, settings]);
}

function routerFor(context: RouterContext, history: RouterHistory) {
  return createRouter({ routeTree: testTree(), history, ...baseRouterOptions(context) });
}

function mount(
  router: AnyRouter,
  environment: Setup,
  options: { language?: ReturnType<typeof languageController>; nonce?: string } = {},
) {
  return render(
    <RootProviders
      // The test tree is not the registered one; the providers only need a router.
      router={router as never}
      queryClient={environment.queryClient}
      language={options.language ?? languageController()}
      nonce={options.nonce}
    />,
  );
}

// ---------------------------------------------------------------------------------------------
// 1. The providers
// ---------------------------------------------------------------------------------------------

describe('the providers', () => {
  it('are mounted in the order Query, language, Motion, Router, Toast', async () => {
    rendered.order.length = 0;
    const environment = setup([]);
    const router = routerFor(environment.context, createMemoryHistory({ initialEntries: ['/'] }));

    mount(router, environment);
    await screen.findByText('Dashboard page');

    const firstSeen = [...new Set(rendered.order)];
    expect(firstSeen).toEqual(['query', 'language', 'motion', 'router', 'toast']);
  });

  it('give Motion the CSP nonce of the page', async () => {
    rendered.motion.length = 0;
    const environment = setup([]);
    const router = routerFor(environment.context, createMemoryHistory({ initialEntries: ['/'] }));

    mount(router, environment, { nonce: 'page-nonce-123' });
    await screen.findByText('Dashboard page');

    expect(rendered.motion.at(-1)?.nonce).toBe('page-nonce-123');
  });

  it('make the toast available inside the routes, with labels from the catalogue', async () => {
    const environment = setup([]);
    const rootRoute = root();
    function Page(): ReactNode {
      const { toast } = useToast();
      return (
        <button
          type="button"
          onClick={() => {
            toast({ title: 'Saved' });
          }}
        >
          Save
        </button>
      );
    }
    const index = createRoute({ getParentRoute: () => rootRoute, path: '/', component: Page });
    const router = createRouter({
      routeTree: rootRoute.addChildren([index]),
      history: createMemoryHistory({ initialEntries: ['/'] }),
      ...baseRouterOptions(environment.context),
    });
    mount(router, environment, { language: languageController('nl') });

    (await screen.findByRole('button', { name: 'Save' })).click();

    expect(await screen.findByText('Saved')).toBeInTheDocument();
    // The close button of the toast is named in Dutch, from the catalogue.
    expect(
      await screen.findByRole('button', { name: createTranslator('nl').t('common.close') }),
    ).toBeInTheDocument();
  });

  it('give the routes the query client and the language of the page', async () => {
    const environment = setup([]);
    const language = languageController('nl');
    const rootRoute = root();
    function Page(): ReactNode {
      return <p>{createTranslator(language.language).t('common.close')}</p>;
    }
    const index = createRoute({ getParentRoute: () => rootRoute, path: '/', component: Page });
    const router = createRouter({
      routeTree: rootRoute.addChildren([index]),
      history: createMemoryHistory({ initialEntries: ['/'] }),
      ...baseRouterOptions(environment.context),
    });

    mount(router, environment, { language });

    expect(await screen.findByText('Sluiten')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------------------------
// 2. requirePermission
// ---------------------------------------------------------------------------------------------

describe('requirePermission', () => {
  const gate = (held: readonly Permission[], anyOf: readonly Permission[]) =>
    requirePermission(anyOf)({ context: { me: sampleMe({ permissions: held }) } });

  it('allows when the actor holds any one of the permissions', () => {
    expect(gate(['users:read'], ['users:read'])).toEqual({ access: 'allowed' });
    expect(gate(['groups:read', 'users:read'], ['users:read'])).toEqual({ access: 'allowed' });
    expect(gate(['settings:connection'], ['settings:branding', 'settings:connection'])).toEqual({
      access: 'allowed',
    });
  });

  it('denies when it holds none, and by default: nothing held, or nothing required', () => {
    expect(gate(['groups:read'], ['users:read'])).toEqual({ access: 'denied' });
    expect(gate([], ['users:read'])).toEqual({ access: 'denied' });
    expect(gate(['users:read'], [])).toEqual({ access: 'denied' });
    expect(gate([], [])).toEqual({ access: 'denied' });
  });

  it('is the same function as requireAnyOf', () => {
    expect(requirePermission).toBe(requireAnyOf);
  });

  it('hasAccess answers the same question for a component', () => {
    expect(hasAccess(sampleMe({ permissions: ['users:read'] }), ['users:read'])).toBe(true);
    expect(hasAccess(sampleMe(), ['users:read'])).toBe(false);
    expect(hasAccess(sampleSignedInMe(), ['audit:read'])).toBe(true);
  });
});

describe('loadMe', () => {
  it('answers from the cache the boot data seeded, without a request', async () => {
    const environment = setup(['users:read']);
    const fetchSpy = vi.fn<() => Promise<Response>>(() => Promise.reject(new Error('no network')));
    const context: RouterContext = {
      queryClient: environment.queryClient,
      api: createApiClient({ fetch: fetchSpy, buildVersion: null }),
    };

    const { me } = await loadMe(context);

    expect(me.permissions).toEqual(['users:read']);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetches /api/v1/me when nothing was embedded (a development server)', async () => {
    const me = sampleSignedInMe();
    const urls: string[] = [];
    const api = createApiClient({
      buildVersion: null,
      fetch: (url) => {
        urls.push(url);
        return Promise.resolve(
          new Response(JSON.stringify(me), { headers: { 'Content-Type': 'application/json' } }),
        );
      },
    });

    const loaded = await loadMe({ queryClient: createAppQueryClient(), api });

    expect(urls).toEqual(['/api/v1/me']);
    expect(loaded.me).toEqual(me);
  });
});

// ---------------------------------------------------------------------------------------------
// 3. A denied route renders No-access at the same URL
// ---------------------------------------------------------------------------------------------

describe('a denied route', () => {
  it('shows the No-access content at the same URL and leaves the history alone', async () => {
    const environment = setup([]);
    const history = createMemoryHistory({ initialEntries: ['/'] });
    const router = routerFor(environment.context, history);
    mount(router, environment);
    await screen.findByText('Dashboard page');
    const entriesBefore = history.length;

    act(() => {
      history.push('/users');
    });

    expect(await screen.findByText('No access content')).toBeInTheDocument();
    expect(screen.queryByText('Users page')).not.toBeInTheDocument();
    expect(history.location.pathname).toBe('/users');
    expect(router.state.location.pathname).toBe('/users');
    expect(history.length).toBe(entriesBefore + 1); // one push for the navigation, no redirect

    // Back works: it returns to where the person came from.
    act(() => {
      history.back();
    });
    expect(await screen.findByText('Dashboard page')).toBeInTheDocument();
  });

  it('shows the page when the permission is there', async () => {
    const environment = setup(['users:read']);
    const router = routerFor(
      environment.context,
      createMemoryHistory({ initialEntries: ['/users'] }),
    );

    mount(router, environment);

    expect(await screen.findByText('Users page')).toBeInTheDocument();
    expect(screen.queryByText('No access content')).not.toBeInTheDocument();
  });

  it('gates on any one of several permissions', async () => {
    const allowed = setup(['settings:connection']);
    mount(
      routerFor(allowed.context, createMemoryHistory({ initialEntries: ['/settings'] })),
      allowed,
    );
    expect(await screen.findByText('Settings page')).toBeInTheDocument();
  });

  it('denies a deep link typed into the address bar the same way (no page flash first)', async () => {
    const environment = setup([]);
    const router = routerFor(
      environment.context,
      createMemoryHistory({ initialEntries: ['/settings'] }),
    );

    mount(router, environment);

    expect(await screen.findByText('No access content')).toBeInTheDocument();
    expect(screen.queryByText('Settings page')).not.toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/settings');
  });
});

// ---------------------------------------------------------------------------------------------
// 4. document.title
// ---------------------------------------------------------------------------------------------

describe('document.title', () => {
  it('is <page> - <organisation name> after navigation, the page part translated', async () => {
    const environment = setup(['users:read'], 'Acme');
    const history = createMemoryHistory({ initialEntries: ['/'] });
    const router = routerFor(environment.context, history);
    const en = createTranslator('en');
    mount(router, environment);

    await waitFor(() => {
      expect(document.title).toBe(`${en.t('problem.not_found')} - Acme`);
    });

    act(() => {
      history.push('/users');
    });

    await waitFor(() => {
      expect(document.title).toBe(`${en.t('problem.permission_denied')} - Acme`);
    });
  });

  it('follows the language, and never translates the organisation name', async () => {
    const environment = setup([], 'Gebruikers & Co');
    const language = languageController('en');
    const router = routerFor(environment.context, createMemoryHistory({ initialEntries: ['/'] }));
    mount(router, environment, { language });
    await waitFor(() => {
      expect(document.title).toBe(
        `${createTranslator('en').t('problem.not_found')} - Gebruikers & Co`,
      );
    });

    act(() => {
      language.setLanguage('nl');
    });

    await waitFor(() => {
      expect(document.title).toBe(
        `${createTranslator('nl').t('problem.not_found')} - Gebruikers & Co`,
      );
    });
  });

  it('is only the organisation name on a page without a title key', async () => {
    const environment = setup(['settings:branding'], 'Acme');
    const router = routerFor(
      environment.context,
      createMemoryHistory({ initialEntries: ['/settings'] }),
    );

    mount(router, environment);
    await screen.findByText('Settings page');

    await waitFor(() => {
      expect(document.title).toBe('Acme');
    });
  });

  it('keeps an organisation name with markup as plain text', async () => {
    const name = '"><img src=x onerror=alert(1)>';
    const environment = setup([], name);
    const router = routerFor(environment.context, createMemoryHistory({ initialEntries: ['/'] }));

    mount(router, environment);

    await waitFor(() => {
      expect(document.title).toBe(`${createTranslator('en').t('problem.not_found')} - ${name}`);
    });
    expect(document.querySelector('img')).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// The real app router
// ---------------------------------------------------------------------------------------------

describe('createAppRouter', () => {
  it('builds the router with the base options: preloading, scroll restoration, the two wraps', () => {
    const environment = setup([]);
    const options = baseRouterOptions(environment.context);

    expect(options.defaultPreload).toBe('intent');
    expect(options.scrollRestoration).toBe(true);
    expect(typeof options.Wrap).toBe('function');
    expect(typeof options.InnerWrap).toBe('function');
    expect(options.context).toBe(environment.context);

    const router = createAppRouter(
      createMemoryHistory({ initialEntries: ['/'] }),
      environment.context,
    );
    expect(router.options.context).toBe(environment.context);
  });
});

// ---------------------------------------------------------------------------------------------
// The sign-in gate of the root route (T-B-297; FR-B-607, FR-B-402; plan 12.1)
// ---------------------------------------------------------------------------------------------

describe('isPublicPath: the pages an anonymous visitor may open', () => {
  it.each(['/signin', '/no-access', '/break-glass', '/setup', '/setup/anything', '/setup/a/b'])(
    '%s is public',
    (path) => {
      expect(isPublicPath(path)).toBe(true);
    },
  );

  it.each([
    '/',
    '/users',
    '/settings',
    '/settings/connection',
    '/setupx',
    '/setup-wizard',
    '/signin/extra',
    '/signins',
    '/Signin',
    '/break-glass/x',
    '/no-access/x',
    '/design',
    '',
    '/this-page-does-not-exist',
  ])('%s is gated', (path) => {
    expect(isPublicPath(path)).toBe(false);
  });
});

describe('an anonymous visitor of a gated route is replaced by /signin?returnTo=<the path>', () => {
  it('replaces the entry in the history, so Back does not return to the gated page', async () => {
    const { router } = await renderApp({ me: sampleMe(), path: '/users' });
    await screen.findByRole('heading', { level: 1 });
    expect(router.state.location.pathname).toBe('/signin');
    expect(router.state.location.search).toEqual({ returnTo: '/users' });
    expect(router.history.length).toBe(1);
  });

  it('keeps the query of the page in returnTo', async () => {
    const { router } = await renderApp({ me: sampleMe(), path: '/settings/appearance?tab=logo' });
    await screen.findByRole('heading', { level: 1 });
    expect(router.state.location.search).toEqual({ returnTo: '/settings/appearance?tab=logo' });
  });

  it('gates the dashboard and an address that is no page too, and leaves returnTo out for /', async () => {
    const dashboard = await renderApp({ me: sampleMe(), path: '/' });
    await screen.findByRole('heading', { level: 1 });
    expect(dashboard.router.state.location.pathname).toBe('/signin');
    expect(dashboard.router.state.location.search).toEqual({});
    dashboard.unmount();

    const unknown = await renderApp({ me: sampleMe(), path: '/this-page-does-not-exist' });
    await screen.findByRole('heading', { level: 1 });
    expect(unknown.router.state.location.pathname).toBe('/signin');
    expect(unknown.router.state.location.search).toEqual({ returnTo: '/this-page-does-not-exist' });
  });

  it('never carries an unsafe path as returnTo', async () => {
    const { router } = await renderApp({ me: sampleMe(), path: '/setupx' });
    await screen.findByRole('heading', { level: 1 });
    expect(router.state.location.pathname).toBe('/signin');
    // /setupx starts with /setup, which a sign-in may never return to (safeReturnTo), so it is dropped.
    expect(router.state.location.search).toEqual({});
  });

  it('does not touch the public pages: /signin, /no-access, /break-glass and /setup* stay where they are', async () => {
    for (const path of ['/signin', '/no-access', '/break-glass', '/setup', '/setup/anything']) {
      const { router, unmount } = await renderApp({ me: sampleMe(), path });
      await screen.findByRole('main');
      expect(router.state.location.pathname, path).toBe(path);
      unmount();
    }
  });

  it('does not touch /setup* for any setup state: the server decides, not the client', async () => {
    for (const setupState of [
      'unconfigured',
      'in_progress',
      'awaiting_first_signin',
      'completed',
    ] as const) {
      const { router, unmount } = await renderApp({ me: sampleMe({ setupState }), path: '/setup' });
      await screen.findByRole('main');
      expect(router.state.location.pathname, setupState).toBe('/setup');
      unmount();
    }
  });
});

describe('a signed-in actor without the permission stays on the page and sees the No-access content', () => {
  it('shows it in place, at the same URL', async () => {
    const { router } = await renderApp({
      me: sampleMe({ kind: 'user', roles: ['reader'] }),
      path: '/settings/appearance',
    });
    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: createTranslator('en').t('pages.noAccess.title'),
      }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/settings/appearance');
  });
});

describe('no route renders a preview banner (FR-B-102)', () => {
  it('shows no banner on any route for a normal actor, and none says "preview"', async () => {
    for (const path of ['/', '/users', '/settings', '/signin', '/no-access']) {
      const { unmount } = await renderApp({ me: sampleSignedInMe(), path });
      await screen.findByRole('main');
      expect(screen.queryByRole('status'), path).not.toBeInTheDocument();
      expect(document.body.textContent.toLowerCase(), path).not.toContain('preview mode');
      expect(document.body.textContent.toLowerCase(), path).not.toContain('voorbeeldmodus');
      unmount();
    }
  });
});

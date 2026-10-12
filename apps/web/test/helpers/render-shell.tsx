// Mounts the application shell around small, code-based routes, the way main.tsx mounts the real
// one: the same providers (RootProviders), the same router options (baseRouterOptions), the root
// route's `beforeLoad` loading `me`. The real file-based tree is covered by pages.test.tsx.
//
// Storage and the language controller are injected, so a test never leaks a choice into the next one.
import type { Branding } from '@m365portal/shared/schemas/branding';
import {
  Outlet,
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  type AnyRoute,
} from '@tanstack/react-router';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode } from 'react';
import { AppShell } from '../../src/components/shell/AppShell';
import { RootProviders } from '../../src/components/pages/root-providers';
import { AuthRuntimeProvider } from '../../src/features/auth/runtime';
import { createSessionStore } from '../../src/features/auth/session-store';
import { createApiClient, type FetchFunction } from '../../src/lib/api';
import { createAuthEffects, type BrowserLocation } from '../../src/lib/auth-nav';
import type { MeResponse } from '../../src/lib/boot-data';
import { loadMe, requirePermission, gatedPage } from '../../src/lib/gating';
import { createLanguageController } from '../../src/lib/locale';
import { createAppQueryClient, seedQueryClient } from '../../src/lib/query';
import type { RouterContext } from '../../src/lib/router-context';
import { createStorage, type AppStorage, type KeyValueStore } from '../../src/lib/storage';
import { baseRouterOptions, createAppRouter } from '../../src/router';
import { sampleBranding, sampleMe } from './boot-fixtures';

/** A Web Storage stand-in that records what was written. */
export class MemoryBackend implements KeyValueStore {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}

export interface RenderShellOptions {
  readonly path?: string;
  readonly me?: MeResponse;
  readonly branding?: Branding;
  readonly language?: 'en' | 'nl';
  readonly backend?: MemoryBackend;
  readonly storage?: AppStorage;
  /** More routes under the root, for a test that needs a page that throws or loads slowly. */
  readonly extraRoutes?: (root: AnyRoute) => AnyRoute[];
  /** The network of the API client; by default there is none and every request fails. */
  readonly fetch?: FetchFunction;
  /** For a test with fake timers: how the simulated user advances them (`vi.advanceTimersByTime`). */
  readonly advanceTimers?: (milliseconds: number) => void | Promise<void>;
}

function Page({ children }: { readonly children: ReactNode }): ReactNode {
  return <h1>{children}</h1>;
}

/** The routes the shell tests walk: Dashboard, Users (gated), Settings and Settings, Appearance. */
function shellTree(extraRoutes?: RenderShellOptions['extraRoutes']) {
  const rootRoute = createRootRouteWithContext<RouterContext>()({
    beforeLoad: ({ context }) => loadMe(context),
    component: AppShell,
  });
  const index = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    staticData: { titleKey: 'nav.dashboard' },
    component: () => <Page>Dashboard page</Page>,
  });
  const users = createRoute({
    getParentRoute: () => rootRoute,
    path: '/users',
    staticData: { titleKey: 'nav.users' },
    beforeLoad: requirePermission(['users:read']),
    component: gatedPage(
      () => <Page>Users page</Page>,
      () => <Page>No access content</Page>,
    ),
  });
  const settings = createRoute({
    getParentRoute: () => rootRoute,
    path: '/settings',
    staticData: { titleKey: 'nav.settings' },
    component: Outlet,
  });
  const settingsIndex = createRoute({
    getParentRoute: () => settings,
    path: '/',
    component: () => <Page>Settings page</Page>,
  });
  const appearance = createRoute({
    getParentRoute: () => settings,
    path: '/appearance',
    staticData: { titleKey: 'nav.appearance' },
    component: () => <Page>Appearance page</Page>,
  });
  return rootRoute.addChildren([
    index,
    users,
    settings.addChildren([settingsIndex, appearance]),
    ...(extraRoutes?.(rootRoute) ?? []),
  ]);
}

/** The shell on small code-based routes (`shellTree`), or, with `real: true`, on the real route tree. */
export async function renderShell(options: RenderShellOptions & { readonly real?: boolean } = {}) {
  // The session UI of this render: its own store, and a location that records where the page is sent.
  const store = createSessionStore();
  const moves: string[] = [];
  let currentPath = options.path ?? '/';
  const location: BrowserLocation = {
    get pathname() {
      return new URL(currentPath, 'http://panel.test').pathname;
    },
    get search() {
      return new URL(currentPath, 'http://panel.test').search;
    },
    assign: (url) => moves.push(`assign ${url}`),
    replace: (url) => moves.push(`replace ${url}`),
  };
  const api = createApiClient({
    buildVersion: null,
    fetch: options.fetch ?? (() => Promise.reject(new TypeError('the test has no network'))),
    auth: createAuthEffects({ location, store }),
  });
  const queryClient = createAppQueryClient();
  const me = options.me ?? sampleMe();
  seedQueryClient(queryClient, { me, branding: options.branding ?? sampleBranding('Acme') }, api);
  store.noteMeSession(me.session);
  const backend = options.backend ?? new MemoryBackend();
  const storage = options.storage ?? createStorage(backend);
  const language = createLanguageController({
    storage: createStorage(null),
    languages: [options.language ?? 'en'],
    root: document.createElement('html'),
  });
  const history = createMemoryHistory({ initialEntries: [options.path ?? '/'] });
  const router =
    options.real === true
      ? createAppRouter(history, { queryClient, api })
      : createRouter({
          routeTree: shellTree(options.extraRoutes),
          history,
          ...baseRouterOptions({ queryClient, api }),
        });
  router.subscribe('onResolved', () => {
    currentPath = router.state.location.href;
  });
  const user = userEvent.setup(
    options.advanceTimers === undefined ? {} : { advanceTimers: options.advanceTimers },
  );
  const view = render(
    <AuthRuntimeProvider runtime={{ store, location }}>
      <RootProviders
        router={router as never}
        queryClient={queryClient}
        language={language}
        storage={storage}
      />
    </AuthRuntimeProvider>,
  );
  await router.load();
  currentPath = router.state.location.href;
  return { ...view, user, router, backend, storage, language, queryClient, store, moves, api };
}

/** The application on its real, file-based route tree. */
export function renderApp(options: RenderShellOptions = {}) {
  return renderShell({ ...options, real: true });
}

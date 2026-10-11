import { QueryClient } from '@tanstack/react-query';
import { createRouter, type RouterHistory } from '@tanstack/react-router';
import { AppToastProvider, DocumentTitleSync } from './components/pages/root-providers';
import { getApiClient } from './lib/api';
import type { RouterContext } from './lib/router-context';
import { routeTree } from './routeTree.gen';

/**
 * The options every router of the application has, the real one and the ones tests build from a
 * small route tree: the context, preloading on intent, scroll restoration, the toast provider around
 * the router and the document title inside it (root-providers.tsx).
 */
export function baseRouterOptions(context: RouterContext) {
  return {
    context,
    defaultPreload: 'intent',
    scrollRestoration: true,
    Wrap: AppToastProvider,
    InnerWrap: DocumentTitleSync,
  } as const;
}

/**
 * The file-based route tree lives in src/routes; routeTree.gen.ts is generated (`pnpm routes:generate`).
 * Without a context a private Query client and the API client of the page are used.
 */
export function createAppRouter(
  history?: RouterHistory,
  context: RouterContext = { queryClient: new QueryClient(), api: getApiClient() },
) {
  return createRouter({ routeTree, history, ...baseRouterOptions(context) });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter;
  }
}

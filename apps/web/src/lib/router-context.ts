// What every route can rely on (plan 9.1): the router context, and the hooks that read from it.
//
// The context is created once in main.tsx and handed to the router: the Query client (seeded with the
// embedded `me` and `branding`) and the API client. The root route's `beforeLoad` adds `me` to it
// (lib/gating.ts `loadMe`), so a child route can gate on `context.me` without a request, and a
// component can read the same data reactively with `useMe()`.
//
// It also declares what a route may say about itself in `staticData`: `titleKey`, the catalogue key of
// the page title (`document.title` is `<page> - <organisation name>`). Other keys (the breadcrumb
// label, the parent) are declared where they are used, as further members of the same interface.
import type { MessageKey } from '@m365portal/shared/i18n';
import type { Branding } from '@m365portal/shared/schemas/branding';
import { useRouter } from '@tanstack/react-router';
import { useQuery, useSuspenseQuery, type QueryClient } from '@tanstack/react-query';
import type { ApiClient } from './api';
import type { MeResponse } from './boot-data';
import { brandingQueryOptions, meQueryOptions } from './query';

export interface RouterContext {
  readonly queryClient: QueryClient;
  readonly api: ApiClient;
}

declare module '@tanstack/react-router' {
  interface StaticDataRouteOption {
    /** The catalogue key of the title of the page; the document title is `<this> - <organisation>`. */
    titleKey?: MessageKey;
  }
}

/** The context the router was created with. */
export function useRouterContext(): RouterContext {
  return useRouter().options.context;
}

/** Who the client is and what it may do. Always present: the root route loads it before any page. */
export function useMe(): MeResponse {
  return useSuspenseQuery(meQueryOptions(useRouterContext().api)).data;
}

/** The current branding, or undefined while it is not loaded (the embedded data makes that rare). */
export function useBranding(): Branding | undefined {
  return useQuery(brandingQueryOptions(useRouterContext().api)).data;
}

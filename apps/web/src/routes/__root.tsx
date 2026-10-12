import { createRootRouteWithContext } from '@tanstack/react-router';
import { NotFound } from '../components/pages/NotFound';
import { RootError } from '../components/pages/RootError';
import { RootLayout } from '../components/shell/AppShell';
import { loadMe, requireSignIn } from '../lib/gating';
import type { RouterContext } from '../lib/router-context';

// The root route loads `me` before any page (so every child can gate on `context.me` without a request),
// sends an anonymous visitor of a page that is not public to `/signin?returnTo=<path>` (T-B-297, FR-B-607;
// the setup wizard, the sign-in page, the no-access page and the break-glass form are public), draws the
// shell around the page, answers an unknown URL with Not-found inside the shell, and has its own error
// boundary for the case that `me` cannot be loaded at all.
export const Route = createRootRouteWithContext<RouterContext>()({
  beforeLoad: async ({ context, location }) => {
    const loaded = await loadMe(context);
    requireSignIn(loaded.me, location);
    return loaded;
  },
  component: RootLayout,
  notFoundComponent: NotFound,
  errorComponent: RootError,
});

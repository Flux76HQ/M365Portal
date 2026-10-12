import { createRootRouteWithContext } from '@tanstack/react-router';
import { NotFound } from '../components/pages/NotFound';
import { RootError } from '../components/pages/RootError';
import { RootLayout } from '../components/shell/AppShell';
import { loadMe, requireSignIn } from '../lib/gating';
import { loadLazyNamespace } from '../lib/locale';
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
  // The session text (the persona menu, the timers, the step-up dialog, the break-glass banner) is a lazy
  // catalogue that only a signed-in visitor needs (T-B-307).
  loader: async ({ context }) => {
    if (context.me.actor.kind === 'user' || context.me.actor.kind === 'break_glass') {
      await loadLazyNamespace('session');
    }
  },
  component: RootLayout,
  notFoundComponent: NotFound,
  errorComponent: RootError,
});

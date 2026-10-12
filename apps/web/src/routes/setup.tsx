import { createFileRoute } from '@tanstack/react-router';
import { SetupPage } from '../features/setup/SetupPage';
import { loadLazyNamespace } from '../lib/locale';

// /setup (FR-B-207, FR-B-221): public and never gated by the client; the server answers who may see it. The
// wizard's text is a lazy catalogue (`setup`), loaded here so that the first render has it, and the page
// itself is the route's own chunk. The proof list of the verify and finish steps is the connection page's, so
// its catalogue (`connection`) is loaded with it: without it the list shows keys instead of words. `/setup/<anything>` is the root route's Not-found (the shell of a
// public path), so no splat route exists.
export const Route = createFileRoute('/setup')({
  staticData: { titleKey: 'setup.title' },
  loader: async () => {
    await Promise.all([loadLazyNamespace('setup'), loadLazyNamespace('connection')]);
  },
  component: SetupPage,
});

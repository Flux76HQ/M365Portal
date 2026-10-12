import { createFileRoute } from '@tanstack/react-router';
import { SetupPage } from '../features/setup/SetupPage';
import { loadLazyNamespace } from '../lib/locale';

// /setup (FR-B-207, FR-B-221): public and never gated by the client; the server answers who may see it. The
// wizard's text is a lazy catalogue (`setup`), loaded here so that the first render has it, and the page
// itself is the route's own chunk. `/setup/<anything>` is the root route's Not-found (the shell of a
// public path), so no splat route exists.
export const Route = createFileRoute('/setup')({
  staticData: { titleKey: 'setup.title' },
  loader: async () => {
    await loadLazyNamespace('setup');
  },
  component: SetupPage,
});

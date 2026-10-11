import { createFileRoute } from '@tanstack/react-router';
import { NotFound } from '../components/pages/NotFound';
import { Showcase } from '../features/showcase/Showcase';
import { validateShowcaseSearch } from '../features/showcase/search';
import { gatedPage } from '../lib/gating';

// The page is long: it mounts in parts, one after each task, so no single commit blocks the main thread
// (lib/staged.ts; T-A-173).
function StagedShowcase() {
  return <Showcase staged />;
}

// The component showcase exists only while the server runs with SHOWCASE=true (FR-A-131): `me.features`
// says so, and otherwise the address is an ordinary unknown URL and shows Not-found. (Not `throw
// notFound()`: that value is not an Error, which the lint rule refuses, and the rule stays on.)
export const Route = createFileRoute('/design')({
  staticData: { titleKey: 'nav.design' },
  // The state of the demo table (`q`, `sort`, `page`, `size`, `f.department`) and `scenario` live in the URL.
  validateSearch: validateShowcaseSearch,
  beforeLoad: ({ context }) => ({
    access: context.me.features.showcase ? ('allowed' as const) : ('missing' as const),
  }),
  component: gatedPage(StagedShowcase, NotFound),
});

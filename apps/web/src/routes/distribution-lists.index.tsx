import { createFileRoute } from '@tanstack/react-router';
import { DistributionListsPage } from '../features/distribution-lists/DistributionListsPage';
import { validateDistributionListsSearch } from '../features/directory/search';
import { accessOf } from '../lib/gating';

// The list of distribution lists. The search text, the kind and the order are the search parameters of the
// address, validated by `validateDistributionListsSearch` (a bad link shows the plain list).
export const Route = createFileRoute('/distribution-lists/')({
  validateSearch: validateDistributionListsSearch,
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ context, deps }) => {
    // The first page starts while the page and the text load; the loader does not wait for it.
    if (accessOf(context) === 'allowed') {
      void import('../features/distribution-lists/queries')
        .then(({ prefetchLists }) => prefetchLists(context, deps.search))
        .catch(() => undefined);
    }
  },
  component: DistributionListsPage,
});

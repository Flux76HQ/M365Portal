import { createFileRoute } from '@tanstack/react-router';
import { GroupsPage } from '../features/groups/GroupsPage';
import { validateGroupsSearch } from '../features/directory/search';
import { accessOf } from '../lib/gating';

// The list of groups. The search text, the kind and the order are the search parameters of the address.
export const Route = createFileRoute('/groups/')({
  validateSearch: validateGroupsSearch,
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ context, deps }) => {
    // The first page starts while the page and the text load; the loader does not wait for it.
    if (accessOf(context) === 'allowed') {
      void import('../features/groups/queries')
        .then(({ prefetchGroups }) => prefetchGroups(context, deps.search))
        .catch(() => undefined);
    }
  },
  component: GroupsPage,
});

import { createFileRoute } from '@tanstack/react-router';
import { UsersPage } from '../features/users/UsersPage';
import { validateUsersSearch } from '../features/directory/search';
import { accessOf } from '../lib/gating';

// The list of users. The search text, the filters and the order are the search parameters of the address,
// validated by `validateUsersSearch` (a bad link shows the plain list).
export const Route = createFileRoute('/users/')({
  validateSearch: validateUsersSearch,
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ context, deps }) => {
    // The first page is asked for while the page and the text load; the loader does not wait for it: a slow
    // or failed answer is the page's own loading state or error. The queries are imported here and not at
    // the top: this file belongs to the entry, the schemas behind them to the route's own chunk.
    if (accessOf(context) === 'allowed') {
      void import('../features/users/queries')
        .then(({ prefetchUsers }) => prefetchUsers(context, deps.search))
        .catch(() => undefined);
    }
  },
  component: UsersPage,
});

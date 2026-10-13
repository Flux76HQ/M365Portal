import { createFileRoute } from '@tanstack/react-router';
import { ContactsPage } from '../features/contacts/ContactsPage';
import { validateContactsSearch } from '../features/directory/search';
import { accessOf } from '../lib/gating';

// The list of contacts. The search text and the order are the search parameters of the address, validated by
// `validateContactsSearch` (a bad link shows the plain list).
export const Route = createFileRoute('/contacts/')({
  validateSearch: validateContactsSearch,
  loaderDeps: ({ search }) => ({ search }),
  loader: ({ context, deps }) => {
    // The first page starts while the page and the text load; the loader does not wait for it.
    if (accessOf(context) === 'allowed') {
      void import('../features/contacts/queries')
        .then(({ prefetchContacts }) => prefetchContacts(context, deps.search))
        .catch(() => undefined);
    }
  },
  component: ContactsPage,
});

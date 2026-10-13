import { createFileRoute } from '@tanstack/react-router';
import { ContactDetail } from '../features/contacts/ContactDetail';
import { isGuid } from '../features/directory/guid';
import { accessOf, hasAccess } from '../lib/gating';

// One contact. The contact and the first page of its lists start at once; the loader does not wait for them.
export const Route = createFileRoute('/contacts/$id')({
  staticData: { titleKey: 'contacts.detail.title' },
  loader: ({ context, params }) => {
    if (accessOf(context) === 'allowed' && isGuid(params.id)) {
      const withLists = hasAccess(context.me, ['distributionlists:read']);
      void import('../features/contacts/queries')
        .then(({ prefetchContact }) => prefetchContact(context, params.id, withLists))
        .catch(() => undefined);
    }
  },
  component: ContactDetail,
});

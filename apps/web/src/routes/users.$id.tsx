import { createFileRoute } from '@tanstack/react-router';
import { UserDetail } from '../features/users/UserDetail';
import { isGuid } from '../features/directory/guid';
import { accessOf } from '../lib/gating';

// One user. The id is a GUID in the address (the page asks for nothing when it is not one).
export const Route = createFileRoute('/users/$id')({
  staticData: { titleKey: 'users.detail.title' },
  loader: ({ context, params }) => {
    // The user and the first page of their groups start at once; the loader does not wait for them.
    if (accessOf(context) === 'allowed' && isGuid(params.id)) {
      const withGroups = context.me.permissions.includes('groups:read');
      void import('../features/users/queries')
        .then(({ prefetchUser }) => prefetchUser(context, params.id, withGroups))
        .catch(() => undefined);
    }
  },
  component: UserDetail,
});

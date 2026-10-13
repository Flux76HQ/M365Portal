import { createFileRoute } from '@tanstack/react-router';
import { GroupDetail } from '../features/groups/GroupDetail';
import { isGuid } from '../features/directory/guid';
import { accessOf } from '../lib/gating';

// One group. The group, its owners and its members start at once; the loader does not wait for them.
export const Route = createFileRoute('/groups/$id')({
  staticData: { titleKey: 'groups.detail.title' },
  loader: ({ context, params }) => {
    if (accessOf(context) === 'allowed' && isGuid(params.id)) {
      void import('../features/groups/queries')
        .then(({ prefetchGroup }) => prefetchGroup(context, params.id))
        .catch(() => undefined);
    }
  },
  component: GroupDetail,
});

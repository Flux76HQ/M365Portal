import { createFileRoute } from '@tanstack/react-router';
import { DistributionListDetail } from '../features/distribution-lists/DistributionListDetail';
import { isGuid } from '../features/directory/guid';
import { accessOf } from '../lib/gating';

// One distribution list. The list and its first page of members start at once; the loader does not wait.
export const Route = createFileRoute('/distribution-lists/$id')({
  staticData: { titleKey: 'distributionLists.detail.title' },
  loader: ({ context, params }) => {
    if (accessOf(context) === 'allowed' && isGuid(params.id)) {
      void import('../features/distribution-lists/queries')
        .then(({ prefetchList }) => prefetchList(context, params.id))
        .catch(() => undefined);
    }
  },
  component: DistributionListDetail,
});

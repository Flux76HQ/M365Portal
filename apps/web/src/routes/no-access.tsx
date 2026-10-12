import { createFileRoute } from '@tanstack/react-router';
import { NoAccessReason } from '../features/auth/NoAccessReason';
import { stringSearchParam } from '../lib/search';

// /no-access (FR-B-607): public. `?reason=` is `no_role` or `graph_unavailable` (anything else is read
// as `no_role`) and `?ref=` the request id of the failed sign-in, shown only when it looks like one.
// A person who signed in at Microsoft but holds no role has no session, so the page needs none. (An
// actor who lacks one permission sees the in-place No-access content of the page they opened, not
// this route.)
export interface NoAccessSearch {
  readonly reason?: string;
  readonly ref?: string;
}

export const Route = createFileRoute('/no-access')({
  staticData: { titleKey: 'nav.noAccess' },
  validateSearch: (search: Record<string, unknown>): NoAccessSearch => {
    const reason = stringSearchParam(search.reason);
    const ref = stringSearchParam(search.ref);
    return {
      ...(reason === undefined ? {} : { reason }),
      ...(ref === undefined ? {} : { ref }),
    };
  },
  component: NoAccessReason,
});

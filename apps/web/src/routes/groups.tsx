import { Outlet, createFileRoute } from '@tanstack/react-router';
import { NoAccess } from '../components/pages/NoAccess';
import { gatedPage, requirePermission } from '../lib/gating';
import { DIRECTORY_NAMESPACES, MEMBER_NAMESPACES, loadLazyNamespaces } from '../lib/locale';

// /groups (FR-C-501): the layout of the groups pages, the list below it and one page for a group. Gated by
// `groups:read`, as /users is by `users:read`; the text of both directory namespaces is loaded here (a
// group's page lists users, and both name the permission message of `users`, EC-C14). Member editing (Phase D)
// uses the picker and the result text of `distributionLists`, so the groups pages load that namespace too.
export const Route = createFileRoute('/groups')({
  staticData: { titleKey: 'nav.groups' },
  beforeLoad: requirePermission(['groups:read']),
  loader: async () => {
    await loadLazyNamespaces([...DIRECTORY_NAMESPACES, ...MEMBER_NAMESPACES]);
  },
  component: gatedPage(Outlet, NoAccess),
});

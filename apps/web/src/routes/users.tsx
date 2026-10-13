import { Outlet, createFileRoute } from '@tanstack/react-router';
import { NoAccess } from '../components/pages/NoAccess';
import { gatedPage, requirePermission } from '../lib/gating';
import { DIRECTORY_NAMESPACES, loadLazyNamespaces } from '../lib/locale';

// /users (FR-C-501): the layout of the users pages, the list below it and one page for a user. It holds the
// gate and the text, so the pages below share them. Gated by `users:read`; an actor without it sees the
// No-access content at the same URL, whichever page of the folder the address names. The server enforces;
// this only decides what is shown. The text of both directory namespaces (users and groups) is loaded here:
// the user's page lists groups, and both name the permission message of `users` (EC-C14).
export const Route = createFileRoute('/users')({
  staticData: { titleKey: 'nav.users' },
  beforeLoad: requirePermission(['users:read']),
  loader: async () => {
    await loadLazyNamespaces(DIRECTORY_NAMESPACES);
  },
  component: gatedPage(Outlet, NoAccess),
});

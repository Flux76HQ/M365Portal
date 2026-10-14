import { createFileRoute } from '@tanstack/react-router';
import { NoAccess } from '../components/pages/NoAccess';
import { RolesPage } from '../features/access/RolesPage';
import { gatedPage, requirePermission } from '../lib/gating';
import { ACCESS_NAMESPACES, loadLazyNamespaces } from '../lib/locale';
import { useMe } from '../lib/router-context';

function Roles() {
  const me = useMe();
  // The break-glass session holds `rbac:manage` but can only restore an Owner: the server refuses these routes to it
  // (`actorKinds: ['user']`), so the page is No-access for it and asks the API for nothing.
  return me.actor.kind === 'user' ? <RolesPage /> : <NoAccess />;
}

// /settings/roles, "Rollen en toegang" (Phase D3, FR-B-508, ADR-0183): give existing users and groups a role. It needs
// `rbac:manage`; anyone else sees the in-place No-access content at the same address. The server enforces every
// call (permission, step-up, no privilege escalation, last Owner); this page only offers the form.
export const Route = createFileRoute('/settings/roles')({
  staticData: { titleKey: 'access.admin.title' },
  beforeLoad: requirePermission(['rbac:manage']),
  loader: async () => {
    await loadLazyNamespaces(ACCESS_NAMESPACES);
  },
  component: gatedPage(Roles, NoAccess),
});

import { createFileRoute } from '@tanstack/react-router';
import { AccessPage } from '../features/access/AccessPage';
import { ACCESS_NAMESPACES, loadLazyNamespaces } from '../lib/locale';

// /settings/access, "Mijn toegang" (FR-B-514): open to any signed-in actor (the root route sends an anonymous
// visitor to the sign-in), so it has no permission gate. The server answers for the actor it resolves.
export const Route = createFileRoute('/settings/access')({
  staticData: { titleKey: 'access.page.title' },
  loader: async () => {
    await loadLazyNamespaces(ACCESS_NAMESPACES);
  },
  component: AccessPage,
});

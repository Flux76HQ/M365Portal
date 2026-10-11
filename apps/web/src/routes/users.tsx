import { createFileRoute } from '@tanstack/react-router';
import { NoAccess } from '../components/pages/NoAccess';
import { PlaceholderPage } from '../components/pages/PlaceholderPage';
import { gatedPage, requirePermission } from '../lib/gating';

// Phase C (FR-A-129, FR-A-130): a placeholder that says so. Gated by `users:read`; an actor without it sees
// the No-access content at this same URL. The server enforces; this only decides what the page shows.
function UsersPage() {
  return (
    <PlaceholderPage
      titleKey="nav.users"
      descriptionKey="placeholders.users.description"
      phase="C"
    />
  );
}

export const Route = createFileRoute('/users')({
  staticData: { titleKey: 'nav.users' },
  beforeLoad: requirePermission(['users:read']),
  component: gatedPage(UsersPage, NoAccess),
});

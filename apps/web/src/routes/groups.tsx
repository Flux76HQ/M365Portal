import { createFileRoute } from '@tanstack/react-router';
import { NoAccess } from '../components/pages/NoAccess';
import { PlaceholderPage } from '../components/pages/PlaceholderPage';
import { gatedPage, requirePermission } from '../lib/gating';

// Phase C (FR-A-129, FR-A-130): a placeholder that says so. Gated by `groups:read`; an actor without it sees
// the No-access content at this same URL. The server enforces; this only decides what the page shows.
function GroupsPage() {
  return (
    <PlaceholderPage
      titleKey="nav.groups"
      descriptionKey="placeholders.groups.description"
      phase="C"
    />
  );
}

export const Route = createFileRoute('/groups')({
  staticData: { titleKey: 'nav.groups' },
  beforeLoad: requirePermission(['groups:read']),
  component: gatedPage(GroupsPage, NoAccess),
});

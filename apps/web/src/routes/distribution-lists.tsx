import { createFileRoute } from '@tanstack/react-router';
import { NoAccess } from '../components/pages/NoAccess';
import { PlaceholderPage } from '../components/pages/PlaceholderPage';
import { gatedPage, requirePermission } from '../lib/gating';

// Phase D (FR-A-129, FR-A-130): a placeholder that says so. Gated by `distributionlists:read`; an actor without it sees
// the No-access content at this same URL. The server enforces; this only decides what the page shows.
function DistributionListsPage() {
  return (
    <PlaceholderPage
      titleKey="nav.distributionLists"
      descriptionKey="placeholders.distributionLists.description"
      phase="D"
    />
  );
}

export const Route = createFileRoute('/distribution-lists')({
  staticData: { titleKey: 'nav.distributionLists' },
  beforeLoad: requirePermission(['distributionlists:read']),
  component: gatedPage(DistributionListsPage, NoAccess),
});

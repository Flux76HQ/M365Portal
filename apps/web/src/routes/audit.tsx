import { createFileRoute } from '@tanstack/react-router';
import { NoAccess } from '../components/pages/NoAccess';
import { PlaceholderPage } from '../components/pages/PlaceholderPage';
import { gatedPage, requirePermission } from '../lib/gating';

// Phase D (FR-A-129, FR-A-130): a placeholder that says so. Gated by `audit:read`; an actor without it sees
// the No-access content at this same URL. The server enforces; this only decides what the page shows.
function AuditPage() {
  return (
    <PlaceholderPage
      titleKey="nav.auditLog"
      descriptionKey="placeholders.audit.description"
      phase="D"
    />
  );
}

export const Route = createFileRoute('/audit')({
  staticData: { titleKey: 'nav.auditLog' },
  beforeLoad: requirePermission(['audit:read']),
  component: gatedPage(AuditPage, NoAccess),
});

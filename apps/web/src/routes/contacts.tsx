import { createFileRoute } from '@tanstack/react-router';
import { NoAccess } from '../components/pages/NoAccess';
import { PlaceholderPage } from '../components/pages/PlaceholderPage';
import { gatedPage, requirePermission } from '../lib/gating';

// Phase D (FR-A-129, FR-A-130): a placeholder that says so. Gated by `contacts:read`; an actor without it sees
// the No-access content at this same URL. The server enforces; this only decides what the page shows.
function ContactsPage() {
  return (
    <PlaceholderPage
      titleKey="nav.contacts"
      descriptionKey="placeholders.contacts.description"
      phase="D"
    />
  );
}

export const Route = createFileRoute('/contacts')({
  staticData: { titleKey: 'nav.contacts' },
  beforeLoad: requirePermission(['contacts:read']),
  component: gatedPage(ContactsPage, NoAccess),
});

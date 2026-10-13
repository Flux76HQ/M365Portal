import { Outlet, createFileRoute } from '@tanstack/react-router';
import { NoAccess } from '../components/pages/NoAccess';
import { gatedPage, requirePermission } from '../lib/gating';
import { CONTACT_NAMESPACES, loadLazyNamespaces } from '../lib/locale';

// /contacts (FR-D-901): the layout of the contact pages, the list below it and one page for a contact. Gated by
// `contacts:read`; an actor without it sees the No-access content at the same URL, whichever page of the folder
// the address names. The server enforces; this only decides what is shown. The text is loaded here: the shared
// directory text, the contacts text, and the distribution list text (the lists a contact is in, the detail
// codes and the reason labels).
export const Route = createFileRoute('/contacts')({
  staticData: { titleKey: 'nav.contacts' },
  beforeLoad: requirePermission(['contacts:read']),
  loader: async () => {
    await loadLazyNamespaces(CONTACT_NAMESPACES);
  },
  component: gatedPage(Outlet, NoAccess),
});

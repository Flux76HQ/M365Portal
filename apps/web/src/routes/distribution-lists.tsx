import { Outlet, createFileRoute } from '@tanstack/react-router';
import { NoAccess } from '../components/pages/NoAccess';
import { gatedPage, requirePermission } from '../lib/gating';
import { LIST_NAMESPACES, loadLazyNamespaces } from '../lib/locale';

// /distribution-lists (FR-D-901): the layout of the distribution list pages, the list below it and one page for a
// list. Gated by `distributionlists:read`; an actor without it sees the No-access content at the same URL,
// whichever page of the folder the address names. The server enforces; this only decides what is shown. The
// text is loaded here: the shared directory text (a dash, paging, errors) and the member editing text.
export const Route = createFileRoute('/distribution-lists')({
  staticData: { titleKey: 'nav.distributionLists' },
  beforeLoad: requirePermission(['distributionlists:read']),
  loader: async () => {
    await loadLazyNamespaces(LIST_NAMESPACES);
  },
  component: gatedPage(Outlet, NoAccess),
});

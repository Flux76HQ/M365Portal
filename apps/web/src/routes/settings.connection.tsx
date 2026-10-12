import { createFileRoute } from '@tanstack/react-router';
import { NoAccess } from '../components/pages/NoAccess';
import { ConnectionPage } from '../features/connection/ConnectionPage';
import { gatedPage, requirePermission } from '../lib/gating';
import { loadLazyNamespace } from '../lib/locale';

// /settings/connection (FR-B-111, FR-B-607): needs `settings:connection`; a user without it sees the in-place
// No-access content at the same address. The text is the lazy catalogues `connection` and `setup` (the proof
// list, the log and the device-code panel are shared with the wizard).
export const Route = createFileRoute('/settings/connection')({
  staticData: { titleKey: 'connection.title' },
  beforeLoad: requirePermission(['settings:connection']),
  loader: async () => {
    await Promise.all([loadLazyNamespace('connection'), loadLazyNamespace('setup')]);
  },
  component: gatedPage(ConnectionPage, NoAccess),
});

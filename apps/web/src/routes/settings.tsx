import { Outlet, createFileRoute } from '@tanstack/react-router';
import { NoAccess } from '../components/pages/NoAccess';
import { gatedPage, requirePermission } from '../lib/gating';

// The layout of the Settings pages: any `settings:*` permission opens the section (FR-A-129). Each page
// below gates on the permission of its own setting.
export const Route = createFileRoute('/settings')({
  staticData: { titleKey: 'nav.settings' },
  beforeLoad: requirePermission(['settings:branding', 'settings:connection']),
  component: gatedPage(Outlet, NoAccess),
});

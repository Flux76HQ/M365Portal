import { createFileRoute } from '@tanstack/react-router';
import { NoAccess } from '../components/pages/NoAccess';
import { PageHeader } from '../components/pages/PageHeader';
import { useTranslator } from '../lib/locale';
import { gatedPage, requirePermission } from '../lib/gating';

// A STUB (T-A-169). Seam X2 (tasks.md section 1.3): `T-A-214` of stream S5 replaces this whole file with
// the Appearance page. The route path, the title key and the gate stay as they are, so the generated
// route tree does not change.
function AppearancePage() {
  const { t } = useTranslator();
  return <PageHeader title={t('nav.appearance')} description={t('pages.appearance.stub')} />;
}

export const Route = createFileRoute('/settings/appearance')({
  staticData: { titleKey: 'nav.appearance' },
  beforeLoad: requirePermission(['settings:branding']),
  component: gatedPage(AppearancePage, NoAccess),
});

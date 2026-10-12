import { createFileRoute } from '@tanstack/react-router';
import { NotFound } from '../components/pages/NotFound';
import { PageHeader } from '../components/pages/PageHeader';
import { BreakGlassForm } from '../features/auth/BreakGlassForm';
import { useLanguage, loadLazyNamespace } from '../lib/locale';
import { useMe } from '../lib/router-context';

function BreakGlassPage() {
  const { t } = useLanguage().translator;
  const me = useMe();
  // The server answers 404 for the API when the account is not configured; the page agrees (FR-B-522).
  if (!me.features.breakGlass) return <NotFound />;
  return (
    <div className="mx-auto flex w-full max-w-md flex-col py-8">
      <PageHeader title={t('breakglass.form.title')} />
      <BreakGlassForm />
    </div>
  );
}

// /break-glass (FR-B-522, FR-B-607): public, Not-found unless `me.features.breakGlass`.
export const Route = createFileRoute('/break-glass')({
  staticData: { titleKey: 'breakglass.form.title' },
  loader: async () => {
    await loadLazyNamespace('breakglass');
  },
  component: BreakGlassPage,
});

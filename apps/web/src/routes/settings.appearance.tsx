import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { NoAccess } from '../components/pages/NoAccess';
import { PageHeader } from '../components/pages/PageHeader';
import { Button } from '../components/ui/button';
import { ErrorState } from '../components/ui/error-state';
import { Skeleton } from '../components/ui/skeleton';
import { AppearanceForm } from '../features/branding/AppearanceForm';
import { loadBrandingTools, useBrandingTools } from '../features/branding/tools';
import { ApiError } from '../lib/api';
import { gatedPage, requirePermission } from '../lib/gating';
import { useTranslator } from '../lib/locale';
import { messageForError } from '../lib/problem';
import { brandingQueryOptions } from '../lib/query';
import { useMe, useRouterContext } from '../lib/router-context';

// The Appearance page (T-A-214; FR-A-132; seam X2 of tasks.md section 1.3: this file replaced the S4 stub;
// the route path, the title key and the gate are the stub's, so the generated route tree is unchanged).
// The page is the route's own chunk: the form, the pickers, the preview and the shared branding code load
// with it and never with the entry.
function AppearancePage() {
  const { t } = useTranslator();
  const { api } = useRouterContext();
  const me = useMe();
  const tools = useBrandingTools();
  const query = useQuery(brandingQueryOptions(api));

  let content;
  if (query.data !== undefined && tools !== null) {
    content = <AppearanceForm branding={query.data} tools={tools} api={api} />;
  } else if (query.isError && query.data === undefined) {
    content = (
      <ErrorState
        headingLevel={2}
        title={t('appearance.loadError')}
        description={messageForError({ t }, query.error, { publicOrigin: me.publicOrigin })}
        {...(query.error instanceof ApiError && query.error.requestId !== null
          ? { requestIdLabel: t('common.table.requestId'), requestId: query.error.requestId }
          : {})}
        action={
          <Button
            onClick={() => {
              void query.refetch();
            }}
          >
            {t('appearance.retry')}
          </Button>
        }
      />
    );
  } else {
    content = (
      <div aria-busy="true" aria-label={t('appearance.loading')} className="flex flex-col gap-4">
        <Skeleton height={64} />
        <Skeleton height={240} />
      </div>
    );
  }

  return (
    <>
      <PageHeader title={t('nav.appearance')} description={t('appearance.description')} />
      {content}
    </>
  );
}

export const Route = createFileRoute('/settings/appearance')({
  staticData: { titleKey: 'nav.appearance' },
  beforeLoad: requirePermission(['settings:branding']),
  // The shared branding code is part of what the route needs: loaded before the page renders, the form
  // is in the first render pass (which React slices) and not in a second, synchronous one that the
  // arrival of the tools would cause (T-A-173; a 40 ms task on a phone).
  loader: async () => {
    await loadBrandingTools();
  },
  component: gatedPage(AppearancePage, NoAccess),
});

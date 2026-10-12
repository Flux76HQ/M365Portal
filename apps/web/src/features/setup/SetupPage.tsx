import { useQuery, useQueryClient } from '@tanstack/react-query';
import { NotFound } from '../../components/pages/NotFound';
import { PageHeader } from '../../components/pages/PageHeader';
import { Skeleton } from '../../components/ui/skeleton';
import { ApiError } from '../../lib/api';
import { useTranslator } from '../../lib/locale';
import { useRouterContext } from '../../lib/router-context';
import { LoadError } from './LoadError';
import { TokenForm } from './TokenForm';
import { Wizard } from './Wizard';
import { setupApi, setupKeys } from './setup-api';

/**
 * `/setup` (T-B-300; FR-B-207, FR-B-221): public, and not gated by the client at all. The server decides who
 * may see it: a closed gate answers 404 and the page shows Not-found; while no setup session exists the
 * token form opens one; after that the wizard takes over.
 */
export function SetupPage() {
  const { t } = useTranslator();
  const { api } = useRouterContext();
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: setupKeys.status,
    queryFn: ({ signal }) => setupApi(api).status(signal),
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  if (status.error instanceof ApiError && status.error.status === 404) return <NotFound />;

  let content;
  if (status.data !== undefined) {
    content = status.data.tokenRequired ? (
      <TokenForm
        api={api}
        onUnlocked={() => {
          void queryClient.invalidateQueries({ queryKey: setupKeys.status });
        }}
      />
    ) : (
      <Wizard api={api} />
    );
  } else if (status.isError) {
    content = (
      <LoadError
        title={t('setup.title')}
        error={status.error}
        retryLabel={t('setup.retry')}
        onRetry={() => {
          void status.refetch();
        }}
      />
    );
  } else {
    content = (
      <div aria-busy="true" aria-label={t('setup.loading')} className="flex flex-col gap-4">
        <Skeleton height={64} />
        <Skeleton height={240} />
      </div>
    );
  }
  return (
    <>
      <PageHeader
        title={status.data?.tokenRequired === true ? t('setup.token.title') : t('setup.title')}
        description={status.data?.tokenRequired === true ? undefined : t('setup.lead')}
      />
      {content}
    </>
  );
}

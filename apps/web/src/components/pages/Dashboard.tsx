import { useQuery } from '@tanstack/react-query';
import { PlugZapIcon } from 'lucide-react';
import { useTranslator } from '../../lib/locale';
import { meQueryOptions } from '../../lib/query';
import { useRouterContext } from '../../lib/router-context';
import { EmptyState } from '../ui/empty-state';
import { CounterCard } from './CounterCard';
import { PageHeader } from './PageHeader';

export type DashboardState = 'loading' | 'empty' | 'error';

/**
 * The dashboard (FR-A-130, PD-19): four counters and, once loaded, the honest empty state. Phase A has
 * no tenant and no dashboard endpoint, so there is nothing to count and no card shows a number.
 */
export function Dashboard({ state }: { readonly state: DashboardState }) {
  const { t } = useTranslator();
  return (
    <>
      <PageHeader title={t('dashboard.title')} description={t('dashboard.lead')} />
      <section
        aria-label={t('dashboard.cards')}
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
      >
        <CounterCard name={t('dashboard.card.users')} state={state} />
        <CounterCard name={t('dashboard.card.groups')} state={state} />
        <CounterCard name={t('dashboard.card.distributionLists')} state={state} />
        <CounterCard name={t('dashboard.card.contacts')} state={state} />
      </section>
      {state === 'loading' ? null : (
        <section className="mt-6 rounded-lg border border-line-subtle bg-surface-raised">
          <EmptyState
            headingLevel={2}
            icon={<PlugZapIcon />}
            title={t('dashboard.empty.title')}
            description={t('dashboard.empty.description')}
          />
        </section>
      )}
    </>
  );
}

/**
 * The page at `/`: skeletons while `me` is pending, then the empty state. `me` is normally in the cache
 * before the first render (it is embedded in the page), so the skeleton shows only when it is not.
 */
export function DashboardPage() {
  const { api } = useRouterContext();
  const me = useQuery(meQueryOptions(api));
  return <Dashboard state={me.isPending ? 'loading' : me.isError ? 'error' : 'empty'} />;
}

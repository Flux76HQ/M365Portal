import { useQuery } from '@tanstack/react-query';
import { Suspense, lazy } from 'react';
import type { DashboardCounter, DashboardResponse } from '@m365portal/shared/schemas/dashboard';
import { PlugZapIcon } from 'lucide-react';
import { useTranslator } from '../../lib/locale';
import { meQueryOptions } from '../../lib/query';
import { useRouterContext } from '../../lib/router-context';
import { EmptyState } from '../ui/empty-state';
import { CounterCard, type CounterCardState } from './CounterCard';
import { PageHeader } from './PageHeader';

/** The counters in the order of the cards (a type-only import of the schema keeps it out of the entry). */
const COUNTERS = ['users', 'groups', 'distributionLists', 'contacts'] as const;

// The numbers need the schema and the query: a chunk of their own, loaded once a signed-in actor is here.
const DashboardData = lazy(() => import('./DashboardData'));

export type DashboardProps =
  | { readonly state: 'loading' | 'empty' | 'error' }
  | { readonly state: 'data'; readonly counters: DashboardResponse };

/** One counter of the response as the state of its card; without a response the card shows `fallback`. */
function cardOf(
  counter: DashboardCounter | undefined,
  fallback: 'loading' | 'empty' | 'error',
): CounterCardState {
  if (counter === undefined) return { state: fallback };
  if (counter.state === 'ok')
    return { state: 'data', value: counter.count, capped: counter.capped };
  return { state: counter.state === 'denied' ? 'denied' : 'error' };
}

/**
 * The dashboard (FR-A-130, FR-D-808, PD-19): four counters. A signed-in actor gets the numbers of
 * `GET /api/v1/dashboard`; a visitor who is not signed in, or a tenant that is not connected, gets the honest
 * empty state. A card is never blank and a number is never invented.
 */
export function Dashboard(props: DashboardProps) {
  const { t } = useTranslator();
  const counters = props.state === 'data' ? props.counters : undefined;
  const fallback = props.state === 'data' ? 'error' : props.state;
  return (
    <>
      <PageHeader title={t('dashboard.title')} description={t('dashboard.lead')} />
      <section
        aria-label={t('dashboard.cards')}
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
      >
        {COUNTERS.map((key) => (
          <CounterCard
            key={key}
            name={t(`dashboard.card.${key}`)}
            {...cardOf(counters?.[key], fallback)}
          />
        ))}
      </section>
      {props.state === 'empty' ? (
        <section className="mt-6 rounded-lg border border-line-subtle bg-surface-raised">
          <EmptyState
            headingLevel={2}
            icon={<PlugZapIcon />}
            title={t('dashboard.empty.title')}
            description={t('dashboard.empty.description')}
          />
        </section>
      ) : null}
    </>
  );
}

/**
 * The page at `/`: skeletons while `me` is pending, then, for a signed-in actor, the counters (a skeleton
 * until they arrive, "could not be loaded" if they fail); for anyone else the empty state. `me` is normally
 * in the cache before the first render (it is embedded in the page), so the first skeleton is rare.
 */
export function DashboardPage() {
  const { api } = useRouterContext();
  const me = useQuery(meQueryOptions(api));
  if (me.isPending) return <Dashboard state="loading" />;
  if (me.isError) return <Dashboard state="error" />;
  const { kind } = me.data.actor;
  if (kind !== 'user' && kind !== 'break_glass') return <Dashboard state="empty" />;
  return (
    <Suspense fallback={<Dashboard state="loading" />}>
      <DashboardData />
    </Suspense>
  );
}

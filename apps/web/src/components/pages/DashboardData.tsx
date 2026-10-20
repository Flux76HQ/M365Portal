import { useQuery } from '@tanstack/react-query';
import { dashboardQueryOptions } from '../../lib/dashboard-query';
import { useRouterContext } from '../../lib/router-context';
import { Dashboard } from './Dashboard';

/** The dashboard of a signed-in actor: the counters of `GET /api/v1/dashboard` (P70). A lazy chunk. */
export default function DashboardData() {
  const { api } = useRouterContext();
  const counters = useQuery(dashboardQueryOptions(api));
  if (counters.data !== undefined) return <Dashboard state="data" counters={counters.data} />;
  return <Dashboard state={counters.isError ? 'error' : 'loading'} />;
}

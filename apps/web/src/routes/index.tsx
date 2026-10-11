import { createFileRoute } from '@tanstack/react-router';
import { DashboardPage } from '../components/pages/Dashboard';

export const Route = createFileRoute('/')({
  staticData: { titleKey: 'nav.dashboard' },
  component: DashboardPage,
});

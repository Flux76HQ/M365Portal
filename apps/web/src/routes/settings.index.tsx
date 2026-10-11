import { createFileRoute } from '@tanstack/react-router';
import { SettingsOverview } from '../components/pages/SettingsOverview';

export const Route = createFileRoute('/settings/')({
  component: SettingsOverview,
});

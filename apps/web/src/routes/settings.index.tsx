import { createFileRoute } from '@tanstack/react-router';
import { SettingsOverview } from '../components/pages/SettingsOverview';
import { loadLazyNamespace } from '../lib/locale';

export const Route = createFileRoute('/settings/')({
  // The card "Roles and access" is worded by the lazy `access` catalogue, which "My access" loads as well.
  loader: async () => {
    await loadLazyNamespace('access');
  },
  component: SettingsOverview,
});

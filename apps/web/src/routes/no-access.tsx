import { createFileRoute } from '@tanstack/react-router';
import { NoAccess } from '../components/pages/NoAccess';

export const Route = createFileRoute('/no-access')({
  staticData: { titleKey: 'nav.noAccess' },
  component: NoAccess,
});

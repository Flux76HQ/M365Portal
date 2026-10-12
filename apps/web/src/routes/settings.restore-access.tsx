import { createFileRoute } from '@tanstack/react-router';
import { NotFound } from '../components/pages/NotFound';
import { RestoreAccessPage } from '../features/auth/RestoreAccessPage';
import { loadLazyNamespace } from '../lib/locale';
import { useMe } from '../lib/router-context';

function RestoreAccess() {
  const me = useMe();
  // Only the break-glass session has this page; for everyone else, a signed-in Owner included, it does not exist.
  return me.actor.kind === 'break_glass' ? <RestoreAccessPage /> : <NotFound />;
}

// /settings/restore-access (FR-B-523): the one write a break-glass session is offered. The server enforces it
// (`actorKinds: ['break_glass']`); the page only hides itself.
export const Route = createFileRoute('/settings/restore-access')({
  staticData: { titleKey: 'breakglass.restore.title' },
  loader: async () => {
    await loadLazyNamespace('breakglass');
  },
  component: RestoreAccess,
});

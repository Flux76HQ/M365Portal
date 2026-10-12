import { Outlet, createFileRoute } from '@tanstack/react-router';

// The layout of the Settings pages. It has no gate of its own any more (T-B-306): "Mijn toegang" is open to
// every signed-in actor, so each page below gates on the permission of its own setting (Appearance:
// `settings:branding`, Connection: `settings:connection`, Restore access: the break-glass session) and the
// overview lists only what the actor may open. Gating is cosmetic; the server enforces every permission.
export const Route = createFileRoute('/settings')({
  staticData: { titleKey: 'nav.settings' },
  component: Outlet,
});

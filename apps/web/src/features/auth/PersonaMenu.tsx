import { deriveInitials } from '@m365portal/shared/branding/initials';
import { useRouter } from '@tanstack/react-router';
import { KeyRoundIcon, LogOutIcon, UsersRoundIcon } from 'lucide-react';
import { Menu } from '../../components/ui/menu';
import { Persona } from '../../components/ui/persona';
import { useTranslator } from '../../lib/locale';
import { useMe } from '../../lib/router-context';
import { useSignOut } from './use-sign-out';

/** "Mijn toegang": the page that lists the roles and permissions of the signed-in actor (T-B-304). */
export const MY_ACCESS_PATH = '/settings/access';

/**
 * Who the actor is, as the page names it: the display name of a person (data, never translated), and
 * for the other kinds the name of the kind in the language of the page.
 */
export function useActorName(): string {
  const { t } = useTranslator();
  const me = useMe();
  switch (me.actor.kind) {
    case 'user':
      return me.actor.label;
    case 'setup':
      return t('session.actor.setup');
    case 'break_glass':
      return t('session.actor.breakGlass');
    case 'anonymous':
      return t('shell.actor.anonymous');
  }
}

/**
 * The persona of the header (FR-B-608; plan 12.4): the initials of the display name. A signed-in user
 * has a menu behind it with "Mijn toegang", "Uitloggen" and "Overal uitloggen"; a break-glass session has
 * the first two (it has one session to end). The setup actor and an anonymous visitor have a persona and
 * no menu. Nothing here is a control: the menu entries lead to pages and calls the server enforces.
 */
export function PersonaMenu() {
  const { t } = useTranslator();
  const me = useMe();
  const router = useRouter();
  const signOut = useSignOut();
  const name = useActorName();
  const persona = (
    <Persona initials={deriveInitials(name)} label={t('shell.actor.label', { name })} />
  );

  if (me.actor.kind !== 'user' && me.actor.kind !== 'break_glass') return persona;

  return (
    <Menu
      trigger={
        <button
          type="button"
          aria-label={t('session.persona.menuLabel', { name })}
          className="inline-flex min-h-target min-w-target items-center justify-center rounded-full"
        >
          {persona}
        </button>
      }
      entries={[
        {
          kind: 'item',
          id: 'access',
          label: t('session.menu.myAccess'),
          icon: <KeyRoundIcon />,
        },
        { kind: 'separator' },
        { kind: 'item', id: 'signout', label: t('session.menu.signOut'), icon: <LogOutIcon /> },
        ...(me.actor.kind === 'user'
          ? [
              {
                kind: 'item' as const,
                id: 'signoutall',
                label: t('session.menu.signOutAll'),
                icon: <UsersRoundIcon />,
              },
            ]
          : []),
      ]}
      onSelect={(id) => {
        if (id === 'access') router.history.push(MY_ACCESS_PATH);
        else void signOut(id === 'signoutall');
      }}
    />
  );
}

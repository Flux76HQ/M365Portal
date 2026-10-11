import { deriveInitials } from '@m365portal/shared/branding/initials';
import { MenuIcon } from 'lucide-react';
import { useTranslator } from '../../lib/locale';
import { useMe } from '../../lib/router-context';
import { IconButton } from '../ui/icon-button';
import { Persona } from '../ui/persona';
import { LanguageSwitcher } from './LanguageSwitcher';
import { OrgMark } from './OrgMark';
import { SearchTrigger } from './SearchTrigger';
import { ThemeSwitcher } from './ThemeSwitcher';

export interface HeaderProps {
  /** Opens the navigation drawer (below 768 px). */
  readonly onOpenMenu: () => void;
  /** Opens the command palette. */
  readonly onOpenSearch: () => void;
}

/** The actor as the page names it: by kind, in the language of the page, never the server's English label. */
function useActorName(): string {
  const { t } = useTranslator();
  const me = useMe();
  return me.actor.kind === 'preview' ? t('shell.actor.preview') : t('shell.actor.anonymous');
}

/**
 * The header (56 px): the menu button and the organisation mark below 768 px, the search trigger, the
 * language and theme switchers and who the actor is. It is the page's `banner` landmark.
 */
export function Header({ onOpenMenu, onOpenSearch }: HeaderProps) {
  const { t } = useTranslator();
  const actorName = useActorName();
  return (
    <header
      data-slot="header"
      className="glass-header sticky top-0 z-chrome flex h-14 shrink-0 items-center gap-2 border-b border-line-subtle px-4"
    >
      <IconButton label={t('shell.sidebar.open')} onClick={onOpenMenu} className="md:hidden">
        <MenuIcon className="size-5" />
      </IconButton>
      <OrgMark variant="compact" showName className="min-w-0 shrink md:hidden" />
      <SearchTrigger onOpen={onOpenSearch} />
      <div className="ms-auto flex shrink-0 items-center gap-2">
        <ThemeSwitcher className="hidden sm:inline-flex" />
        <LanguageSwitcher />
        <Persona
          initials={deriveInitials(actorName)}
          label={t('shell.actor.label', { name: actorName })}
        />
      </div>
    </header>
  );
}

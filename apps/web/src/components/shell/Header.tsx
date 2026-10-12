import { MenuIcon } from 'lucide-react';
import { PersonaMenu } from '../../features/auth/PersonaMenu';
import { useTranslator } from '../../lib/locale';
import { IconButton } from '../ui/icon-button';
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

/**
 * The header (56 px): the menu button and the organisation mark below 768 px, the search trigger, the
 * language and theme switchers and who the actor is (the persona, with its menu for a signed-in
 * actor). It is the page's `banner` landmark.
 */
export function Header({ onOpenMenu, onOpenSearch }: HeaderProps) {
  const { t } = useTranslator();
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
        <PersonaMenu />
      </div>
    </header>
  );
}

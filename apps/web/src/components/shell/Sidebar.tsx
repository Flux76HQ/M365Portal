import { Link } from '@tanstack/react-router';
import { PanelLeftCloseIcon, PanelLeftOpenIcon, XIcon } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { cn } from '../../lib/cn';
import { navigationCommands } from '../../lib/commands';
import { useTranslator } from '../../lib/locale';
import { useMe } from '../../lib/router-context';
import { DIALOG_SCRIM_CLASS, useFocusReturn } from '../ui/dialog';
import { IconButton } from '../ui/icon-button';
import { Tooltip } from '../ui/tooltip';
import { LanguageSwitcher } from './LanguageSwitcher';
import { OrgMark } from './OrgMark';
import { ThemeSwitcher } from './ThemeSwitcher';

// The sidebar (FR-A-126, plan 9.5): 256 px expanded, 64 px collapsed, a drawer below 768 px. The
// destinations come from the command registry, so the sidebar, the palette and the header trigger
// offer the same things to the same actor.

const LINK_CLASS = cn(
  'relative flex min-h-control items-center gap-3 rounded-md px-3 text-body font-medium text-fg-secondary',
  'transition-colors duration-fast ease-standard hover:bg-accent-subtle hover:text-fg',
  'aria-[current=page]:bg-accent-subtle aria-[current=page]:font-semibold aria-[current=page]:text-accent-text',
  'aria-[current=page]:before:absolute aria-[current=page]:before:inset-y-1.5 aria-[current=page]:before:start-0 aria-[current=page]:before:w-1 aria-[current=page]:before:rounded-sm aria-[current=page]:before:bg-accent',
);

export interface NavListProps {
  /** Icons only, with the names as tooltips (the collapsed sidebar). */
  readonly collapsed?: boolean;
  /** Called after a link is followed (the drawer closes). */
  readonly onNavigate?: () => void;
}

/** The destinations this actor may open. A link is current (`aria-current="page"`) while its page is open. */
export function NavList({ collapsed = false, onNavigate }: NavListProps) {
  const { t } = useTranslator();
  const me = useMe();
  return (
    <ul className="flex flex-col gap-1">
      {navigationCommands(me).map((command) => {
        if (command.run.kind !== 'navigate') return null;
        const label = t(command.labelKey);
        const Icon = command.icon;
        const link = (
          <Link
            to={command.run.to}
            activeOptions={{ exact: command.run.to === '/' }}
            onClick={onNavigate}
            className={cn(LINK_CLASS, collapsed && 'justify-center px-0')}
          >
            <Icon aria-hidden="true" className="size-5 shrink-0" />
            <span className={collapsed ? 'sr-only' : 'truncate'}>{label}</span>
          </Link>
        );
        return (
          <li key={command.id}>
            {collapsed ? (
              <Tooltip content={label} side="right">
                {link}
              </Tooltip>
            ) : (
              link
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Version({ className }: { readonly className?: string }) {
  const { t } = useTranslator();
  const me = useMe();
  return (
    <p className={cn('truncate text-caption text-fg-muted', className)}>
      {t('shell.version', { version: me.version })}
    </p>
  );
}

export interface SidebarProps {
  readonly collapsed: boolean;
  readonly onToggle: () => void;
}

/** The sidebar from 768 px up. Below that it is hidden and the drawer takes its place. */
export function Sidebar({ collapsed, onToggle }: SidebarProps) {
  const { t } = useTranslator();
  return (
    <aside
      data-slot="sidebar"
      className={cn(
        'glass-sidebar sticky top-0 z-chrome hidden h-dvh shrink-0 flex-col border-e border-line-subtle md:flex',
        collapsed ? 'w-16' : 'w-64',
      )}
    >
      <div className={cn('flex h-14 shrink-0 items-center px-4', collapsed && 'justify-center px-0')}>
        <OrgMark variant={collapsed ? 'compact' : 'full'} />
      </div>
      <nav
        aria-label={t('a11y.mainNavigation')}
        className={cn('min-h-0 flex-1 overflow-y-auto py-2', collapsed ? 'px-2' : 'px-3')}
      >
        <NavList collapsed={collapsed} />
      </nav>
      <div
        className={cn(
          'flex shrink-0 items-center gap-2 border-t border-line-subtle p-3',
          collapsed ? 'justify-center' : 'justify-between',
        )}
      >
        {collapsed ? null : <Version />}
        <IconButton
          label={collapsed ? t('shell.sidebar.expand') : t('shell.sidebar.collapse')}
          size="sm"
          onClick={onToggle}
        >
          {collapsed ? (
            <PanelLeftOpenIcon className="size-4" />
          ) : (
            <PanelLeftCloseIcon className="size-4" />
          )}
        </IconButton>
      </div>
    </aside>
  );
}

export interface NavDrawerProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/**
 * The menu below 768 px: the same destinations in a modal dialog (focus trap, Escape, focus back to the
 * button that opened it). The theme and language switchers live here too, because the header has no
 * room for the theme switcher on a phone.
 */
export function NavDrawer({ open, onOpenChange }: NavDrawerProps) {
  const { t } = useTranslator();
  const returnFocus = useFocusReturn(open);
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay data-slot="nav-drawer-overlay" className={DIALOG_SCRIM_CLASS} />
        <DialogPrimitive.Content
          data-slot="nav-drawer"
          aria-describedby={undefined}
          onCloseAutoFocus={returnFocus}
          className="fixed inset-y-0 start-0 z-dialog flex w-72 max-w-[85vw] flex-col border-e border-line-subtle bg-surface-overlay text-fg shadow-3 data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in"
        >
          <div className="flex h-14 shrink-0 items-center justify-between gap-2 px-4">
            <OrgMark variant="full" />
            <DialogPrimitive.Close asChild>
              <IconButton label={t('shell.sidebar.close')} size="sm">
                <XIcon className="size-4" />
              </IconButton>
            </DialogPrimitive.Close>
          </div>
          <DialogPrimitive.Title className="sr-only">
            {t('shell.sidebar.drawerTitle')}
          </DialogPrimitive.Title>
          <nav
            aria-label={t('a11y.mainNavigation')}
            className="min-h-0 flex-1 overflow-y-auto px-3 py-2"
          >
            <NavList
              onNavigate={() => {
                onOpenChange(false);
              }}
            />
          </nav>
          <div className="flex shrink-0 flex-col gap-3 border-t border-line-subtle p-3">
            <div className="flex items-center justify-between gap-2">
              <ThemeSwitcher />
              <LanguageSwitcher />
            </div>
            <Version />
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

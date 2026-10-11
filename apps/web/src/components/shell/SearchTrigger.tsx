import { SearchIcon } from 'lucide-react';
import { useTranslator } from '../../lib/locale';
import { cn } from '../../lib/cn';

export interface SearchTriggerProps {
  /** Opens the command palette: in Phase A the global search is the palette (PD-18). */
  readonly onOpen: () => void;
  readonly className?: string;
}

/**
 * The search control of the header. Phase A has nothing to search except the pages and actions of the
 * command registry, so this is the palette's trigger: a button with an accessible name, not a text
 * field that would need a second listbox with its own focus handling.
 */
export function SearchTrigger({ onOpen, className }: SearchTriggerProps) {
  const { t } = useTranslator();
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-haspopup="dialog"
      aria-keyshortcuts="Control+K Meta+K"
      className={cn(
        'inline-flex h-control min-w-target items-center gap-2 rounded-md border border-line-control bg-surface-raised px-2.5 text-body text-fg-secondary',
        'transition-colors duration-fast ease-standard hover:text-fg sm:min-w-56 sm:justify-start',
        className,
      )}
    >
      <SearchIcon aria-hidden="true" className="size-4 shrink-0" />
      <span className="sr-only truncate sm:not-sr-only">{t('shell.search.label')}</span>
    </button>
  );
}

import { createTranslator, type Translator } from '@m365portal/shared/i18n';
import { Command as Cmdk } from 'cmdk';
import { SearchIcon } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useMemo, useState } from 'react';
import {
  visibleCommands,
  type Command,
  type CommandGroup,
} from '../../lib/commands';
import { useTranslator } from '../../lib/locale';
import { useMe } from '../../lib/router-context';
import {
  DIALOG_LAYER_CLASS,
  DIALOG_SCRIM_CLASS,
  DIALOG_SURFACE_CLASS,
  useFocusReturn,
} from '../ui/dialog';
import { useRunCommand } from './run-command';

const GROUP_ORDER: readonly CommandGroup[] = ['navigate', 'preferences', 'help'];
const GROUP_HEADING = {
  navigate: 'palette.group.navigate',
  preferences: 'palette.group.preferences',
  help: 'palette.group.help',
} as const;

/** Both languages, so a Dutch keyword finds a command on an English page and the other way round. */
const TRANSLATORS: readonly Translator[] = [createTranslator('en'), createTranslator('nl')];

/** What the search matches a command against: its label and keywords, in every language. */
function searchTerms(command: Command, translator: Translator): string[] {
  const terms = [translator.t(command.labelKey)];
  for (const other of TRANSLATORS) {
    terms.push(other.t(command.labelKey));
    for (const key of command.keywordKeys) terms.push(other.t(key));
  }
  return terms;
}

const ITEM_CLASS =
  'flex min-h-control cursor-default items-center gap-3 rounded-md px-3 text-body text-fg select-none data-[selected=true]:bg-accent-subtle data-[selected=true]:outline-2 data-[selected=true]:-outline-offset-2 data-[selected=true]:outline-focus-ring';

export interface CommandPaletteProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Shows the shortcut overview (the "keyboard shortcuts" command). */
  readonly onShortcuts: () => void;
}

/**
 * The command palette (FR-A-127, PD-18): a modal dialog around a combobox and a listbox (cmdk), with a
 * focus trap, Escape to close and the focus returned to where it was. It lists what the registry offers
 * this actor, the same entries the sidebar uses plus the actions. It is a lazy chunk: nothing of it, nor
 * of cmdk, is in the entry (plan 9.3).
 */
export default function CommandPalette({ open, onOpenChange, onShortcuts }: CommandPaletteProps) {
  const translator = useTranslator();
  const { t } = translator;
  const me = useMe();
  const returnFocus = useFocusReturn(open);
  const [search, setSearch] = useState('');
  const run = useRunCommand({ onShortcuts });

  const grouped = useMemo(() => {
    const visible = visibleCommands(me);
    return GROUP_ORDER.map((group) => ({
      group,
      commands: visible.filter((command) => command.group === group),
    })).filter((entry) => entry.commands.length > 0);
  }, [me]);

  const close = (): void => {
    onOpenChange(false);
  };

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        // A palette that is opened again starts empty.
        if (!next) setSearch('');
        onOpenChange(next);
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay data-slot="palette-overlay" className={DIALOG_SCRIM_CLASS} />
        <div data-slot="palette-layer" className={`${DIALOG_LAYER_CLASS} items-start pt-[12vh]`}>
          <DialogPrimitive.Content
            data-slot="palette"
            onCloseAutoFocus={returnFocus}
            className={`${DIALOG_SURFACE_CLASS} max-w-xl`}
          >
            <DialogPrimitive.Title className="sr-only">{t('palette.title')}</DialogPrimitive.Title>
            <DialogPrimitive.Description className="sr-only">
              {t('palette.description')}
            </DialogPrimitive.Description>
            <Cmdk label={t('palette.inputLabel')} loop className="flex min-h-0 flex-col">
              <div className="flex items-center gap-3 border-b border-line-subtle px-4">
                <SearchIcon aria-hidden="true" className="size-4 shrink-0 text-fg-muted" />
                <Cmdk.Input
                  value={search}
                  onValueChange={setSearch}
                  placeholder={t('palette.placeholder')}
                  className="h-12 min-w-0 flex-1 bg-transparent text-body text-fg outline-none placeholder:text-fg-muted"
                />
              </div>
              <Cmdk.List
                aria-label={t('palette.list')}
                className="max-h-80 overflow-y-auto p-2 [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-caption [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-fg-muted"
              >
                <Cmdk.Empty className="px-3 py-6 text-center text-body text-fg-secondary">
                  {t('palette.empty', { query: search })}
                </Cmdk.Empty>
                {grouped.map(({ group, commands }) => (
                  <Cmdk.Group key={group} heading={t(GROUP_HEADING[group])}>
                    {commands.map((command) => {
                      const Icon = command.icon;
                      return (
                        <Cmdk.Item
                          key={command.id}
                          value={command.id}
                          keywords={searchTerms(command, translator)}
                          className={ITEM_CLASS}
                          onSelect={() => {
                            close();
                            run(command);
                          }}
                        >
                          <Icon aria-hidden="true" className="size-4 shrink-0 text-fg-secondary" />
                          <span className="truncate">{t(command.labelKey)}</span>
                        </Cmdk.Item>
                      );
                    })}
                  </Cmdk.Group>
                ))}
              </Cmdk.List>
            </Cmdk>
          </DialogPrimitive.Content>
        </div>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

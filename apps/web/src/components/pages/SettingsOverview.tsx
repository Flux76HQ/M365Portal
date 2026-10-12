import type { MessageKey } from '@m365portal/shared/i18n';
import { Link } from '@tanstack/react-router';
import { ChevronRightIcon } from 'lucide-react';
import { visibleCommands } from '../../lib/commands';
import { useTranslator } from '../../lib/locale';
import { useMe } from '../../lib/router-context';
import { PageHeader } from './PageHeader';

/**
 * The cards of the overview: one per Settings page. Whether a card shows is the command registry's answer
 * for the same id (`visibleCommands`), so the overview, the sidebar and the palette cannot disagree about
 * what this actor may open (FR-A-130, FR-B-607, T-B-306). A card is a link; hiding is cosmetic, the server
 * enforces every permission.
 */
const CARDS: readonly {
  readonly commandId: string;
  readonly titleKey: MessageKey;
  readonly descriptionKey: MessageKey;
}[] = [
  {
    commandId: 'settings-appearance',
    titleKey: 'nav.appearance',
    descriptionKey: 'pages.settings.appearance.description',
  },
  {
    commandId: 'settings-connection',
    titleKey: 'nav.connection',
    descriptionKey: 'pages.settings.connection.description',
  },
  {
    commandId: 'settings-access',
    titleKey: 'nav.access',
    descriptionKey: 'pages.settings.access.description',
  },
  {
    commandId: 'settings-restore-access',
    titleKey: 'nav.restoreAccess',
    descriptionKey: 'pages.settings.restoreAccess.description',
  },
];

export function SettingsOverview() {
  const { t } = useTranslator();
  const me = useMe();
  const commands = visibleCommands(me);
  const cards = CARDS.flatMap((card) => {
    const command = commands.find((candidate) => candidate.id === card.commandId);
    return command?.run.kind !== 'navigate'
      ? []
      : [{ ...card, to: command.run.to, Icon: command.icon }];
  });
  return (
    <>
      <PageHeader title={t('pages.settings.title')} description={t('pages.settings.lead')} />
      {cards.length === 0 ? null : (
        <ul aria-label={t('pages.settings.list')} className="grid max-w-2xl grid-cols-1 gap-3">
          {cards.map(({ commandId, to, Icon, titleKey, descriptionKey }) => (
            <li key={commandId}>
              <Link
                to={to}
                className="flex min-h-control items-center gap-4 rounded-lg border border-line-subtle bg-surface-raised p-4 transition-colors duration-fast ease-standard hover:bg-accent-subtle"
              >
                <Icon aria-hidden="true" className="size-6 shrink-0 text-accent-text" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-subtitle font-semibold text-fg">{t(titleKey)}</span>
                  <span className="text-body text-fg-secondary">{t(descriptionKey)}</span>
                </span>
                <ChevronRightIcon aria-hidden="true" className="size-4 shrink-0 text-fg-muted" />
              </Link>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-6 max-w-prose text-body text-fg-secondary">{t('pages.settings.later')}</p>
    </>
  );
}

import { useId } from 'react';
import { useTranslator } from '../../lib/locale';
import { SHORTCUT_DEFINITIONS, usesCommandKey } from '../../lib/shortcuts';
import { Dialog } from '../ui/dialog';
import { Switch } from '../ui/switch';

export interface ShortcutsOverviewProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Whether `?` and `/` are on (the setting is the shell's: it also drives the listener). */
  readonly singleKeyEnabled: boolean;
  readonly onSingleKeyChange: (enabled: boolean) => void;
}

/**
 * The overview of the keyboard shortcuts (FR-A-128), with the switch that turns the single-character
 * ones off (WCAG 2.1.4). It is a lazy chunk: nothing of it is in the entry (plan 9.3).
 */
export default function ShortcutsOverview({
  open,
  onOpenChange,
  singleKeyEnabled,
  onSingleKeyChange,
}: ShortcutsOverviewProps) {
  const { t } = useTranslator();
  const switchId = useId();
  const hintId = useId();
  const modifier = usesCommandKey() ? t('shortcuts.key.command') : t('shortcuts.key.control');

  const keyLabel = (key: string): string => {
    if (key === 'modifier') return modifier;
    if (key === 'escape') return t('shortcuts.key.escape');
    return key;
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('shortcuts.title')}
      description={t('shortcuts.description')}
      closeLabel={t('shortcuts.close')}
    >
      <ul aria-label={t('shortcuts.list')} className="flex flex-col divide-y divide-line-subtle">
        {SHORTCUT_DEFINITIONS.map((definition) => (
          <li key={definition.id} className="flex items-center justify-between gap-4 py-2">
            <span className="text-body text-fg">{t(definition.descriptionKey)}</span>
            <span className="flex shrink-0 items-center gap-1">
              {definition.keys.map((key, index) => (
                <span key={key} className="flex items-center gap-1">
                  {index > 0 ? <span aria-hidden="true">+</span> : null}
                  <kbd className="min-w-6 rounded-sm border border-line-control bg-surface-page px-1.5 py-0.5 text-center font-mono text-caption text-fg">
                    {keyLabel(key)}
                  </kbd>
                </span>
              ))}
            </span>
          </li>
        ))}
      </ul>
      <div className="mt-4 flex items-start justify-between gap-4 border-t border-line-subtle pt-4">
        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor={switchId} className="text-body font-medium text-fg">
            {t('shortcuts.setting.label')}
          </label>
          <p id={hintId} className="text-body-sm text-fg-secondary">
            {t('shortcuts.setting.hint')}
          </p>
        </div>
        <Switch
          id={switchId}
          aria-describedby={hintId}
          checked={singleKeyEnabled}
          onCheckedChange={onSingleKeyChange}
        />
      </div>
    </Dialog>
  );
}

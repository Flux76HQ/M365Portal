import { isLocale } from '@m365portal/shared/i18n';
import { LanguagesIcon } from 'lucide-react';
import { useLanguage } from '../../lib/locale';
import { IconButton } from '../ui/icon-button';
import { Menu } from '../ui/menu';

/**
 * The language of the interface, as a menu of the two languages, each written in itself. The choice is
 * applied to the whole page at once, sets `<html lang>` and is remembered (FR-A-113). Organisation names
 * and other data are never translated.
 */
export function LanguageSwitcher() {
  const { language, translator, setLanguage } = useLanguage();
  const { t } = translator;
  return (
    <Menu
      trigger={
        <IconButton label={t('lang.label')}>
          <LanguagesIcon className="size-5" />
        </IconButton>
      }
      entries={[
        { kind: 'label', label: t('lang.label') },
        {
          kind: 'radio-group',
          value: language,
          onValueChange: (value) => {
            if (isLocale(value)) setLanguage(value);
          },
          options: [
            { value: 'nl', label: t('lang.nl') },
            { value: 'en', label: t('lang.en') },
          ],
        },
      ]}
      onSelect={() => undefined}
    />
  );
}

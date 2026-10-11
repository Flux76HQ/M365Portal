import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react';
import { useTranslator } from '../../lib/locale';
import { isThemeChoice, useTheme } from '../../lib/theme';
import { SegmentedControl } from '../ui/segmented-control';

export interface ThemeSwitcherProps {
  readonly className?: string;
}

/** Light, dark or follow the system: a segmented control, applied at once and remembered (FR-A-121). */
export function ThemeSwitcher({ className }: ThemeSwitcherProps) {
  const { t } = useTranslator();
  const { choice, setChoice } = useTheme();
  return (
    <SegmentedControl
      className={className}
      label={t('theme.label')}
      value={choice}
      onValueChange={(value) => {
        if (isThemeChoice(value)) setChoice(value);
      }}
      options={[
        { value: 'light', label: t('theme.light'), icon: <SunIcon /> },
        { value: 'dark', label: t('theme.dark'), icon: <MoonIcon /> },
        { value: 'system', label: t('theme.system'), icon: <MonitorIcon /> },
      ]}
    />
  );
}

import { useNavigate } from '@tanstack/react-router';
import { useCallback } from 'react';
import type { Command } from '../../lib/commands';
import { useLanguage } from '../../lib/locale';
import { useTheme } from '../../lib/theme';

/**
 * Carries out a command of the registry: go to a page, switch the theme or the language, or ask the shell
 * to show the shortcut overview. The registry is data; this is the one place that knows what its
 * actions do.
 */
export function useRunCommand(options: { readonly onShortcuts: () => void }) {
  const { onShortcuts } = options;
  const navigate = useNavigate();
  const { setChoice } = useTheme();
  const { setLanguage } = useLanguage();
  return useCallback(
    (command: Command): void => {
      const { run } = command;
      switch (run.kind) {
        case 'navigate':
          void navigate({ to: run.to });
          break;
        case 'theme':
          setChoice(run.choice);
          break;
        case 'language':
          setLanguage(run.language);
          break;
        case 'shortcuts':
          onShortcuts();
          break;
      }
    },
    [navigate, setChoice, setLanguage, onShortcuts],
  );
}

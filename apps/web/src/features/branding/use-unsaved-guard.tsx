// The unsaved-changes guard (T-A-214; FR-A-132): while the form differs from what is saved, leaving
// the page asks first. Two doors are guarded:
//   - moving inside the app (a link, Back, a command) is stopped by the router's blocker, and a
//     ConfirmDialog that names the object asks whether to stay or leave;
//   - closing or reloading the tab raises the browser's own `beforeunload` question (the browser words
//     the question itself, which no page can change). The listener is this hook's own and exists only
//     while there are edits; the router's built-in one is off, so the tab is asked exactly once and the
//     behaviour does not depend on which history implementation the router runs on.
// Nothing is stored: the guard only reads `dirty`.
import { useBlocker } from '@tanstack/react-router';
import { useEffect, type ReactNode } from 'react';
import { ConfirmDialog } from '../../components/ui/confirm-dialog';
import { useTranslator } from '../../lib/locale';

export interface UnsavedGuardOptions {
  /** The form differs from what is saved. */
  readonly dirty: boolean;
  /** The name of the thing that would lose its changes ("Appearance of Contoso"). */
  readonly objectName: string;
}

/** Returns the dialog to render once, anywhere in the page. */
export function useUnsavedGuard({ dirty, objectName }: UnsavedGuardOptions): ReactNode {
  const { t } = useTranslator();
  const blocker = useBlocker({
    shouldBlockFn: () => dirty,
    enableBeforeUnload: false,
    withResolver: true,
  });
  useEffect(() => {
    if (!dirty) return;
    const ask = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', ask);
    return () => {
      window.removeEventListener('beforeunload', ask);
    };
  }, [dirty]);

  return (
    <ConfirmDialog
      open={blocker.status === 'blocked'}
      onOpenChange={(open) => {
        if (!open) blocker.reset?.();
      }}
      objectName={objectName}
      title={t('appearance.leave.title')}
      description={t('appearance.leave.description')}
      confirmLabel={t('appearance.leave.confirm')}
      cancelLabel={t('appearance.leave.cancel')}
      onConfirm={() => {
        blocker.proceed?.();
      }}
    />
  );
}

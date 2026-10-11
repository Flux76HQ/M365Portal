import type { ErrorComponentProps } from '@tanstack/react-router';
import { ErrorView } from './ErrorView';

/**
 * The boundary of the root route: `me` could not be loaded, or the shell itself failed. It stands alone,
 * because without `me` there is nothing to build the shell from, and carries its own `main` landmark.
 */
export function RootError(props: ErrorComponentProps) {
  return (
    <main className="min-h-dvh bg-surface-page text-fg">
      <ErrorView {...props} scope="root" />
    </main>
  );
}

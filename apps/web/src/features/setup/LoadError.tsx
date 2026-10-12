import type { ReactNode } from 'react';
import { Button } from '../../components/ui/button';
import { ErrorState } from '../../components/ui/error-state';
import { ApiError } from '../../lib/api';
import { useTranslator } from '../../lib/locale';
import { messageForError } from '../../lib/problem';
import { useMe } from '../../lib/router-context';

export interface LoadErrorProps {
  /** The heading: what could not be loaded. */
  readonly title: string;
  readonly error: unknown;
  readonly retryLabel: string;
  readonly onRetry: () => void;
  /** More next to the retry button (a link to the sign-in, say). */
  readonly extra?: ReactNode;
}

/**
 * A page that could not load: what failed, why (the translated problem code, never the server's text), the
 * request id for support, and a way to try again. Every error shows a next step (FR-B-609).
 */
export function LoadError({ title, error, retryLabel, onRetry, extra }: LoadErrorProps) {
  const { t } = useTranslator();
  const me = useMe();
  return (
    <ErrorState
      headingLevel={2}
      title={title}
      description={messageForError({ t }, error, { publicOrigin: me.publicOrigin })}
      {...(error instanceof ApiError && error.requestId !== null
        ? { requestIdLabel: t('common.table.requestId'), requestId: error.requestId }
        : {})}
      action={
        <div className="flex flex-wrap justify-center gap-2">
          <Button onClick={onRetry}>{retryLabel}</Button>
          {extra}
        </div>
      }
    />
  );
}

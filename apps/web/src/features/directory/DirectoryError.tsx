// A failed read of the directory (EC-C13, EC-C14): what could not be loaded, why (the translated problem,
// never the server's text), the request id for support and a way to try again. A Graph 403 for the panel's
// own application carries the detail code `graph_permission_missing`; its message points to Settings,
// Connection (repair) and the page offers the link.
import { errorDetailMessageKey } from '@m365portal/shared/i18n/detail-codes';
import type { MessageKey } from '@m365portal/shared/i18n';
import { ROUTES } from '@m365portal/shared/routes';
import { Link } from '@tanstack/react-router';
import { Button } from '../../components/ui/button';
import { ErrorState } from '../../components/ui/error-state';
import { ApiError } from '../../lib/api';
import { useTranslator } from '../../lib/locale';
import { messageForError } from '../../lib/problem';
import { useMe } from '../../lib/router-context';

export interface DirectoryErrorProps {
  readonly title: string;
  readonly error: unknown;
  readonly retryLabel: string;
  readonly onRetry: () => void;
  /** The heading level that fits the page outline. */
  readonly headingLevel?: 2 | 3;
}

/** The detail message of the first `errors[]` entry that has a message of its own, if any. */
export function detailMessageKey(error: unknown): MessageKey | undefined {
  if (!(error instanceof ApiError)) return undefined;
  for (const detail of error.errors) {
    const key = errorDetailMessageKey(detail.code);
    if (key !== undefined) return key as MessageKey;
  }
  return undefined;
}

export function DirectoryError({
  title,
  error,
  retryLabel,
  onRetry,
  headingLevel = 2,
}: DirectoryErrorProps) {
  const translator = useTranslator();
  const me = useMe();
  const detailKey = detailMessageKey(error);
  const description =
    detailKey === undefined
      ? messageForError(translator, error, { publicOrigin: me.publicOrigin })
      : translator.t(detailKey);
  return (
    <ErrorState
      headingLevel={headingLevel}
      title={title}
      description={description}
      {...(error instanceof ApiError && error.requestId !== null
        ? { requestIdLabel: translator.t('common.table.requestId'), requestId: error.requestId }
        : {})}
      action={
        <div className="flex flex-wrap justify-center gap-2">
          <Button onClick={onRetry}>{retryLabel}</Button>
          {detailKey === 'users.error.graph_permission_missing' ? (
            <Button asChild variant="secondary">
              <Link to={ROUTES.connection}>{translator.t('users.error.openConnection')}</Link>
            </Button>
          ) : null}
        </div>
      }
    />
  );
}

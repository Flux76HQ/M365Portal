import { ROUTES } from '@m365portal/shared/routes';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useRouter, type ErrorComponentProps } from '@tanstack/react-router';
import { TriangleAlertIcon } from 'lucide-react';
import { ApiError } from '../../lib/api';
import type { MeResponse } from '../../lib/boot-data';
import { useTranslator } from '../../lib/locale';
import { messageForError } from '../../lib/problem';
import { queryKeys } from '../../lib/query';
import { Button } from '../ui/button';
import { StatusPage } from './StatusPage';

export interface ErrorViewProps extends ErrorComponentProps {
  readonly scope: 'root' | 'route';
}

/**
 * What both error boundaries show (FR-A-112, FR-A-130, E-20): the translated title, a line that says what
 * kind of failure it was (the message of the problem code, or the generic message with the code and the
 * request id for one the page does not know), and the request id when there is one. It never shows a
 * stack trace, an exception message, a file path or the server's English text: `messageForError` reads
 * the code and nothing else from the error. Retry resets the boundary and asks the router to load again.
 */
export function ErrorView({ error, reset, scope }: ErrorViewProps) {
  const translator = useTranslator();
  const { t } = translator;
  const router = useRouter();
  const queryClient = useQueryClient();
  // The origin the panel expects, for `origin_not_allowed`; `me` may not be loaded (a root failure).
  const publicOrigin = queryClient.getQueryData<MeResponse>(queryKeys.me)?.publicOrigin ?? null;
  const requestId = error instanceof ApiError ? error.requestId : null;

  return (
    <StatusPage
      tone="error"
      icon={<TriangleAlertIcon />}
      title={t(scope === 'root' ? 'errors.root.title' : 'errors.route.title')}
      description={t(scope === 'root' ? 'errors.root.description' : 'errors.route.description')}
      message={messageForError(translator, error, { publicOrigin })}
      requestIdLabel={t('errors.requestId')}
      requestId={requestId}
      actions={
        <>
          <Button
            variant="primary"
            onClick={() => {
              void router.invalidate();
              reset();
            }}
          >
            {t('errors.retry')}
          </Button>
          <Button asChild>
            <Link to={ROUTES.dashboard}>{t('errors.home')}</Link>
          </Button>
        </>
      }
    />
  );
}

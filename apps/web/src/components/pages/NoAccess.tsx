import { ROUTES } from '@m365portal/shared/routes';
import { Link } from '@tanstack/react-router';
import { LockKeyholeIcon } from 'lucide-react';
import { useTranslator } from '../../lib/locale';
import { Button } from '../ui/button';
import { StatusPage } from './StatusPage';

/**
 * What a gated page shows an actor without its permission, at the same URL (plan 9.1): Back works and the
 * address stays honest. Gating is cosmetic; the server refuses the data anyway. Also the page at /no-access.
 */
export function NoAccess() {
  const { t } = useTranslator();
  return (
    <StatusPage
      icon={<LockKeyholeIcon />}
      title={t('pages.noAccess.title')}
      description={t('pages.noAccess.description')}
      actions={
        <Button asChild variant="primary">
          <Link to={ROUTES.dashboard}>{t('pages.backToDashboard')}</Link>
        </Button>
      }
    />
  );
}

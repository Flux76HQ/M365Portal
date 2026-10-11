import { ROUTES } from '@m365portal/shared/routes';
import { Link } from '@tanstack/react-router';
import { CompassIcon } from 'lucide-react';
import { useTranslator } from '../../lib/locale';
import { Button } from '../ui/button';
import { StatusPage } from './StatusPage';

/** An address that is not a page of this panel (and `/design` while the showcase is off). */
export function NotFound() {
  const { t } = useTranslator();
  return (
    <StatusPage
      icon={<CompassIcon />}
      title={t('pages.notFound.title')}
      description={t('pages.notFound.description')}
      actions={
        <Button asChild variant="primary">
          <Link to={ROUTES.dashboard}>{t('pages.backToDashboard')}</Link>
        </Button>
      }
    />
  );
}

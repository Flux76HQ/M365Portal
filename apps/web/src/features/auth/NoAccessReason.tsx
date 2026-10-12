import {
  noAccessMessageKey,
  resolveNoAccessReason,
  resolveNoAccessRef,
} from '@m365portal/shared/auth/signin-errors';
import type { MessageKey } from '@m365portal/shared/i18n';
import { getRouteApi } from '@tanstack/react-router';
import { LockKeyholeIcon } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { loginUrl } from '../../lib/auth-nav';
import { useTranslator } from '../../lib/locale';
import { PublicPage } from './PublicPage';

const route = getRouteApi('/no-access');

/**
 * /no-access (FR-B-607, SB-26): the person signed in at Microsoft, but holds no role (`no_role`) or the
 * panel could not check it (`graph_unavailable`). Any other `reason` is read as `no_role`. The `ref` is
 * the request id of the failed sign-in and is shown only when it looks like one, so the address cannot
 * put text on the page. Two actions, both links to the sign-in; no data of the tenant appears here.
 */
export function NoAccessReason() {
  const { t } = useTranslator();
  const search = route.useSearch();
  const reason = resolveNoAccessReason(search.reason);
  const reference = resolveNoAccessRef(search.ref);
  const message = t(noAccessMessageKey(reason) as MessageKey);
  const remedy = t(`noaccess.remedy.${reason}`);
  return (
    <PublicPage title={t('noaccess.title')} icon={<LockKeyholeIcon />}>
      <div className="flex flex-col gap-2 text-body">
        <p className="font-semibold text-fg">{message}</p>
        <p className="text-fg-secondary">{remedy}</p>
      </div>
      {reference === null ? null : (
        <p className="flex flex-col gap-0.5 text-caption text-fg-muted">
          <span>{t('noaccess.reference')}</span>
          <code className="font-mono text-body-sm text-fg select-all">{reference}</code>
          <span>{t('noaccess.referenceHelp')}</span>
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button asChild variant="primary">
          <a href={loginUrl({ prompt: 'login' })}>{t('noaccess.action.signInAgain')}</a>
        </Button>
        <Button asChild variant="secondary">
          <a href={loginUrl({ prompt: 'select_account' })}>{t('noaccess.action.otherAccount')}</a>
        </Button>
      </div>
    </PublicPage>
  );
}

import { Banner } from '../../components/ui/banner';
import { useTranslator } from '../../lib/locale';
import { useMe } from '../../lib/router-context';

/**
 * "Lidmaatschap kon niet worden bepaald" (FR-B-608; plan 12.4): shown while the server says the group
 * memberships behind the roles could not be determined (`session.groupsStale`). A polite status region.
 */
export function GroupsStaleNotice() {
  const { t } = useTranslator();
  const me = useMe();
  if (me.actor.kind !== 'user' || me.session?.groupsStale !== true) return null;
  return (
    <Banner tone="warning" title={t('session.groupsStale.title')} data-testid="groups-stale-notice">
      {t('session.groupsStale.message')}
    </Banner>
  );
}

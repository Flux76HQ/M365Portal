import { useTranslator } from '../../lib/locale';
import { useMe } from '../../lib/router-context';
import { Banner } from '../ui/banner';

/**
 * The warning that preview mode is on (FR-A-032): everyone who opens the panel acts as the preview
 * administrator. It is a status region at the top of every page while `me.features.preview` is true and
 * it has no close button, because a banner that says "nothing here is protected" must not be dismissed.
 */
export function PreviewBanner() {
  const { t } = useTranslator();
  const me = useMe();
  if (!me.features.preview) return null;
  return (
    <Banner tone="warning" title={t('banner.preview.title')}>
      {t('banner.preview.message')}
    </Banner>
  );
}

import { ROUTES } from '@m365portal/shared/routes';
import { Link } from '@tanstack/react-router';
import { ChevronRightIcon, PaletteIcon } from 'lucide-react';
import { hasAccess } from '../../lib/gating';
import { useTranslator } from '../../lib/locale';
import { useMe } from '../../lib/router-context';
import { PageHeader } from './PageHeader';

/**
 * The Settings overview (FR-A-130): Appearance is the only setting that exists in Phase A; the connection
 * settings arrive in Phase B and access management in Phase D, and the page says so instead of listing
 * entries that lead nowhere.
 */
export function SettingsOverview() {
  const { t } = useTranslator();
  const me = useMe();
  const canChangeAppearance = hasAccess(me, ['settings:branding']);
  return (
    <>
      <PageHeader title={t('pages.settings.title')} description={t('pages.settings.lead')} />
      {canChangeAppearance ? (
        <ul aria-label={t('pages.settings.list')} className="grid max-w-2xl grid-cols-1 gap-3">
          <li>
            <Link
              to={ROUTES.appearance}
              className="flex min-h-control items-center gap-4 rounded-lg border border-line-subtle bg-surface-raised p-4 transition-colors duration-fast ease-standard hover:bg-accent-subtle"
            >
              <PaletteIcon aria-hidden="true" className="size-6 shrink-0 text-accent-text" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-subtitle font-semibold text-fg">{t('nav.appearance')}</span>
                <span className="text-body text-fg-secondary">
                  {t('pages.settings.appearance.description')}
                </span>
              </span>
              <ChevronRightIcon aria-hidden="true" className="size-4 shrink-0 text-fg-muted" />
            </Link>
          </li>
        </ul>
      ) : null}
      <p className="mt-6 max-w-prose text-body text-fg-secondary">{t('pages.settings.later')}</p>
    </>
  );
}

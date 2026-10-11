import type { ClientPath } from '@m365portal/shared/routes';
import { Link, useRouterState } from '@tanstack/react-router';
import { useTranslator } from '../../lib/locale';
import { Breadcrumbs, type BreadcrumbItem } from '../ui/breadcrumbs';
import { ROUTES } from '@m365portal/shared/routes';

/**
 * The path to the current page, from the route tree (FR-A-126): the dashboard, then every matched route
 * that has a `staticData.titleKey`, each linking to its own address. Nothing is shown on the dashboard
 * itself or on a page that is not in the tree (Not-found), where a trail would say nothing.
 */
export function BreadcrumbsBar() {
  const { t } = useTranslator();
  const trail = useRouterState({
    select: (state) =>
      state.matches.flatMap((match) =>
        match.staticData.titleKey === undefined
          ? []
          : [{ id: match.routeId, titleKey: match.staticData.titleKey, pathname: match.pathname }],
      ),
  });

  const first = trail[0];
  const items: BreadcrumbItem[] = trail.map((entry) => ({
    id: entry.id,
    label: t(entry.titleKey),
    href: entry.pathname,
  }));
  // Every page but the dashboard starts at the dashboard.
  if (first !== undefined && first.pathname !== ROUTES.dashboard) {
    items.unshift({ id: 'dashboard', label: t('nav.dashboard'), href: ROUTES.dashboard });
  }
  if (items.length < 2) return null;

  return (
    <div className="px-4 pt-4 sm:px-6">
      <Breadcrumbs
        label={t('a11y.breadcrumbs')}
        items={items}
        renderLink={({ href, className, title, children }) => (
          // The hrefs are pathnames of matched routes, which are paths of the route tree.
          <Link to={href as ClientPath} className={className} title={title}>
            {children}
          </Link>
        )}
      />
    </div>
  );
}

import type { MessageKey } from '@m365portal/shared/i18n';
import { MyAccessResponseSchema } from '@m365portal/shared/schemas/auth';
import { useQuery } from '@tanstack/react-query';
import { PageHeader } from '../../components/pages/PageHeader';
import { Banner } from '../../components/ui/banner';
import { Skeleton } from '../../components/ui/skeleton';
import { useLanguage } from '../../lib/locale';
import { useRouterContext } from '../../lib/router-context';
import { LoadError } from '../setup/LoadError';
import { EffectivePermissions } from './EffectivePermissions';
import { ScopeText } from './ScopeText';

/**
 * `/settings/access`, "Mijn toegang" (T-B-304; FR-B-514; US-B12): any signed-in actor may open it. It lists
 * the roles of the signed-in user, whether each came directly or through a group (by name when it is known),
 * the scope in words, the expiry and the effective permissions. It changes nothing; to change access, ask an
 * Owner. A break-glass session has no roles and one permission.
 */
export function AccessPage() {
  const { translator } = useLanguage();
  const { t, d } = translator;
  const { api } = useRouterContext();
  const query = useQuery({
    queryKey: ['me', 'access'],
    queryFn: ({ signal }) =>
      api.get('/api/v1/me/access', { schema: MyAccessResponseSchema, signal }),
    staleTime: 0,
  });

  let content;
  if (query.data === undefined) {
    content = query.isError ? (
      <LoadError
        title={t('access.page.loadError')}
        error={query.error}
        retryLabel={t('access.page.retry')}
        onRetry={() => {
          void query.refetch();
        }}
      />
    ) : (
      <div aria-busy="true" aria-label={t('access.page.loading')} className="flex flex-col gap-4">
        <Skeleton height={96} />
        <Skeleton height={160} />
      </div>
    );
  } else {
    const data = query.data;
    content = (
      <div className="flex flex-col gap-6">
        <p className="text-body text-fg">{t('access.who', { name: data.principal.label })}</p>
        {data.groupsStale ? (
          <Banner
            tone="warning"
            title={t('access.stale.title')}
            className="rounded-md border border-line-subtle"
          >
            {t('access.stale.message')}
            {data.groupsResolvedAt === null ? null : (
              <>
                {' '}
                {t('access.stale.checked', {
                  time: d(Date.parse(data.groupsResolvedAt), {
                    dateStyle: 'long',
                    timeStyle: 'short',
                  }),
                })}
              </>
            )}
          </Banner>
        ) : null}
        <section aria-labelledby="access-roles" className="flex flex-col gap-2">
          <h2 id="access-roles" className="text-subtitle font-semibold text-fg">
            {t('access.roles.heading')}
          </h2>
          {data.principal.kind === 'break_glass' ? (
            <p className="text-body text-fg-secondary">{t('access.roles.breakGlass')}</p>
          ) : data.assignments.length === 0 ? (
            <p className="text-body text-fg-secondary">{t('access.roles.empty')}</p>
          ) : (
            <ul aria-label={t('access.assignment.list')} className="flex flex-col gap-2">
              {data.assignments.map((assignment) => (
                <li
                  key={assignment.id}
                  className="flex flex-col gap-1 rounded-lg border border-line-subtle bg-surface-raised p-3"
                >
                  <p className="text-body font-semibold text-fg">
                    {assignment.role.builtin
                      ? t(`role.${assignment.role.key}` as MessageKey)
                      : assignment.role.key}
                  </p>
                  <p className="text-body-sm text-fg-secondary">
                    {assignment.origin.type === 'direct'
                      ? t('origin.direct')
                      : assignment.origin.groupName === null
                        ? t('origin.groupUnnamed')
                        : t('origin.group', { group: assignment.origin.groupName })}
                  </p>
                  <div className="text-body-sm text-fg-secondary">
                    <span className="font-medium">{t('access.assignment.scope')}: </span>
                    <ScopeText scope={assignment.scope} />
                  </div>
                  <p className="text-body-sm text-fg-secondary">
                    {assignment.expiresAt === null
                      ? t('access.assignment.noExpiry')
                      : t('access.assignment.expires', {
                          date: d(Date.parse(assignment.expiresAt), { dateStyle: 'long' }),
                        })}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
        <EffectivePermissions grants={data.grants} />
        <p className="max-w-prose text-body-sm text-fg-muted">{t('access.page.readOnly')}</p>
      </div>
    );
  }
  return (
    <>
      <PageHeader title={t('access.page.title')} description={t('access.page.description')} />
      {content}
    </>
  );
}

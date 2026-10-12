import type { MessageKey } from '@m365portal/shared/i18n';
import type { MyAccessResponseSchema } from '@m365portal/shared/schemas/auth';
import type { z } from 'zod';
import { useLanguage } from '../../lib/locale';
import { ScopeText } from './ScopeText';

type Grants = z.infer<typeof MyAccessResponseSchema>['grants'];

/**
 * The effective permissions (FR-B-514): what the user may do with all roles together, in words, with the
 * detail level (`basic` is "only name and email address") and the scope. Information only: the server
 * decides every action.
 */
export function EffectivePermissions({ grants }: { readonly grants: Grants }) {
  const { t } = useLanguage().translator;
  return (
    <section aria-labelledby="access-permissions" className="flex flex-col gap-2">
      <h2 id="access-permissions" className="text-subtitle font-semibold text-fg">
        {t('access.permissions.heading')}
      </h2>
      <p className="max-w-prose text-body text-fg-secondary">{t('access.permissions.description')}</p>
      {grants.length === 0 ? (
        <p className="text-body text-fg-secondary">{t('access.permissions.empty')}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line-subtle">
          <table aria-label={t('access.permissions.table')} className="w-full min-w-120 border-collapse text-start text-body">
            <thead>
              <tr className="border-b border-line-subtle bg-surface-page">
                <th scope="col" className="px-3 py-2 text-start text-body-sm font-semibold text-fg-secondary">
                  {t('access.permissions.column.permission')}
                </th>
                <th scope="col" className="px-3 py-2 text-start text-body-sm font-semibold text-fg-secondary">
                  {t('access.permissions.column.detail')}
                </th>
                <th scope="col" className="px-3 py-2 text-start text-body-sm font-semibold text-fg-secondary">
                  {t('access.permissions.column.scope')}
                </th>
              </tr>
            </thead>
            <tbody>
              {grants.map((grant) => (
                <tr key={`${grant.permission}:${grant.qualifier}`} className="border-b border-line-subtle last:border-b-0">
                  <td className="px-3 py-2 text-fg">{t(`permission.${grant.permission}` as MessageKey)}</td>
                  <td className="px-3 py-2 text-fg-secondary">{t(`qualifier.${grant.qualifier}` as MessageKey)}</td>
                  <td className="px-3 py-2 text-fg-secondary">
                    <ScopeText scope={grant.scope} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

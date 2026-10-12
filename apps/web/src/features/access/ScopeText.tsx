import type { MessageKey } from '@m365portal/shared/i18n';
import type { ScopeItemSchema } from '@m365portal/shared/schemas/rbac';
import type { z } from 'zod';
import { useLanguage } from '../../lib/locale';

export type ScopeItem = z.infer<typeof ScopeItemSchema>;

export interface ScopeTextProps {
  /** `all`, or no items, means everything. */
  readonly scope: 'all' | readonly ScopeItem[];
}

/**
 * A scope in words (FR-B-513, FR-B-514): "all groups whose name starts with Sales", "only users with ID ...",
 * "all users in the department Finance". The words are the panel's; the value is data the administrator typed
 * and is printed as it is. No scope item means everything.
 */
export function ScopeText({ scope }: ScopeTextProps) {
  const { t } = useLanguage().translator;
  if (scope === 'all' || scope.length === 0) return <>{t('access.assignment.scopeAll')}</>;
  const lines = scope.map((item) => {
    const target = t(`resource.${item.target}` as MessageKey);
    switch (item.match.by) {
      case 'id':
        return t('scope.id', { target, id: item.match.id });
      case 'prefix':
        return t(`scope.prefix.${item.match.attr}` as MessageKey, { target, value: item.match.value });
      case 'department':
        return t('scope.department', { target, value: item.match.value });
    }
  });
  return (
    <ul className="flex flex-col gap-0.5">
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}

// The filters of the users list (FR-C-201): account state and user type, each a choice of one among three
// with a visible name. A role that holds `users:read` as `basic` only does not get them: the server refuses
// the filters for it (FR-C-204), so the page does not offer what cannot work.
import { useTranslator } from '../../lib/locale';
import { FilterChoice } from '../directory/FilterChoice';
import type { UsersParams } from './queries';

export interface UserFiltersProps {
  readonly params: UsersParams;
  readonly onEnabled: (value: UsersParams['enabled']) => void;
  readonly onType: (value: UsersParams['type']) => void;
}

export function UserFilters({ params, onEnabled, onType }: UserFiltersProps) {
  const { t } = useTranslator();
  return (
    <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
      <FilterChoice
        label={t('users.filter.enabled.label')}
        value={params.enabled}
        onValueChange={(value) => {
          if (value === 'all' || value === 'true' || value === 'false') onEnabled(value);
        }}
        options={[
          { value: 'all', label: t('users.filter.enabled.all') },
          { value: 'true', label: t('users.filter.enabled.true') },
          { value: 'false', label: t('users.filter.enabled.false') },
        ]}
      />
      <FilterChoice
        label={t('users.filter.type.label')}
        value={params.type}
        onValueChange={(value) => {
          if (value === 'all' || value === 'member' || value === 'guest') onType(value);
        }}
        options={[
          { value: 'all', label: t('users.filter.type.all') },
          { value: 'member', label: t('users.filter.type.member') },
          { value: 'guest', label: t('users.filter.type.guest') },
        ]}
      />
    </div>
  );
}

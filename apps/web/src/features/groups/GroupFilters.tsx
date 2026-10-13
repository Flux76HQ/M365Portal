// The filter of the groups list (FR-C-301): the kind, and the note that dynamic distribution lists are not
// listed (FR-C-302): Graph does not return them, so the list never claims to be complete for distribution.
import { useTranslator } from '../../lib/locale';
import { FilterChoice } from '../directory/FilterChoice';
import { StateNotice } from '../directory/StateNotice';
import type { GroupsParams } from './queries';

export interface GroupFiltersProps {
  readonly params: GroupsParams;
  readonly onKind: (value: GroupsParams['kind']) => void;
}

const KINDS = ['all', 'm365', 'security', 'mailsecurity', 'distribution'] as const;

export function GroupFilters({ params, onKind }: GroupFiltersProps) {
  const { t } = useTranslator();
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <FilterChoice
        label={t('groups.filter.kind.label')}
        value={params.kind}
        onValueChange={(value) => {
          const kind = KINDS.find((candidate) => candidate === value);
          if (kind !== undefined) onKind(kind);
        }}
        options={[
          { value: 'all', label: t('groups.filter.kind.all') },
          { value: 'm365', label: t('groups.kind.m365') },
          { value: 'security', label: t('groups.kind.security') },
          { value: 'mailsecurity', label: t('groups.kind.mailsecurity') },
          { value: 'distribution', label: t('groups.kind.distribution') },
        ]}
      />
      <StateNotice state={{ kind: 'dynamicListsNote' }} className="max-w-prose" />
    </div>
  );
}

// The filter of the lists (FR-D-202): the kind of list.
import { LIST_KIND_VALUES } from '../directory/search';
import { useTranslator } from '../../lib/locale';
import { FilterChoice } from '../directory/FilterChoice';
import type { ListsParams } from './queries';

export interface ListFiltersProps {
  readonly params: ListsParams;
  readonly onKind: (value: ListsParams['kind']) => void;
}

export function ListFilters({ params, onKind }: ListFiltersProps) {
  const { t } = useTranslator();
  return (
    <FilterChoice
      label={t('distributionLists.filter.kind.label')}
      value={params.kind}
      onValueChange={(value) => {
        if (value === 'all') onKind('all');
        else {
          const kind = LIST_KIND_VALUES.find((candidate) => candidate === value);
          if (kind !== undefined) onKind(kind);
        }
      }}
      options={[
        { value: 'all', label: t('distributionLists.filter.kind.all') },
        ...LIST_KIND_VALUES.map((kind) => ({
          value: kind,
          label: t(`distributionLists.kind.${kind}`),
        })),
      ]}
    />
  );
}

// The kind of a distribution list as words (FR-D-202, FR-D-207): a bordered label with the name of the kind and,
// for the lists that are read-only here (dynamic, synchronised), the words "Read-only" next to it. The kind
// arrives on the wire; the page never derives it.
import type { DistributionListKind } from '@m365portal/shared/schemas/distribution-lists';
import { useTranslator } from '../../lib/locale';

export function ListKindBadge({ kind }: { readonly kind: DistributionListKind }) {
  const { t } = useTranslator();
  return (
    <span data-kind={kind} className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="rounded-sm border border-line-subtle px-1.5 py-0.5 text-body-sm font-medium text-fg">
        {t(`distributionLists.kind.${kind}`)}
      </span>
      {kind === 'standard' ? null : (
        <span className="text-body-sm text-fg-secondary">
          {t('distributionLists.readOnly.badge')}
        </span>
      )}
    </span>
  );
}

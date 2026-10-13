// The result of a member change, per member (FR-D-203, FR-D-353, US-D3): how many were added, removed, already
// in the wanted state or failed, whether the change was made for everyone, and a table with one row per member
// with the reason of each failure. Failures come first: with 200 members, the three that failed must not hide
// under the 197 that did not. The names are the page's (the picker's selection or the rows that were selected);
// a member whose name is not known is "Unnamed member", never the id.
import {
  MEMBER_WRITE_RESULTS,
  type MemberWriteItem,
  type MemberWriteSummary,
} from '@m365portal/shared/schemas/member-writes';
import { CircleCheckIcon, CircleXIcon } from 'lucide-react';
import { useId } from 'react';
import { Button } from '../../components/ui/button';
import { useTranslator } from '../../lib/locale';
import { DirectoryTable, type DirectoryColumn } from './DirectoryTable';
import { StateNotice } from './StateNotice';

export interface MemberResultsProps {
  readonly results: readonly MemberWriteItem[];
  readonly summary: MemberWriteSummary;
  /** Names by member id. */
  readonly names: ReadonlyMap<string, string>;
  /** Exchange may not show the change yet (EC-D7); lists only. */
  readonly readBackPending?: boolean;
  /** Reads the members again; offered next to the read-back note. */
  readonly onRefresh?: () => void;
  readonly onDismiss?: () => void;
}

export function MemberResults({
  results,
  summary,
  names,
  readBackPending = false,
  onRefresh,
  onDismiss,
}: MemberResultsProps) {
  const { t } = useTranslator();
  const headingId = useId();
  const ordered = [
    ...results.filter((item) => item.result === 'failed'),
    ...results.filter((item) => item.result !== 'failed'),
  ];
  const counts = MEMBER_WRITE_RESULTS.filter((result) => summary[result] > 0).map((result) =>
    t('distributionLists.results.count', {
      result: t(`distributionLists.result.${result}`),
      count: summary[result],
    }),
  );
  const verdict =
    summary.failed === 0
      ? t('distributionLists.results.allDone')
      : summary.failed === results.length
        ? t('distributionLists.results.allFailed')
        : t('distributionLists.results.partial');

  const columns: DirectoryColumn<MemberWriteItem>[] = [
    {
      id: 'member',
      header: t('distributionLists.results.column.member'),
      rowHeader: true,
      cell: (item) => names.get(item.id) ?? t('distributionLists.members.unnamed'),
    },
    {
      id: 'result',
      header: t('distributionLists.results.column.result'),
      cell: (item) => {
        const Icon = item.result === 'failed' ? CircleXIcon : CircleCheckIcon;
        return (
          <span className="inline-flex items-center gap-1.5">
            <Icon
              aria-hidden="true"
              className={
                item.result === 'failed'
                  ? 'size-4 shrink-0 text-danger'
                  : 'size-4 shrink-0 text-success'
              }
            />
            {t(`distributionLists.result.${item.result}`)}
          </span>
        );
      },
    },
    {
      id: 'reason',
      header: t('distributionLists.results.column.reason'),
      cell: (item) =>
        item.reason === undefined ? null : t(`distributionLists.reason.${item.reason}`),
    },
  ];

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-lg border border-line-subtle bg-surface-raised p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 id={headingId} className="text-body font-semibold text-fg">
          {t('distributionLists.results.heading')}
        </h3>
        {onDismiss === undefined ? null : (
          <Button size="sm" onClick={onDismiss}>
            {t('distributionLists.results.dismiss')}
          </Button>
        )}
      </div>
      <p role="status" className="text-body text-fg">
        {counts.join(', ')}
      </p>
      <p className="text-body text-fg-secondary">{verdict}</p>
      {readBackPending ? (
        <div className="flex flex-wrap items-center gap-3">
          <StateNotice state={{ kind: 'readBackPending' }} />
          {onRefresh === undefined ? null : (
            <Button size="sm" onClick={onRefresh}>
              {t('distributionLists.results.refresh')}
            </Button>
          )}
        </div>
      ) : null}
      <DirectoryTable
        caption={t('distributionLists.results.caption')}
        columns={columns}
        rows={ordered}
        getRowKey={(item) => item.id}
      />
    </section>
  );
}

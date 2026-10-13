// Under a cursor list: how many rows this page shows (a polite live region, so a change of filter is read
// out, FR-C-506) and Previous / Next. There is no total and no "page 3 of 9": the server does not know it
// (FR-C-201), so the text says which page this is and the buttons say what is possible.
import { Button } from '../../components/ui/button';
import { useTranslator } from '../../lib/locale';
import type { CursorPaging } from './useCursorPaging';

export interface ListFooterProps {
  /** "50 users shown"; empty while the list loads or failed. */
  readonly countText: string;
  readonly paging: CursorPaging;
  /** The cursor of the next page, or undefined at the end of the list. */
  readonly nextCursor: string | undefined;
  /** Stops the buttons while another page loads. */
  readonly busy?: boolean;
}

export function ListFooter({ countText, paging, nextCursor, busy = false }: ListFooterProps) {
  const { t } = useTranslator();
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p role="status" aria-live="polite" className="text-body-sm text-fg-secondary">
        {countText}
      </p>
      <nav aria-label={t('common.table.pagination')} className="flex items-center gap-2">
        <Button size="sm" disabled={!paging.canPrevious || busy} onClick={paging.previous}>
          {t('common.table.previousPage')}
        </Button>
        <span className="text-body-sm text-fg-secondary">
          {t('users.paging.page', { page: paging.page })}
        </span>
        <Button
          size="sm"
          disabled={nextCursor === undefined || busy}
          onClick={() => {
            if (nextCursor !== undefined) paging.next(nextCursor);
          }}
        >
          {t('common.table.nextPage')}
        </Button>
      </nav>
    </div>
  );
}

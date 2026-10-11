// The DataTable is i18n-agnostic and storage-agnostic (contract C12): it takes a typed `labels` object
// and a `columnStorage` interface. This module is the wiring a page uses: the labels come from the
// catalogue (`common.table.*`, in the language of the translator) and the remembered columns go through
// the storage module under `STORAGE_KEYS.columnsPrefix + table id`.
import type { Translator } from '@m365portal/shared/i18n';
import type {
  DataTableColumnPrefs,
  DataTableColumnStorage,
} from '../components/data-table/column-picker';
import type { DataTableLabels } from '../components/data-table/labels';
import { columnsKey, type AppStorage } from './storage';

/**
 * Every label of a DataTable, from the catalogue. `tableLabel` names the table (and the scroll region
 * around it) and is the page's own text; the rest is generic. A page that needs another word for one of
 * them overrides that field after the call. Counts are plural groups, so Dutch and English each decide
 * their own forms and word order.
 */
export function createTableLabels(
  translator: Pick<Translator, 't'>,
  tableLabel: string,
): DataTableLabels {
  const { t } = translator;
  return {
    tableLabel,
    searchLabel: t('common.table.search'),
    searchPlaceholder: t('common.table.searchPlaceholder'),
    searchSubmit: t('common.table.search'),
    searchClear: t('common.table.searchClear'),
    resultCount: (total) => t('common.table.resultCount', { count: total }),
    loading: t('common.table.loading'),
    selectAllRowsOnPage: t('common.table.selectAllRows'),
    selectRow: (row) => t('common.table.selectRow', { row }),
    emptyTitle: t('common.table.emptyTitle'),
    emptyDescription: t('common.table.emptyDescription'),
    noResultsTitle: t('common.table.noResultsTitle'),
    noResultsDescription: t('common.table.noResultsDescription'),
    clearFilters: t('common.table.clearFilters'),
    errorTitle: t('common.table.errorTitle'),
    errorDescription: t('common.table.errorDescription'),
    retry: t('common.table.retry'),
    requestId: t('common.table.requestId'),
    paginationLabel: t('common.table.pagination'),
    previousPage: t('common.table.previousPage'),
    nextPage: t('common.table.nextPage'),
    pageStatus: (page, pageCount) => t('common.table.pageStatus', { page, pageCount }),
    pageSizeLabel: t('common.table.pageSizeLabel'),
    pageSizeOption: (size) => t('common.table.pageSizeOption', { size }),
    selectionOnPage: (count) => t('common.table.selectionOnPage', { count }),
    selectAllResults: (total) => t('common.table.selectAllResults', { total }),
    allResultsSelected: (total) => t('common.table.allResultsSelected', { total }),
    clearSelection: t('common.table.clearSelection'),
    bulkActionsLabel: t('common.table.bulkActions'),
    columnsButton: t('common.table.columns'),
    columnsTitle: t('common.table.columnsTitle'),
    columnsDescription: t('common.table.columnsDescription'),
    moveColumnLeft: (column) => t('common.table.moveColumnLeft', { column }),
    moveColumnRight: (column) => t('common.table.moveColumnRight', { column }),
    columnMoved: (column, position, total) =>
      t('common.table.columnMoved', { column, position, total }),
    columnShown: (column) => t('common.table.columnShown', { column }),
    columnHidden: (column) => t('common.table.columnHidden', { column }),
    resetColumns: t('common.table.resetColumns'),
    closeLabel: t('common.table.close'),
    actionsColumn: t('common.table.actionsColumn'),
    rowActions: (row) => t('common.table.rowActions', { row }),
    openDetails: (row) => t('common.table.openDetails', { row }),
    detailsClose: t('common.table.detailsClose'),
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function parsePrefs(text: string | null): DataTableColumnPrefs | null {
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const { hidden, order } = parsed as Record<string, unknown>;
  return isStringArray(hidden) && isStringArray(order) ? { hidden, order } : null;
}

/**
 * The remembered column choice of each table, in this browser (FR-A-125), through the storage module. The
 * interface must not throw: a table id the key rule refuses, text that is not JSON and a stored value of
 * the wrong shape all read as "no choice", and a refused write is the storage module's business.
 */
export function createColumnStorage(storage: AppStorage): DataTableColumnStorage {
  return {
    read(tableId) {
      try {
        return parsePrefs(storage.read(columnsKey(tableId)));
      } catch {
        return null;
      }
    },
    write(tableId, prefs) {
      try {
        storage.write(
          columnsKey(tableId),
          JSON.stringify({ hidden: prefs.hidden, order: prefs.order }),
        );
      } catch {
        // A table id the key rule refuses cannot be stored; the choice then lasts as long as the table.
      }
    },
    clear(tableId) {
      try {
        storage.remove(columnsKey(tableId));
      } catch {
        // See write.
      }
    },
  };
}

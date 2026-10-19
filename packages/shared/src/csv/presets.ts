// The presets of a distribution list export (T-D-201, FR-D-402): which columns, which separator, whether
// there is a byte order mark. A preset other than `custom` fixes all three; `custom` takes them from the
// request.
//
// The Laposta preset is E-MAIL + FIRST NAME + LAST NAME with a semicolon and a BOM, and nothing more:
// the current import format of Laposta has not been read from its documentation (U91, open), so the
// preset is labelled "check the importer" in the interface until the owner has closed U91 (OV-D6).
import type { CsvSeparator } from './write.js';

/** The columns an export can hold, in the order the interface offers them. */
export const EXPORT_COLUMNS = ['email', 'firstName', 'lastName', 'displayName', 'type'] as const;
export type ExportColumn = (typeof EXPORT_COLUMNS)[number];

/** The header of each column in the file. Fixed English words: an importer maps columns by them, not the UI. */
export const EXPORT_HEADERS: Readonly<Record<ExportColumn, string>> = Object.freeze({
  email: 'email',
  firstName: 'first_name',
  lastName: 'last_name',
  displayName: 'display_name',
  type: 'type',
});

export const EXPORT_PRESETS = ['laposta', 'generic', 'custom'] as const;
export type ExportPreset = (typeof EXPORT_PRESETS)[number];

/** What the writer needs: the columns, the separator, the BOM and the two filters, all decided. */
export interface ResolvedExportOptions {
  readonly columns: readonly ExportColumn[];
  readonly separator: CsvSeparator;
  readonly bom: boolean;
  /** One row per e-mail address, compared case-insensitively; the first one in the list order stays. */
  readonly dedupe: boolean;
  /** A member without an e-mail address is left out (and counted); otherwise it is a row with an empty cell. */
  readonly skipWithoutEmail: boolean;
}

/** The options as the request states them. For a preset other than `custom` the three fixed ones are absent. */
export interface ExportOptionsInput {
  readonly preset: ExportPreset;
  readonly columns?: readonly ExportColumn[] | undefined;
  readonly separator?: CsvSeparator | undefined;
  readonly bom?: boolean | undefined;
  readonly dedupe: boolean;
  readonly skipWithoutEmail: boolean;
}

const FIXED = {
  laposta: { columns: ['email', 'firstName', 'lastName'], separator: ';', bom: true },
  generic: { columns: EXPORT_COLUMNS, separator: ',', bom: false },
} as const satisfies Record<
  'laposta' | 'generic',
  { columns: readonly ExportColumn[]; separator: CsvSeparator; bom: boolean }
>;

/** The options the export runs with. `custom` without columns is the default five. */
export function resolveExportOptions(input: ExportOptionsInput): ResolvedExportOptions {
  const common = { dedupe: input.dedupe, skipWithoutEmail: input.skipWithoutEmail };
  if (input.preset === 'custom') {
    return {
      columns: input.columns ?? EXPORT_COLUMNS,
      separator: input.separator ?? ';',
      bom: input.bom ?? true,
      ...common,
    };
  }
  return { ...FIXED[input.preset], ...common };
}

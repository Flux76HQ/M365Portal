// Wire schemas of the distribution list export (Phase D step D2, T-D-201; FR-D-401, FR-D-402, FR-D-404).
// The body of P55 (the download) and of P46 (the preview of its first rows) is the same: the preview
// shows what the download would start with, made by the same function with the same options.
//
// Rules of this folder: Zod only, no transform, `.meta({ id })`, strict. A preset other than `custom`
// fixes the columns, the separator and the BOM; sending them with such a preset is a 422, not a silent
// override, so a client never believes it chose what the server then ignored.
import { z } from 'zod';
import { EXPORT_COLUMNS, EXPORT_PRESETS } from '../csv/presets.js';

export const ExportColumnSchema = z.enum(EXPORT_COLUMNS).meta({ id: 'ExportColumn' });
export const ExportPresetSchema = z.enum(EXPORT_PRESETS).meta({ id: 'ExportPreset' });
export const ExportSeparatorSchema = z.enum([',', ';']).meta({ id: 'ExportSeparator' });

export const ExportOptionsSchema = z
  .strictObject({
    preset: ExportPresetSchema,
    /** `custom` only: one to five columns, each once. */
    columns: z
      .array(ExportColumnSchema)
      .min(1)
      .max(EXPORT_COLUMNS.length)
      .refine((columns) => new Set(columns).size === columns.length, 'columns are unique')
      .optional(),
    /** `custom` only. */
    separator: ExportSeparatorSchema.optional(),
    /** `custom` only. */
    bom: z.boolean().optional(),
    dedupe: z.boolean().default(true),
    skipWithoutEmail: z.boolean().default(true),
  })
  .refine(
    (options) =>
      options.preset === 'custom' ||
      (options.columns === undefined &&
        options.separator === undefined &&
        options.bom === undefined),
    { message: 'a preset fixes the columns, the separator and the BOM', path: ['preset'] },
  )
  .meta({ id: 'ExportOptions' });

/** The first rows of the file, exactly as the download would start (P46). */
export const ExportPreviewResponseSchema = z
  .strictObject({
    /** The text of the header and the first rows, line breaks included; no BOM. */
    csv: z.string().max(65_536),
    /** Rows of data in `csv`. */
    rows: z.number().int().min(0),
    /** Members left out so far (no address, a duplicate, a member the actor may not see). */
    skipped: z.number().int().min(0),
    /** True when the list has more members than the preview read. */
    more: z.boolean(),
  })
  .meta({ id: 'ExportPreviewResponse' });

export type ExportOptions = z.infer<typeof ExportOptionsSchema>;
export type ExportPreviewResponse = z.infer<typeof ExportPreviewResponseSchema>;

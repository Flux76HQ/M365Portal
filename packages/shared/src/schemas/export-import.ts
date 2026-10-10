// Branding export and import wire schemas (contract sections 4 and 8.1, R10, R11, FR-A-093, C10): the
// JSON document that `GET /api/v1/branding/export` writes and `POST /api/v1/branding/import` reads, the
// import query, and the result. Same rules as `schemas/branding.ts`: Zod only, no transform,
// `.meta({ id })`.
//
// Import is hostile input (E-22, H-42): the document schema is strict, so an unknown member, and the
// members `__proto__` and `constructor` of a parsed JSON text, are refused. A repeated key cannot be
// seen after `JSON.parse` and is the business of the route's own parser; so is the document depth.
// `schemaVersion` is the literal 1: the route reads that member first, so that a newer version gets
// `import_unsupported_version` and not a generic schema failure.
import { z } from 'zod';
import { LIMITS } from '../limits.js';
import { UploadWarningSchema } from './assets.js';
import { BrandingSchema, OrgNameInputSchema, OrgNameSchema } from './branding.js';
import { AccentInputSchema, HexColorSchema, Sha256HexSchema } from './common.js';

/** A PNG as base64 in the longest form the file limit allows: 4 characters per 3 bytes, padded. */
const MAX_BASE64_LENGTH = 4 * Math.ceil(LIMITS.body.logoFileBytes / 3);
const BASE64_CHARACTERS = /^[A-Za-z0-9+/]*={0,2}$/;

/** How many bytes the base64 text decodes to, for text whose length is a multiple of 4. */
function decodedLength(text: string): number {
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  return (text.length / 4) * 3 - padding;
}

/**
 * Canonical base64 (RFC 4648 section 4): the standard alphabet, padded, no whitespace, no line breaks,
 * trailing bits zero, and decoding to at most the 2,097,152 bytes of the file limit. Canonical means
 * that encoding the decoded bytes gives the text back. The length is checked first, so a huge string
 * is refused without being read.
 */
function isCanonicalBase64(text: string): boolean {
  if (text.length === 0 || text.length > MAX_BASE64_LENGTH || text.length % 4 !== 0) return false;
  if (!BASE64_CHARACTERS.test(text)) return false;
  if (decodedLength(text) > LIMITS.body.logoFileBytes) return false;
  try {
    return btoa(atob(text)) === text;
  } catch {
    return false;
  }
}

/** The bytes of a PNG master in an export or import document. */
export const Base64PngSchema = z
  .string()
  .min(4)
  .max(MAX_BASE64_LENGTH)
  .refine(isCanonicalBase64, { error: 'base64_invalid' })
  .meta({ id: 'Base64Png' });

/**
 * `GET /api/v1/branding/export` and the body of `POST /api/v1/branding/import`:
 * `{ schemaVersion: 1, orgName, accent, images: { logoLight, logoDark, compact } }`. Every image member
 * is present, `null` when there is none: a member that is missing is refused instead of read as "no
 * logo", so a typo cannot silently remove a logo. The export holds the stored master PNGs (the explicit
 * compact only); the name and accent are validated like `PUT` does, and normalised by the service.
 */
export const BrandingExportSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    orgName: OrgNameInputSchema,
    accent: AccentInputSchema,
    images: z.strictObject({
      logoLight: Base64PngSchema.nullable(),
      logoDark: Base64PngSchema.nullable(),
      compact: Base64PngSchema.nullable(),
    }),
  })
  .meta({ id: 'BrandingExport' });

/** `POST /api/v1/branding/import?dryRun=true|false`: the query is text, so no boolean is coerced. */
export const ImportQuerySchema = z
  .strictObject({ dryRun: z.enum(['true', 'false']).optional() })
  .meta({ id: 'ImportQuery' });

/** What one image of an import became after the complete pipeline, with the pipeline's warnings. */
export const ImportedImageSummarySchema = z
  .strictObject({
    hash: Sha256HexSchema,
    width: z.int().min(1).max(1024),
    height: z.int().min(1).max(1024),
    bytes: z.int().min(1).max(LIMITS.body.logoFileBytes),
    warnings: z.array(UploadWarningSchema).max(2),
  })
  .meta({ id: 'ImportedImageSummary' });

/**
 * `200` of `POST /api/v1/branding/import`. A dry run stores nothing, so `applied` is false and
 * `branding` is null; an import that was applied carries the new branding. `orgName` and `accent`
 * are the normalised values.
 */
export const ImportResultSchema = z
  .strictObject({
    dryRun: z.boolean(),
    applied: z.boolean(),
    orgName: OrgNameSchema,
    accent: HexColorSchema,
    images: z.strictObject({
      logoLight: ImportedImageSummarySchema.nullable(),
      logoDark: ImportedImageSummarySchema.nullable(),
      compact: ImportedImageSummarySchema.nullable(),
    }),
    branding: BrandingSchema.nullable(),
  })
  .refine(({ dryRun, applied }) => applied === !dryRun, {
    error: 'applied_dry_run_mismatch',
    path: ['applied'],
  })
  .refine(({ dryRun, branding }) => (branding === null) === dryRun, {
    error: 'branding_dry_run_mismatch',
    path: ['branding'],
  })
  .meta({ id: 'ImportResult' });

export type Base64Png = z.infer<typeof Base64PngSchema>;
export type BrandingExport = z.infer<typeof BrandingExportSchema>;
export type ImportQuery = z.infer<typeof ImportQuerySchema>;
export type ImportedImageSummary = z.infer<typeof ImportedImageSummarySchema>;
export type ImportResult = z.infer<typeof ImportResultSchema>;

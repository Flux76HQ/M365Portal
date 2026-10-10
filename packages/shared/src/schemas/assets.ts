// Asset staging wire schemas (contract sections 4 and 8.1, R7, FR-A-080, FR-A-084 to FR-A-089, C10):
// the slot and query of `POST /api/v1/branding/assets`, the staged asset and the warnings the pipeline
// reports on success. Same rules as `schemas/branding.ts`: Zod only, no transform, `.meta({ id })`.
import { z } from 'zod';
import { LIMITS } from '../limits.js';
import { assetRefFields, urlMatchesHash } from './branding.js';

/** The three places a logo can go (R7 query `slot`): `logoLight`, `logoDark` and `compact`. */
export const AssetSlotSchema = z
  .enum(['logoLight', 'logoDark', 'compact'])
  .meta({ id: 'AssetSlot' });

/** `POST /api/v1/branding/assets?slot=...`: exactly one parameter, refused when repeated or unknown. */
export const UploadAssetQuerySchema = z
  .strictObject({ slot: AssetSlotSchema })
  .meta({ id: 'UploadAssetQuery' });

/**
 * What the sanitiser dropped from an SVG (contract section 6, FR-A-087). One list, used by the
 * sanitiser that reports them and by the web page that explains them in plain words.
 */
export const SVG_CONTENT_CATEGORIES = [
  'script',
  'event_handler',
  'external_reference',
  'foreign_object',
  'style',
  'animation',
  'filter',
  'unknown_element',
  'unknown_attribute',
  'processing_instruction',
  'unresolved_reference',
] as const;

export const SvgContentCategorySchema = z
  .enum(SVG_CONTENT_CATEGORIES)
  .meta({ id: 'SvgContentCategory' });

/** An SVG was accepted but parts of it were dropped; the categories say what kind of part. */
export const SvgContentRemovedWarningSchema = z
  .strictObject({
    code: z.literal('svg_content_removed'),
    categories: z
      .array(SvgContentCategorySchema)
      .min(1)
      .max(SVG_CONTENT_CATEGORIES.length)
      .refine((categories) => new Set(categories).size === categories.length, {
        error: 'categories_not_unique',
      }),
  })
  .meta({ id: 'SvgContentRemovedWarning' });

/** An animated image was accepted and reduced to its first frame (FR-A-086). */
export const AnimationFlattenedWarningSchema = z
  .strictObject({ code: z.literal('animation_flattened') })
  .meta({ id: 'AnimationFlattenedWarning' });

/** A warning on a successful upload; the problem codes of a failed one are in `problem.ts`. */
export const UploadWarningSchema = z
  .discriminatedUnion('code', [SvgContentRemovedWarningSchema, AnimationFlattenedWarningSchema])
  .meta({ id: 'UploadWarning' });

/**
 * A processed image waiting to be applied: the members of an `AssetRef`, its size in bytes, and
 * whether these bytes were new (`created: true`, HTTP 201) or had been staged before (HTTP 200).
 */
export const StagedAssetSchema = z
  .strictObject({
    ...assetRefFields,
    bytes: z.int().min(1).max(LIMITS.body.logoFileBytes),
    created: z.boolean(),
  })
  .refine(urlMatchesHash, { error: 'asset_url_mismatch', path: ['url'] })
  .meta({ id: 'StagedAsset' });

/** `201` or `200` of `POST /api/v1/branding/assets`. At most one warning of each kind. */
export const UploadAssetResponseSchema = z
  .strictObject({
    asset: StagedAssetSchema,
    warnings: z.array(UploadWarningSchema).max(2),
  })
  .meta({ id: 'UploadAssetResponse' });

export type AssetSlot = z.infer<typeof AssetSlotSchema>;
export type UploadAssetQuery = z.infer<typeof UploadAssetQuerySchema>;
export type SvgContentCategory = z.infer<typeof SvgContentCategorySchema>;
export type UploadWarning = z.infer<typeof UploadWarningSchema>;
export type StagedAsset = z.infer<typeof StagedAssetSchema>;
export type UploadAssetResponse = z.infer<typeof UploadAssetResponseSchema>;

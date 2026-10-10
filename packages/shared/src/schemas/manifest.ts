// The web manifest (contract section 5, R13, FR-A-094, C10): `GET /manifest.webmanifest`, generated from
// the branding. The organisation name is serialised as JSON data, never concatenated into text, so a
// hostile name is only ever a string value here. Same rules as `schemas/branding.ts`: Zod only, no
// transform, `.meta({ id })`; strict, so the server cannot add a member this schema does not know.
import { z } from 'zod';
import { shortOrgName } from '../branding/org-name.js';
import { OrgNameSchema } from './branding.js';
import { HexColorSchema } from './common.js';

/** An icon of the manifest: a branding file, 192 or 512 pixels, and maybe maskable. */
export const ManifestIconSchema = z
  .strictObject({
    src: z.string().regex(/^\/branding\/[0-9a-f]{64}\.png$/),
    sizes: z.enum(['192x192', '512x512']),
    type: z.literal('image/png'),
    purpose: z.enum(['any', 'maskable']).optional(),
  })
  .meta({ id: 'ManifestIcon' });

/**
 * `name` is the organisation name, `short_name` its first 12 grapheme clusters (cut by the shared
 * `shortOrgName`; a longer text is refused), `theme_color` the effective light accent,
 * `background_color` the light page surface, and `start_url`, `scope` and `id` are `/`. Three icons at
 * most: 192, 512 and the maskable 512. In degraded mode (storage unusable) the manifest has the default
 * name and no icons.
 */
export const WebManifestSchema = z
  .strictObject({
    id: z.literal('/'),
    name: OrgNameSchema,
    short_name: z
      .string()
      .min(1)
      .max(256)
      .refine((value) => shortOrgName(value) === value, { error: 'short_name_invalid' }),
    start_url: z.literal('/'),
    scope: z.literal('/'),
    display: z.literal('standalone'),
    theme_color: HexColorSchema,
    background_color: HexColorSchema,
    icons: z.array(ManifestIconSchema).max(3),
  })
  .meta({ id: 'WebManifest' });

export type ManifestIcon = z.infer<typeof ManifestIconSchema>;
export type WebManifest = z.infer<typeof WebManifestSchema>;

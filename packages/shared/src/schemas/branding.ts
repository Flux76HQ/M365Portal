// Branding wire schemas (contract sections 4 and 8.1, FR-A-080, FR-A-081, FR-A-082, FR-A-083, FR-A-092,
// C10): what `GET /api/v1/branding` returns, what `PUT /api/v1/branding` takes, and the `If-Match`
// header. The server routes, the OpenAPI document and the web app share them, so they cannot disagree.
//
// Rules of this folder: Zod only, no transform (a transform cannot be written in OpenAPI), every
// schema has `.meta({ id })` and the id is the constant name without the `Schema` suffix. Parsing a
// valid value returns it unchanged; normalising what a person typed is the job of `normalizeOrgName`
// and `normalizeAccent` in the service. Cross-field rules (`refine`) state what the data model's CHECK
// constraints and the code that fills a response already guarantee, so a server that breaks one fails
// loudly here.
//
// This module is imported lazily by the web app (the Appearance route chunk) and by the OpenAPI
// document. It therefore imports only Zod, its sibling schemas, the organisation-name module and the
// limits: never the glyph table, the accent derivation or the tokens (`shared/schemas-branding.test.ts`
// checks the imports).
import { z } from 'zod';
import { isDefaultName as isDefaultOrgName, tryNormalizeOrgName } from '../branding/org-name.js';
import {
  AccentInputSchema,
  HexColorSchema,
  IsoTimestampSchema,
  Sha256HexSchema,
} from './common.js';

// ---------------------------------------------------------------------------------------------
// The organisation name
// ---------------------------------------------------------------------------------------------

/**
 * What a person types as an organisation name: anything `normalizeOrgName` accepts (FR-A-081). The
 * schema returns the text unchanged; storing it NFC-normalised, trimmed and with collapsed whitespace
 * is the job of the normaliser. Every failure has the message code `org_name_invalid`, which the
 * server promotes to the problem code.
 */
export const OrgNameInputSchema = z
  .string({ error: 'org_name_invalid' })
  .refine((value) => tryNormalizeOrgName(value) !== null, { error: 'org_name_invalid' })
  .meta({ id: 'OrgNameInput' });

/** An organisation name as it is stored and returned: the normaliser leaves it as it is. */
export const OrgNameSchema = z
  .string({ error: 'org_name_invalid' })
  .refine((value) => tryNormalizeOrgName(value) === value, { error: 'org_name_invalid' })
  .meta({ id: 'OrgName' });

// ---------------------------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------------------------

/** The derived colours of one theme (C9, `AccentTokenSet` of `branding/accent.ts`), lower-case `#rrggbb`. */
export const AccentTokenSetSchema = z
  .strictObject({
    accent: HexColorSchema,
    accentHover: HexColorSchema,
    accentActive: HexColorSchema,
    accentSubtle: HexColorSchema,
    onAccent: HexColorSchema,
    accentText: HexColorSchema,
    focusRing: HexColorSchema,
    /** True when `accent` differs from the colour that was chosen (the UI then says why). */
    adjusted: z.boolean(),
  })
  .meta({ id: 'AccentTokenSet' });

export const ThemeTokensSchema = z
  .strictObject({
    light: AccentTokenSetSchema,
    dark: AccentTokenSetSchema,
  })
  .meta({ id: 'ThemeTokens' });

// ---------------------------------------------------------------------------------------------
// Assets and icons
// ---------------------------------------------------------------------------------------------

/** The URL a branding file is served at: `/branding/<hash>.png` (R12). The one spelling of it. */
export function brandingAssetUrl(hash: string): string {
  return `/branding/${hash}.png`;
}

/** The rule of `AssetRef` and `IconRef`: the url is the one of the hash, nothing else. */
export function urlMatchesHash(reference: {
  readonly hash: string;
  readonly url: string;
}): boolean {
  return reference.url === brandingAssetUrl(reference.hash);
}

const urlRule = { error: 'asset_url_mismatch', path: ['url'] };

const DIMENSION = z.int().min(1).max(1024);

/** The members of a processed image; `StagedAsset` (`schemas/assets.ts`) adds to them. */
export const assetRefFields = {
  hash: Sha256HexSchema,
  url: z.string(),
  width: DIMENSION,
  height: DIMENSION,
  /** Alpha-weighted mean relative luminance, 0 to 1; null when unknown (data-model 4.2). */
  luminance: z.number().min(0).max(1).nullable(),
};

/** A logo as the API shows it (R6): its hash, where to fetch it, its size and its luminance. */
export const AssetRefSchema = z
  .strictObject(assetRefFields)
  .refine(urlMatchesHash, urlRule)
  .meta({ id: 'AssetRef' });

/** An icon as the API shows it: its hash and where to fetch it (its size is the name of its slot). */
export const IconRefSchema = z
  .strictObject({ hash: Sha256HexSchema, url: z.string() })
  .refine(urlMatchesHash, urlRule)
  .meta({ id: 'IconRef' });

export const IconSetSchema = z
  .strictObject({
    favicon32: IconRefSchema,
    appleTouch180: IconRefSchema,
    pwa192: IconRefSchema,
    pwa512: IconRefSchema,
    maskable512: IconRefSchema,
  })
  .meta({ id: 'IconSet' });

// ---------------------------------------------------------------------------------------------
// The monogram
// ---------------------------------------------------------------------------------------------

/** The key of the pictogram among the keys of the glyph table (`A` to `Z`, `0` to `9`). */
const PICTOGRAM_KEY = 'pictogram';

/**
 * One drawn glyph of the monogram (`MonogramGlyph` of `branding/monogram.ts`): its key in the glyph
 * table, its horizontal offset and advance in glyph units, and its path data. The path is restricted to
 * the subset of commands the table uses, so it can go into a `d` attribute and nowhere else.
 */
export const MonogramGlyphSchema = z
  .strictObject({
    key: z.string().regex(/^(?:[A-Z0-9]|pictogram)$/),
    x: z.int().min(0).max(4096),
    advance: z.int().min(1).max(4096),
    path: z
      .string()
      .max(2048)
      .regex(/^M[Mhvlqz0-9 -]*z$/),
  })
  .meta({ id: 'MonogramGlyph' });

/**
 * The monogram of the saved name (FR-A-092): its initials, whether the pictogram is drawn, and the
 * glyphs. The glyphs are laid out left to right, each at the sum of the advances before it.
 */
export const MonogramSchema = z
  .strictObject({
    /** What `deriveInitials` returned: at most two grapheme clusters, accents kept, maybe empty. */
    initials: z.string().max(256),
    fallback: z.boolean(),
    glyphs: z.array(MonogramGlyphSchema).min(1).max(2),
  })
  .refine(
    ({ fallback, glyphs }) => {
      const pictogram = glyphs.some((glyph) => glyph.key === PICTOGRAM_KEY);
      return fallback ? glyphs.length === 1 && pictogram : !pictogram;
    },
    { error: 'monogram_fallback_mismatch', path: ['fallback'] },
  )
  .refine(
    ({ glyphs }) => {
      let offset = 0;
      for (const glyph of glyphs) {
        if (glyph.x !== offset) return false;
        offset += glyph.advance;
      }
      return true;
    },
    { error: 'monogram_layout_invalid', path: ['glyphs'] },
  )
  .meta({ id: 'Monogram' });

// ---------------------------------------------------------------------------------------------
// The branding (R6) and its replacement (R8)
// ---------------------------------------------------------------------------------------------

/**
 * `GET /api/v1/branding` and every response that carries the branding. No actor identity is part of
 * it (the table keeps `updated_by_*`, the API does not show it), and a member that is not listed is
 * refused, so adding one is a change of this schema.
 */
export const BrandingSchema = z
  .strictObject({
    /** The revision counter of the single branding row; also the ETag (`"<revision>"`). */
    revision: z.int().min(1),
    orgName: OrgNameSchema,
    /** Derived from the name (it is `M365Portal`), never stored. */
    isDefaultName: z.boolean(),
    /** The accent as chosen, lower-case `#rrggbb`; the effective colours are in `tokens`. */
    accent: HexColorSchema,
    tokens: ThemeTokensSchema,
    logos: z.strictObject({
      light: AssetRefSchema.nullable(),
      dark: AssetRefSchema.nullable(),
      compact: AssetRefSchema.nullable(),
    }),
    /** True when the compact logo was fitted from another logo instead of uploaded. */
    compactDerived: z.boolean(),
    icons: IconSetSchema,
    monogram: MonogramSchema,
    updatedAt: IsoTimestampSchema,
  })
  .refine(({ orgName, isDefaultName }) => isDefaultName === isDefaultOrgName(orgName), {
    error: 'default_name_flag_mismatch',
    path: ['isDefaultName'],
  })
  .refine(({ compactDerived, logos }) => !compactDerived || logos.compact !== null, {
    error: 'compact_derived_without_compact',
    path: ['compactDerived'],
  })
  .meta({ id: 'Branding' });

/**
 * `PUT /api/v1/branding`: the whole branding (replacement semantics, `If-Match` required). The logos
 * are the hashes of staged or applied assets; `null` means no logo in that slot. The values are
 * validated, not normalised: the service normalises name and accent with the shared normalisers.
 */
export const ApplyBrandingRequestSchema = z
  .strictObject({
    orgName: OrgNameInputSchema,
    accent: AccentInputSchema,
    logos: z.strictObject({
      light: Sha256HexSchema.nullable(),
      dark: Sha256HexSchema.nullable(),
      compact: Sha256HexSchema.nullable(),
    }),
  })
  .meta({ id: 'ApplyBrandingRequest' });

// ---------------------------------------------------------------------------------------------
// If-Match
// ---------------------------------------------------------------------------------------------

/**
 * The `If-Match` header of `PUT`, `DELETE` and a non-dry-run import: a strong validator that is a
 * quoted integer, such as `"3"`. A weak validator, an unquoted number, a list, `*`, leading zeros and
 * anything over 15 digits are malformed (422 `validation_failed`, pointer `header/If-Match`); a
 * well-formed tag that is not the current revision is stale (412 `branding_conflict`).
 */
export const IfMatchHeaderSchema = z
  .string()
  .regex(/^"(?:0|[1-9]\d{0,14})"$/)
  .meta({ id: 'IfMatchHeader' });

/** The ETag of a revision, and the `If-Match` a client sends back: `"3"`. */
export function revisionEtag(revision: number): string {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new RangeError('a revision is a non-negative safe integer');
  }
  return `"${String(revision)}"`;
}

/** The revision in an `If-Match` or `ETag` value of the form `"3"`, or null when it is malformed. */
export function parseRevisionEtag(value: string): number | null {
  const parsed = IfMatchHeaderSchema.safeParse(value);
  return parsed.success ? Number(parsed.data.slice(1, -1)) : null;
}

// ---------------------------------------------------------------------------------------------
// Types (the name without the suffix, contract section 8)
// ---------------------------------------------------------------------------------------------

export type OrgNameInput = z.infer<typeof OrgNameInputSchema>;
export type AccentTokenSet = z.infer<typeof AccentTokenSetSchema>;
export type ThemeTokens = z.infer<typeof ThemeTokensSchema>;
export type AssetRef = z.infer<typeof AssetRefSchema>;
export type IconRef = z.infer<typeof IconRefSchema>;
export type IconSet = z.infer<typeof IconSetSchema>;
export type MonogramGlyph = z.infer<typeof MonogramGlyphSchema>;
export type Monogram = z.infer<typeof MonogramSchema>;
export type Branding = z.infer<typeof BrandingSchema>;
export type ApplyBrandingRequest = z.infer<typeof ApplyBrandingRequestSchema>;

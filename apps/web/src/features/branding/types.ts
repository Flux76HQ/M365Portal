// The types of the branding feature (T-A-210). They are the shared wire types, re-exported under the names
// the feature uses; nothing here is a value, so importing this module never pulls a Zod schema in.
import type {
  AccentTokenSet,
  ApplyBrandingRequest,
  AssetRef,
  Branding,
} from '@m365portal/shared/schemas/branding';
import type {
  AssetSlot,
  StagedAsset,
  SvgContentCategory,
  UploadAssetResponse,
  UploadWarning,
} from '@m365portal/shared/schemas/assets';
import type { ImportResult, ImportedImageSummary } from '@m365portal/shared/schemas/export-import';

export type {
  AccentTokenSet,
  ApplyBrandingRequest,
  AssetRef,
  AssetSlot,
  Branding,
  ImportResult,
  ImportedImageSummary,
  StagedAsset,
  SvgContentCategory,
  UploadAssetResponse,
  UploadWarning,
};

/** The three places a logo can go on the page, named as the form says them. */
export type LogoVariant = 'light' | 'dark' | 'compact';

/** The slot the upload route knows for each variant. */
export const SLOT_OF_VARIANT: Readonly<Record<LogoVariant, AssetSlot>> = Object.freeze({
  light: 'logoLight',
  dark: 'logoDark',
  compact: 'compact',
});

/** The variants in the order the page shows them. */
export const LOGO_VARIANTS: readonly LogoVariant[] = Object.freeze(['light', 'dark', 'compact']);

/** What `PUT /api/v1/branding` takes, and the revision it was loaded at (for `If-Match`). */
export interface ApplyVariables {
  readonly request: ApplyBrandingRequest;
  readonly revision: number;
}

export interface ResetVariables {
  readonly revision: number;
}

export interface StageVariables {
  readonly slot: AssetSlot;
  readonly file: Blob;
  readonly signal?: AbortSignal;
}

/**
 * An import: the text of the file as it was read (the server parses it, so duplicate keys are seen), and
 * whether to only check it. A real import needs the revision the page was loaded at.
 */
export interface ImportVariables {
  readonly text: string;
  readonly dryRun: boolean;
  readonly revision?: number;
}

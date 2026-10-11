// What a fresh installation looks like (T-A-085; FR-A-081, PD-12): the organisation name
// "M365Portal", the default accent, no logos, monogram icons.
//
// Two users. The service creates the first branding row from `DEFAULT_BRANDING` through the same
// code path as any apply, and `reset` applies it again. The manifest and the shell use
// `degradedBranding()` when storage is unusable (FR-A-013): everything in it is computed from the
// constants, in memory, with no icon (there is no file to point at).
import { deriveAccentTokens } from '@m365portal/shared/branding/accent';
import { monogramFor } from '@m365portal/shared/branding/monogram';
import { DEFAULT_ORG_NAME, isDefaultName } from '@m365portal/shared/branding/org-name';
import type { Branding } from '@m365portal/shared/schemas/branding';
import { DEFAULT_ACCENT } from '@m365portal/shared/tokens';

/** The hashes of the logos in the three slots, or `null` for no logo. */
export interface LogoHashes {
  readonly light: string | null;
  readonly dark: string | null;
  readonly compact: string | null;
}

/** What a branding is made of: what an administrator chooses. */
export interface BrandingChoice {
  readonly orgName: string;
  readonly accent: string;
  readonly logos: LogoHashes;
}

export const NO_LOGOS: LogoHashes = Object.freeze({ light: null, dark: null, compact: null });

/** The branding of a fresh installation and of a reset. */
export const DEFAULT_BRANDING: BrandingChoice = Object.freeze({
  orgName: DEFAULT_ORG_NAME,
  accent: DEFAULT_ACCENT,
  logos: NO_LOGOS,
});

/** The actor of changes nobody asked for: the first branding row. */
export const SYSTEM_ACTOR = Object.freeze({ kind: 'system', id: 'system' } as const);

/** The branding the server shows without a database: no icons, no logos, revision 0. */
export type DegradedBranding = Pick<
  Branding,
  'orgName' | 'isDefaultName' | 'accent' | 'tokens' | 'monogram'
> & { readonly revision: 0 };

export function degradedBranding(): DegradedBranding {
  const monogram = monogramFor(DEFAULT_BRANDING.orgName);
  return {
    revision: 0,
    orgName: DEFAULT_BRANDING.orgName,
    isDefaultName: isDefaultName(DEFAULT_BRANDING.orgName),
    accent: DEFAULT_BRANDING.accent,
    tokens: deriveAccentTokens(DEFAULT_BRANDING.accent),
    monogram: { ...monogram, glyphs: [...monogram.glyphs] },
  };
}

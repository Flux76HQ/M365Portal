// The values of the Appearance form and the rules they are checked against (T-A-214; FR-A-132).
//
// The rules are the shared ones, not copies: the organisation name goes through `tryNormalizeOrgName`
// and the accent through `tryNormalizeAccent`, the two functions the server uses to judge the same
// input. An issue carries the problem CODE the server would answer with (`org_name_invalid`,
// `accent_invalid`) as its message, and the form translates it with the catalogue entry of that code,
// so the same words appear whether the browser or the server noticed first. Saving is never blocked
// for a colour that is merely hard to read: the accent is adjusted, not refused.
import { z } from 'zod';
import type { BrandingTools } from './tools';
import type { ApplyBrandingRequest, AssetRef, Branding, ImportResult, LogoVariant } from './types';

export interface AppearanceValues {
  /** The name as typed. */
  orgName: string;
  /** The accent as typed (`#rgb` or `#rrggbb`, any case). */
  accent: string;
  /** The processed logo of each slot, or null. */
  logos: Record<LogoVariant, AssetRef | null>;
}

export const ORG_NAME_ISSUE = 'org_name_invalid';
export const ACCENT_ISSUE = 'accent_invalid';

const AssetRefShape = z.custom<AssetRef>(
  (value) => typeof value === 'object' && value !== null && 'hash' in value,
);

/** The schema the form validates with. `tools` are the lazily loaded shared normalisers. */
export function createAppearanceSchema(tools: BrandingTools) {
  // The judges are the shared normalisers; these only ask them whether they accept the text.
  const nameIsAccepted = (text: string): boolean =>
    tools.orgName.tryNormalizeOrgName(text) !== null;
  const colourIsAccepted = (text: string): boolean =>
    tools.accent.tryNormalizeAccent(text) !== null;
  return z.object({
    orgName: z.string().refine(nameIsAccepted, { error: ORG_NAME_ISSUE }),
    accent: z.string().refine(colourIsAccepted, { error: ACCENT_ISSUE }),
    logos: z.object({
      light: AssetRefShape.nullable(),
      dark: AssetRefShape.nullable(),
      compact: AssetRefShape.nullable(),
    }),
  });
}

/** The form values for a saved branding. */
export function valuesOf(branding: Branding): AppearanceValues {
  return {
    orgName: branding.orgName,
    accent: branding.accent,
    logos: {
      light: branding.logos.light,
      dark: branding.logos.dark,
      compact: branding.logos.compact,
    },
  };
}

/**
 * What `PUT /api/v1/branding` takes for these values. A compact logo the server made itself and the
 * person did not touch is sent as `null`, so the server derives it again from the main logo.
 */
export function requestOf(values: AppearanceValues, compactDerived: boolean): ApplyBrandingRequest {
  return {
    orgName: values.orgName,
    accent: values.accent,
    logos: {
      light: values.logos.light?.hash ?? null,
      dark: values.logos.dark?.hash ?? null,
      compact: compactDerived ? null : (values.logos.compact?.hash ?? null),
    },
  };
}

/** The request that puts a saved branding back (Undo). */
export function requestOfBranding(branding: Branding): ApplyBrandingRequest {
  return requestOf(valuesOf(branding), branding.compactDerived);
}

/** Does the form differ from what is saved? Names and colours compare in their normalised form. */
export function isDirty(
  values: AppearanceValues,
  saved: Branding,
  compactDerived: boolean,
  tools: BrandingTools,
): boolean {
  const name = tools.orgName.tryNormalizeOrgName(values.orgName) ?? values.orgName;
  const accent = tools.accent.tryNormalizeAccent(values.accent) ?? values.accent;
  const hashOf = (asset: AssetRef | null): string | null => asset?.hash ?? null;
  return (
    name !== saved.orgName ||
    accent !== saved.accent ||
    hashOf(values.logos.light) !== hashOf(saved.logos.light) ||
    hashOf(values.logos.dark) !== hashOf(saved.logos.dark) ||
    // A compact logo the server derived counts as unchanged until the person picks their own.
    (!(compactDerived && saved.compactDerived) &&
      hashOf(values.logos.compact) !== hashOf(saved.logos.compact))
  );
}

/** The branding an applied import produced, if the result carries one. */
export function appliedBranding(result: ImportResult): Branding | null {
  return result.applied ? result.branding : null;
}

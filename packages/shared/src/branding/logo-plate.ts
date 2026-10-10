// The logo plate rule (A-39, PD-11, E-05, brief 5a "automatic display"). The ONE home of the rule
// (FR-A-008): the sidebar tile, the header and the icon composer on the server all ask `logoPlateFor`
// or `iconPlateFor`, so they cannot disagree about when a logo needs a plate.
//
// A logo is shown unchanged. It is never recoloured or inverted: the only thing that may happen is
// that it sits on a plate, a light or a dark neutral rectangle, when its colour would make it
// illegible on the sidebar of the current theme. Which logo is "illegible" is decided from one number
// that is measured once per asset and stored with it (data-model 4.2): the alpha-weighted mean
// relative luminance of the visible pixels, from 0 (black) to 1 (white).
//
// The rule, and where its numbers come from (the brief gives none; these are this task's choice and
// go to docs/open-points.md through the gate note):
//
//   - The logo needs a plate when its luminance has less than 3:1 WCAG contrast with the sidebar
//     surface of the theme. 3:1 is the bound of WCAG 1.4.11 (non-text contrast), the lowest ratio the
//     standard accepts for a graphic that carries information. A logotype is formally exempt from
//     1.4.11, but below 3:1 most of the logo disappears into the sidebar, so it is the right line
//     for "illegible". The surface is the sidebar of `SURFACES` in the token module (where the logo
//     is shown), so a change of that surface moves the thresholds with it.
//   - With the surfaces of plan 10.2 that means:
//       on the dark theme a logo with a luminance below 0.113 gets a light plate;
//       on the light theme a logo with a luminance above 0.248 gets a dark plate;
//     every other logo gets none, among them every logo as light as the dark sidebar or as dark as
//     the light one. A mid grey of luminance 0.181 (where black and white text read equally well) is
//     legible on both themes, so a mid-tone logo never gets a plate.
//   - The plate is the one that contrasts better with the logo: the light plate is the raised surface
//     of the light theme (white), the dark plate the raised surface of the dark theme. Both come from
//     the token module, so there is no colour in this file.
//   - A luminance that is not known (null, undefined, NaN, outside 0 to 1, not a number) gets no
//     plate on screen: showing a logo as it is beats guessing. An icon always has a plate (PD-11), and
//     with an unknown luminance it is the light one.
//
// Limit of the method: a mean is a proxy. A logo that is half white and half black has a middle
// luminance and gets no plate although one half may vanish. The mean is what the data model stores;
// a per-asset minimum and maximum would be a data model change (open point).
//
// Platform-neutral and pure: no clock, no I/O, no randomness, no work at import time.
import { SURFACES, type Theme } from '../tokens/colours.js';
import {
  WCAG_NON_TEXT_CONTRAST,
  contrastRatioOfLuminances,
  relativeLuminance,
} from './contrast.js';

/** What a logo sits on: nothing, a light plate or a dark plate. */
export type LogoPlate = 'none' | 'light' | 'dark';

/** The contrast below which a logo is plated: WCAG 1.4.11, see the header. */
export const LOGO_PLATE_MIN_CONTRAST = WCAG_NON_TEXT_CONTRAST;

/** A luminance is known when it is a number from 0 to 1 (this is false for NaN as well). */
function isKnownLuminance(value: unknown): value is number {
  return typeof value === 'number' && value >= 0 && value <= 1;
}

/** The colour (`#rrggbb`) of a plate: a surface of the token module, never a colour of this file. */
export function logoPlateColour(plate: 'light' | 'dark'): string {
  return plate === 'light' ? SURFACES.light.raised : SURFACES.dark.raised;
}

/**
 * The plate an icon sits on: always one (PD-11). The one that contrasts better with a logo of this
 * luminance, the light one for a dark logo and the dark one for a light logo; the light one when the
 * luminance is not known.
 */
export function iconPlateFor(luminance: number | null | undefined): 'light' | 'dark' {
  if (!isKnownLuminance(luminance)) return 'light';
  const onLight = contrastRatioOfLuminances(luminance, relativeLuminance(logoPlateColour('light')));
  const onDark = contrastRatioOfLuminances(luminance, relativeLuminance(logoPlateColour('dark')));
  return onLight >= onDark ? 'light' : 'dark';
}

/**
 * The plate a logo needs on the sidebar of `theme`: `none` when it has at least 3:1 contrast with the
 * sidebar (or its luminance is unknown), otherwise the plate that contrasts with it. A pure function
 * of the two arguments: the same logo gets the same plate on every screen and on every request.
 */
export function logoPlateFor(luminance: number | null | undefined, theme: Theme): LogoPlate {
  if (!isKnownLuminance(luminance)) return 'none';
  const sidebar = relativeLuminance(SURFACES[theme].sidebar);
  if (contrastRatioOfLuminances(luminance, sidebar) >= LOGO_PLATE_MIN_CONTRAST) return 'none';
  return iconPlateFor(luminance);
}

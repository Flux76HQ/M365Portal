// Shadow recipes (plan 10.3): soft, Apple-like. A recipe is data; css.ts turns it into a
// `box-shadow` value with the ink colours of colours.ts, so this file holds no colour.
//
// Light mode lifts a surface with a shadow. Dark mode uses black at a higher alpha and a 1 px
// inner border instead of a lift, because a shadow on a near-black page cannot be seen.
import type { InkName, Theme } from './colours.js';

export interface ShadowLayer {
  readonly x: number;
  readonly y: number;
  readonly blur: number;
  readonly spread: number;
  readonly ink: InkName;
  readonly alpha: number;
  readonly inset: boolean;
}

export const SHADOW_LEVELS = Object.freeze([1, 2, 3] as const);
export type ShadowLevel = (typeof SHADOW_LEVELS)[number];

function layer(
  y: number,
  blur: number,
  alpha: number,
  spread = 0,
  ink: InkName = 'shadow',
  inset = false,
): ShadowLayer {
  return Object.freeze({ x: 0, y, blur, spread, ink, alpha, inset });
}

/** The 1 px inner border that replaces the lift in dark mode. */
const DARK_BORDER = layer(0, 0, 0.07, 1, 'highlight', true);

export const SHADOWS: Readonly<
  Record<Theme, Readonly<Record<ShadowLevel, readonly ShadowLayer[]>>>
> = Object.freeze({
  light: Object.freeze({
    1: Object.freeze([layer(1, 2, 0.06), layer(1, 3, 0.08)]),
    2: Object.freeze([layer(4, 12, 0.08)]),
    3: Object.freeze([layer(12, 32, 0.12)]),
  }),
  dark: Object.freeze({
    1: Object.freeze([layer(1, 2, 0.3), layer(1, 3, 0.36), DARK_BORDER]),
    2: Object.freeze([layer(4, 12, 0.4), DARK_BORDER]),
    3: Object.freeze([layer(12, 32, 0.5), DARK_BORDER]),
  }),
});

// Type tokens (plan 10.3). The face is Inter variable, self-hosted (FR-A-123); the fallback face is a
// size-adjusted system font declared in fonts.css so the swap causes no layout shift.

/** Family names; the @font-face rules that define them live in apps/web/src/styles/fonts.css. */
export const FONT_FAMILIES = Object.freeze({
  inter: 'Inter Variable',
  interFallback: 'Inter Fallback',
} as const);

/** The sans stack: Inter, its size-adjusted fallback, then whatever the system offers. */
export const FONT_STACK_SANS = `"${FONT_FAMILIES.inter}", "${FONT_FAMILIES.interFallback}", system-ui, sans-serif`;

export interface TypeStyle {
  readonly sizePx: number;
  readonly lineHeightPx: number;
}

export const TYPE_SCALE = Object.freeze({
  caption: Object.freeze({ sizePx: 12, lineHeightPx: 16 }),
  'body-sm': Object.freeze({ sizePx: 13, lineHeightPx: 20 }),
  body: Object.freeze({ sizePx: 14, lineHeightPx: 20 }),
  'body-lg': Object.freeze({ sizePx: 16, lineHeightPx: 24 }),
  subtitle: Object.freeze({ sizePx: 18, lineHeightPx: 24 }),
  'title-3': Object.freeze({ sizePx: 20, lineHeightPx: 28 }),
  'title-2': Object.freeze({ sizePx: 24, lineHeightPx: 32 }),
  'title-1': Object.freeze({ sizePx: 28, lineHeightPx: 36 }),
  display: Object.freeze({ sizePx: 32, lineHeightPx: 40 }),
} as const satisfies Record<string, TypeStyle>);

export type TypeStyleName = keyof typeof TYPE_SCALE;

export const FONT_WEIGHTS = Object.freeze({ regular: 400, medium: 500, semibold: 600 } as const);

/** Tracking is -0.01 em from this size up. */
export const TRACKING_FROM_PX = 20;
export const TRACKING_TIGHT = '-0.01em';

/** The letter spacing of a size: tight from 20 px up, none below. */
export function trackingFor(sizePx: number): string {
  return sizePx >= TRACKING_FROM_PX ? TRACKING_TIGHT : '0em';
}

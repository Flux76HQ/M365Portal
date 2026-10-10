// Spacing and size tokens (plan 10.3). Values are pixels on a 4 px grid; CSS gets them as rem so
// they follow the reader's text size (WCAG 1.4.4).

export const SPACING_UNIT_PX = 4;

/** Step name (Tailwind's 0.25 rem step) to pixels. Every value is a multiple of 4. */
export const SPACING_PX = Object.freeze({
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
  12: 48,
  16: 64,
} as const);

/** The root font size the rem conversion assumes (the browser default). */
export const ROOT_FONT_SIZE_PX = 16;

/** `14` becomes `0.875rem`. */
export function pxToRem(px: number): string {
  if (!Number.isFinite(px) || px < 0) throw new RangeError(`not a size in pixels: ${String(px)}`);
  return `${String(Number((px / ROOT_FONT_SIZE_PX).toFixed(4)))}rem`;
}

/** Control height: 32 px, 40 px on coarse pointers (touch). */
export const CONTROL_HEIGHT_PX = Object.freeze({ default: 32, coarse: 40 } as const);

/** Table row heights: compact and comfortable. */
export const TABLE_ROW_HEIGHT_PX = Object.freeze({ compact: 40, comfortable: 48 } as const);

/** Every interactive target is at least this wide and high (WCAG 2.5.8). */
export const MIN_TARGET_PX = 24;

/** Breakpoints; 768 is where the sidebar becomes a drawer, 1024 where the details panel docks. */
export const BREAKPOINTS_PX = Object.freeze({
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
  '2xl': 1536,
} as const);

/** Content cap. */
export const CONTENT_MAX_PX = 1600;

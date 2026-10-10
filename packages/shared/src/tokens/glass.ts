// Glass tokens (plan 10.3): the translucent layers of the shell. Text never sits on glass below an
// alpha of 0.92, so the contrast figures of the opaque surfaces (FR-A-101) still hold. The CSS in
// apps/web/src/styles falls back to the opaque surface under forced-colors, prefers-reduced-
// transparency and without backdrop-filter support.
import type { SurfaceName } from './colours.js';

/** The lowest alpha of a layer that carries text. */
export const MIN_TEXT_GLASS_ALPHA = 0.92;

export interface GlassLayer {
  /** The opaque surface the glass is made of. */
  readonly surface: SurfaceName;
  readonly alpha: number;
  readonly blurPx: number;
}

export const GLASS = Object.freeze({
  header: Object.freeze({ surface: 'page', alpha: 0.92, blurPx: 12 } satisfies GlassLayer),
  sidebar: Object.freeze({ surface: 'sidebar', alpha: 0.92, blurPx: 12 } satisfies GlassLayer),
  /** Black at 32 % behind a dialog; carries no text. */
  scrim: Object.freeze({ alpha: 0.32, blurPx: 8 }),
});

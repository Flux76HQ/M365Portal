// Focus ring geometry (plan 10.3, FR-A-152). The ring is drawn on :focus-visible only, as an outline
// of this width and offset in the `focus-ring` colour (derived from the accent, at least 3:1 on every
// surface); under forced-colors it uses the system colour Highlight. `outline: none` is never used
// without a replacement.

export const FOCUS = Object.freeze({ widthPx: 2, offsetPx: 2, style: 'solid' } as const);

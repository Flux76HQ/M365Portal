// The monogram: initials to glyphs (FR-A-092, A-40, E-13). The ONE home of the mapping (FR-A-008): the
// UI tile, the favicon, the apple-touch icon and the PWA icons all draw the glyphs this module returns,
// from the paths of the generated table, so the tile and the icons always agree. No system font is
// involved anywhere: distroless has none (probe P22).
//
// `monogramGlyphs(initials)` guarantees A to Z and 0 to 9. A cluster is drawn as a Latin letter or a
// digit when it is one after NFD, with the combining marks and joiners taken off (so an accented
// letter is drawn as its base letter), or when it is in the small table of letters that have no
// decomposition (O-slash, AE, OE, L-stroke, D-stroke, eth, thorn, sharp s, dotless i and the like).
// Anything else (Cyrillic, Greek, Chinese, Arabic, emoji, an underscore) cannot be drawn; when no
// cluster of the initials can, the result is one generic pictogram. When only some can, those are
// drawn (A-40 promises the guaranteed set and the pictogram; "A" followed by a Japanese company form
// is better served by an A than by a building). At most two glyphs are drawn, because the initials
// are at most two clusters (FR-A-092).
//
// Layout is part of the contract, so that no consumer lays the glyphs out differently: the glyphs are
// placed left to right in the glyph box of `glyphs.generated.ts` (1000 units from cap line to
// baseline, y down); `x` is the offset of a glyph, the sum of the advances before it, and the width of
// the whole is `x + advance` of the last glyph.
//
// Platform-neutral and pure; the results are frozen.
import { GLYPHS, GLYPH_KEYS, PICTOGRAM, type GlyphKey } from './glyphs.generated.js';
import { deriveInitials, splitGraphemes } from './initials.js';

/** The key of the pictogram among the keys of the table (`A` to `Z`, `0` to `9`). */
export const MONOGRAM_PICTOGRAM_KEY = 'pictogram';

/** The initials are at most two clusters, and so at most two glyphs are drawn. */
export const MONOGRAM_MAX_GLYPHS = 2;

export type MonogramGlyphKey = GlyphKey | typeof MONOGRAM_PICTOGRAM_KEY;

/** One drawn glyph: its table key, where it starts, how far it advances, and its path data. */
export interface MonogramGlyph {
  readonly key: MonogramGlyphKey;
  /** The horizontal offset in glyph units: the sum of the advances of the glyphs before it. */
  readonly x: number;
  readonly advance: number;
  /** Path data in the box of the glyph table (see the header of `glyphs.generated.ts`). */
  readonly path: string;
}

/** What the branding API and the shell carry for the tile: the initials and the glyphs they draw. */
export interface Monogram {
  /** What `deriveInitials` returned (at most two clusters; accents kept; possibly empty). */
  readonly initials: string;
  /** True when no initial can be drawn and the single glyph is the pictogram. */
  readonly fallback: boolean;
  readonly glyphs: readonly MonogramGlyph[];
}

/**
 * Letters that have no canonical decomposition, so NFD leaves them alone, with the letter they are
 * drawn as. Upper and lower case are both listed: the sharp s would become "SS" if upper-cased.
 */
const LATIN_WITHOUT_DECOMPOSITION: Readonly<Record<string, GlyphKey>> = {
  '\u{D8}': 'O', // O with stroke
  '\u{F8}': 'O',
  '\u{C6}': 'A', // AE
  '\u{E6}': 'A',
  '\u{152}': 'O', // OE
  '\u{153}': 'O',
  '\u{141}': 'L', // L with stroke
  '\u{142}': 'L',
  '\u{110}': 'D', // D with stroke
  '\u{111}': 'D',
  '\u{D0}': 'D', // eth
  '\u{F0}': 'D',
  '\u{DE}': 'T', // thorn
  '\u{FE}': 'T',
  '\u{DF}': 'S', // sharp s
  '\u{1E9E}': 'S', // capital sharp s
  '\u{17F}': 'S', // long s
  '\u{131}': 'I', // dotless i
  '\u{132}': 'I', // IJ
  '\u{133}': 'I',
  '\u{126}': 'H', // H with stroke
  '\u{127}': 'H',
  '\u{166}': 'T', // T with stroke
  '\u{167}': 'T',
  '\u{13F}': 'L', // L with middle dot
  '\u{140}': 'L',
  '\u{149}': 'N', // n preceded by apostrophe
  '\u{138}': 'K', // kra
};

/** Combining marks (accents, the keycap, variation selectors) and the two joiners. */
const MARKS_AND_JOINERS = /\p{M}|\u{200C}|\u{200D}/gu;

function isGlyphKey(text: string): text is GlyphKey {
  return (GLYPH_KEYS as readonly string[]).includes(text);
}

/** The glyph key a cluster is drawn as, or null when the table cannot draw it. */
function glyphKeyOf(cluster: string): GlyphKey | null {
  const base = cluster.normalize('NFD').replace(MARKS_AND_JOINERS, '');
  const mapped = LATIN_WITHOUT_DECOMPOSITION[base];
  if (mapped !== undefined) return mapped;
  const upper = base.toUpperCase();
  return isGlyphKey(upper) ? upper : null;
}

function glyphOf(key: GlyphKey, x: number): MonogramGlyph {
  const shape = GLYPHS[key];
  return Object.freeze({ key, x, advance: shape.advance, path: shape.path });
}

/**
 * The glyphs that draw these initials: one per cluster that is a Latin letter or a digit once its
 * accent is taken off (at most two), or, when there is none, the single pictogram. Always at least
 * one glyph.
 */
export function monogramGlyphs(initials: string): readonly MonogramGlyph[] {
  const keys: GlyphKey[] = [];
  for (const cluster of splitGraphemes(initials).slice(0, MONOGRAM_MAX_GLYPHS)) {
    const key = glyphKeyOf(cluster);
    if (key !== null) keys.push(key);
  }
  if (keys.length === 0) {
    return Object.freeze([
      Object.freeze({
        key: MONOGRAM_PICTOGRAM_KEY,
        x: 0,
        advance: PICTOGRAM.advance,
        path: PICTOGRAM.path,
      } satisfies MonogramGlyph),
    ]);
  }
  let x = 0;
  const glyphs = keys.map((key) => {
    const glyph = glyphOf(key, x);
    x += glyph.advance;
    return glyph;
  });
  return Object.freeze(glyphs);
}

/**
 * The monogram of a name: its initials and the glyphs that draw them. This is what the branding
 * service puts in `GET /api/v1/branding`, what the icon renderer draws and what the live preview of
 * the Appearance page computes for the name being typed.
 */
export function monogramFor(name: string): Monogram {
  const initials = deriveInitials(name);
  const glyphs = monogramGlyphs(initials);
  return Object.freeze({
    initials,
    fallback: glyphs.length === 1 && glyphs[0]?.key === MONOGRAM_PICTOGRAM_KEY,
    glyphs,
  });
}

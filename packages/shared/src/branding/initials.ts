// The initials of an organisation name (FR-A-092, E-13, A-40). The ONE home of the derivation
// (FR-A-008, baseline section 10): the UI tile, the favicon and the PWA icons all start from
// `deriveInitials`, so they cannot disagree about which letters a name stands for. `monogram.ts` turns
// the initials into glyphs.
//
// The rule, in the words of the spec: word-like segments come from `Intl.Segmenter`; one word gives
// its first grapheme, two or more give the first grapheme of the first word and the first grapheme of
// the last word; at most two. Spaces, punctuation, symbols and emoji are not word-like and are
// skipped, so "(Acme) & Sons" gives AS and a rocket in front of "Rocket" gives R. The unit is the
// grapheme cluster, so a letter with its accent and a ZWJ emoji are never cut in half.
//
// Three details the spec leaves to the implementation, each one a choice, not an accident:
//   - the initial is upper-cased, unless that would make it more than one cluster (the German sharp s
//     becomes SS, so it stays as it is);
//   - a word that starts with something that is neither a letter nor a number (an underscore, a lone
//     combining mark) gives the first cluster that is: "_Acme" gives A;
//   - a joiner left at the end of a cluster ("a" followed by a zero-width non-joiner) is dropped, and
//     the result is NFC, so "e" plus a combining acute gives the precomposed letter.
//
// Accents are kept ("Elan" gives E-acute, as E-13 says); drawing the letter without its accent is the
// business of `monogramGlyphs`. Platform-neutral and pure: no clock, no I/O, no randomness, no work at
// import time.

let graphemeSegmenter: Intl.Segmenter | undefined;
let wordSegmenter: Intl.Segmenter | undefined;

/** Built on first use: this module does no work at import time. */
function graphemes(): Intl.Segmenter {
  graphemeSegmenter ??= new Intl.Segmenter('en', { granularity: 'grapheme' });
  return graphemeSegmenter;
}

function words(): Intl.Segmenter {
  wordSegmenter ??= new Intl.Segmenter('en', { granularity: 'word' });
  return wordSegmenter;
}

/** The grapheme clusters of a text, in order. (Also used by `monogram.ts`; there is no other copy.) */
export function splitGraphemes(text: string): string[] {
  return Array.from(graphemes().segment(text), (part) => part.segment);
}

/** A cluster that starts with a letter or a number, in any script. */
const STARTS_WITH_LETTER_OR_NUMBER = /^[\p{L}\p{N}]/u;
const TRAILING_JOINERS = /(?:\u{200C}|\u{200D})+$/u;

/** The upper-case form of a cluster, or the cluster itself when its upper case is more than one. */
function upperCased(cluster: string): string {
  const upper = cluster.toUpperCase();
  return splitGraphemes(upper).length === 1 ? upper : cluster;
}

/** The initial a word-like segment stands for, or '' when it has no letter or number to start with. */
function initialOf(word: string): string {
  for (const cluster of splitGraphemes(word)) {
    if (STARTS_WITH_LETTER_OR_NUMBER.test(cluster)) {
      return upperCased(cluster).replace(TRAILING_JOINERS, '').normalize('NFC');
    }
  }
  return '';
}

/**
 * The initials of a name: at most two grapheme clusters, upper case. One word gives its first
 * cluster; two or more give the first of the first word and the first of the last word. A name with
 * no word-like segment (only symbols, only emoji, empty) gives the empty string.
 */
export function deriveInitials(name: string): string {
  let first = '';
  let last = '';
  let count = 0;
  for (const part of words().segment(name)) {
    if (part.isWordLike !== true) continue;
    const initial = initialOf(part.segment);
    if (initial === '') continue;
    if (count === 0) first = initial;
    last = initial;
    count += 1;
  }
  return count <= 1 ? first : `${first}${last}`;
}

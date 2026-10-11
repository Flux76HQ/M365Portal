// Value grammars of the SVG allowlist (T-A-080; FR-A-087; plan 8.6): what an attribute value may look
// like. Every function here is a strict, linear-time recogniser that answers yes or no (or returns the
// parsed pieces); none of them evaluates anything, and none of them lets a string through that it did
// not match completely. A value that fails is dropped by the sanitiser, never repaired.
//
// The grammars are the ones the logo use case needs and a little more: numbers and lengths, colours
// (hex, `rgb()`, `rgba()`, `hsl()`, `hsla()`, the named colours, `none`, `currentColor`), paints with
// `url(#id)` and an optional fallback, path data, transform lists, point lists, dash arrays. Anything
// else, such as `calc()`, `var()`, `env()`, CSS escapes, `image()` or a URL that is not `#id`, is not
// in a grammar and therefore refused.

/** Numbers are finite and at most this large in magnitude (plan 8.6). */
export const MAX_NUMBER_MAGNITUDE = 1_000_000;

/** Path data has at most this many segments (plan 8.6). */
export const MAX_PATH_SEGMENTS = 50_000;

/** The pattern an `id` must match (plan 8.6). */
export const ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;

const NUMBER_SOURCE = String.raw`[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?`;
const NUMBER = new RegExp(`^${NUMBER_SOURCE}$`);

/** True when the text has the syntax of a number, whatever its size. */
export function isNumberSyntax(text: string): boolean {
  return NUMBER.test(text);
}

/** A number, or null when the syntax is wrong, the value is not finite or it is larger than the limit. */
export function parseNumber(text: string): number | null {
  if (!NUMBER.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) && Math.abs(value) <= MAX_NUMBER_MAGNITUDE ? value : null;
}

const LENGTH_UNITS = ['px', 'pt', 'pc', 'mm', 'cm', 'in', '%'] as const;

/** Split a length into its number and unit text; the number is not yet checked. */
function splitUnit(text: string): { number: string; unit: string } {
  const unit = LENGTH_UNITS.find((candidate) => text.endsWith(candidate));
  return unit === undefined
    ? { number: text, unit: '' }
    : { number: text.slice(0, -unit.length), unit };
}

/** True when the text has the syntax of a length, whatever its size. */
export function isLengthSyntax(text: string): boolean {
  return NUMBER.test(splitUnit(text.trim()).number);
}

/** Pixels per unit for the absolute units (CSS: 96 pixels to the inch). */
const PIXELS_PER_UNIT: Readonly<Record<string, number>> = {
  px: 1,
  pt: 96 / 72,
  pc: 16,
  mm: 96 / 25.4,
  cm: 96 / 2.54,
  in: 96,
};

export interface Length {
  readonly value: number;
  /** `''` for a plain number, else the unit as written. */
  readonly unit: string;
}

export function parseLength(text: string): Length | null {
  const { number, unit } = splitUnit(text.trim());
  const value = parseNumber(number);
  return value === null ? null : { value, unit };
}

/** The length in user units (pixels), or null for a percentage or an unusable value. */
export function lengthInPixels(text: string): number | null {
  const length = parseLength(text);
  if (length === null || length.unit === '%') return null;
  const factor = length.unit === '' ? 1 : (PIXELS_PER_UNIT[length.unit] ?? 1);
  return length.value * factor;
}

/** A list of numbers separated by whitespace and/or one comma; null when any item is not a number. */
export function parseNumberList(text: string, maxItems: number): number[] | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const items = trimmed.split(/\s*,\s*|\s+/);
  if (items.length > maxItems) return null;
  const numbers: number[] = [];
  for (const item of items) {
    const value = parseNumber(item);
    if (value === null) return null;
    numbers.push(value);
  }
  return numbers;
}

// ---------------------------------------------------------------------------------------------
// Colours and paints
// ---------------------------------------------------------------------------------------------

/** The lengths (with the hash sign) of the CSS hex forms: #rgb, #rgba, #rrggbb, #rrggbbaa. */
const HEX_FORM_LENGTHS: ReadonlySet<number> = new Set([4, 5, 7, 9]);

/**
 * Is `text` a CSS hex colour in any of its four forms? This only recognises a value inside a
 * document for the allowlist; it never normalises a colour (accent hex normalisation is the shared
 * `normalizeAccent`), so it is a character test and not a pattern that takes a colour apart.
 */
function isHashForm(text: string): boolean {
  if (!text.startsWith('#') || !HEX_FORM_LENGTHS.has(text.length)) return false;
  for (let index = 1; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    const digit = code >= 48 && code <= 57;
    const lower = code >= 97 && code <= 102;
    const upper = code >= 65 && code <= 70;
    if (!digit && !lower && !upper) return false;
  }
  return true;
}

/** The CSS named colours plus `transparent`. */
const NAMED_COLOURS: ReadonlySet<string> = new Set(
  (
    'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet ' +
    'brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan ' +
    'darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta ' +
    'darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue ' +
    'darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey ' +
    'dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray ' +
    'green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush ' +
    'lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray ' +
    'lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray ' +
    'lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon ' +
    'mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue ' +
    'mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin ' +
    'navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen ' +
    'paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple ' +
    'rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna ' +
    'silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato ' +
    'turquoise violet wheat white whitesmoke yellow yellowgreen transparent'
  ).split(' '),
);

/** `rgb()`, `rgba()`, `hsl()` or `hsla()` with three or four numeric arguments. */
function isFunctionColour(text: string): boolean {
  const open = text.indexOf('(');
  if (open < 0 || !text.endsWith(')')) return false;
  const name = text.slice(0, open).toLowerCase();
  if (!['rgb', 'rgba', 'hsl', 'hsla'].includes(name)) return false;
  const inner = text.slice(open + 1, -1);
  if (inner.includes('(') || inner.includes(')')) return false;
  const tokens = inner.trim().split(/\s*[,/]\s*|\s+/);
  if (tokens.length !== 3 && tokens.length !== 4) return false;
  for (const [index, token] of tokens.entries()) {
    // `%` on any argument; `deg` only on the hue of hsl().
    const hue = name.startsWith('hsl') && index === 0;
    const number = token.endsWith('%')
      ? token.slice(0, -1)
      : hue && token.endsWith('deg')
        ? token.slice(0, -3)
        : token;
    if (parseNumber(number) === null) return false;
  }
  return true;
}

/** A colour: hex, a colour function, a named colour or `currentColor`. */
export function isColour(text: string): boolean {
  if (isHashForm(text)) return true;
  if (/^currentcolor$/i.test(text)) return true;
  if (NAMED_COLOURS.has(text.toLowerCase())) return true;
  return isFunctionColour(text);
}

/** The id of a `url(#id)` value, or null when the text is anything else. */
export function parseUrlReference(text: string): string | null {
  if (!text.startsWith('url(#') || !text.endsWith(')')) return null;
  const id = text.slice('url(#'.length, -1);
  return ID_PATTERN.test(id) ? id : null;
}

/** The id of a `#id` value, or null when the text is anything else. */
export function parseFragmentReference(text: string): string | null {
  if (!text.startsWith('#')) return null;
  const id = text.slice(1);
  return ID_PATTERN.test(id) ? id : null;
}

export interface Paint {
  /** The id of a `url(#id)` reference, or null. */
  readonly reference: string | null;
  /** The colour (or `none`) to use instead of the reference, or when there is no reference. */
  readonly fallback: string | null;
}

/** `none`, `currentColor`, a colour, or `url(#id)` with an optional `none` or colour fallback. */
export function parsePaint(text: string): Paint | null {
  const value = text.trim();
  if (value === 'none') return { reference: null, fallback: 'none' };
  if (isColour(value)) return { reference: null, fallback: value };
  if (!value.startsWith('url(')) return null;
  const close = value.indexOf(')');
  if (close < 0) return null;
  const reference = parseUrlReference(value.slice(0, close + 1));
  if (reference === null) return null;
  const rest = value.slice(close + 1);
  if (rest === '') return { reference, fallback: null };
  if (!/^\s+\S/.test(rest)) return null;
  const fallback = rest.trim();
  return fallback === 'none' || isColour(fallback) ? { reference, fallback } : null;
}

/** `none` or `url(#id)`, as `clip-path` and `mask` take. */
export function parseReferenceOrNone(text: string): { reference: string | null } | null {
  const value = text.trim();
  if (value === 'none') return { reference: null };
  const reference = parseUrlReference(value);
  return reference === null ? null : { reference };
}

// ---------------------------------------------------------------------------------------------
// Path data
// ---------------------------------------------------------------------------------------------

const PATH_ARITY: Readonly<Record<string, number>> = {
  M: 2,
  L: 2,
  H: 1,
  V: 1,
  C: 6,
  S: 4,
  Q: 4,
  T: 2,
  A: 7,
  Z: 0,
};

const PATH_NUMBER = new RegExp(NUMBER_SOURCE, 'y');

/**
 * Strict path data: commands `MmLlHhVvCcSsQqTtAaZz`, numbers only, the first command a move, the
 * flags of an arc a single `0` or `1`, parameters in whole sets, at most 50,000 segments. The
 * separator between two items is whitespace and/or one comma; there is none needed where the
 * grammar is unambiguous (`1-2`, `.5.5`, `10 20` and `0 0 1 1` flags). Returns the segment count, or
 * null when the data is not valid.
 */
export function countPathSegments(data: string): number | null {
  let at = 0;
  const end = data.length;

  const skipSpace = (): void => {
    while (at < end && /[\t\n\f\r ]/.test(data.charAt(at))) at += 1;
  };
  const skipSeparator = (): void => {
    skipSpace();
    if (data.charAt(at) === ',') {
      at += 1;
      skipSpace();
    }
  };
  const readNumber = (): boolean => {
    PATH_NUMBER.lastIndex = at;
    const match = data.match(PATH_NUMBER);
    if (match === null) return false;
    if (parseNumber(match[0]) === null) return false;
    at += match[0].length;
    return true;
  };
  const readFlag = (): boolean => {
    const flag = data.charAt(at);
    if (flag !== '0' && flag !== '1') return false;
    at += 1;
    return true;
  };
  const startsNumber = (): boolean => /[-+.0-9]/.test(data.charAt(at));

  let segments = 0;
  skipSpace();
  if (at >= end) return null;
  let first = true;
  while (at < end) {
    const letter = data.charAt(at);
    const command = letter.toUpperCase();
    const arity = PATH_ARITY[command];
    if (arity === undefined || letter.toLowerCase() === letter.toUpperCase()) return null;
    if (first && command !== 'M') return null;
    first = false;
    at += 1;
    skipSpace();
    if (arity === 0) {
      segments += 1;
    } else {
      // One set at least; more sets while a number follows (an implicit repeat of the command). A
      // comma is only allowed between two items, so one after the last set is refused.
      do {
        for (let parameter = 0; parameter < arity; parameter += 1) {
          if (parameter > 0) skipSeparator();
          const isFlag = command === 'A' && (parameter === 3 || parameter === 4);
          if (!(isFlag ? readFlag() : readNumber())) return null;
        }
        segments += 1;
        if (segments > MAX_PATH_SEGMENTS) return null;
        skipSpace();
        if (data.charAt(at) === ',') {
          at += 1;
          skipSpace();
          if (!startsNumber()) return null;
        }
      } while (at < end && startsNumber());
    }
    skipSpace();
    if (segments > MAX_PATH_SEGMENTS) return null;
  }
  return segments;
}

// ---------------------------------------------------------------------------------------------
// Transforms, points, dashes, view boxes
// ---------------------------------------------------------------------------------------------

const TRANSFORM_ARITY: ReadonlyMap<string, readonly number[]> = new Map([
  ['matrix', [6]],
  ['translate', [1, 2]],
  ['scale', [1, 2]],
  ['rotate', [1, 3]],
  ['skewX', [1]],
  ['skewY', [1]],
]);

const MAX_TRANSFORMS = 32;

/** A transform list: `matrix`, `translate`, `scale`, `rotate`, `skewX`, `skewY` with the right number of numbers. */
export function isTransformList(text: string): boolean {
  let rest = text.trim();
  let count = 0;
  while (rest !== '') {
    const open = rest.indexOf('(');
    const close = rest.indexOf(')');
    if (open < 1 || close < open) return false;
    count += 1;
    if (count > MAX_TRANSFORMS) return false;
    const arity = TRANSFORM_ARITY.get(rest.slice(0, open).trim());
    const numbers = parseNumberList(rest.slice(open + 1, close), 6);
    if (arity === undefined || numbers === null || !arity.includes(numbers.length)) return false;
    // Between two transforms: whitespace, and at most one comma.
    rest = rest.slice(close + 1).trimStart();
    if (rest.startsWith(',')) rest = rest.slice(1).trimStart();
  }
  return count > 0;
}

/** A `points` list: an even number of numbers, at least two pairs are not required, one pair is. */
export function isPointList(text: string): boolean {
  const numbers = parseNumberList(text, 2 * MAX_PATH_SEGMENTS);
  return numbers !== null && numbers.length >= 2 && numbers.length % 2 === 0;
}

/** `none`, or up to 32 non-negative lengths. */
export function isDashArray(text: string): boolean {
  const value = text.trim();
  if (value === 'none') return true;
  const items = value.split(/\s*,\s*|\s+/);
  if (items.length < 1 || items.length > 32) return false;
  return items.every((item) => {
    const length = parseLength(item);
    return length !== null && length.value >= 0;
  });
}

export interface ViewBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Four numbers with a positive width and height; null otherwise (and for an out-of-range number). */
export function parseViewBox(text: string): ViewBox | null {
  const numbers = parseNumberList(text, 4);
  if (numbers?.length !== 4) return null;
  const [x = 0, y = 0, width = 0, height = 0] = numbers;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

const PRESERVE_ASPECT_RATIO = /^(?:none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max))(?:\s+(?:meet|slice))?$/;

export function isPreserveAspectRatio(text: string): boolean {
  return PRESERVE_ASPECT_RATIO.test(text.trim());
}

// ---------------------------------------------------------------------------------------------
// The rule for each attribute
// ---------------------------------------------------------------------------------------------

/** Validate a value for an attribute: the cleaned value, or null when it is refused. */
export type ValueRule = (value: string) => string | null;

const keyword =
  (...allowed: readonly string[]): ValueRule =>
  (value) => {
    const trimmed = value.trim();
    return allowed.includes(trimmed) ? trimmed : null;
  };

const length: ValueRule = (value) => (parseLength(value) === null ? null : value.trim());
const nonNegativeLength: ValueRule = (value) => {
  const parsed = parseLength(value);
  return parsed !== null && parsed.value >= 0 ? value.trim() : null;
};
const numberValue: ValueRule = (value) =>
  parseNumber(value.trim()) === null ? null : value.trim();
const numberOrPercentage: ValueRule = (value) => {
  const trimmed = value.trim();
  const parsed = parseLength(trimmed);
  return parsed !== null && (parsed.unit === '' || parsed.unit === '%') ? trimmed : null;
};
const colour: ValueRule = (value) => (isColour(value.trim()) ? value.trim() : null);
const paint: ValueRule = (value) => (parsePaint(value) === null ? null : value.trim());
const referenceOrNone: ValueRule = (value) =>
  parseReferenceOrNone(value) === null ? null : value.trim();

/**
 * The value rule of every allowlisted attribute, by name. An attribute of the allowlist without a
 * rule here is a bug of the allowlist, and `svg-sanitiser.test.ts` fails on it.
 */
export const VALUE_RULES: Readonly<Record<string, ValueRule>> = {
  // Geometry.
  x: length,
  y: length,
  width: nonNegativeLength,
  height: nonNegativeLength,
  cx: length,
  cy: length,
  r: nonNegativeLength,
  rx: nonNegativeLength,
  ry: nonNegativeLength,
  x1: length,
  y1: length,
  x2: length,
  y2: length,
  fx: length,
  fy: length,
  points: (value) => (isPointList(value) ? value.trim() : null),
  d: (value) => (countPathSegments(value) === null ? null : value.trim()),
  viewBox: (value) => (parseViewBox(value) === null ? null : value.trim()),
  preserveAspectRatio: (value) => (isPreserveAspectRatio(value) ? value.trim() : null),
  transform: (value) => (isTransformList(value) ? value.trim() : null),
  gradientTransform: (value) => (isTransformList(value) ? value.trim() : null),
  // Presentation.
  fill: paint,
  stroke: paint,
  'fill-opacity': numberOrPercentage,
  'stroke-opacity': numberOrPercentage,
  opacity: numberOrPercentage,
  'stop-opacity': numberOrPercentage,
  'fill-rule': keyword('nonzero', 'evenodd'),
  'clip-rule': keyword('nonzero', 'evenodd'),
  'stroke-width': nonNegativeLength,
  'stroke-linecap': keyword('butt', 'round', 'square'),
  'stroke-linejoin': keyword('miter', 'round', 'bevel'),
  'stroke-miterlimit': numberValue,
  'stroke-dasharray': (value) => (isDashArray(value) ? value.trim() : null),
  'stroke-dashoffset': length,
  'stop-color': colour,
  offset: numberOrPercentage,
  'clip-path': referenceOrNone,
  mask: referenceOrNone,
  display: keyword('inline', 'block', 'none'),
  visibility: keyword('visible', 'hidden', 'collapse'),
  // Units.
  gradientUnits: keyword('userSpaceOnUse', 'objectBoundingBox'),
  spreadMethod: keyword('pad', 'reflect', 'repeat'),
  clipPathUnits: keyword('userSpaceOnUse', 'objectBoundingBox'),
  maskUnits: keyword('userSpaceOnUse', 'objectBoundingBox'),
  maskContentUnits: keyword('userSpaceOnUse', 'objectBoundingBox'),
  // Identity and references (the references are checked against the document later).
  id: (value) => (ID_PATTERN.test(value) ? value : null),
  href: (value) => (parseFragmentReference(value) === null ? null : value),
};

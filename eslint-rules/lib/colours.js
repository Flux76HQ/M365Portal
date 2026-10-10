// What counts as a colour written by hand, shared by two controls so that they look at the same
// words: the lint rule local/no-raw-colour (eslint-rules/rules/no-raw-colour.js) and the source scan
// of packages/shared/test/repo-conventions.test.ts (check 4, FR-A-009). Not a rule, so the loader
// does not scan it (it reads rules/ only).

/** The 148 CSS named colours. `transparent`, `currentColor` and `inherit` are not colours of their own. */
export const NAMED_COLOURS = new Set(
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
    'silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle ' +
    'tomato turquoise violet wheat white whitesmoke yellow yellowgreen'
  ).split(' '),
);

/** Properties (and attributes) that start with one of these hold a colour or a shorthand with one. */
const COLOUR_PROPERTY_PREFIXES = [
  'background',
  'border',
  'outline',
  'fill',
  'stroke',
  'boxshadow',
  'textshadow',
  'textdecoration',
  'textstroke',
  'textemphasis',
  'columnrule',
  'filter',
];

/**
 * Can the value of this CSS property, style-object key or SVG/JSX attribute be a colour?
 * `color`, `backgroundColor`, `border-top`, `box-shadow`, `fill`, `stopColor`, `--any-custom-property`.
 * camelCase and kebab-case are the same name.
 */
export function isColourProperty(name) {
  if (name.startsWith('--')) return true;
  const key = name
    .replace(/^-(?:webkit|moz|ms)-/, '')
    .replaceAll('-', '')
    .toLowerCase();
  return /colou?r$/.test(key) || COLOUR_PROPERTY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * The named colours a value spells out: `1px solid Tomato` gives Tomato. Words that are part of
 * something else (`red-500`, `tokens.red`, `$red`, `red(`, a file name in `url(red.svg)`) are not
 * colours. `transparent`, `currentColor`, `inherit` and system colours (`Highlight`) are allowed.
 *
 * @param {string} value
 * @returns {{ word: string, index: number }[]}
 */
export function findNamedColourWords(value) {
  const visible = value.replace(/url\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\)/gi, (url) =>
    ' '.repeat(url.length),
  );
  const found = [];
  for (const match of visible.matchAll(/(?<![\w#.$@/-])([A-Za-z]+)(?![\w(./-])/g)) {
    if (NAMED_COLOURS.has((match[1] ?? '').toLowerCase())) {
      found.push({ word: match[1] ?? '', index: match.index });
    }
  }
  return found;
}

/**
 * The text between the parenthesis at `openIndex` and its partner (or the end of the line when it is
 * never closed): the arguments of a colour function.
 *
 * @param {string} text
 * @param {number} openIndex index of the "("
 */
export function argumentsOf(text, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < text.length; index += 1) {
    const character = text[index];
    if (character === '(') depth += 1;
    else if (character === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(openIndex + 1, index);
    } else if (character === '\n') {
      break;
    }
  }
  return text.slice(openIndex + 1).split('\n')[0] ?? '';
}

/**
 * A colour made of a design token, not a literal: `hsl(var(--accent))`,
 * `color-mix(in oklab, var(--accent) 20%, transparent)`. The token is the single source of the
 * colour, which is exactly what the rule asks for.
 */
export function referencesToken(args) {
  return /\bvar\(\s*--/i.test(args);
}

/**
 * Attributes whose value is an id, a fragment or a path and never a colour: `href="#add"` is a link
 * to the element `add`, which happens to spell three hex digits.
 */
const REFERENCE_ATTRIBUTES = new Set([
  'href',
  'xlinkhref',
  'xlink:href',
  'to',
  'for',
  'htmlfor',
  'id',
  'headers',
  'usemap',
  'form',
  'list',
  'aria-controls',
  'aria-labelledby',
  'aria-describedby',
  'aria-owns',
  'aria-activedescendant',
  'aria-details',
  'aria-errormessage',
  'aria-flowto',
]);

export function isReferenceAttribute(name) {
  return REFERENCE_ATTRIBUTES.has(name.toLowerCase());
}

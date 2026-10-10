// local/no-raw-colour (FR-A-009, AGENTS.md section 6)
//
// The brand colour is chosen by the organisation at runtime, so no component may carry a colour of
// its own: they consume design tokens (CSS custom properties through Tailwind utilities). This rule
// refuses a colour written into a string or template literal of the web package's TypeScript:
//
//   - hex colours:                      '#fff', '#1a2b3c', '#1a2b3c80'
//   - colour functions:                 rgb( rgba( hsl( hsla( hwb( lab( lch( oklab( oklch( color-mix(
//   - color() with a colour space:      color(display-p3 ...)
//   - Tailwind arbitrary colour values: bg-[#fff], text-[rgb(...)], bg-[color:...], bg-[red]
//
// The patterns mirror the source scan in packages/shared/test/repo-conventions.test.ts (check 4),
// which also reads CSS files; this rule is the control for code, and it reports the literal that
// holds the colour. A literal is reported once, for the first pattern (in the order below) that
// matches it. Words that merely look like a colour (anchors such as '/#main-content', the numeric
// entity '&#169;', 'url(#clip)', a name ending in "color(") are not matched.
//
// The design tokens themselves live in packages/shared/src/tokens and in
// apps/web/src/styles/tokens.generated.css, outside this rule's scope.

export const meta = {
  type: 'problem',
  docs: {
    description:
      'Disallow raw colour literals and Tailwind arbitrary colour values in the web package (FR-A-009)',
  },
  messages: {
    rawColour: 'Raw {{kind}} "{{text}}": use a design token instead (FR-A-009).',
  },
  schema: [],
};

export const scope = {
  files: ['apps/web/src/**/*.{ts,tsx}'],
  ignores: [],
};

const FUNCTIONS = 'rgba?|hsla?|hwb|oklch|oklab|lab|lch';

/** The 148 CSS named colours: `bg-[red]` is a colour even though no function or '#' is in sight. */
const NAMED_COLOURS = new Set(
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

/** `-[red]`, `-[color:red]`; the capture is the name. */
const ARBITRARY_NAMED = /-\[(?:color:)?([a-z]+)\]/gi;
/** `-[color:...]` and `-[rgb(...)]`: an arbitrary value that says it is a colour. */
const ARBITRARY_TYPED = new RegExp(`-\\[(?:color:|(?:${FUNCTIONS})\\()`, 'i');
// "Word character" below means a letter or digit, not an underscore: Tailwind writes the spaces of an
// arbitrary value as underscores, so in `shadow-[0_0_0_1px_#000_inset]` the colour sits between two.
const COLOUR_SPACE_FUNCTION = new RegExp(
  String.raw`(?<![A-Za-z0-9-])color\(\s*(?:srgb|display-p3|a98-rgb|prophoto-rgb|rec2020|xyz)`,
  'i',
);
const COLOUR_FUNCTION = new RegExp(String.raw`(?<![A-Za-z0-9-])(?:${FUNCTIONS}|color-mix)\(`, 'i');
// Exactly 3, 4, 6 or 8 hex digits. Not preceded by a letter, digit, '&' (numeric entities), '/', '#'
// or '-' (anchors, ids), and not followed by a letter, digit or '-'.
const HEX_COLOUR =
  /(?<![A-Za-z0-9&/#-])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})(?![A-Za-z0-9-])/i;

/**
 * Each detector returns the matched text or undefined, and the list is tried in this order. The
 * Tailwind shapes come first because the plain function and hex patterns would only describe them
 * less precisely.
 */
const DETECTORS = [
  {
    kind: 'Tailwind arbitrary colour value',
    find(text) {
      const hits = [];
      const typed = ARBITRARY_TYPED.exec(text);
      if (typed !== null) hits.push({ index: typed.index, text: typed[0] });
      for (const match of text.matchAll(ARBITRARY_NAMED)) {
        if (NAMED_COLOURS.has((match[1] ?? '').toLowerCase())) {
          hits.push({ index: match.index, text: match[0] });
          break;
        }
      }
      // The earlier hit is the one worth showing; on a tie the typed form is the more precise.
      return hits.sort((a, b) => a.index - b.index)[0]?.text;
    },
  },
  { kind: 'colour() with a colour space', find: (text) => COLOUR_SPACE_FUNCTION.exec(text)?.[0] },
  { kind: 'colour function', find: (text) => COLOUR_FUNCTION.exec(text)?.[0] },
  { kind: 'hex colour', find: (text) => HEX_COLOUR.exec(text)?.[0] },
];

function firstColourIn(text) {
  for (const { kind, find } of DETECTORS) {
    const found = find(text);
    if (found !== undefined) return { kind, text: found };
  }
  return undefined;
}

export function create(context) {
  function check(node, text) {
    const found = firstColourIn(text);
    if (found !== undefined) {
      context.report({ node, messageId: 'rawColour', data: found });
    }
  }

  return {
    Literal(node) {
      if (typeof node.value === 'string') check(node, node.value);
    },
    TemplateElement(node) {
      check(node, node.value.cooked ?? node.value.raw);
    },
  };
}

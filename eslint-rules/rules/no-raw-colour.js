// local/no-raw-colour (FR-A-009, AGENTS.md section 6)
//
// The brand colour is chosen by the organisation at runtime, so no component may carry a colour of
// its own: they consume design tokens (CSS custom properties through Tailwind utilities). This rule
// refuses a colour written into the web package's scripts:
//
//   - hex colours:                      '#fff', '#1a2b3c', '#1a2b3c80'
//   - colour functions:                 rgb( rgba( hsl( hsla( hwb( lab( lch( oklab( oklch( color-mix(
//   - color() with a colour space:      color(display-p3 ...)
//   - Tailwind arbitrary colour values: bg-[#fff], text-[rgb(...)], bg-[color:...], bg-[red]
//   - named colours, where the place says "colour": a style object ({ color: 'red' }), a colour
//     attribute (<circle fill="black" />, <Text color="red" />), a declaration in a string
//     ('color: red', '[color:red]'), light-dark(white, black)
//
// A colour made of a design token is not raw: `hsl(var(--accent))`, `color-mix(in oklab,
// var(--accent) 20%, transparent)` and `bg-[color:var(--accent)]` carry no colour of their own. The
// value of an attribute that is an id or a link (`href="#add"`) is not a colour either.
//
// The patterns mirror the source scan in packages/shared/test/repo-conventions.test.ts (check 4),
// which also reads CSS, HTML and SVG; this rule is the control for code, and it reports the literal
// that holds the colour. The two share eslint-rules/lib/colours.js, the list of the 148 CSS colour
// names and the words that say "this is a colour". A literal is reported once, for the first
// pattern (in the order below) that matches it. Words that merely look like a colour (anchors such
// as '/#main-content', the numeric entity '&#169;', 'url(#clip)', a name ending in "color(") are not
// matched.
//
// The design tokens themselves live in packages/shared/src/tokens and in
// apps/web/src/styles/tokens.generated.css, outside this rule's scope.
import { staticName } from '../lib/ast.js';
import {
  argumentsOf,
  findNamedColourWords,
  isColourProperty,
  isReferenceAttribute,
  NAMED_COLOURS,
  referencesToken,
} from '../lib/colours.js';
import { WEB_SCRIPTS } from '../lib/scope.js';

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
  files: [WEB_SCRIPTS],
  ignores: [],
};

const FUNCTIONS = 'rgba?|hsla?|hwb|oklch|oklab|lab|lch';

/** `-[red]`, `-[color:red]`; the capture is the name. */
const ARBITRARY_NAMED = /-\[(?:color:)?([a-z]+)\]/gi;
/** `-[color:...]` and `-[rgb(...)]`: an arbitrary value that says it is a colour. */
const ARBITRARY_TYPED = new RegExp(`-\\[(?:color:|(?:${FUNCTIONS})(?=\\())`, 'gi');
// "Word character" below means a letter or digit, not an underscore: Tailwind writes the spaces of an
// arbitrary value as underscores, so in `shadow-[0_0_0_1px_#000_inset]` the colour sits between two.
const COLOUR_SPACE_FUNCTION = new RegExp(
  String.raw`(?<![A-Za-z0-9-])color\(\s*(?:srgb|display-p3|a98-rgb|prophoto-rgb|rec2020|xyz)`,
  'i',
);
const COLOUR_FUNCTION = new RegExp(
  String.raw`(?<![A-Za-z0-9-])(?:${FUNCTIONS}|color-mix)(?=\()`,
  'gi',
);
// Exactly 3, 4, 6 or 8 hex digits. Not preceded by a letter, digit, '&' (numeric entities), '/', '#'
// or '-' (anchors, ids), and not followed by a letter, digit or '-'.
const HEX_COLOUR =
  /(?<![A-Za-z0-9&/#-])(?<!url\(\s*["']?)#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})(?![A-Za-z0-9-])/i;
/** `light-dark(`: the colour scheme switch, whose arguments are colours. */
const LIGHT_DARK = /(?<![A-Za-z0-9-])light-dark(?=\()/gi;
/** `property: value` inside a string: a declaration, `[color:red]` of Tailwind included. */
const DECLARATION = /(?<![\w-])(--[\w-]+|[A-Za-z][\w-]*)\s*:\s*([^;{}\]'"`\n]*)/g;

/**
 * Each detector returns { text } of the first colour it finds or undefined, and the list is tried in
 * this order. The Tailwind shapes come first because the plain function and hex patterns would only
 * describe them less precisely. `place` is what the literal is the value of: the key of a style
 * object, the name of a JSX attribute.
 */
const DETECTORS = [
  {
    kind: 'Tailwind arbitrary colour value',
    find(text) {
      const hits = [];
      for (const typed of text.matchAll(ARBITRARY_TYPED)) {
        const after = typed.index + typed[0].length;
        const tokenised = typed[0].endsWith(':')
          ? /^\s*var\(\s*--/i.test(text.slice(after))
          : referencesToken(argumentsOf(text, after));
        if (!tokenised) {
          hits.push({
            index: typed.index,
            text: typed[0].endsWith(':') ? typed[0] : `${typed[0]}(`,
          });
          break;
        }
      }
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
  {
    kind: 'colour function',
    find(text) {
      for (const match of text.matchAll(COLOUR_FUNCTION)) {
        const open = match.index + match[0].length;
        if (!referencesToken(argumentsOf(text, open))) return `${match[0]}(`;
      }
      return undefined;
    },
  },
  {
    kind: 'hex colour',
    find: (text, place) =>
      place !== undefined && isReferenceAttribute(place) ? undefined : HEX_COLOUR.exec(text)?.[0],
  },
  {
    kind: 'named colour',
    find(text, place) {
      // A value of a colour property: { color: 'red' }, fill="black".
      if (place !== undefined && isColourProperty(place)) {
        const [first] = findNamedColourWords(text);
        if (first !== undefined) return first.word;
      }
      // A declaration inside a string: 'color: red', '[color:red]', 'padding: 0; background: white'.
      for (const match of text.matchAll(DECLARATION)) {
        if (!isColourProperty(match[1] ?? '')) continue;
        const [first] = findNamedColourWords(match[2] ?? '');
        if (first !== undefined) return first.word;
      }
      // light-dark(white, black): the arguments are colours.
      for (const match of text.matchAll(LIGHT_DARK)) {
        const [first] = findNamedColourWords(argumentsOf(text, match.index + match[0].length));
        if (first !== undefined) return first.word;
      }
      return undefined;
    },
  },
];

function firstColourIn(text, place) {
  for (const { kind, find } of DETECTORS) {
    const found = find(text, place);
    if (found !== undefined) return { kind, text: found };
  }
  return undefined;
}

/**
 * What a literal is the value of: the key of the property or the name of the JSX attribute it ends
 * up in, looking through the branches of a conditional, `&&`, `||`, `??`, a type assertion and the
 * braces of an attribute.
 */
function placeOf(start) {
  let child = start;
  for (;;) {
    const parent = child.parent;
    switch (parent?.type) {
      case 'ConditionalExpression':
        if (parent.test === child) return undefined;
        break;
      case 'LogicalExpression':
      case 'TSAsExpression':
      case 'TSSatisfiesExpression':
      case 'TSNonNullExpression':
      case 'TSTypeAssertion':
      case 'ChainExpression':
      case 'JSXExpressionContainer':
        break;
      case 'Property':
        return parent.value === child ? staticName(parent) : undefined;
      case 'JSXAttribute':
        return parent.name.type === 'JSXIdentifier' ? parent.name.name : undefined;
      default:
        return undefined;
    }
    child = parent;
  }
}

const NAMED_COLOUR_DETECTOR = DETECTORS.find((detector) => detector.kind === 'named colour');

export function create(context) {
  function report(node, found) {
    context.report({ node, messageId: 'rawColour', data: found });
  }

  return {
    Literal(node) {
      if (typeof node.value !== 'string') return;
      const found = firstColourIn(node.value, placeOf(node));
      if (found !== undefined) report(node, found);
    },

    TemplateLiteral(node) {
      const place = placeOf(node);
      let reported = false;
      for (const quasi of node.quasis) {
        const found = firstColourIn(quasi.value.cooked ?? quasi.value.raw, place);
        if (found !== undefined) {
          report(quasi, found);
          reported = true;
        }
      }
      // A declaration can run across a substitution: `box-shadow: 0 0 0 2px ${ring}, 0 0 4px navy`.
      if (!reported && node.expressions.length > 0) {
        const joined = node.quasis
          .map((quasi) => quasi.value.cooked ?? quasi.value.raw)
          .join('\u0001');
        const text = NAMED_COLOUR_DETECTOR?.find(joined, place);
        if (text !== undefined) report(node, { kind: 'named colour', text });
      }
    },
  };
}

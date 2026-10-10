// local/no-literal-ui-strings (FR-A-115, baseline section 12)
//
// The interface is written in Dutch and English and every visible word comes from the catalogues
// through the translator. A literal string in JSX would show the same text to both languages, so it
// is refused where it would be displayed:
//
//   - JSX text:            <p>Save changes</p>
//   - user-facing props:   aria-label, aria-description, aria-placeholder, aria-roledescription,
//                          title, placeholder and alt
//
// "Literal" means a string that contains a letter and does not come out of a call (a catalogue
// call, `t('key')`, is a call; its arguments are keys and data, not text). Punctuation, digits,
// symbols and whitespace carry no language and pass. A string in braces is looked at too, including
// the branches of `a ? 'x' : 'y'`, the right side of `a && 'x'`, both sides of `a || 'x'` and
// `a ?? 'x'`, a template literal's fixed text and a `+` concatenation: `{'Save'}` is the same
// mistake as `Save`.
//
// Only the listed attributes are inspected. A component prop such as `label` is not: the rule cannot
// know whether a component renders it, and the catalogue check plus review cover that.
import { unwrap } from '../lib/ast.js';

export const meta = {
  type: 'problem',
  docs: {
    description:
      'Disallow user-visible literal strings in JSX text and in user-facing attributes (FR-A-115)',
  },
  messages: {
    jsxText: 'Literal UI text "{{text}}": use a catalogue key through the translator (FR-A-115).',
    attribute:
      'Literal text "{{text}}" in the "{{name}}" attribute: use a catalogue key through the translator (FR-A-115).',
  },
  schema: [],
};

export const scope = {
  files: ['apps/web/src/**/*.tsx'],
  ignores: ['apps/web/src/**/*.test.tsx', 'apps/web/src/**/*.spec.tsx'],
};

const USER_FACING_ATTRIBUTES = new Set([
  'aria-label',
  'aria-description',
  'aria-placeholder',
  'aria-roledescription',
  'title',
  'placeholder',
  'alt',
]);

const LETTER = /\p{L}/u;
const SHOWN_LENGTH = 40;

/** What the message shows: whitespace collapsed, shortened so one long paragraph stays readable. */
function shown(value) {
  const characters = [...value.replace(/\s+/g, ' ').trim()];
  return characters.length > SHOWN_LENGTH
    ? `${characters.slice(0, SHOWN_LENGTH).join('')}…`
    : characters.join('');
}

/**
 * The literal strings an expression would put on screen: [{ node, value }]. Calls, identifiers and
 * member accesses are values from elsewhere and yield nothing.
 */
function literalsShownBy(expression) {
  const node = unwrap(expression);
  switch (node.type) {
    case 'Literal':
      return typeof node.value === 'string' && LETTER.test(node.value)
        ? [{ node, value: node.value }]
        : [];
    case 'TemplateLiteral': {
      const fixedText = node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join(' ');
      return LETTER.test(fixedText) ? [{ node, value: fixedText }] : [];
    }
    case 'ConditionalExpression':
      return [...literalsShownBy(node.consequent), ...literalsShownBy(node.alternate)];
    case 'LogicalExpression':
      // `a && b` shows b (or a falsy a); `a || b` and `a ?? b` can show either side.
      return node.operator === '&&'
        ? literalsShownBy(node.right)
        : [...literalsShownBy(node.left), ...literalsShownBy(node.right)];
    case 'BinaryExpression':
      return node.operator === '+'
        ? [...literalsShownBy(node.left), ...literalsShownBy(node.right)]
        : [];
    default:
      return [];
  }
}

export function create(context) {
  return {
    JSXText(node) {
      if (LETTER.test(node.value)) {
        context.report({ node, messageId: 'jsxText', data: { text: shown(node.value) } });
      }
    },

    JSXExpressionContainer(node) {
      // The container of an attribute value is handled by the JSXAttribute visitor.
      if (node.parent.type !== 'JSXElement' && node.parent.type !== 'JSXFragment') return;
      if (node.expression.type === 'JSXEmptyExpression') return;
      for (const literal of literalsShownBy(node.expression)) {
        context.report({
          node: literal.node,
          messageId: 'jsxText',
          data: { text: shown(literal.value) },
        });
      }
    },

    JSXAttribute(node) {
      if (node.name.type !== 'JSXIdentifier' || !USER_FACING_ATTRIBUTES.has(node.name.name)) return;
      const { value } = node;
      if (value === null) return;
      const literals =
        value.type === 'JSXExpressionContainer'
          ? value.expression.type === 'JSXEmptyExpression'
            ? []
            : literalsShownBy(value.expression)
          : literalsShownBy(value);
      for (const literal of literals) {
        context.report({
          node: literal.node,
          messageId: 'attribute',
          data: { name: node.name.name, text: shown(literal.value) },
        });
      }
    },
  };
}

// local/no-literal-ui-strings (FR-A-115, baseline section 12)
//
// The interface is written in Dutch and English and every visible word comes from the catalogues
// through the translator. A literal string in JSX would show the same text to both languages, so it
// is refused where it would be displayed:
//
//   - JSX text:            <p>Save changes</p>
//   - user-facing props:   aria-label, aria-description, aria-placeholder, aria-roledescription,
//                          aria-valuetext, aria-braillelabel, aria-brailleroledescription, title,
//                          placeholder, alt and children
//   - elements whose label or value is text: the label of <option>, <optgroup> and <track>, and the
//                          value of an <input> of type submit, button or reset
//   - the same keys in an object literal, wherever it is: `<input {...{ placeholder: 'Search' }} />`
//                          and `const props = { 'aria-label': 'Close' }; <button {...props} />`
//
// "Literal" means a string that contains a letter and does not come out of a call (a catalogue
// call, `t('key')`, is a call; its arguments are keys and data, not text). Punctuation, digits,
// symbols and whitespace carry no language and pass. A string in braces is looked at too, including
// the branches of `a ? 'x' : 'y'`, the right side of `a && 'x'`, both sides of `a || 'x'` and
// `a ?? 'x'`, a template literal's fixed text and a `+` concatenation: `{'Save'}` is the same
// mistake as `Save`.
//
// A `const` that holds such a string and is shown (`const heading = 'Users'; <h1>{heading}</h1>`) is
// followed one step, like the SQL rule follows a const. A `let`, a parameter and an import are values
// from elsewhere and are not.
//
// Only the listed attributes are inspected. A component prop such as `label` is not: the rule cannot
// know whether a component renders it, and the catalogue check plus review cover that. Strings that
// reach the screen through an array that is mapped (`['Name', 'Email'].map(...)`) or an object field
// that a component renders later are likewise beyond a syntactic rule: the catalogue check, review
// and the end-to-end tests cover them (known limit O6).
import { constInitializer, staticName, unwrap } from '../lib/ast.js';
import { WEB_COMPONENTS } from '../lib/scope.js';

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

// Tests live in apps/web/test, outside this scope. A *.test.tsx beside the sources is nobody's test
// (repo-conventions.test.ts check 9 reports it), so it is no reason to switch the rule off.
export const scope = {
  files: [WEB_COMPONENTS],
  ignores: [],
};

const USER_FACING_ATTRIBUTES = new Set([
  'aria-label',
  'aria-description',
  'aria-placeholder',
  'aria-roledescription',
  'aria-valuetext',
  'aria-braillelabel',
  'aria-brailleroledescription',
  'title',
  'placeholder',
  'alt',
  'children',
]);

/** Elements whose `label` attribute is shown as text. */
const LABELLED_ELEMENTS = new Set(['option', 'optgroup', 'track']);
/** The `type` values of an <input> that shows its `value` as the text of a button. */
const BUTTON_INPUT_TYPES = new Set(['submit', 'button', 'reset']);

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
function literalsShownBy(sourceCode, expression, followConst = true) {
  const node = unwrap(expression);
  const next = (child) => literalsShownBy(sourceCode, child, followConst);
  switch (node.type) {
    case 'Identifier': {
      // One step through a const: `const heading = 'Users'; <h1>{heading}</h1>`. The report stays at
      // the place where the text is shown.
      const initializer = followConst ? constInitializer(sourceCode, node) : undefined;
      return initializer === undefined
        ? []
        : literalsShownBy(sourceCode, initializer, false).map((literal) => ({
            node,
            value: literal.value,
          }));
    }
    case 'Literal':
      return typeof node.value === 'string' && LETTER.test(node.value)
        ? [{ node, value: node.value }]
        : [];
    case 'TemplateLiteral': {
      const fixedText = node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join(' ');
      return LETTER.test(fixedText) ? [{ node, value: fixedText }] : [];
    }
    case 'ConditionalExpression':
      return [...next(node.consequent), ...next(node.alternate)];
    case 'LogicalExpression':
      // `a && b` shows b (or a falsy a); `a || b` and `a ?? b` can show either side.
      return node.operator === '&&' ? next(node.right) : [...next(node.left), ...next(node.right)];
    case 'BinaryExpression':
      return node.operator === '+' ? [...next(node.left), ...next(node.right)] : [];
    default:
      return [];
  }
}

/** The string value of a JSX attribute, when it is written as a plain string. */
function plainValue(attribute) {
  const { value } = attribute;
  if (value?.type === 'Literal') return value.value;
  if (value?.type === 'JSXExpressionContainer' && value.expression.type === 'Literal') {
    return value.expression.value;
  }
  return undefined;
}

/**
 * `label` of <option>, <optgroup> and <track>, and `value` of an <input> that is a button, are text
 * on the screen. On a component they cannot be judged (the component may never show them).
 */
function isShownByElement(attribute, name) {
  const element = attribute.parent;
  if (element.name.type !== 'JSXIdentifier') return false;
  const tag = element.name.name;
  if (name === 'label') return LABELLED_ELEMENTS.has(tag);
  if (name === 'value' && tag === 'input') {
    const type = element.attributes.find(
      (candidate) =>
        candidate.type === 'JSXAttribute' &&
        candidate.name.type === 'JSXIdentifier' &&
        candidate.name.name === 'type',
    );
    return type !== undefined && BUTTON_INPUT_TYPES.has(String(plainValue(type)));
  }
  return false;
}

export function create(context) {
  const { sourceCode } = context;

  return {
    JSXText(node) {
      if (!LETTER.test(node.value)) return;
      // Point at the words, not at the line breaks and indentation around them.
      const raw = sourceCode.getText(node);
      const start = node.range[0] + (raw.length - raw.trimStart().length);
      const end = node.range[1] - (raw.length - raw.trimEnd().length);
      context.report({
        loc: { start: sourceCode.getLocFromIndex(start), end: sourceCode.getLocFromIndex(end) },
        messageId: 'jsxText',
        data: { text: shown(node.value) },
      });
    },

    JSXExpressionContainer(node) {
      // The container of an attribute value is handled by the JSXAttribute visitor.
      if (node.parent.type !== 'JSXElement' && node.parent.type !== 'JSXFragment') return;
      if (node.expression.type === 'JSXEmptyExpression') return;
      for (const literal of literalsShownBy(sourceCode, node.expression)) {
        context.report({
          node: literal.node,
          messageId: 'jsxText',
          data: { text: shown(literal.value) },
        });
      }
    },

    JSXAttribute(node) {
      if (node.name.type !== 'JSXIdentifier') return;
      const { name } = node.name;
      if (!USER_FACING_ATTRIBUTES.has(name) && !isShownByElement(node, name)) return;
      const { value } = node;
      if (value === null) return;
      const literals =
        value.type === 'JSXExpressionContainer'
          ? value.expression.type === 'JSXEmptyExpression'
            ? []
            : literalsShownBy(sourceCode, value.expression)
          : literalsShownBy(sourceCode, value);
      for (const literal of literals) {
        context.report({
          node: literal.node,
          messageId: 'attribute',
          data: { name, text: shown(literal.value) },
        });
      }
    },

    // The same keys in an object literal: props that are spread, or handed to createElement.
    Property(node) {
      if (node.parent.type !== 'ObjectExpression') return;
      const name = staticName(node);
      if (name === undefined || !USER_FACING_ATTRIBUTES.has(name)) return;
      for (const literal of literalsShownBy(sourceCode, node.value)) {
        context.report({
          node: literal.node,
          messageId: 'attribute',
          data: { name, text: shown(literal.value) },
        });
      }
    },
  };
}

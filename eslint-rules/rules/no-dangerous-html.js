// local/no-dangerous-html (plan 8.2, FR-A-042)
//
// The web app never writes HTML into the page. The response carries
// `require-trusted-types-for 'script'`, which makes the browser refuse a string assigned to an HTML
// sink; this rule is the matching control in source, so the mistake is caught before the browser
// has to. Everything is rendered as React elements or as text.
//
//   - dangerouslySetInnerHTML      JSX attribute or property of a props object
//   - innerHTML, outerHTML         any access, read or write, on anything
//   - insertAdjacentHTML           any access
//   - setHTMLUnsafe, parseHTMLUnsafe, createContextualFragment, srcdoc (srcDoc in JSX)
//   - document.write / writeln     on the document, including window.document, a const that
//                                  holds either (`const d = document; d.write(html)`), a name taken
//                                  off it (`const { write } = document`) and what document.open()
//                                  gives back
//   - setAttribute('srcdoc', html)  and setAttributeNS(null, 'srcdoc', html)
//
// A computed key that is a constant string is the same access: `el['innerHTML']`,
// `el['inner' + 'HTML']`, `const k = 'innerHTML'; el[k]`. A key that is only known at run time
// (`el[name]`) cannot be seen; the Trusted Types header still stops it there.
import { constantString, isDocument, resolvedName } from '../lib/ast.js';
import { WEB_SCRIPTS } from '../lib/scope.js';

export const meta = {
  type: 'problem',
  docs: { description: 'Disallow writing HTML into the page: HTML sinks are forbidden (FR-A-042)' },
  messages: {
    dangerousHtml:
      '"{{name}}" writes HTML into the page: render React elements, or text through the translator. Trusted Types would block it at run time (FR-A-042).',
  },
  schema: [],
};

export const scope = {
  files: [WEB_SCRIPTS],
  ignores: [],
};

const HTML_SINKS = new Set([
  'dangerouslySetInnerHTML',
  'innerHTML',
  'outerHTML',
  'insertAdjacentHTML',
  'setHTMLUnsafe',
  'parseHTMLUnsafe',
  'createContextualFragment',
  'srcdoc',
]);
/** Attributes of a JSX element that take markup. */
const HTML_ATTRIBUTES = new Set(['dangerouslySetInnerHTML', 'srcDoc', 'srcdoc']);
const DOCUMENT_WRITERS = new Set(['write', 'writeln']);

export function create(context) {
  const { sourceCode } = context;

  function report(node, name) {
    context.report({ node, messageId: 'dangerousHtml', data: { name } });
  }

  return {
    JSXAttribute(node) {
      if (node.name.type === 'JSXIdentifier' && HTML_ATTRIBUTES.has(node.name.name)) {
        report(node, node.name.name);
      }
    },

    // Props objects and destructuring patterns: `{ dangerouslySetInnerHTML: ... }`, `{ innerHTML }`.
    Property(node) {
      const name = resolvedName(sourceCode, node);
      if (name !== undefined && HTML_SINKS.has(name)) report(node, name);
    },

    MemberExpression(node) {
      const name = resolvedName(sourceCode, node);
      if (name === undefined) return;
      if (HTML_SINKS.has(name)) {
        report(node, name);
      } else if (DOCUMENT_WRITERS.has(name) && isDocument(sourceCode, node.object)) {
        report(node, `document.${name}`);
      }
    },

    // const { write } = document;
    ObjectPattern(node) {
      const { parent } = node;
      const source =
        parent.type === 'VariableDeclarator'
          ? parent.init
          : parent.type === 'AssignmentExpression'
            ? parent.right
            : undefined;
      if (source === null || source === undefined || !isDocument(sourceCode, source)) return;
      for (const property of node.properties) {
        const name = property.type === 'Property' ? resolvedName(sourceCode, property) : undefined;
        if (name !== undefined && DOCUMENT_WRITERS.has(name)) report(property, `document.${name}`);
      }
    },

    // el.setAttribute('srcdoc', html), el.setAttributeNS(null, 'srcdoc', html)
    CallExpression(node) {
      const callee = node.callee.type === 'ChainExpression' ? node.callee.expression : node.callee;
      if (callee.type !== 'MemberExpression') return;
      const method = resolvedName(sourceCode, callee);
      if (method !== 'setAttribute' && method !== 'setAttributeNS') return;
      const name = node.arguments[method === 'setAttribute' ? 0 : 1];
      const text = name === undefined ? undefined : constantString(sourceCode, name);
      if (text?.toLowerCase() === 'srcdoc') report(node, 'srcdoc');
    },
  };
}

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
//   - document.write / writeln     on the document, including window.document
//
// A computed key with a fixed string (`el['innerHTML']`) is the same access. A dynamic key
// (`el[name]`) cannot be seen; the Trusted Types header still stops it at run time.
import { isGlobalObjectName, staticName, unwrap } from '../lib/ast.js';

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
  files: ['apps/web/src/**/*.{ts,tsx}'],
  ignores: [],
};

const HTML_SINKS = new Set([
  'dangerouslySetInnerHTML',
  'innerHTML',
  'outerHTML',
  'insertAdjacentHTML',
]);
const DOCUMENT_WRITERS = new Set(['write', 'writeln']);

/** `document` or `window.document`, `globalThis.document`, `self.document`. */
function isDocument(expression) {
  const node = unwrap(expression);
  if (node.type === 'Identifier') return node.name === 'document';
  if (node.type !== 'MemberExpression' || staticName(node) !== 'document') return false;
  const owner = unwrap(node.object);
  return owner.type === 'Identifier' && isGlobalObjectName(owner.name);
}

export function create(context) {
  function report(node, name) {
    context.report({ node, messageId: 'dangerousHtml', data: { name } });
  }

  return {
    JSXAttribute(node) {
      if (node.name.type === 'JSXIdentifier' && node.name.name === 'dangerouslySetInnerHTML') {
        report(node, 'dangerouslySetInnerHTML');
      }
    },

    // Props objects and destructuring patterns: `{ dangerouslySetInnerHTML: ... }`, `{ innerHTML }`.
    Property(node) {
      const name = staticName(node);
      if (name !== undefined && HTML_SINKS.has(name)) report(node, name);
    },

    MemberExpression(node) {
      const name = staticName(node);
      if (name === undefined) return;
      if (HTML_SINKS.has(name)) {
        report(node, name);
      } else if (DOCUMENT_WRITERS.has(name) && isDocument(node.object)) {
        report(node, `document.${name}`);
      }
    },
  };
}

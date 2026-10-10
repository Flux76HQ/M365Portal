// local/no-direct-storage (FR-A-114, plan 9.4)
//
// Browser storage can throw (Safari private mode, blocked site data, quota), so every access is
// wrapped in try/catch with a fallback to memory, and every key is defined once. That all happens
// in one module, apps/web/src/lib/storage.ts, which this rule's scope leaves out. Everywhere else
// in the web package these are refused:
//
//   localStorage, sessionStorage, indexedDB       as globals, or through window / globalThis / self
//   document.cookie                               read or write
//
// A local variable, import or parameter that merely has one of these names is not the global and
// passes; the scope analysis tells them apart. `const { localStorage } = window` is the same access
// as `window.localStorage`.
import { isGlobalObjectName, staticName, unwrap } from '../lib/ast.js';

export const meta = {
  type: 'problem',
  docs: {
    description:
      'Disallow direct browser storage access outside apps/web/src/lib/storage.ts (FR-A-114)',
  },
  messages: {
    directStorage:
      'Direct use of "{{name}}": go through apps/web/src/lib/storage.ts, which handles blocked storage (FR-A-114).',
  },
  schema: [],
};

export const scope = {
  files: ['apps/web/src/**/*.{ts,tsx}'],
  ignores: ['apps/web/src/lib/storage.ts'],
};

const STORAGE_GLOBALS = new Set(['localStorage', 'sessionStorage', 'indexedDB']);

/** `window`, `globalThis` or `self`. */
function isGlobalObject(expression) {
  const node = unwrap(expression);
  return node.type === 'Identifier' && isGlobalObjectName(node.name);
}

/** `document`, or the document of a global object (`window.document`). */
function isDocument(expression) {
  const node = unwrap(expression);
  if (node.type === 'Identifier') return node.name === 'document';
  return (
    node.type === 'MemberExpression' &&
    staticName(node) === 'document' &&
    isGlobalObject(node.object)
  );
}

/** The expression a destructuring pattern takes its values from, if it is a declarator or assignment. */
function sourceOfPattern(pattern) {
  const { parent } = pattern;
  if (parent.type === 'VariableDeclarator' && parent.id === pattern)
    return parent.init ?? undefined;
  if (parent.type === 'AssignmentExpression' && parent.left === pattern) return parent.right;
  return undefined;
}

export function create(context) {
  const { sourceCode } = context;

  function report(node, name) {
    context.report({ node, messageId: 'directStorage', data: { name } });
  }

  return {
    // The globals themselves, the way `no-restricted-globals` finds them: references to a global
    // that the configuration declares, and references that resolve to nothing at all.
    Program(node) {
      const globalScope = sourceCode.getScope(node);
      for (const variable of globalScope.variables) {
        if (variable.defs.length === 0 && STORAGE_GLOBALS.has(variable.name)) {
          for (const reference of variable.references) report(reference.identifier, variable.name);
        }
      }
      for (const reference of globalScope.through) {
        if (STORAGE_GLOBALS.has(reference.identifier.name)) {
          report(reference.identifier, reference.identifier.name);
        }
      }
    },

    MemberExpression(node) {
      const name = staticName(node);
      if (name === undefined) return;
      if (STORAGE_GLOBALS.has(name) && isGlobalObject(node.object)) {
        report(node, name);
      } else if (name === 'cookie' && isDocument(node.object)) {
        report(node, 'document.cookie');
      }
    },

    Property(node) {
      if (node.parent.type !== 'ObjectPattern') return;
      const name = staticName(node);
      if (name === undefined || !STORAGE_GLOBALS.has(name)) return;
      const source = sourceOfPattern(node.parent);
      if (source !== undefined && isGlobalObject(source)) report(node, name);
    },
  };
}

// local/no-trusted-types-policy-elsewhere (FR-A-042, plan 8.2)
//
// The Content-Security-Policy lists exactly one Trusted Types policy name (`trusted-types
// m365portal-sw`), and exactly one module creates it: apps/web/src/lib/sw-register.ts, which this
// rule's scope leaves out. A second `trustedTypes.createPolicy` anywhere else would either throw
// (the name is not allowed) or, worse, tempt someone to widen the allow-list.
//
// The call is recognised on the global (`trustedTypes`), on a global object's property
// (`window.trustedTypes`, `globalThis.trustedTypes!`, `self['trustedTypes']`) and through a `const`
// alias of those. Referencing `createPolicy` without calling it, and destructuring it, count too.
import { constInitializer, isGlobalObjectName, staticName, unwrap } from '../lib/ast.js';

export const meta = {
  type: 'problem',
  docs: {
    description:
      'Disallow creating Trusted Types policies outside apps/web/src/lib/sw-register.ts (FR-A-042)',
  },
  messages: {
    policyElsewhere:
      'A Trusted Types policy is created in apps/web/src/lib/sw-register.ts only: use what it exports instead of creating another (FR-A-042).',
  },
  schema: [],
};

export const scope = {
  files: ['apps/web/src/**/*.{ts,tsx}'],
  ignores: ['apps/web/src/lib/sw-register.ts'],
};

/** True when an expression is the `trustedTypes` object, directly or through `const` aliases. */
function isTrustedTypes(sourceCode, expression, depth = 0) {
  const node = unwrap(expression);
  if (node.type === 'Identifier') {
    if (node.name === 'trustedTypes') return true;
    const initializer = depth < 4 ? constInitializer(sourceCode, node) : undefined;
    return initializer !== undefined && isTrustedTypes(sourceCode, initializer, depth + 1);
  }
  if (node.type === 'MemberExpression' && staticName(node) === 'trustedTypes') {
    const owner = unwrap(node.object);
    return owner.type === 'Identifier' && isGlobalObjectName(owner.name);
  }
  return false;
}

export function create(context) {
  const { sourceCode } = context;

  function report(node) {
    context.report({ node, messageId: 'policyElsewhere' });
  }

  return {
    MemberExpression(node) {
      if (staticName(node) === 'createPolicy' && isTrustedTypes(sourceCode, node.object)) {
        report(node);
      }
    },

    // const { createPolicy } = window.trustedTypes;
    Property(node) {
      if (node.parent.type !== 'ObjectPattern' || staticName(node) !== 'createPolicy') return;
      const { parent } = node.parent;
      const source =
        parent.type === 'VariableDeclarator'
          ? parent.init
          : parent.type === 'AssignmentExpression'
            ? parent.right
            : undefined;
      if (source !== null && source !== undefined && isTrustedTypes(sourceCode, source)) {
        report(node);
      }
    },
  };
}

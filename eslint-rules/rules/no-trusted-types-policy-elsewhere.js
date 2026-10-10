// local/no-trusted-types-policy-elsewhere (FR-A-042, plan 8.2)
//
// The Content-Security-Policy lists exactly one Trusted Types policy name (`trusted-types
// m365portal-sw`), and exactly one module creates it: apps/web/src/lib/sw-register.ts, which this
// rule's scope leaves out. A second `trustedTypes.createPolicy` anywhere else would either throw
// (the name is not allowed) or, worse, tempt someone to widen the allow-list.
//
// The factory is recognised
//   - as the global (`trustedTypes`), as a property of a global object (`window.trustedTypes`,
//     `globalThis.window.trustedTypes!`, `self['trustedTypes']`) and as a destructured one
//     (`const { trustedTypes: tt } = window`)
//   - through every value a variable ever holds: `const tt = window.trustedTypes`, `let tt = ...`
//     assigned later, a fallback (`window.trustedTypes ?? polyfill`, `a || b`), a conditional
//   - through a small function that returns it (`const get = () => window.trustedTypes; get()`)
//   - by type, when type information is available: a receiver whose type is TrustedTypePolicyFactory,
//     a parameter or a field included, however it was reached (the same way the route rule
//     recognises a Hono instance)
// Referencing `createPolicy` without calling it, and destructuring it, count too.
import {
  findVariable,
  isGlobalObject as isGlobalObjectOf,
  resolvedName,
  unwrap,
} from '../lib/ast.js';
import { WEB_SCRIPTS } from '../lib/scope.js';

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
  files: [WEB_SCRIPTS],
  ignores: ['apps/web/src/lib/sw-register.ts'],
};

const FACTORY_TYPE = 'TrustedTypePolicyFactory';
const FUNCTIONS = new Set(['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration']);

/** True when the type is the factory, or a union, intersection or constraint that contains it. */
function isFactoryType(type, seen = new Set(), depth = 0) {
  if (type === undefined || seen.has(type) || depth > 6) return false;
  seen.add(type);
  if (type.getSymbol()?.getName() === FACTORY_TYPE) return true;
  if (type.isUnionOrIntersection()) {
    return type.types.some((member) => isFactoryType(member, seen, depth + 1));
  }
  return isFactoryType(type.getConstraint(), seen, depth + 1);
}

export function create(context) {
  const { sourceCode } = context;
  const services = sourceCode.parserServices;
  const checker = services?.program?.getTypeChecker();

  function hasFactoryType(expression) {
    if (checker === undefined || services?.esTreeNodeToTSNodeMap === undefined) return false;
    const tsNode = services.esTreeNodeToTSNodeMap.get(expression);
    return tsNode !== undefined && isFactoryType(checker.getTypeAtLocation(tsNode));
  }

  /** `window`, `globalThis.window`, `window.top`, or a const that holds one. */
  function isGlobalObject(expression) {
    return isGlobalObjectOf(sourceCode, expression);
  }

  /** The expressions a function can return: its expression body, or the `return`s of its block. */
  function returnedBy(fn) {
    // A declared function (`declare function obtain(): Factory`) has no body to look into.
    if (fn.body === null || fn.body === undefined) return [];
    if (fn.body.type !== 'BlockStatement') return [fn.body];
    const found = [];
    const visit = (node) => {
      if (node.type === 'ReturnStatement') {
        if (node.argument !== null) found.push(node.argument);
        return;
      }
      // A nested function returns for itself.
      if (FUNCTIONS.has(node.type)) return;
      for (const key of sourceCode.visitorKeys[node.type] ?? []) {
        const child = node[key];
        for (const item of Array.isArray(child) ? child : [child]) {
          if (item !== null && item !== undefined && typeof item.type === 'string') visit(item);
        }
      }
    };
    visit(fn.body);
    return found;
  }

  /** The functions an expression in call position can be: itself, or what its variable holds. */
  function functionsBehind(callee, depth) {
    const node = unwrap(callee);
    if (FUNCTIONS.has(node.type)) return [node];
    if (node.type !== 'Identifier' || depth > 4) return [];
    const variable = findVariable(sourceCode.getScope(node), node.name);
    const functions = [];
    for (const definition of variable?.defs ?? []) {
      if (definition.type === 'FunctionName') functions.push(definition.node);
    }
    for (const reference of variable?.references ?? []) {
      // writeExpr is null for a write without a value and undefined for a read.
      const written = reference.writeExpr ?? undefined;
      if (written !== undefined && FUNCTIONS.has(unwrap(written).type)) {
        functions.push(unwrap(written));
      }
    }
    return functions;
  }

  /** True when an expression is the `trustedTypes` object, however it was reached. */
  function isTrustedTypes(expression, depth = 0) {
    if (depth > 5) return false;
    const node = unwrap(expression);
    switch (node.type) {
      case 'Identifier': {
        if (node.name === 'trustedTypes') return true;
        const variable = findVariable(sourceCode.getScope(node), node.name);
        if (variable === undefined) return false;
        // Every value the variable is ever given: its initialiser and each later assignment.
        for (const reference of variable.references) {
          const written = reference.writeExpr ?? undefined;
          if (written !== undefined && isTrustedTypes(written, depth + 1)) return true;
        }
        // const { trustedTypes: tt } = window;
        return variable.defs.some(
          (definition) =>
            definition.type === 'Variable' &&
            definition.node.id.type === 'ObjectPattern' &&
            definition.node.init !== null &&
            isGlobalObject(definition.node.init) &&
            definition.node.id.properties.some(
              (property) =>
                property.type === 'Property' &&
                resolvedName(sourceCode, property) === 'trustedTypes' &&
                (property.value === definition.name ||
                  (property.value.type === 'AssignmentPattern' &&
                    property.value.left === definition.name)),
            ),
        );
      }
      case 'MemberExpression':
        return resolvedName(sourceCode, node) === 'trustedTypes' && isGlobalObject(node.object);
      case 'LogicalExpression':
        return isTrustedTypes(node.left, depth + 1) || isTrustedTypes(node.right, depth + 1);
      case 'ConditionalExpression':
        return (
          isTrustedTypes(node.consequent, depth + 1) || isTrustedTypes(node.alternate, depth + 1)
        );
      case 'AssignmentExpression':
        return isTrustedTypes(node.right, depth + 1);
      case 'SequenceExpression':
        return isTrustedTypes(node.expressions.at(-1), depth + 1);
      case 'CallExpression':
        return functionsBehind(node.callee, depth).some((fn) =>
          returnedBy(fn).some((value) => isTrustedTypes(value, depth + 1)),
        );
      default:
        return false;
    }
  }

  function isFactory(expression) {
    return isTrustedTypes(expression) || hasFactoryType(expression);
  }

  function report(node) {
    context.report({ node, messageId: 'policyElsewhere' });
  }

  return {
    MemberExpression(node) {
      if (resolvedName(sourceCode, node) === 'createPolicy' && isFactory(node.object)) {
        report(node);
      }
    },

    // const { createPolicy } = window.trustedTypes;
    Property(node) {
      if (
        node.parent.type !== 'ObjectPattern' ||
        resolvedName(sourceCode, node) !== 'createPolicy'
      ) {
        return;
      }
      const { parent } = node.parent;
      const source =
        parent.type === 'VariableDeclarator'
          ? parent.init
          : parent.type === 'AssignmentExpression'
            ? parent.right
            : undefined;
      if (source !== null && source !== undefined && isFactory(source)) {
        report(node);
      }
    },
  };
}

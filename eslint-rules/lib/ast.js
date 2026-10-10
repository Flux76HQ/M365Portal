// Small AST helpers shared by the local rules. Not scanned by the loader (it reads rules/ only).

/**
 * Looks through the wrappers that do not change what an expression evaluates to: `x as T`,
 * `x satisfies T`, `x!`, `<T>x` and the `?.` chain wrapper. Parentheses are not nodes.
 */
export function unwrap(node) {
  let current = node;
  for (;;) {
    switch (current.type) {
      case 'TSAsExpression':
      case 'TSSatisfiesExpression':
      case 'TSNonNullExpression':
      case 'TSTypeAssertion':
      case 'ChainExpression':
        current = current.expression;
        break;
      default:
        return current;
    }
  }
}

/**
 * The name a member access or a property key spells out, when it is known without running the
 * code: `a.b`, `a['b']` and `a[`b`]` give "b"; `a[b]` gives undefined.
 *
 * @param {{ type: string, computed?: boolean, property?: any, key?: any }} node
 *   a MemberExpression, Property, PropertyDefinition or MethodDefinition
 */
export function staticName(node) {
  const key = node.type === 'MemberExpression' ? node.property : node.key;
  if (key === undefined || key === null) return undefined;
  if (node.computed !== true) {
    if (key.type === 'Identifier') return key.name;
    if (key.type === 'Literal') return String(key.value);
    return undefined;
  }
  if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
  if (key.type === 'TemplateLiteral' && key.expressions.length === 0) {
    return key.quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
}

/** True for `window`, `globalThis`, `self` written as a plain identifier. */
export function isGlobalObjectName(name) {
  return name === 'window' || name === 'globalThis' || name === 'self';
}

/** Finds the variable an identifier refers to, walking outwards from `scope`. */
export function findVariable(scope, name) {
  let current = scope;
  while (current !== null) {
    const variable = current.set.get(name);
    if (variable !== undefined) return variable;
    current = current.upper;
  }
  return undefined;
}

/**
 * The initialiser of a `const` that is the only definition of the variable an identifier refers to,
 * or undefined. `const sql = \`...\`; db.prepare(sql)` is the same code as `db.prepare(\`...\`)`, so
 * the rules that look at what is passed follow one such step.
 */
export function constInitializer(sourceCode, identifier) {
  const variable = findVariable(sourceCode.getScope(identifier), identifier.name);
  if (variable?.defs.length !== 1) return undefined;
  const [definition] = variable.defs;
  if (
    definition?.type !== 'Variable' ||
    definition.parent?.kind !== 'const' ||
    definition.node.id.type !== 'Identifier'
  ) {
    return undefined;
  }
  return definition.node.init ?? undefined;
}

/**
 * The string an expression always evaluates to, when that is known without running the code: a
 * string literal, a template whose substitutions are constants, a `+` of constants, or a `const`
 * that holds one. `undefined` for anything else.
 */
export function constantString(sourceCode, expression, depth = 0) {
  const node = unwrap(expression);
  switch (node.type) {
    case 'Literal':
      return typeof node.value === 'string' ? node.value : undefined;
    case 'TemplateLiteral': {
      let text = '';
      for (const [index, quasi] of node.quasis.entries()) {
        text += quasi.value.cooked ?? quasi.value.raw;
        const substitution = node.expressions[index];
        if (substitution === undefined) continue;
        const part = constantString(sourceCode, substitution, depth);
        if (part === undefined) return undefined;
        text += part;
      }
      return text;
    }
    case 'BinaryExpression': {
      if (node.operator !== '+') return undefined;
      const left = constantString(sourceCode, node.left, depth);
      const right = left === undefined ? undefined : constantString(sourceCode, node.right, depth);
      return right === undefined ? undefined : left + right;
    }
    case 'Identifier': {
      const initializer = depth < 4 ? constInitializer(sourceCode, node) : undefined;
      return initializer === undefined
        ? undefined
        : constantString(sourceCode, initializer, depth + 1);
    }
    default:
      return undefined;
  }
}

/**
 * Like `staticName`, and a computed key that is a constant string expression counts as well:
 * `el['inner' + 'HTML']` and `const k = 'innerHTML'; el[k]` both spell "innerHTML".
 */
export function resolvedName(sourceCode, node) {
  const name = staticName(node);
  if (name !== undefined || node.computed !== true) return name;
  const key = node.type === 'MemberExpression' ? node.property : node.key;
  return key === undefined || key === null ? undefined : constantString(sourceCode, key);
}

/** Properties through which a window reaches the global object again: `globalThis.window.top`. */
const GLOBAL_OBJECT_PROPERTIES = new Set([
  'window',
  'self',
  'globalThis',
  'top',
  'parent',
  'frames',
]);

/**
 * `window`, `globalThis`, `self`, a chain of them (`globalThis.window`, `window.top`), or a `const`
 * that holds one: `const w = window; w.localStorage` is the same access as `window.localStorage`.
 */
export function isGlobalObject(sourceCode, expression, depth = 0) {
  const node = unwrap(expression);
  if (node.type === 'Identifier') {
    if (isGlobalObjectName(node.name)) return true;
    const initializer = depth < 4 ? constInitializer(sourceCode, node) : undefined;
    return initializer !== undefined && isGlobalObject(sourceCode, initializer, depth + 1);
  }
  if (node.type !== 'MemberExpression') return false;
  const name = resolvedName(sourceCode, node);
  return (
    name !== undefined &&
    GLOBAL_OBJECT_PROPERTIES.has(name) &&
    isGlobalObject(sourceCode, node.object, depth + 1)
  );
}

/**
 * `document`, `window.document`, a `const` that holds either, and the document that `document.open()`
 * gives back.
 */
export function isDocument(sourceCode, expression, depth = 0) {
  const node = unwrap(expression);
  if (node.type === 'Identifier') {
    if (node.name === 'document') return true;
    const initializer = depth < 4 ? constInitializer(sourceCode, node) : undefined;
    return initializer !== undefined && isDocument(sourceCode, initializer, depth + 1);
  }
  if (node.type === 'MemberExpression') {
    return (
      resolvedName(sourceCode, node) === 'document' &&
      isGlobalObject(sourceCode, node.object, depth + 1)
    );
  }
  if (node.type === 'CallExpression') {
    const callee = unwrap(node.callee);
    return (
      callee.type === 'MemberExpression' &&
      resolvedName(sourceCode, callee) === 'open' &&
      isDocument(sourceCode, callee.object, depth + 1)
    );
  }
  return false;
}

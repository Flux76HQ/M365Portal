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

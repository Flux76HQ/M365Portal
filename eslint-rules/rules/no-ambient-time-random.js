// local/no-ambient-time-random (PB-20, SB-34; T-B-061)
//
// Time, randomness and timers of the Phase B code come in through the injected `Clock`,
// `RandomSource` and `Scheduler` (apps/server/src/ports/clock.ts), so that a test moves a fake clock
// instead of sleeping and a seeded source makes a failure reproducible. In
// apps/server/src/{setup,connection,auth,rbac,policy,integrations,secrets} these are refused:
//
//   Date.now()   Date()   new Date() without an argument     the wall clock, read directly
//   Math.random                                               unseedable randomness
//   setTimeout, setInterval, setImmediate                     global timers, also node:timers and
//                                                             node:timers/promises
//   crypto.randomUUID, randomBytes, randomInt, randomFill,
//   randomFillSync, getRandomValues                           identifiers and nonces come from
//                                                             RandomSource.bytes
//
// `new Date(value)` and `Date.parse` are fine: they convert a value they were given.
//
// Under secrets/ the node:crypto functions are allowed: key, nonce and salt generation is the job of
// that folder and its callers do not substitute a seeded source for a real key. The wall clock, the
// timers and Math.random stay refused there.
import { findVariable, isGlobalObject, resolvedName, unwrap } from '../lib/ast.js';
import { SCRIPT_EXTENSIONS } from '../lib/scope.js';

export const meta = {
  type: 'problem',
  docs: {
    description:
      'Disallow ambient time, randomness and timers in the Phase B server code: use Clock, RandomSource and Scheduler (PB-20)',
  },
  messages: {
    ambientTime:
      '"{{name}}" reads the wall clock or starts a timer: use the injected Clock or Scheduler (ports/clock.ts, PB-20).',
    ambientRandom:
      '"{{name}}" is ambient randomness: use the injected RandomSource (ports/clock.ts, PB-20).',
  },
  schema: [],
};

export const scope = {
  files: [
    `apps/server/src/{setup,connection,auth,rbac,policy,integrations,secrets}/**/*.{${SCRIPT_EXTENSIONS}}`,
  ],
  ignores: [],
};

const TIMERS = new Set(['setTimeout', 'setInterval', 'setImmediate']);
const TIMER_MODULES = new Set(['timers', 'timers/promises']);
const CRYPTO_MODULES = new Set(['crypto']);
const RANDOM_FUNCTIONS = new Set([
  'randomUUID',
  'randomBytes',
  'randomInt',
  'randomFill',
  'randomFillSync',
  'getRandomValues',
]);

function moduleOf(specifier) {
  return typeof specifier === 'string' && specifier.startsWith('node:')
    ? specifier.slice('node:'.length)
    : specifier;
}

function declaredAs(sourceCode, node, name) {
  const variable = findVariable(sourceCode.getScope(node), name);
  return variable !== undefined && variable.defs.length > 0;
}

export function create(context) {
  const { sourceCode } = context;
  const inSecrets = /(?:^|\/)apps\/server\/src\/secrets\//.test(
    context.filename.replaceAll('\\', '/'),
  );
  /** Local names bound to the node:crypto module itself (default and namespace imports). */
  const cryptoModuleNames = new Set();

  function time(node, name) {
    context.report({ node, messageId: 'ambientTime', data: { name } });
  }
  function random(node, name) {
    context.report({ node, messageId: 'ambientRandom', data: { name } });
  }

  /** `crypto`, `webcrypto`, `globalThis.crypto`, a name bound to node:crypto, or `crypto.webcrypto`. */
  function isCryptoObject(expression, depth = 0) {
    const node = unwrap(expression);
    if (node.type === 'Identifier') {
      if (cryptoModuleNames.has(node.name)) return true;
      return (
        (node.name === 'crypto' || node.name === 'webcrypto') &&
        !declaredAs(sourceCode, node, node.name)
      );
    }
    if (node.type !== 'MemberExpression' || depth > 3) return false;
    const name = resolvedName(sourceCode, node);
    return (
      (name === 'crypto' && isGlobalObject(sourceCode, node.object)) ||
      (name === 'webcrypto' && isCryptoObject(node.object, depth + 1))
    );
  }

  /** `Date`, `Math` as the globals, not a local of the same name. */
  function isGlobalIdentifier(node, name) {
    const target = unwrap(node);
    return (
      target.type === 'Identifier' && target.name === name && !declaredAs(sourceCode, target, name)
    );
  }

  return {
    ImportDeclaration(node) {
      const module = moduleOf(node.source.value);
      if (TIMER_MODULES.has(module)) {
        if (node.importKind !== 'type') time(node, `import from ${node.source.value}`);
        return;
      }
      if (!CRYPTO_MODULES.has(module)) return;
      for (const specifier of node.specifiers) {
        if (specifier.type !== 'ImportSpecifier') {
          cryptoModuleNames.add(specifier.local.name);
          continue;
        }
        const imported =
          specifier.imported.type === 'Identifier'
            ? specifier.imported.name
            : String(specifier.imported.value);
        if (RANDOM_FUNCTIONS.has(imported) && !inSecrets && specifier.importKind !== 'type') {
          random(specifier, imported);
        }
        if (imported === 'webcrypto') cryptoModuleNames.add(specifier.local.name);
      }
    },

    // `Date.now`, `Math.random`, `crypto.randomUUID` and the same through the global object.
    MemberExpression(node) {
      const name = resolvedName(sourceCode, node);
      if (name === undefined) return;
      const object = unwrap(node.object);
      if (
        name === 'now' &&
        (isGlobalIdentifier(object, 'Date') ||
          (object.type === 'MemberExpression' &&
            resolvedName(sourceCode, object) === 'Date' &&
            isGlobalObject(sourceCode, object.object)))
      ) {
        time(node, 'Date.now');
      } else if (name === 'random' && isGlobalIdentifier(object, 'Math')) {
        random(node, 'Math.random');
      } else if (TIMERS.has(name) && isGlobalObject(sourceCode, object)) {
        time(node, name);
      } else if (RANDOM_FUNCTIONS.has(name) && !inSecrets && isCryptoObject(object)) {
        random(node, name);
      }
    },

    // `const { randomUUID } = crypto`, `const { now } = Date`.
    Property(node) {
      if (node.parent.type !== 'ObjectPattern') return;
      const { parent: pattern } = node;
      const holder = pattern.parent;
      const source =
        holder.type === 'VariableDeclarator' && holder.id === pattern
          ? holder.init
          : holder.type === 'AssignmentExpression' && holder.left === pattern
            ? holder.right
            : undefined;
      if (source === undefined || source === null) return;
      const name = resolvedName(sourceCode, node);
      if (name === undefined) return;
      if (name === 'now' && isGlobalIdentifier(source, 'Date')) time(node, 'Date.now');
      else if (name === 'random' && isGlobalIdentifier(source, 'Math')) random(node, 'Math.random');
      else if (TIMERS.has(name) && isGlobalObject(sourceCode, source)) time(node, name);
      else if (RANDOM_FUNCTIONS.has(name) && !inSecrets && isCryptoObject(source))
        random(node, name);
    },

    NewExpression(node) {
      if (isGlobalIdentifier(node.callee, 'Date') && node.arguments.length === 0) {
        time(node, 'new Date()');
      }
    },
    CallExpression(node) {
      // `Date()` without `new` returns the current time as a string.
      if (isGlobalIdentifier(node.callee, 'Date')) time(node, 'Date()');
    },

    // The global timers, found the way no-restricted-globals finds them.
    Program(node) {
      const globalScope = sourceCode.getScope(node);
      const isTypeQuery = (reference) => reference.identifier.parent.type === 'TSTypeQuery';
      for (const variable of globalScope.variables) {
        if (TIMERS.has(variable.name) && variable.defs.length === 0) {
          for (const reference of variable.references) {
            if (!isTypeQuery(reference)) time(reference.identifier, variable.name);
          }
        }
      }
      for (const reference of globalScope.through) {
        if (TIMERS.has(reference.identifier.name) && !isTypeQuery(reference)) {
          time(reference.identifier, reference.identifier.name);
        }
      }
    },
  };
}

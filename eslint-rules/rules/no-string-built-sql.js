// local/no-string-built-sql (FR-A-060, data-model section 4)
//
// Every query is parameterised: the SQL text is a constant and values are bound (better-sqlite3
// placeholders, or the Drizzle `sql` tag, whose `${value}` become parameters). SQL assembled from
// strings is how injection happens, so a template literal with substitutions or a concatenation is
// refused wherever it is handed to something that runs SQL:
//
//   prepare, exec, pragma, sql.raw      take SQL text and nothing else: any built string fails
//   run, all, get, query                also exist on Map, Headers and Hono's context, where a
//                                       built key is normal (`cache.get(`${ip}:${route}`)`), so a
//                                       built string fails only when its fixed text reads like SQL
//                                       (a statement keyword followed by a space, a clause word,
//                                       ORDER BY ...). A statement assembled entirely from variables
//                                       is not caught here; `prepare` and `exec` are, for the
//                                       statements that matter.
//
// What counts as built: a template literal with substitutions, `+` concatenation of anything but
// two constants, `.concat(...)` and `[...].join(...)` with a non-constant part, a conditional or
// logical expression with a built branch, and an identifier whose only definition is a `const`
// holding one of those. Tagged templates (the `sql` tag) are not built. A parameter or a call
// result is opaque and passes: the rule cannot see through it.
//
// `pragma` is not in the task's list; it is here because better-sqlite3's db.pragma(text) runs
// "PRAGMA " + text. `/x/.exec(...)` (a regular expression literal) is not a database.
//
// Migrations are outside this rule's scope (apps/server/drizzle is not under src).
import { constInitializer, staticName, unwrap } from '../lib/ast.js';

export const meta = {
  type: 'problem',
  docs: { description: 'Disallow SQL assembled from strings in the server (FR-A-060)' },
  messages: {
    stringBuilt:
      'SQL assembled from a string in {{method}}(): keep the SQL text constant and bind the values as parameters, or use the Drizzle sql tag (FR-A-060).',
  },
  schema: [],
};

export const scope = {
  files: ['apps/server/src/**/*.ts'],
  ignores: [],
};

/** Methods that take SQL text and nothing else. */
const TAKES_SQL = new Set(['prepare', 'exec', 'pragma']);
/** Method names shared with objects that are not databases. */
const MAYBE_SQL = new Set(['run', 'all', 'get', 'query']);

const SQL_TEXT = new RegExp(
  [
    String.raw`\b(?:select|insert|update|delete|replace|create|drop|alter|pragma|vacuum|attach|detach|begin|commit|rollback|explain|reindex)\s`,
    String.raw`\bwith\s+(?:recursive\s+)?\w+\s+as\b`,
    String.raw`\b(?:from|where|join|having|returning|into)\s`,
    String.raw`\b(?:order|group)\s+by\b`,
    String.raw`\bvalues\s*\(`,
    String.raw`\bset\s+\w+\s*=`,
  ].join('|'),
  'i',
);

const CONSTANT = (text) => ({ kind: 'constant', text });
const BUILT = (text) => ({ kind: 'built', text });
const OPAQUE = { kind: 'opaque', text: '' };

/** Joins the analyses of the parts of one string: built if any part is built. */
function combine(parts) {
  const text = parts.map((part) => part.text).join(' ');
  if (parts.some((part) => part.kind === 'built')) return BUILT(text);
  return parts.every((part) => part.kind === 'constant') ? CONSTANT(text) : OPAQUE;
}

/** Joins the analyses of the parts of a concatenation: any non-constant part builds the string. */
function concatenate(parts) {
  const text = parts.map((part) => part.text).join(' ');
  return parts.every((part) => part.kind === 'constant') ? CONSTANT(text) : BUILT(text);
}

/**
 * What an expression is as a string: { kind: 'constant' | 'built' | 'opaque', text } where `text`
 * is the fixed text of its parts.
 */
function analyse(sourceCode, expression, depth = 0) {
  const node = unwrap(expression);
  const next = (child) => analyse(sourceCode, child, depth);
  switch (node.type) {
    case 'Literal':
      return CONSTANT(String(node.value));
    case 'TemplateLiteral': {
      const text = node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join(' ');
      return node.expressions.length === 0 ? CONSTANT(text) : BUILT(text);
    }
    case 'BinaryExpression':
      return node.operator === '+' ? concatenate([next(node.left), next(node.right)]) : OPAQUE;
    case 'ConditionalExpression':
      return combine([next(node.consequent), next(node.alternate)]);
    case 'LogicalExpression':
      return combine([next(node.left), next(node.right)]);
    case 'CallExpression': {
      const callee = unwrap(node.callee);
      if (callee.type !== 'MemberExpression') return OPAQUE;
      const name = staticName(callee);
      if (name === 'concat') {
        return concatenate([
          next(callee.object),
          ...node.arguments.map((argument) => next(argument)),
        ]);
      }
      const receiver = unwrap(callee.object);
      if (name === 'join' && receiver.type === 'ArrayExpression') {
        return concatenate(
          receiver.elements.map((element) =>
            element === null || element.type === 'SpreadElement' ? OPAQUE : next(element),
          ),
        );
      }
      return OPAQUE;
    }
    case 'Identifier': {
      const initializer = depth < 4 ? constInitializer(sourceCode, node) : undefined;
      return initializer === undefined ? OPAQUE : analyse(sourceCode, initializer, depth + 1);
    }
    default:
      return OPAQUE;
  }
}

/** The name the call is known by here ("prepare", "sql.raw"), or undefined for other calls. */
function watchedMethod(callee) {
  if (callee.type !== 'MemberExpression') return undefined;
  const name = staticName(callee);
  if (name === undefined) return undefined;
  const receiver = unwrap(callee.object);
  if (name === 'raw' && receiver.type === 'Identifier' && receiver.name === 'sql') return 'sql.raw';
  if (name === 'exec' && receiver.type === 'Literal' && 'regex' in receiver) return undefined;
  return TAKES_SQL.has(name) || MAYBE_SQL.has(name) ? name : undefined;
}

export function create(context) {
  const { sourceCode } = context;
  return {
    CallExpression(node) {
      const method = watchedMethod(unwrap(node.callee));
      const [argument] = node.arguments;
      if (method === undefined || argument === undefined || argument.type === 'SpreadElement') {
        return;
      }
      const text = analyse(sourceCode, argument);
      if (text.kind !== 'built') return;
      if (MAYBE_SQL.has(method) && !SQL_TEXT.test(text.text)) return;
      context.report({ node: argument, messageId: 'stringBuilt', data: { method } });
    },
  };
}

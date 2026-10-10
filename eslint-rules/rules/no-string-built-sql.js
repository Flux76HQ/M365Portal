// local/no-string-built-sql (FR-A-060, data-model section 4)
//
// Every query is parameterised: the SQL text is a constant and values are bound (better-sqlite3
// placeholders, or the Drizzle `sql` tag, whose `${value}` become parameters). SQL assembled from
// strings is how injection happens. The rule is an ALLOW-LIST: the text handed to something that
// runs SQL must be provably constant. A list of the ways to build a string (a template, `+`, `+=`,
// `join`, a helper) always misses one.
//
//   prepare, exec, pragma, sql.raw     take SQL text and nothing else, on any receiver
//   run, all, get, query, values,      take SQL on a database or a transaction (a receiver called
//   execute                            db, database, sqlite, tx, trx, ...); on anything else they
//                                      are Map#get, Headers#get, Hono's c.req.query, ... where a
//                                      built key is normal (`cache.get(`${ip}:${route}`)`), so a
//                                      built string fails only when its fixed text reads like SQL
//                                      (a statement keyword followed by a space, ORDER BY, or two
//                                      clause words such as FROM and WHERE: one alone is English)
//
// Provably constant is:
//   - a string literal, or a template literal whose substitutions are themselves constant
//     (`SELECT * FROM ${TABLE}` with `const TABLE = 'branding'`)
//   - `+`, `?:`, `||` and `??` over constants
//   - a `sql` tagged template (the Drizzle tag binds its expressions as parameters)
//   - a `const` of the same file holding such an expression, and a member of a `const` object
//     literal of the same file whose value is one (`const statements = { byId: 'SELECT ...' }`)
//
// Everything else is not: a `let` (it can change between the declaration and the call: `q += ...`),
// a parameter (the caller built it), an import (the constant lives where this rule does not look),
// a member access it cannot resolve, a helper call (`buildQuery(f)`, `filters.join(' ')`), another
// tag (`String.raw`). To run a statement that is assembled from parts, write each statement out as a
// literal or use the Drizzle `sql` tag.
//
// The method may hide behind a name: `const { prepare } = db; prepare(text)` and
// `const prepare = db.prepare.bind(db)` are followed one step.
//
// `pragma` is not in the task's list; it is here because better-sqlite3's db.pragma(text) runs
// "PRAGMA " + text. `/x/.exec(...)` (a regular expression literal) is not a database.
//
// Migrations are outside this rule's scope (apps/server/drizzle is not under src or scripts).
import { constInitializer, findVariable, resolvedName, staticName, unwrap } from '../lib/ast.js';
import { SERVER_SCRIPTS } from '../lib/scope.js';

export const meta = {
  type: 'problem',
  docs: { description: 'Disallow SQL that is not a constant string in the server (FR-A-060)' },
  messages: {
    stringBuilt:
      'SQL passed to {{method}}() is not a constant string: write the statement as a literal (or a const holding one, or the Drizzle sql tag) and bind the values as parameters (FR-A-060).',
  },
  schema: [],
};

export const scope = {
  files: [SERVER_SCRIPTS],
  ignores: [],
};

/** Methods that take SQL text and nothing else, whatever they are called on. */
const TAKES_SQL = new Set(['prepare', 'exec', 'pragma']);
/** Methods that take SQL on a database, and mean something else on a Map or a request. */
const MAYBE_SQL = new Set(['run', 'all', 'get', 'query', 'values', 'execute']);
const WATCHED = new Set([...TAKES_SQL, ...MAYBE_SQL]);

/** `db`, `appDb`, `database`, `sqlite`, `tx`, `trx`: the last word of the receiver says it is a database. */
const DATABASE_NAME = /(?:^|[a-z0-9])(?:db|database|sqlite|tx|trx)$/i;

/** A word that starts or shapes a statement: one is enough to say "this is SQL". */
const SQL_STATEMENT_SIGNALS = [
  /\b(?:select|insert|update|delete|replace|create|drop|alter|pragma|vacuum|attach|detach|begin|commit|rollback|explain|reindex)\s/i,
  /\bwith\s+(?:recursive\s+)?\w+\s+as\b/i,
  /\b(?:order|group)\s+by\b/i,
  /\bvalues\s*\(/i,
  /\bset\s+\w+\s*=/i,
];
/** Clause words are ordinary English as well ("rate limit from 10.0.0.1"): it takes two of them. */
const SQL_CLAUSE_SIGNALS = [
  /\bfrom\s/i,
  /\bwhere\s/i,
  /\bjoin\s/i,
  /\bhaving\s/i,
  /\breturning\s/i,
  /\binto\s/i,
];

/** Does the fixed text of a built string read like SQL? */
function readsLikeSql(text) {
  if (SQL_STATEMENT_SIGNALS.some((signal) => signal.test(text))) return true;
  return SQL_CLAUSE_SIGNALS.filter((signal) => signal.test(text)).length >= 2;
}

const CONSTANT = (text) => ({ kind: 'constant', text });
const BUILT = (text) => ({ kind: 'built', text });
const OPAQUE = { kind: 'opaque', text: '' };

/** Joins the analyses of the parts of a string: constant only if every part is. */
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

/** The value of `object.name` when `object` is a const object literal of this file. */
function memberInitializer(sourceCode, member) {
  const name = staticName(member);
  const target = unwrap(member.object);
  if (name === undefined || target.type !== 'Identifier') return undefined;
  const table = constInitializer(sourceCode, target);
  const literal = table === undefined ? undefined : unwrap(table);
  if (literal?.type !== 'ObjectExpression') return undefined;
  const property = literal.properties.find(
    (candidate) => candidate.type === 'Property' && staticName(candidate) === name,
  );
  return property?.type === 'Property' ? property.value : undefined;
}

/**
 * What an expression is as a string: { kind: 'constant' | 'built' | 'opaque', text } where `text`
 * is the fixed text of its parts. Constant is the only kind that is accepted where SQL is run.
 */
function analyse(sourceCode, expression, depth = 0) {
  const node = unwrap(expression);
  const next = (child) => analyse(sourceCode, child, depth);
  switch (node.type) {
    case 'Literal':
      return CONSTANT(String(node.value));
    case 'TemplateLiteral': {
      const text = node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join(' ');
      // Substitutions that are constants themselves leave the statement constant.
      return node.expressions.every((substitution) => next(substitution).kind === 'constant')
        ? CONSTANT(text)
        : BUILT(text);
    }
    case 'TaggedTemplateExpression': {
      const tag = unwrap(node.tag);
      // The Drizzle tag binds every ${} as a parameter; any other tag (String.raw, dedent) builds a string.
      if (tag.type === 'Identifier' && tag.name === 'sql') return CONSTANT('');
      return BUILT(
        node.quasi.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join(' '),
      );
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
      if (node.name === 'undefined') return CONSTANT('');
      const initializer = depth < 4 ? constInitializer(sourceCode, node) : undefined;
      return initializer === undefined ? OPAQUE : analyse(sourceCode, initializer, depth + 1);
    }
    case 'MemberExpression': {
      const value = depth < 4 ? memberInitializer(sourceCode, node) : undefined;
      return value === undefined ? OPAQUE : analyse(sourceCode, value, depth + 1);
    }
    default:
      return OPAQUE;
  }
}

/** The name of the last word of a receiver: `db` for `db`, `this.db`, `deps.db`, `deps.db.$client`. */
function receiverName(receiver) {
  const node = unwrap(receiver);
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'ThisExpression') return 'this';
  if (node.type === 'MemberExpression') return staticName(node) ?? '';
  if (node.type === 'CallExpression') return receiverName(node.callee);
  return '';
}

/**
 * The watched method a call is a call of, under the name it is written with: "prepare", "sql.raw",
 * or undefined. A name that was taken off an object (`const { prepare } = db`, `const prepare =
 * db.prepare.bind(db)`) is followed to the method it stands for.
 */
function watchedMethod(sourceCode, callee) {
  if (callee.type === 'Identifier') return methodBehindName(sourceCode, callee);
  if (callee.type !== 'MemberExpression') return undefined;
  const name = resolvedName(sourceCode, callee);
  if (name === undefined) return undefined;
  const receiver = unwrap(callee.object);
  if (name === 'raw' && receiver.type === 'Identifier' && receiver.name === 'sql') return 'sql.raw';
  if (name === 'exec' && receiver.type === 'Literal' && 'regex' in receiver) return undefined;
  return WATCHED.has(name) ? name : undefined;
}

/** `prepare(...)` where `prepare` was destructured from an object or bound from a method. */
function methodBehindName(sourceCode, identifier) {
  const variable = findVariable(sourceCode.getScope(identifier), identifier.name);
  if (variable?.defs.length !== 1) return undefined;
  const [definition] = variable.defs;
  if (definition?.type !== 'Variable') return undefined;
  const declarator = definition.node;
  // const { prepare } = db;  const { prepare: p } = db;
  if (declarator.id.type === 'ObjectPattern') {
    for (const property of declarator.id.properties) {
      if (
        property.type === 'Property' &&
        property.value.type === 'Identifier' &&
        property.value.name === identifier.name
      ) {
        const name = staticName(property);
        return name !== undefined && WATCHED.has(name) ? name : undefined;
      }
    }
    return undefined;
  }
  if (declarator.id.type !== 'Identifier' || declarator.init === null) return undefined;
  // const prepare = db.prepare;  const prepare = db.prepare.bind(db);
  let source = unwrap(declarator.init);
  if (source.type === 'CallExpression') {
    const callee = unwrap(source.callee);
    if (callee.type === 'MemberExpression' && staticName(callee) === 'bind') {
      source = unwrap(callee.object);
    }
  }
  if (source.type !== 'MemberExpression') return undefined;
  const name = staticName(source);
  return name !== undefined && WATCHED.has(name) ? name : undefined;
}

export function create(context) {
  const { sourceCode } = context;
  return {
    CallExpression(node) {
      const callee = unwrap(node.callee);
      const method = watchedMethod(sourceCode, callee);
      const [argument] = node.arguments;
      if (method === undefined || argument === undefined) return;
      // The receiver decides how strict the check is for the methods that exist on non-databases too.
      const onDatabase =
        callee.type === 'MemberExpression' && DATABASE_NAME.test(receiverName(callee.object));
      const strict = method === 'sql.raw' || TAKES_SQL.has(method) || onDatabase;
      const text =
        argument.type === 'SpreadElement'
          ? { kind: 'opaque', text: '' }
          : analyse(sourceCode, argument);
      if (text.kind === 'constant') return;
      if (!strict && !(text.kind === 'built' && readsLikeSql(text.text))) return;
      context.report({ node: argument, messageId: 'stringBuilt', data: { method } });
    },
  };
}

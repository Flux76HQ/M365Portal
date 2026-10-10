// local/no-string-built-sql (FR-A-060): SQL is never assembled from strings. Every query is
// parameterised (better-sqlite3 placeholders, the Drizzle `sql` tag); SQL text itself is a constant.
//
// The method names the rule watches also exist on things that are not databases (Map#get,
// Headers#get, Hono's c.req.query), where a built key is normal. So the rule is exact where a method
// only ever takes SQL text (prepare, exec, pragma, sql.raw) and, for run, all, get and query, asks
// that the built string also reads like SQL. The suite pins both halves.
import type { RuleTester } from 'eslint';
import { describe, expect, it } from 'vitest';
import { createRuleTester, ruleOf, scopeOf, STRICT_ASSERTIONS } from './support.js';

const FILE = 'apps/server/src/db/queries.ts';
const rule = ruleOf('no-string-built-sql');

function validCase(code: string, name?: string): RuleTester.ValidTestCase {
  return { name: name ?? code, code, filename: FILE };
}

function built(code: string, method: string, name?: string): RuleTester.InvalidTestCase {
  return {
    name: name ?? code,
    code,
    filename: FILE,
    errors: [{ messageId: 'stringBuilt', data: { method } }],
  };
}

createRuleTester().run('local/no-string-built-sql', rule, {
  assertionOptions: STRICT_ASSERTIONS,
  valid: [
    // Constants.
    validCase("db.prepare('SELECT * FROM branding WHERE id = ?');"),
    validCase('db.prepare(`SELECT * FROM branding WHERE id = ?`);', 'template without expressions'),
    validCase("db.exec('PRAGMA journal_mode = WAL');"),
    validCase("db.pragma('foreign_keys = OFF');"),
    validCase("db.prepare('SELECT ' + '1');", 'concatenation of constants'),
    validCase("sql.raw('NOW()');"),
    validCase('sql.raw(`NOW()`);'),
    validCase("const text = 'SELECT 1'; db.prepare(text);", 'a constant behind a const'),
    validCase(
      "const text = 'SELECT * FROM t ' + 'WHERE id = ?'; db.prepare(text);",
      'a constant concatenation behind a const',
    ),

    // The Drizzle sql tag binds its expressions as parameters.
    validCase('db.run(sql`UPDATE t SET a = ${value} WHERE id = ${id}`);'),
    validCase('db.all(sql`SELECT * FROM t WHERE id = ${id}`);'),
    validCase('db.get(sql`SELECT * FROM t WHERE id = ${id}`);'),
    validCase('const q = sql`SELECT ${col}`; db.all(q);', 'a tagged template behind a const'),

    // Values bound to a prepared statement.
    validCase('stmt.get(id);'),
    validCase('stmt.all(a, b);'),
    validCase('stmt.run(name, value);'),
    validCase('stmt.get(`${id}`);', 'a built value without SQL text is a bound parameter'),
    validCase('stmt.run(`user-${id}`, now);'),
    validCase("stmt.run('x' + id);"),

    // Not databases: the same method names on other objects.
    validCase('cache.get(`${ip}:${route}`);', 'a Map key'),
    validCase("buckets.get(ip + ':' + route);", 'a concatenated Map key'),
    validCase('headers.get(`x-${name}`);', 'a header name'),
    validCase('c.req.query(`filter_${index}`);', 'a Hono query parameter name'),
    validCase('c.req.query(prefix + name);'),
    validCase("c.get('requestId');"),
    validCase('registry.get(`update:${id}`);', 'a key that starts with a verb, then a colon'),
    validCase('/id-(\\d+)/.exec(`${line}`);', 'a regular expression'),

    // Not a value the rule can judge.
    validCase('function run(text: string) { return db.prepare(text); }', 'a parameter'),
    validCase('db.prepare(statements.byId);', 'a member of a constant table'),
    validCase('db.prepare(load());', 'the result of a call'),
    validCase('const text = `SELECT ${x}`; log(text);', 'built, but never run'),
    validCase('db.pragma;', 'a method name that is not called'),
  ],

  invalid: [
    // prepare, exec, pragma, sql.raw: any built string.
    built('db.prepare(`SELECT * FROM t WHERE id = ${id}`);', 'prepare', 'template literal'),
    built("db.prepare('SELECT * FROM t WHERE id = ' + id);", 'prepare', 'concatenation'),
    built('db.prepare(a + b);', 'prepare', 'concatenation of two unknowns'),
    built('db.prepare(`${verb} * FROM t`);', 'prepare', 'a template with no fixed SQL text'),
    built('db.exec(`DROP TABLE ${name}`);', 'exec'),
    built('db.exec(`${ddl}`);', 'exec', 'exec of a bare template'),
    built('sqlite.pragma(`foreign_keys = ${flag}`);', 'pragma'),
    built('sql.raw(`ORDER BY ${column}`);', 'sql.raw'),
    built("sql.raw('ORDER BY ' + column);", 'sql.raw', 'sql.raw with concatenation'),
    built('this.db.prepare(`SELECT ${columns} FROM t`);', 'prepare', 'on a member'),
    built('deps.db.$client.prepare(`SELECT ${c} FROM t`);', 'prepare', 'deeper receiver'),
    built('db?.prepare(`SELECT ${c} FROM t`);', 'prepare', 'optional call'),
    built("db['prepare'](`SELECT ${c} FROM t`);", 'prepare', 'computed method name'),
    built('db.prepare(`SELECT ${c} FROM t`).all();', 'prepare', 'chained statement call'),
    built("db.prepare('SELECT * FROM t WHERE id = '.concat(id));", 'prepare', 'String#concat'),
    built("db.prepare(['SELECT', cols, 'FROM t'].join(' '));", 'prepare', 'array join'),
    built('db.prepare(admin ? `SELECT ${c}` : "SELECT 1");', 'prepare', 'one branch is built'),
    built('db.prepare((`SELECT ${c}`) as string);', 'prepare', 'type assertion is looked through'),
    built(
      'const text = `SELECT * FROM t WHERE id = ${id}`; db.prepare(text);',
      'prepare',
      'built behind a const',
    ),
    built(
      "const text = 'SELECT * FROM t WHERE id = ' + id; db.exec(text);",
      'exec',
      'concatenated behind a const',
    ),
    built(
      'const base = `SELECT ${c} FROM t`; const text = base; db.prepare(text);',
      'prepare',
      'built behind two consts',
    ),

    // run, all, get, query: a built string that reads like SQL.
    built('db.run(`DELETE FROM t WHERE id = ${id}`);', 'run'),
    built('db.all(`SELECT * FROM t WHERE name = ${name}`);', 'all'),
    built("db.all('SELECT * FROM t WHERE name = ' + name);", 'all', 'concatenation'),
    built('db.get(`SELECT * FROM t WHERE id = ${id}`);', 'get'),
    built('db.query(`SELECT ${cols} FROM t`);', 'query'),
    built('db.run(`INSERT INTO t (a) VALUES (${a})`);', 'run', 'insert'),
    built('db.run(`UPDATE t SET a = ${a}`);', 'run', 'update'),
    built("db.get(base + ' WHERE id = ' + id);", 'get', 'SQL clause words in a fragment'),
    built('db.all(`${select} ORDER BY ${column}`);', 'all', 'ORDER BY in a fragment'),
    built(
      'const text = `SELECT * FROM t WHERE id = ${id}`; db.get(text);',
      'get',
      'behind a const',
    ),
    built('stmt.all(`SELECT * FROM t WHERE id = ${id}`);', 'all', 'on a statement variable'),

    {
      name: 'every offending call is reported, once each',
      code: 'db.prepare(`SELECT ${a}`);\ndb.exec(`DROP ${b}`);',
      filename: FILE,
      errors: [
        { messageId: 'stringBuilt', data: { method: 'prepare' }, line: 1 },
        { messageId: 'stringBuilt', data: { method: 'exec' }, line: 2 },
      ],
    },
  ],
});

describe('local/no-string-built-sql: scope', () => {
  it('applies to the server source and nothing else', () => {
    const scope = scopeOf('no-string-built-sql');

    expect(scope.files).toEqual(['apps/server/src/**/*.ts']);
    expect(scope.ignores).toEqual([]);
  });
});

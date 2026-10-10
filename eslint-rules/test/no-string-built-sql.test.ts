// local/no-string-built-sql (FR-A-060): SQL is never assembled from strings. Every query is
// parameterised (better-sqlite3 placeholders, the Drizzle `sql` tag); SQL text itself is a constant.
//
// The rule is an allow-list (G0 defect D9): the text handed to something that runs SQL must be
// provably constant, so a `let`, a parameter, an import, a helper call or a member it cannot resolve
// fails like a template with a substitution does.
//
// The method names the rule watches also exist on things that are not databases (Map#get,
// Headers#get, Hono's c.req.query), where a built key is normal. So the rule is exact where a method
// only ever takes SQL text (prepare, exec, pragma, sql.raw) or is called on a database or a
// transaction (db, tx), and for run, all, get, query, values and execute on anything else asks that
// the built string also reads like SQL. The suite pins both halves.
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

    // Constants that are folded: substitutions that are constants themselves, tables of statements.
    validCase(
      "const TABLE = 'branding'; db.prepare(`SELECT * FROM ${TABLE}`);",
      'a constant substitution',
    ),
    validCase('db.prepare(`SELECT ${1 + 1}`);', 'a literal expression in a substitution'),
    validCase(
      "const statements = { byId: 'SELECT * FROM t WHERE id = ?' } as const; db.prepare(statements.byId);",
      'a member of a constant table of the same file',
    ),
    validCase(
      "const statements = { byId: 'SELECT 1' }; db.prepare(statements['byId']);",
      'a computed member with a string key',
    ),
    validCase("db.prepare(admin ? 'SELECT 1' : 'SELECT 2');", 'both branches constant'),
    validCase("const a = 'SELECT 2'; db.prepare(a || 'SELECT 1');", 'a constant default'),
    validCase(
      "const text = ok ? 'SELECT 1' : 'SELECT 2'; db.prepare(text);",
      'a const with two constants',
    ),
    validCase(
      "db.run('PRAGMA optimize'); db.get('SELECT 1'); tx.all('SELECT 2');",
      'literals on a database',
    ),
    validCase(
      'db.execute(sql`SELECT ${x}`); tx.values(sql`SELECT ${x}`);',
      'the sql tag on a database',
    ),
    validCase('db.get(sql`SELECT ${col} FROM t`);'),
    validCase('cache.get(key(filters));', 'a call result as a Map key'),
    validCase('cache.get(`rate limit from ${ip}`);', 'a key with one clause word of plain English'),
    validCase('log.get(`results where ${a} is set`);', 'a key with the word where'),
    validCase('registry.get(`copy into ${name}`);', 'a key with the word into'),
    validCase('map.values();', 'values() on a Map'),
    validCase('const rows = insert(table).values({ a: 1 });', 'values() of an insert builder'),
    validCase('command.execute(input);', 'execute() of a command object'),
    validCase('plugins.get(`name-${id}`);', 'a Map of plugins'),
    validCase('const text = `SELECT ${x}`; log(text);', 'built, but never run'),
    validCase('db.pragma;', 'a method name that is not called'),
    validCase('db.prepare();', 'a call without an argument'),
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

    // Everything that is not provably constant (G0 defect D9).
    built(
      "let q = 'SELECT * FROM t WHERE 1=1'; q += ' AND x = ' + x; db.prepare(q);",
      'prepare',
      'a let that is extended with +=',
    ),
    built(
      "let q = 'SELECT 1'; if (a) { q = 'SELECT ' + a; } db.prepare(q);",
      'prepare',
      'a let that is reassigned in a branch',
    ),
    built("let q = 'SELECT 1'; db.exec(q);", 'exec', 'even a let that is never reassigned'),
    built("db.prepare(filters.join(' '));", 'prepare', 'join on an array variable'),
    built('db.prepare(buildQuery(f));', 'prepare', 'a helper that returns the statement'),
    built('db.prepare(parts.map(String).join(" "));', 'prepare', 'a mapped array'),
    built('function q(text: string) { return db.prepare(text); }', 'prepare', 'a parameter'),
    built('const q = (text: string) => db.exec(text);', 'exec', 'a parameter of an arrow'),
    built('db.prepare(statements.byId);', 'prepare', 'a member that cannot be resolved'),
    built(
      'const stmts = { byId: `SELECT * FROM t WHERE id = ${id}` }; db.prepare(stmts.byId);',
      'prepare',
      'a member of a table that holds a built string',
    ),
    built("import { QUERY } from './queries.js'; db.prepare(QUERY);", 'prepare', 'an import'),
    built('db.prepare(load());', 'prepare', 'the result of a call'),
    built('db.prepare(String.raw`SELECT * FROM t WHERE id = ${id}`);', 'prepare', 'String.raw'),
    built('db.prepare(dedent`SELECT ${c} FROM t`);', 'prepare', 'another tag than sql'),
    built('db.prepare(...parts);', 'prepare', 'a spread argument'),
    built(
      'db.prepare(`SELECT * FROM ${table}`);',
      'prepare',
      'a substitution that is not constant',
    ),
    built(
      'const t = name; db.prepare(`SELECT * FROM ${t}`);',
      'prepare',
      'a const that holds a variable',
    ),
    built('db.execute(`DELETE FROM t WHERE id = ${id}`);', 'execute', 'execute on a database'),
    built('db.get(`${col} ${x}`);', 'get', 'no SQL words at all, on a database'),
    built('tx.run(`${verb}`);', 'run', 'a bare template on a transaction'),
    built('this.db.all(statement);', 'all', 'an unknown statement on this.db'),
    built('deps.sqlite.values(text);', 'values', 'values on a database'),
    built('appDb.query(a + b);', 'query', 'a name that ends in Db'),
    built(
      'const { prepare } = db; prepare(`SELECT * FROM t WHERE id = ${id}`);',
      'prepare',
      'destructured',
    ),
    built('const { prepare: p } = db; p(`SELECT ${c}`);', 'prepare', 'destructured and renamed'),
    built(
      'const prep = db.prepare.bind(db); prep(`SELECT ${c} FROM t`);',
      'prepare',
      'bound to the database',
    ),
    built(
      'const prep = db.prepare; prep(`SELECT ${c} FROM t`);',
      'prepare',
      'taken off the database',
    ),
    built(
      "const m = 'prepare'; db[m](`SELECT ${c} FROM t`);",
      'prepare',
      'a method name held in a const',
    ),
    built(
      "db['pre' + 'pare'](`SELECT ${c} FROM t`);",
      'prepare',
      'a method name built from literals',
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
      'cache.get(`${head} from t where id = ${id}`);',
      'get',
      'two clause words on a Map-like receiver',
    ),
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
  it('applies to the server source and its scripts, every kind of script, nothing else', () => {
    const scope = scopeOf('no-string-built-sql');

    expect(scope.files).toEqual(['apps/server/{src,scripts}/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}']);
    expect(scope.ignores).toEqual([]);
  });
});

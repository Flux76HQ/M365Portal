// Canary cases for local/no-string-built-sql (FR-A-060): scope apps/server/src/**/*.ts.
import type { CanaryCase } from '../canary-case.js';

const RULE = 'local/no-string-built-sql';

const BUILT_QUERY = `
interface Db {
  prepare(text: string): { all(): unknown[] };
}
export function find(db: Db, id: string): unknown[] {
  return db.prepare(\`SELECT * FROM branding WHERE id = \${id}\`).all();
}
`;

export const cases = [
  {
    name: 'a template literal passed to prepare',
    path: 'apps/server/src/__lint_canary__/sql-template.ts',
    code: BUILT_QUERY,
    mustReport: [RULE],
  },
  {
    name: 'a concatenation passed to exec',
    path: 'apps/server/src/__lint_canary__/sql-concat.ts',
    code: `
interface Db {
  exec(text: string): void;
}
export function drop(db: Db, table: string): void {
  db.exec('DROP TABLE ' + table);
}
`,
    mustReport: [RULE],
  },
  {
    name: 'SQL text built in a constant and run later',
    path: 'apps/server/src/__lint_canary__/sql-const.ts',
    code: `
interface Db {
  get(text: string): unknown;
}
export function byName(db: Db, name: string): unknown {
  const text = \`SELECT * FROM branding WHERE name = '\${name}'\`;
  return db.get(text);
}
`,
    mustReport: [RULE],
  },
  {
    name: 'control: constant SQL with bound parameters is allowed',
    path: 'apps/server/src/__lint_canary__/sql-bound.ts',
    code: `
interface Statement {
  get(...params: unknown[]): unknown;
}
interface Db {
  prepare(text: string): Statement;
}
export function find(db: Db, id: string): unknown {
  return db.prepare('SELECT * FROM branding WHERE id = ?').get(id);
}
`,
    mustNotReport: [RULE],
  },
  {
    name: 'control: a built Map key is not SQL',
    path: 'apps/server/src/__lint_canary__/sql-map-key.ts',
    code: `
export function bucket(cache: Map<string, number>, ip: string, route: string): number | undefined {
  return cache.get(\`\${ip}:\${route}\`);
}
`,
    mustNotReport: [RULE],
  },
  {
    name: 'control: the same query in a server test is allowed (tests live outside src)',
    path: 'apps/server/test/__lint_canary__/sql-template.test.ts',
    code: BUILT_QUERY,
    mustNotReport: [RULE],
  },
  {
    name: 'control: the rule is scoped to the server (shared)',
    path: 'packages/shared/src/__lint_canary__/sql-template.ts',
    code: BUILT_QUERY,
    mustNotReport: [RULE],
  },
  {
    name: 'control: the rule is scoped to the server (web)',
    path: 'apps/web/src/__lint_canary__/sql-template.ts',
    code: BUILT_QUERY,
    mustNotReport: [RULE],
  },
  // G0 defects D9 and D15: SQL assembled over several statements, and where the rule looks.
  {
    name: 'SQL built up with += in a let and run later',
    path: 'apps/server/src/__lint_canary__/sql-let.ts',
    code: `
interface Db {
  prepare(text: string): { all(): unknown[] };
}
export function search(db: Db, x: string): unknown[] {
  let q = 'SELECT * FROM t WHERE 1=1';
  q += ' AND x = ' + x;
  return db.prepare(q).all();
}
`,
    mustReport: [RULE],
  },
  {
    name: 'a statement assembled by a helper function',
    path: 'apps/server/src/__lint_canary__/sql-helper.ts',
    code: `
interface Db {
  prepare(text: string): { all(): unknown[] };
}
declare function buildQuery(filters: string[]): string;
export function search(db: Db, filters: string[]): unknown[] {
  return db.prepare(buildQuery(filters)).all();
}
`,
    mustReport: [RULE],
  },
  {
    name: 'a migration script outside src is linted too',
    path: 'apps/server/scripts/__lint_canary__/sql-template.ts',
    code: BUILT_QUERY,
    mustReport: [RULE],
  },
  {
    name: 'a .mjs module of the server is linted',
    path: 'apps/server/src/__lint_canary__/sql-template.mjs',
    code: `
export function find(db, id) {
  return db.prepare(\`SELECT * FROM branding WHERE id = \${id}\`).all();
}
`,
    mustReport: [RULE],
  },
  {
    name: 'a source folder that shares the name of build output is linted (coverage)',
    path: 'apps/server/src/features/coverage/sql-template.ts',
    code: BUILT_QUERY,
    mustReport: [RULE],
  },
  {
    name: 'control: the drizzle migrations folder is outside the rule',
    path: 'apps/server/drizzle/__lint_canary__/migrate.ts',
    code: BUILT_QUERY,
    mustNotReport: [RULE],
  },
  {
    name: 'control: a cache key that reads like a sentence is not SQL',
    path: 'apps/server/src/__lint_canary__/sql-cache-key.ts',
    code: `
export function note(cache: Map<string, number>, ip: string): number | undefined {
  return cache.get(\`rate limit from \${ip}\`);
}
`,
    mustNotReport: [RULE],
  },
] as const satisfies readonly CanaryCase[];

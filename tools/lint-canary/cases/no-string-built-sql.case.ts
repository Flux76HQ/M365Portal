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
] as const satisfies readonly CanaryCase[];

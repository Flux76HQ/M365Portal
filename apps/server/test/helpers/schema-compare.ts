// Reads the structure of a SQLite database and compares two of them. Three guards share it:
//
//   - `schema-parity.test.ts` (T-A-036): a database built by `drizzle-kit export` from the
//     TypeScript schema against one built by the migrations. Triggers are excluded: the audit
//     triggers are hand-written migration SQL and the export cannot render them.
//   - `migrations.upgrade.test.ts` (T-A-038): a database upgraded from snapshot N against one built
//     from snapshot N+1, triggers included.
//   - the negative fixtures of both, which must make `assertSchemasAgree` throw.
//
// What is compared is what an upgrade can silently get wrong (baseline section 2): tables, columns
// (name, declared type, NOT NULL, default expression, primary key position), foreign keys (target
// and ON DELETE / ON UPDATE rule), indexes (name, uniqueness, columns and, for explicit indexes, the
// statement text, which carries a partial index's WHERE), the named CHECK constraints of each table
// (by normalised text, so a changed constant shows: FR-B-702) and, when asked, trigger statements. White
// space and the case of types are normalised; nothing else is.
//
// `sqlite_%` objects and the Drizzle bookkeeping table are not part of the application's schema.
import type { SqliteConnection } from '../../src/db/open.js';

export interface ColumnDescription {
  readonly name: string;
  readonly type: string;
  readonly notNull: boolean;
  readonly default: string | null;
  /** 0 when the column is not part of the primary key, else its 1-based position. */
  readonly primaryKey: number;
  readonly hidden: number;
}

export interface ForeignKeyDescription {
  readonly from: string;
  readonly table: string;
  readonly to: string;
  readonly onUpdate: string;
  readonly onDelete: string;
}

export interface IndexDescription {
  readonly name: string;
  readonly unique: boolean;
  readonly origin: string;
  readonly partial: boolean;
  readonly columns: readonly string[];
  /** The normalised `CREATE INDEX` text of an explicit index; `null` for an automatic one. */
  readonly sql: string | null;
}

export interface TableDescription {
  readonly columns: readonly ColumnDescription[];
  readonly foreignKeys: readonly ForeignKeyDescription[];
  readonly indexes: readonly IndexDescription[];
  /** Named CHECK constraints of the `CREATE TABLE` text, constraint name to normalised expression. */
  readonly checks: Readonly<Record<string, string>>;
}

export interface SchemaDescription {
  readonly tables: Readonly<Record<string, TableDescription>>;
  /** Trigger name to normalised statement; empty when triggers are not compared. */
  readonly triggers: Readonly<Record<string, string>>;
}

export interface DescribeOptions {
  /** Include the trigger statements. Default: no. */
  readonly triggers?: boolean;
}

const IGNORED_TABLE = /^(sqlite_|__drizzle_migrations$)/;

function normaliseSql(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The named CHECK constraints of a `CREATE TABLE` statement: `CONSTRAINT <name> CHECK (<expression>)`,
 * the expression found by matching parentheses (quoted text may hold parentheses). The name is
 * unquoted; the expression is whitespace-normalised.
 */
export function checksOf(createSql: string): Record<string, string> {
  const found: Record<string, string> = {};
  const header = /CONSTRAINT\s+(?:"([^"]+)"|`([^`]+)`|(\w+))\s+CHECK\s*\(/gi;
  for (const match of createSql.matchAll(header)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    let depth = 0;
    let quote: string | undefined;
    for (let position = open; position < createSql.length; position += 1) {
      const character = createSql.charAt(position);
      if (quote !== undefined) {
        if (character === quote) quote = undefined;
      } else if (character === "'" || character === '"' || character === '`') {
        quote = character;
      } else if (character === '(') {
        depth += 1;
      } else if (character === ')') {
        depth -= 1;
        if (depth === 0) {
          const name = match[1] ?? match[2] ?? match[3] ?? '';
          found[name] = normaliseSql(createSql.slice(open + 1, position));
          break;
        }
      }
    }
  }
  return found;
}

function rows<T>(db: SqliteConnection, statement: string): T[] {
  return db.prepare(statement).all() as T[];
}

function describeTable(db: SqliteConnection, table: string): TableDescription {
  const quoted = `"${table.replaceAll('"', '""')}"`;

  const columns = rows<{
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
    hidden: number;
  }>(db, `PRAGMA table_xinfo(${quoted})`).map((column) => ({
    name: column.name,
    type: column.type.toUpperCase(),
    notNull: column.notnull === 1,
    default: column.dflt_value,
    primaryKey: column.pk,
    hidden: column.hidden,
  }));

  const foreignKeys = rows<{
    from: string;
    table: string;
    to: string;
    on_update: string;
    on_delete: string;
  }>(db, `PRAGMA foreign_key_list(${quoted})`)
    .map((key) => ({
      from: key.from,
      table: key.table,
      to: key.to,
      onUpdate: key.on_update,
      onDelete: key.on_delete,
    }))
    .sort((a, b) => a.from.localeCompare(b.from));

  const indexes = rows<{ name: string; unique: number; origin: string; partial: number }>(
    db,
    `PRAGMA index_list(${quoted})`,
  )
    .map((index) => {
      const quotedIndex = `"${index.name.replaceAll('"', '""')}"`;
      const indexedColumns = rows<{ name: string | null }>(
        db,
        `PRAGMA index_info(${quotedIndex})`,
      ).map((column) => column.name ?? '(expression)');
      const definition = db
        .prepare('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?')
        .get('index', index.name) as { sql: string | null } | undefined;
      return {
        name: index.name,
        unique: index.unique === 1,
        origin: index.origin,
        partial: index.partial === 1,
        columns: indexedColumns,
        sql: definition?.sql == null ? null : normaliseSql(definition.sql),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const definition = db
    .prepare('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?')
    .get('table', table) as { sql: string | null } | undefined;
  const checks = checksOf(definition?.sql ?? '');

  return { columns, foreignKeys, indexes, checks };
}

export function describeSchema(
  db: SqliteConnection,
  options: DescribeOptions = {},
): SchemaDescription {
  const tables: Record<string, TableDescription> = {};
  for (const { name } of rows<{ name: string }>(
    db,
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  )) {
    if (!IGNORED_TABLE.test(name)) tables[name] = describeTable(db, name);
  }

  const triggers: Record<string, string> = {};
  if (options.triggers === true) {
    for (const { name, sql } of rows<{ name: string; sql: string }>(
      db,
      "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
    )) {
      triggers[name] = normaliseSql(sql);
    }
  }
  return { tables, triggers };
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** The differences between two descriptions, one readable line each; empty when they agree. */
export function diffSchemas(left: SchemaDescription, right: SchemaDescription): string[] {
  const problems: string[] = [];

  const names = [...new Set([...Object.keys(left.tables), ...Object.keys(right.tables)])].sort();
  for (const name of names) {
    const a = left.tables[name];
    const b = right.tables[name];
    if (a === undefined || b === undefined) {
      problems.push(
        `table ${name} exists only in the ${a === undefined ? 'right' : 'left'} database`,
      );
      continue;
    }

    const columnNames = [
      ...new Set([...a.columns.map((c) => c.name), ...b.columns.map((c) => c.name)]),
    ];
    for (const column of columnNames) {
      const x = a.columns.find((candidate) => candidate.name === column);
      const y = b.columns.find((candidate) => candidate.name === column);
      if (x === undefined || y === undefined) {
        problems.push(
          `${name}.${column} exists only in the ${x === undefined ? 'right' : 'left'} database`,
        );
        continue;
      }
      if (x.type !== y.type) problems.push(`${name}.${column} type: ${x.type} against ${y.type}`);
      if (x.notNull !== y.notNull) {
        problems.push(
          `${name}.${column} not null: ${String(x.notNull)} against ${String(y.notNull)}`,
        );
      }
      if (x.default !== y.default) {
        problems.push(
          `${name}.${column} default: ${String(x.default)} against ${String(y.default)}`,
        );
      }
      if (x.primaryKey !== y.primaryKey) {
        problems.push(
          `${name}.${column} primary key position: ${String(x.primaryKey)} against ${String(y.primaryKey)}`,
        );
      }
      if (x.hidden !== y.hidden) problems.push(`${name}.${column} hidden flag differs`);
    }
    if (
      !same(
        a.columns.map((c) => c.name),
        b.columns.map((c) => c.name),
      ) &&
      problems.every((problem) => !problem.startsWith(`${name}.`))
    ) {
      problems.push(`${name} column order differs`);
    }

    if (!same(a.foreignKeys, b.foreignKeys)) {
      problems.push(
        `${name} foreign keys differ: ${JSON.stringify(a.foreignKeys)} against ${JSON.stringify(b.foreignKeys)}`,
      );
    }
    if (!same(a.indexes, b.indexes)) {
      problems.push(
        `${name} indexes differ: ${JSON.stringify(a.indexes)} against ${JSON.stringify(b.indexes)}`,
      );
    }
    for (const check of [...new Set([...Object.keys(a.checks), ...Object.keys(b.checks)])].sort()) {
      const x = a.checks[check];
      const y = b.checks[check];
      if (x === undefined || y === undefined) {
        problems.push(
          `${name} check ${check} exists only in the ${x === undefined ? 'right' : 'left'} database`,
        );
      } else if (x !== y) {
        problems.push(`${name} check ${check} differs: ${x} against ${y}`);
      }
    }
  }

  const triggerNames = [
    ...new Set([...Object.keys(left.triggers), ...Object.keys(right.triggers)]),
  ].sort();
  for (const name of triggerNames) {
    const a = left.triggers[name];
    const b = right.triggers[name];
    if (a === undefined || b === undefined) {
      problems.push(
        `trigger ${name} exists only in the ${a === undefined ? 'right' : 'left'} database`,
      );
    } else if (a !== b) {
      problems.push(`trigger ${name} differs`);
    }
  }
  return problems;
}

export class SchemaMismatchError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`the schemas differ:\n  ${problems.join('\n  ')}`);
    this.name = 'SchemaMismatchError';
    this.problems = problems;
  }
}

/** Throws a `SchemaMismatchError` unless the two databases have the same structure. */
export function assertSchemasAgree(
  left: SqliteConnection,
  right: SqliteConnection,
  options: DescribeOptions = {},
): void {
  const problems = diffSchemas(describeSchema(left, options), describeSchema(right, options));
  if (problems.length > 0) throw new SchemaMismatchError(problems);
}

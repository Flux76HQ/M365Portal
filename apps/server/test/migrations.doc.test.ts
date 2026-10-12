// T-B-012, FR-B-701, data-model section 12.5 (document agreement): the SQL block of data-model.md
// section 5 (between the two `migration-0001` comment markers), with its macros expanded and its
// whitespace collapsed, matches the committed migration `drizzle/0001_phase_b.sql` object by object.
//
// Without this test the document would be a second source of the schema that can drift. With it the
// document is a review aid that CI keeps honest: the document is the design, the committed file is
// the truth, and a difference fails the test and is fixed in the document in the same commit.
//
// How "the same" is read:
//   - each statement is matched by the name of the object it creates (`CREATE TABLE`, `CREATE INDEX`,
//     `CREATE UNIQUE INDEX`, `CREATE TRIGGER`) or, for the seeds, by the table it inserts into;
//   - macros (`GUID`, `ISO`, `HEX`, `JSONOBJ`) are expanded by `expandCheckMacros`;
//   - whitespace is collapsed and removed around parentheses and commas, the quotes around
//     identifiers (backticks in the document, double quotes where drizzle-kit writes a constraint
//     name) are dropped, and `CHECK (` is `CHECK(`;
//   - the top-level clauses of a `CREATE TABLE` (columns, primary key, foreign keys, constraints) are
//     compared as a set, so a constraint written in another order is the same table;
//   - triggers and seeds are compared as text.
// Negative controls (tasks.md section 0.3): a copy of the block with one changed constant, one
// missing column, one missing trigger and one extra statement must each differ.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import { expandCheckMacros } from '../src/db/check-macros.js';

const dataModel = readFileSync(
  fileURLToPath(new URL('../../../specs/002-phase-b/data-model.md', import.meta.url)),
  'utf8',
);
const migration = readFileSync(
  fileURLToPath(new URL('../drizzle/0001_phase_b.sql', import.meta.url)),
  'utf8',
);

const BEGIN = '<!-- migration-0001:begin -->';
const END = '<!-- migration-0001:end -->';

/** The SQL of the fenced block between the two markers. */
function documentedSql(markdown: string): string {
  const begin = markdown.indexOf(BEGIN);
  const end = markdown.indexOf(END);
  if (begin < 0 || end < 0) throw new Error('data-model.md has no migration-0001 markers');
  const block = markdown.slice(begin + BEGIN.length, end);
  const open = block.indexOf('```sql\n');
  const close = block.lastIndexOf('```');
  if (open < 0 || close < open)
    throw new Error('data-model.md has no sql block between the markers');
  return block.slice(open + '```sql\n'.length, close);
}

/** Statements in order: split on the breakpoint, comment lines dropped, the final `;` dropped. */
function statementsOf(sql: string): string[] {
  return sql
    .split('--> statement-breakpoint')
    .map((chunk) =>
      chunk
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n')
        .trim()
        .replace(/;$/, '')
        .trim(),
    )
    .filter((statement) => statement !== '');
}

/** Whitespace collapsed and removed around punctuation, identifier quotes dropped, `CHECK (` as `CHECK(`. */
function normalise(statement: string): string {
  return statement
    .replace(/[`"]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),])\s*/g, '$1')
    .replace(/\bCHECK \(/g, 'CHECK(')
    .trim();
}

/** The top-level comma-separated clauses of the parenthesised body of a normalised `CREATE TABLE`. */
function clausesOf(statement: string): string[] {
  const open = statement.indexOf('(');
  const close = statement.lastIndexOf(')');
  const body = statement.slice(open + 1, close);
  const clauses: string[] = [];
  let depth = 0;
  let quote = false;
  let start = 0;
  for (let position = 0; position < body.length; position += 1) {
    const character = body.charAt(position);
    if (character === "'") quote = !quote;
    else if (!quote && character === '(') depth += 1;
    else if (!quote && character === ')') depth -= 1;
    else if (!quote && depth === 0 && character === ',') {
      clauses.push(body.slice(start, position));
      start = position + 1;
    }
  }
  clauses.push(body.slice(start));
  return clauses.map((clause) => clause.trim()).sort();
}

interface Described {
  /** `table x`, `index x`, `trigger x`, `seed x` mapped to the comparable form. */
  readonly objects: ReadonlyMap<string, string>;
  readonly duplicates: readonly string[];
}

function describeSql(sql: string): Described {
  const objects = new Map<string, string>();
  const duplicates: string[] = [];
  const add = (key: string, value: string): void => {
    if (objects.has(key)) duplicates.push(key);
    objects.set(key, value);
  };
  for (const raw of statementsOf(sql)) {
    const statement = normalise(expandCheckMacros(raw));
    const table = /^CREATE TABLE (\w+)\(/.exec(statement);
    const index = /^CREATE (?:UNIQUE )?INDEX (\w+) /.exec(statement);
    const trigger = /^CREATE TRIGGER (\w+) /.exec(statement);
    const seed = /^INSERT INTO (\w+)\(/.exec(statement);
    if (table?.[1] !== undefined) add(`table ${table[1]}`, JSON.stringify(clausesOf(statement)));
    else if (index?.[1] !== undefined) add(`index ${index[1]}`, statement);
    else if (trigger?.[1] !== undefined) add(`trigger ${trigger[1]}`, statement);
    else if (seed?.[1] !== undefined) add(`seed ${seed[1]}`, statement);
    else add(`other ${statement.slice(0, 40)}`, statement);
  }
  return { objects, duplicates };
}

/** Throws unless the document's SQL and the migration create the same objects, clause by clause. */
function assertDocumentAgrees(documented: string, committed: string): void {
  const left = describeSql(documented);
  const right = describeSql(committed);
  const problems: string[] = [];
  for (const duplicate of [...left.duplicates, ...right.duplicates]) {
    problems.push(`${duplicate} is created twice`);
  }
  for (const [key, value] of left.objects) {
    const other = right.objects.get(key);
    if (other === undefined) problems.push(`${key} is in the document and not in the migration`);
    else if (other !== value)
      problems.push(`${key} differs between the document and the migration`);
  }
  for (const key of right.objects.keys()) {
    if (!left.objects.has(key)) problems.push(`${key} is in the migration and not in the document`);
  }
  if (problems.length > 0) throw new Error(`document and migration differ: ${problems.join('; ')}`);
}

describe('data-model.md section 5 and drizzle/0001_phase_b.sql agree (FR-B-701)', () => {
  const documented = documentedSql(dataModel);

  it('describes 17 tables, 9 indexes, 29 triggers and 4 seed inserts', () => {
    const { objects } = describeSql(documented);
    const kinds = [...objects.keys()].map((key) => key.split(' ')[0]);
    expect(kinds.filter((kind) => kind === 'table')).toHaveLength(17);
    expect(kinds.filter((kind) => kind === 'index')).toHaveLength(9);
    expect(kinds.filter((kind) => kind === 'trigger')).toHaveLength(29);
    expect(kinds.filter((kind) => kind === 'seed')).toHaveLength(4);
    expect(kinds.filter((kind) => kind === 'other')).toHaveLength(0);
  });

  it('matches the committed migration object by object', () => {
    expect(() => {
      assertDocumentAgrees(documented, migration);
    }).not.toThrow();
  });

  it('expands every macro: the document block contains macros, the committed file none', () => {
    expect(documented).toMatch(/\b(?:GUID|ISO|HEX|JSONOBJ)\(/);
    expect(migration).not.toMatch(/\b(?:GUID|ISO|HEX|JSONOBJ)\(/);
  });
});

describe('the document guard (negative fixtures)', () => {
  const documented = documentedSql(dataModel);
  const guard = (changed: string): void => {
    assertDocumentAgrees(changed, migration);
  };

  it('fails when a constant of the document differs', () => {
    expect(documented).toContain('BETWEEN 0 AND 49');
    expectGuardFails(guard, documented.replace('BETWEEN 0 AND 49', 'BETWEEN 0 AND 48'), {
      name: 'document guard',
      reason: 'table rbac_assignment_scope differs between the document and the migration',
    });
  });

  it('fails when a macro argument of the document differs', () => {
    expect(documented).toContain('HEX(`install_id`, 32)');
    expectGuardFails(guard, documented.replace('HEX(`install_id`, 32)', 'HEX(`install_id`, 31)'), {
      name: 'document guard',
      reason: 'table setup_state differs',
    });
  });

  it('fails when a column or a trigger is missing from the document, or one is extra', () => {
    expectGuardFails(guard, documented.replace('\t`holder` text NOT NULL,\n', ''), {
      name: 'document guard',
      reason: 'table runner_lease differs',
    });
    expectGuardFails(
      guard,
      documented.replace(/CREATE TRIGGER `setup_state_no_delete`[\s\S]*?END;\n/, ''),
      {
        name: 'document guard',
        reason: 'trigger setup_state_no_delete is in the migration and not in the document',
      },
    );
    expectGuardFails(
      guard,
      `${documented}\n--> statement-breakpoint\nCREATE INDEX \`extra\` ON \`secret\` (\`purpose\`);\n`,
      { name: 'document guard', reason: 'index extra is in the document and not in the migration' },
    );
  });

  it('fails when a seed differs', () => {
    expectGuardFails(guard, documented.replace("(1, 'owner', 1, 1,", "(1, 'boss', 1, 1,"), {
      name: 'document guard',
      reason: 'seed rbac_role differs',
    });
  });

  it('fails on a block of the document that does not exist', () => {
    expect(() => documentedSql('no markers here')).toThrow('no migration-0001 markers');
  });

  it('fails when the migration is edited and the document is not (the other direction)', () => {
    const edited = migration.replace('BETWEEN 0 AND 49', 'BETWEEN 0 AND 48');
    expectGuardFails(
      (text: string) => {
        assertDocumentAgrees(documented, text);
      },
      edited,
      { name: 'document guard', reason: 'table rbac_assignment_scope differs' },
    );
  });
});

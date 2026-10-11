// T-B-010, FR-B-701, FR-B-702, PB-26: the four CHECK macros of `db/check-macros.ts` return exactly
// the SQL fragments of data-model section 4; run on an in-memory SQLite they accept the valid and
// refuse the invalid strings; `expandCheckMacros` expands the notation of data-model section 5 and
// only that; and no CHECK of the Phase B schema lists a value that later phases extend.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expectGuardFails } from '@m365portal/shared/testing';
import Database from 'better-sqlite3';
import { SQLiteSyncDialect, getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import { expandCheckMacros, guid, hex, iso, jsonObject } from '../src/db/check-macros.js';
import * as phaseB from '../src/db/schema/phase-b.js';

const dataModel = readFileSync(
  fileURLToPath(new URL('../../../specs/002-phase-b/data-model.md', import.meta.url)),
  'utf8',
);

/** The right-hand side of a line `NAME(args)   <sql>` in the text block of data-model section 4. */
function documentedFragment(head: string): string {
  const escaped = head.replace(/[()]/g, '\\$&');
  const match = new RegExp(`^${escaped}\\s+(.+)$`, 'm').exec(dataModel);
  if (match?.[1] === undefined) throw new Error(`data-model.md has no definition line for ${head}`);
  return match[1].trim();
}

describe('the macros return the fragments of data-model section 4 exactly', () => {
  it('GUID(c)', () => {
    expect(guid('c')).toBe(documentedFragment('GUID(c)'));
  });

  it('ISO(c)', () => {
    expect(iso('c')).toBe(documentedFragment('ISO(c)'));
  });

  it('HEX(c, n)', () => {
    expect(hex('c', 7)).toBe(
      documentedFragment('HEX(c, n)').replaceAll('n)', '7)').replace(/= n /, '= 7 '),
    );
    expect(hex('c', 7)).toBe("(length(c) = 7 AND c NOT GLOB '*[^0-9a-f]*')");
  });

  it('JSONOBJ(c, m)', () => {
    expect(jsonObject('c', 99)).toBe(
      documentedFragment('JSONOBJ(c, m)').replace(/<= m\)/, '<= 99)'),
    );
  });

  it('substitutes the argument everywhere it appears', () => {
    expect(guid('`oid`').match(/`oid`/g)).toHaveLength(2);
    expect(hex('`h`', 64).match(/`h`/g)).toHaveLength(2);
    expect(jsonObject('`d`', 10).match(/`d`/g)).toHaveLength(3);
  });
});

/** A one-column table with the CHECK under test; `insert` reports whether SQLite accepted a value. */
function accepts(check: (column: string) => string, value: unknown): boolean {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE t (v ANY, CHECK (${check('`v`')}))`);
    try {
      db.prepare('INSERT INTO t (v) VALUES (?)').run(value);
      return true;
    } catch (error) {
      if ((error as { code?: string }).code === 'SQLITE_CONSTRAINT_CHECK') return false;
      throw error;
    }
  } finally {
    db.close();
  }
}

describe('run on an in-memory SQLite', () => {
  const GOOD_GUID = '14d82eec-204b-4c2f-b7e8-296a70dab67e';

  it.each([
    GOOD_GUID,
    '00000000-0000-0000-0000-000000000000',
    'ffffffff-ffff-ffff-ffff-ffffffffffff',
  ])('GUID accepts %s', (value) => {
    expect(accepts(guid, value)).toBe(true);
  });

  it.each([
    ['upper case', GOOD_GUID.toUpperCase()],
    ['35 characters', GOOD_GUID.slice(1)],
    ['37 characters', `${GOOD_GUID}0`],
    ['braces', `{${GOOD_GUID}}`],
    ['no hyphens', GOOD_GUID.replaceAll('-', '')],
    ['a non-hex letter', `g${GOOD_GUID.slice(1)}`],
    ['misplaced hyphens', GOOD_GUID.replace('-204b-', '204b--')],
    ['the empty string', ''],
  ])('GUID rejects %s', (_label, value) => {
    expect(accepts(guid, value)).toBe(false);
  });

  it('ISO accepts the Phase A time shape and refuses every other shape', () => {
    for (const value of ['2026-10-10T12:00:00.000Z', '1999-01-01T00:00:00.999Z']) {
      expect(accepts(iso, value), value).toBe(true);
    }
    for (const value of [
      '2026-10-10T12:00:00Z',
      '2026-10-10T12:00:00.00Z',
      '2026-10-10 12:00:00.000Z',
      '2026-10-10T12:00:00.000+00:00',
      '2026-10-10T12:00:00.000z',
      '26-10-10T12:00:00.000Z',
      '2026-10-10T12:00:00.000Z ',
      '',
    ]) {
      expect(accepts(iso, value), JSON.stringify(value)).toBe(false);
    }
  });

  it('ISO is a shape check, not a calendar check (the writers use toISOString)', () => {
    expect(accepts(iso, '2026-13-45T25:61:61.000Z')).toBe(true);
  });

  it('HEX accepts exactly n lower-case hexadecimal characters', () => {
    const check = (c: string): string => hex(c, 4);
    expect(accepts(check, 'abcd')).toBe(true);
    expect(accepts(check, '0123')).toBe(true);
    for (const value of ['abc', 'abcde', 'ABCD', 'abcg', 'abc ', '']) {
      expect(accepts(check, value), JSON.stringify(value)).toBe(false);
    }
    const sha256 = (c: string): string => hex(c, 64);
    expect(accepts(sha256, 'a'.repeat(64))).toBe(true);
    expect(accepts(sha256, 'a'.repeat(63))).toBe(false);
    expect(accepts(sha256, 'a'.repeat(65))).toBe(false);
  });

  it('JSONOBJ accepts an object within the byte limit and refuses everything else', () => {
    const check = (c: string): string => jsonObject(c, 20);
    expect(accepts(check, '{}')).toBe(true);
    expect(accepts(check, '{"a":1}')).toBe(true);
    for (const value of [
      '[]',
      '[1]',
      '"text"',
      '1',
      'null',
      'not json',
      '',
      '{"a":',
      '{"abcdefghijklmnop":1}',
    ]) {
      expect(accepts(check, value), JSON.stringify(value)).toBe(false);
    }
  });

  it('JSONOBJ counts UTF-8 bytes, not characters', () => {
    const check = (c: string): string => jsonObject(c, 12);
    // {"a":"éé"} is 10 characters and 12 bytes; with one more é it is 11 characters and 14 bytes.
    expect(accepts(check, '{"a":"éé"}')).toBe(true);
    expect(accepts(check, '{"a":"ééé"}')).toBe(false);
    expect(accepts(check, '{"a":"eee"}')).toBe(true);
  });

  it('JSONOBJ and the others refuse a non-text value in the way the schema needs', () => {
    expect(accepts(guid, 5)).toBe(false);
    expect(accepts((c) => hex(c, 1), 5)).toBe(false);
  });
});

describe('expandCheckMacros', () => {
  it('expands the four macros of data-model section 5', () => {
    expect(expandCheckMacros('GUID(`oid`)')).toBe(guid('`oid`'));
    expect(expandCheckMacros('ISO(`updated_at`)')).toBe(iso('`updated_at`'));
    expect(expandCheckMacros('HEX(`install_id`, 32)')).toBe(hex('`install_id`', 32));
    expect(expandCheckMacros('JSONOBJ(`detail`, 4096)')).toBe(jsonObject('`detail`', 4096));
  });

  it('expands each occurrence inside a longer expression and leaves the rest alone', () => {
    const input =
      'CHECK ((`tenant_id` IS NULL OR GUID(`tenant_id`)) AND (`verified_at` IS NULL OR ISO(`verified_at`)) AND `x` IN (1, 2))';
    const output = expandCheckMacros(input);
    expect(output).toContain(guid('`tenant_id`'));
    expect(output).toContain(iso('`verified_at`'));
    expect(output).toContain('`x` IN (1, 2)');
    expect(output).not.toMatch(/\b(?:GUID|ISO|HEX|JSONOBJ)\(/);
  });

  it('only that: other text, lower-case functions and malformed macros are not touched', () => {
    for (const text of [
      'length(`a`) = 4',
      "hex(substr(`blob`, 1, 1)) = '01'",
      'json_valid(`x`) = 1',
      'GUID()',
      'GUID(`a`, 3)',
      'HEX(`a`)',
      'JSONOBJ(`a`)',
      'ISO(`a`, 3)',
      'XGUID(`a`)',
      'GUIDS(`a`)',
      'MD5(`a`)',
      '-- GUID is a word',
    ]) {
      expect(expandCheckMacros(text), text).toBe(text);
    }
  });

  it('is idempotent: an expanded text contains no macro', () => {
    const once = expandCheckMacros('GUID(`a`) AND HEX(`b`, 16)');
    expect(expandCheckMacros(once)).toBe(once);
  });
});

// ---------------------------------------------------------------------------------------------
// FR-B-702: no CHECK lists a value that later phases extend
// ---------------------------------------------------------------------------------------------

const dialect = new SQLiteSyncDialect();

function checkTexts(table: SQLiteTable): { name: string; sql: string }[] {
  return getTableConfig(table).checks.map((check) => ({
    name: check.name,
    sql: dialect.sqlToQuery(check.value).sql,
  }));
}

/** Throws when one of `checks` lists values of a column that is validated by a registry. */
function assertNoValueList(
  checks: readonly { name: string; sql: string }[],
  columns: readonly string[],
): void {
  const problems: string[] = [];
  for (const { name, sql } of checks) {
    for (const column of columns) {
      // A list of values (`col IN (...)`). A single comparison such as the qualifier rule
      // (`permission = 'users:read'`) restricts a combination and is not a list.
      const lists = new RegExp(`\`${column}\`\\s+(?:NOT\\s+)?IN\\s*\\(`, 'i').test(sql);
      if (lists) problems.push(`${name} lists values of ${column}`);
    }
  }
  if (problems.length > 0) throw new Error(problems.join('; '));
}

describe('no CHECK lists a value that later phases extend (FR-B-702, DM-04)', () => {
  const TABLES: readonly (readonly [string, SQLiteTable, readonly string[]])[] = [
    ['setup_step', phaseB.setupStep, ['step', 'sub_action', 'error_code', 'rollback_hint_key']],
    ['setup_object', phaseB.setupObject, ['kind']],
    ['setup_log', phaseB.setupLog, ['step', 'message_key']],
    ['rbac_role_permission', phaseB.rbacRolePermission, ['permission']],
    ['secret', phaseB.secret, ['purpose']],
  ];

  it.each(TABLES)('%s validates its extensible columns by shape only', (_name, table, columns) => {
    expect(() => {
      assertNoValueList(checkTexts(table), columns);
    }).not.toThrow();
  });

  it('the guard fails on a CHECK that lists the steps or the permissions (negative fixtures)', () => {
    expectGuardFails(
      assertNoValueList,
      [{ name: 'setup_step_step', sql: "`step` IN ('environment', 'connect', 'configure')" }],
      { name: 'value-list guard', reason: 'setup_step_step lists values of step' },
    );
    // The guard is called with the columns of the table under test; here the second argument is
    // applied to a list built by hand.
    const guard = (checks: { name: string; sql: string }[]): void => {
      assertNoValueList(checks, ['step']);
    };
    expectGuardFails(guard, [{ name: 'c', sql: "`step` NOT IN ('finish')" }], {
      name: 'value-list guard',
      reason: 'c lists values of step',
    });
  });

  it('the closed sets that will not grow do use CHECK (state, mode, status, level, origin, ...)', () => {
    const all = [
      phaseB.setupState,
      phaseB.setupStep,
      phaseB.setupObject,
      phaseB.setupLog,
      phaseB.certificate,
      phaseB.session,
      phaseB.rbacAssignment,
      phaseB.rbacAssignmentScope,
    ].flatMap(checkTexts);
    const text = all.map((check) => check.sql).join('\n');
    for (const set of [
      "`state` IN ('unconfigured', 'in_progress', 'awaiting_first_signin', 'completed')",
      "`mode` IN ('automatic', 'manual')",
      "`status` IN ('pending', 'running', 'waiting', 'succeeded', 'warning', 'failed', 'skipped')",
      "`level` IN ('info', 'warn', 'error')",
      "`origin` IN ('created', 'adopted')",
      "`state` IN ('pending', 'active', 'retired')",
      "`kind` IN ('user', 'break_glass')",
      "`principal_type` IN ('user', 'group')",
      "`source` IN ('wizard', 'api', 'break_glass')",
    ]) {
      expect(text, set).toContain(set);
    }
  });
});

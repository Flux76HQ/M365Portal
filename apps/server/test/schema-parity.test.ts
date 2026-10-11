// T-A-036: FR-A-062 (source-level parity, data-model 8.5, baseline section 2).
//
// `drizzle-kit export` renders the TypeScript schema; the migrations are SQL that a person reviewed
// and sometimes edited. A default is stated in both places (`.default(0)` and `DEFAULT 0`), and a
// fresh install reads only the first while an upgrade reads the second: the table is correct on a
// new machine and wrong on every existing one. This test builds one database from each side and
// compares tables, columns, types, NOT NULL, defaults, indexes and foreign keys. Triggers are left
// out: they are hand-written migration SQL, the export cannot render them, and the snapshots and the
// upgrade harness (T-A-038) cover them.
//
// Negative fixtures (tasks.md section 0.3): a guard nobody has seen fail is an assumption. The
// migration is rewritten in four ways that each break one thing the guard compares, and every
// rewrite must make it throw. The first is the one the baseline names: a SQL `DEFAULT` that differs
// from the schema's `.default()`.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expectGuardFails } from '@m365portal/shared/testing';
import Database from 'better-sqlite3';
import { beforeAll, describe, expect, it } from 'vitest';
import { migrateScratchDatabase, PACKAGE_DIR, defaultPaths } from '../scripts/schema-snapshot.js';
import type { SqliteConnection } from '../src/db/open.js';
import {
  assertSchemasAgree,
  describeSchema,
  diffSchemas,
  SchemaMismatchError,
} from './helpers/schema-compare.js';

const MIGRATIONS = defaultPaths().migrationsFolder;
const STATEMENT_BREAKPOINT = '--> statement-breakpoint';

/** The DDL `drizzle-kit export` renders from `src/db/schema.ts`. */
function exportedSchemaSql(): string {
  return execFileSync(
    process.execPath,
    [
      join(PACKAGE_DIR, 'node_modules', 'drizzle-kit', 'bin.cjs'),
      'export',
      '--dialect',
      'sqlite',
      '--schema',
      './src/db/schema.ts',
    ],
    { cwd: PACKAGE_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 },
  );
}

function databaseFromSql(sql: string): SqliteConnection {
  const db = new Database(':memory:');
  db.exec(sql);
  return db;
}

/**
 * A database built from migration SQL texts rather than from the folder (for the fixtures): the
 * texts in order, each split on the breakpoint, the way the wrapper applies them.
 */
function databaseFromMigrationTexts(texts: readonly string[]): SqliteConnection {
  const db = new Database(':memory:');
  for (const text of texts) {
    for (const statement of text.split(STATEMENT_BREAKPOINT)) db.exec(statement);
  }
  return db;
}

describe('the TypeScript schema and the migrations describe the same database (FR-A-062)', () => {
  let exportedSql = '';
  let migrationText = '';
  let phaseBText = '';
  let fromSchema: SqliteConnection;
  let fromMigrations: SqliteConnection;

  beforeAll(() => {
    exportedSql = exportedSchemaSql();
    migrationText = readFileSync(join(MIGRATIONS, '0000_init.sql'), 'utf8');
    phaseBText = readFileSync(join(MIGRATIONS, '0001_phase_b.sql'), 'utf8');
    fromSchema = databaseFromSql(exportedSql);
    fromMigrations = new Database(':memory:');
    migrateScratchDatabase(fromMigrations, MIGRATIONS);
    return () => {
      fromSchema.close();
      fromMigrations.close();
    };
  }, 90_000);

  it('exports DDL for the three tables of Phase A and the 17 of Phase B and nothing else', () => {
    const described = describeSchema(fromSchema);
    expect(Object.keys(described.tables).sort()).toEqual(
      [
        'app_user',
        'audit_log',
        'branding',
        'branding_asset',
        'certificate',
        'rbac_assignment',
        'rbac_assignment_scope',
        'rbac_epoch',
        'rbac_group_member_cache',
        'rbac_role',
        'rbac_role_permission',
        'rbac_role_template',
        'runner_lease',
        'secret',
        'session',
        'setup_log',
        'setup_object',
        'setup_state',
        'setup_step',
        'tenant_connection',
      ].sort(),
    );
  });

  it('agrees on tables, columns, types, NOT NULL, defaults, indexes and foreign keys', () => {
    expect(diffSchemas(describeSchema(fromSchema), describeSchema(fromMigrations))).toEqual([]);
    expect(() => {
      assertSchemasAgree(fromSchema, fromMigrations);
    }).not.toThrow();
  });

  it('leaves the triggers out: only the migrations have them', () => {
    expect(Object.keys(describeSchema(fromSchema, { triggers: true }).triggers)).toEqual([]);
    const triggers = Object.keys(describeSchema(fromMigrations, { triggers: true }).triggers);
    // Three of Phase A and the 29 of Phase B (`migrations.phase-b.test.ts` names them).
    expect(triggers).toHaveLength(3 + 29);
    expect(triggers.filter((name) => name.startsWith('audit_log_')).sort()).toEqual([
      'audit_log_chain_link',
      'audit_log_no_delete',
      'audit_log_no_update',
    ]);
  });

  it('compares the named CHECK constraints by their normalised text (FR-B-702)', () => {
    const description = describeSchema(fromMigrations);
    expect(Object.keys(description.tables.rbac_epoch?.checks ?? {}).sort()).toEqual([
      'rbac_epoch_singleton',
      'rbac_epoch_value',
    ]);
    expect(description.tables.rbac_epoch?.checks.rbac_epoch_value).toBe('`epoch` >= 0');
    // A CHECK with nested parentheses and quoted text is read whole.
    expect(description.tables.rbac_assignment_scope?.checks.rbac_assignment_scope_match).toContain(
      "`match_by` = 'department'",
    );
    expect(Object.keys(description.tables.branding?.checks ?? {})).toContain('branding_single_row');
  });

  it('compares partial indexes by their WHERE text', () => {
    const indexes = describeSchema(fromMigrations).tables.certificate?.indexes ?? [];
    const active = indexes.find((index) => index.name === 'certificate_one_active');
    expect(active?.partial).toBe(true);
    expect(active?.sql).toContain("WHERE `state` = 'active'");
  });

  it('sees the content of the comparison: it does compare the columns it claims to', () => {
    const description = describeSchema(fromMigrations);
    const branding = description.tables.branding;
    expect(
      branding?.columns.find((column) => column.name === 'logo_compact_derived'),
    ).toMatchObject({
      type: 'INTEGER',
      notNull: true,
      default: '0',
    });
    expect(branding?.foreignKeys).toHaveLength(8);
    expect(branding?.foreignKeys.every((key) => key.onDelete === 'RESTRICT')).toBe(true);
    expect(description.tables.audit_log?.indexes.map((index) => index.name)).toContain(
      'audit_log_hash_uq',
    );
  });

  // -------------------------------------------------------------------------------------------
  // Negative fixtures: each is a migration that was edited by hand, and each must be refused
  // -------------------------------------------------------------------------------------------

  /** Both migrations in order, with the text of migration 0000 replaced by `mutated`. */
  function guard(mutated: string): void {
    const db = databaseFromMigrationTexts([mutated, phaseBText]);
    try {
      assertSchemasAgree(fromSchema, db);
    } finally {
      db.close();
    }
  }

  /** Both migrations in order, with the text of migration 0001 replaced by `mutated`. */
  function guardPhaseB(mutated: string): void {
    const db = databaseFromMigrationTexts([migrationText, mutated]);
    try {
      assertSchemasAgree(fromSchema, db);
    } finally {
      db.close();
    }
  }

  function mutate(from: string, to: string): string {
    expect(migrationText).toContain(from);
    return migrationText.replace(from, to);
  }

  function mutatePhaseB(from: string, to: string): string {
    expect(phaseBText).toContain(from);
    return phaseBText.replace(from, to);
  }

  it('fails when a SQL DEFAULT differs from the schema default (the failure the baseline names)', () => {
    const fixture = mutate(
      '`logo_compact_derived` integer DEFAULT 0 NOT NULL',
      '`logo_compact_derived` integer DEFAULT 1 NOT NULL',
    );
    expectGuardFails(guard, fixture, {
      name: 'schema parity',
      reason: /branding\.logo_compact_derived default: '?0'? against '?1'?/,
    });
    expect(() => {
      guard(fixture);
    }).toThrow(SchemaMismatchError);
  });

  it('fails when a column loses its default', () => {
    expectGuardFails(
      guard,
      mutate("`detail` text DEFAULT '{}' NOT NULL", '`detail` text NOT NULL'),
      {
        name: 'schema parity',
        reason: /audit_log\.detail default/,
      },
    );
  });

  it('fails when NOT NULL differs', () => {
    expectGuardFails(guard, mutate('`org_name` text NOT NULL', '`org_name` text'), {
      name: 'schema parity',
      reason: /branding\.org_name not null/,
    });
  });

  it('fails when a foreign key rule differs', () => {
    expectGuardFails(
      guard,
      mutate(
        'FOREIGN KEY (`logo_light`) REFERENCES `branding_asset`(`sha256`) ON UPDATE no action ON DELETE restrict',
        'FOREIGN KEY (`logo_light`) REFERENCES `branding_asset`(`sha256`) ON UPDATE no action ON DELETE cascade',
      ),
      { name: 'schema parity', reason: /branding foreign keys differ/ },
    );
  });

  it('fails when an index is missing or differs', () => {
    expectGuardFails(
      guard,
      mutate(
        'CREATE INDEX `branding_asset_unreferenced_idx` ON `branding_asset` (`unreferenced_at`) WHERE unreferenced_at IS NOT NULL;',
        'CREATE INDEX `branding_asset_unreferenced_idx` ON `branding_asset` (`unreferenced_at`);',
      ),
      { name: 'schema parity', reason: /branding_asset indexes differ/ },
    );
    expectGuardFails(
      guard,
      mutate('CREATE UNIQUE INDEX `audit_log_hash_uq`', 'CREATE INDEX `audit_log_hash_uq`'),
      { name: 'schema parity', reason: /audit_log indexes differ/ },
    );
  });

  it('fails when a table or a column is missing on either side', () => {
    expectGuardFails(guard, mutate('\t`request_id` text,\n', ''), {
      name: 'schema parity',
      reason: /audit_log\.request_id exists only in the left database/,
    });
  });

  // Phase B (FR-B-702, data-model 12.4): the second negative control. A CHECK constant edited in the
  // migration by hand, or a macro edited in `check-macros.ts` and not regenerated, is a CHECK text
  // that differs from the TypeScript schema's.
  it('fails when a CHECK constant of the migration differs from the schema (Phase B)', () => {
    expectGuardFails(
      guardPhaseB,
      mutatePhaseB(
        'CONSTRAINT "rbac_assignment_scope_position" CHECK(`position` BETWEEN 0 AND 49)',
        'CONSTRAINT "rbac_assignment_scope_position" CHECK(`position` BETWEEN 0 AND 50)',
      ),
      {
        name: 'schema parity',
        reason: /rbac_assignment_scope check rbac_assignment_scope_position differs/,
      },
    );
  });

  it('fails when a CHECK is missing, or added, in the migration', () => {
    expectGuardFails(
      guardPhaseB,
      mutatePhaseB('\tCONSTRAINT "rbac_epoch_value" CHECK(`epoch` >= 0)\n', '').replace(
        'CONSTRAINT "rbac_epoch_singleton" CHECK(`id` = 1),\n',
        'CONSTRAINT "rbac_epoch_singleton" CHECK(`id` = 1)\n',
      ),
      {
        name: 'schema parity',
        reason: /rbac_epoch check rbac_epoch_value exists only in the left/,
      },
    );
  });

  it('fails when a macro changes and the migration is not regenerated', () => {
    // GUID lengths: a macro that wrote 37 instead of 36 would leave every migration CHECK behind.
    expectGuardFails(
      guardPhaseB,
      mutatePhaseB(
        'CHECK((length(`id`) = 36 AND `id` GLOB',
        'CHECK((length(`id`) = 37 AND `id` GLOB',
      ),
      { name: 'schema parity', reason: /check [a-z_]+ differs: \(length\(`id`\) = 36/ },
    );
  });

  it('fails when a partial unique index loses its WHERE (Phase B)', () => {
    expectGuardFails(
      guardPhaseB,
      mutatePhaseB(
        "CREATE UNIQUE INDEX `certificate_one_active` ON `certificate` (`state`) WHERE `state` = 'active';",
        'CREATE UNIQUE INDEX `certificate_one_active` ON `certificate` (`state`);',
      ),
      { name: 'schema parity', reason: /certificate indexes differ/ },
    );
  });

  it('passes the unmodified migration text through the same guard (the fixtures break only what they claim)', () => {
    expect(() => {
      guard(migrationText);
      guardPhaseB(phaseBText);
    }).not.toThrow();
  });
});

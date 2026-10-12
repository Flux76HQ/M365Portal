// A migrated database for the RBAC and policy tests (T-B-238 and after): the real migrations, run
// once per test file into a throwaway directory, then copied in memory for every test, so each test
// starts from the seeded state (five built-in roles, the template, the epoch at 0) and needs no
// clean-up of its own. The handle is the shape the repositories take (`DatabaseHandle`).
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScopeItem } from '@m365portal/shared/rbac/scope';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { onTestFinished } from 'vitest';
import { defaultPaths } from '../../scripts/schema-snapshot.js';
import { runMigrations } from '../../src/db/migrate.js';
import { withTransaction } from '../../src/db/tx.js';
import * as schema from '../../src/db/schema.js';
import type { AppDatabase, DatabaseHandle } from '../../src/db/open.js';
import {
  findRoleByKey,
  insertAssignment,
  scopeHashOf,
  type AssignmentSource,
  type PrincipalType,
} from '../../src/rbac/repository.js';

let image: Promise<Buffer> | undefined;

async function migratedImage(): Promise<Buffer> {
  const directory = await mkdtemp(join(tmpdir(), 'm365portal-rbac-'));
  try {
    const sqlite = new Database(join(directory, 'seed.sqlite'));
    sqlite.pragma('foreign_keys = ON');
    await runMigrations(sqlite, {
      migrationsFolder: defaultPaths().migrationsFolder,
      backupsDir: join(directory, 'backups'),
    });
    const bytes = sqlite.serialize();
    sqlite.close();
    return bytes;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** A fresh in-memory copy of the migrated database, closed when the test ends. */
export async function createMigratedDatabase(): Promise<AppDatabase> {
  image ??= migratedImage();
  const sqlite = new Database(await image);
  sqlite.pragma('foreign_keys = ON');
  const handle: AppDatabase = {
    sqlite,
    orm: drizzle(sqlite, { schema }),
    path: ':memory:',
    close: () => {
      if (sqlite.open) sqlite.close();
    },
  };
  onTestFinished(() => {
    handle.close();
  });
  return handle;
}

// ---------------------------------------------------------------------------------------------
// Rows for the RBAC tests: assignments through the repository, the way the service writes them
// ---------------------------------------------------------------------------------------------

export const TENANT = '11111111-1111-4111-8111-111111111111';

/** A GUID the test can tell apart by its number. */
export function guid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

export interface AssignOptions {
  readonly principalType?: PrincipalType;
  readonly principalId: string;
  readonly role: string;
  readonly scope?: readonly ScopeItem[];
  readonly expiresAt?: string | null;
  readonly source?: AssignmentSource;
  readonly at?: string;
  /** Do nothing, and return the id of the existing row, when the same assignment exists. */
  readonly ifMissing?: boolean;
}

/** Insert an assignment; returns its id. Throws when the role does not exist. */
export function assign(db: DatabaseHandle, options: AssignOptions): string {
  const role = findRoleByKey(db, options.role);
  if (role === undefined) throw new Error(`no role ${options.role}`);
  const id = randomUUID();
  if (options.ifMissing === true) {
    const existing = db.sqlite
      .prepare(
        'SELECT id FROM rbac_assignment WHERE principal_type = ? AND principal_id = ? AND role_id = ? AND scope_hash = ?',
      )
      .get(
        options.principalType ?? 'user',
        options.principalId.toLowerCase(),
        role.id,
        scopeHashOf(options.scope ?? []),
      ) as { id: string } | undefined;
    if (existing !== undefined) return existing.id;
  }
  withTransaction(db, (tx) => {
    insertAssignment(tx, {
      id,
      principalType: options.principalType ?? 'user',
      principalId: options.principalId,
      roleId: role.id,
      expiresAt: options.expiresAt ?? null,
      source: options.source ?? 'api',
      createdAt: options.at ?? '2026-10-11T12:00:00.000Z',
      createdBy: 'test',
      scope: options.scope ?? [],
    });
  });
  return id;
}

/** Make the user known with a resolved group list, the way a sign-in refresh leaves it. */
export function resolveGroups(
  db: DatabaseHandle,
  oid: string,
  groupIds: readonly string[],
  at: string,
): void {
  db.sqlite
    .prepare(
      'INSERT OR REPLACE INTO app_user (tid, oid, upn_label, name_label, first_seen_at, last_signin_at, groups_resolved_at) VALUES (?, ?, NULL, NULL, ?, ?, ?)',
    )
    .run(TENANT, oid, at, at, at);
  db.sqlite.prepare('DELETE FROM rbac_group_member_cache WHERE user_oid = ?').run(oid);
  const insert = db.sqlite.prepare(
    'INSERT INTO rbac_group_member_cache (user_oid, group_id, resolved_at) VALUES (?, ?, ?)',
  );
  for (const groupId of groupIds) insert.run(oid, groupId, at);
}

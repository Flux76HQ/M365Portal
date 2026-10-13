// Direct writes to the data directory of an instance, for the few things the API refuses on purpose
// (T-B-370): an assignment with a past expiry, and a role given to a person before the setup is
// complete. Uses `node:sqlite` (Node 22); the server holds the file open in WAL mode, so a short
// write with a busy timeout is safe. Test support: the product never does this.
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

export const DATABASE_FILE = 'm365portal.sqlite';

function open(dataDir: string): DatabaseSync {
  const database = new DatabaseSync(join(dataDir, DATABASE_FILE));
  database.exec('PRAGMA busy_timeout = 5000');
  return database;
}

/** The hash of an unscoped assignment: the SHA-256 of the canonical key of an empty scope, `[]`. */
const UNSCOPED_HASH = createHash('sha256').update('[]').digest('hex');

export interface DirectAssignment {
  readonly oid: string;
  readonly role: string;
  /** ISO timestamp with milliseconds and `Z`; none means no expiry. */
  readonly expiresAt?: string;
}

/** Gives a user a built-in role, bypassing the API (and its step-up). Returns the assignment id. */
export function insertAssignmentDirectly(dataDir: string, assignment: DirectAssignment): string {
  const database = open(dataDir);
  try {
    const role = database.prepare('SELECT id FROM rbac_role WHERE key = ?').get(assignment.role) as
      { id: string } | undefined;
    if (role === undefined) throw new Error(`no role ${assignment.role} in the database`);
    const id = randomUUID();
    database
      .prepare(
        `INSERT INTO rbac_assignment
           (id, principal_type, principal_id, role_id, scope_hash, expires_at, source, created_at, created_by)
         VALUES (?, 'user', ?, ?, ?, ?, 'api', ?, 'e2e')`,
      )
      .run(
        id,
        assignment.oid.toLowerCase(),
        role.id,
        UNSCOPED_HASH,
        assignment.expiresAt ?? null,
        new Date().toISOString(),
      );
    return id;
  } finally {
    database.close();
  }
}

/** The setup state of the instance, read from its database. */
export function setupStateOf(dataDir: string): string {
  const database = open(dataDir);
  try {
    return (database.prepare('SELECT state FROM setup_state').get() as { state: string }).state;
  } finally {
    database.close();
  }
}

/** Moves every assignment of a user into the past. */
export function expireAssignmentsOf(dataDir: string, oid: string): number {
  const database = open(dataDir);
  try {
    return Number(
      database
        .prepare(
          `UPDATE rbac_assignment SET expires_at = '2020-01-01T00:00:00.000Z'
           WHERE principal_type = 'user' AND principal_id = ?`,
        )
        .run(oid.toLowerCase()).changes,
    );
  } finally {
    database.close();
  }
}

export interface DirectGrant {
  readonly permission: string;
  /** `basic` exists on `users:read` only; none is the full form. */
  readonly qualifier?: 'basic';
}

/**
 * Adds an assignable custom role with the given grants, bypassing the API. The API cannot make a role with
 * the qualifier `basic` in Phase C (the template "board" is not assignable until Phase D), and the e2e
 * specs of the directory need an actor who sees users as name and address only (US-C5).
 */
export function insertCustomRole(
  dataDir: string,
  key: string,
  grants: readonly DirectGrant[],
): void {
  const database = open(dataDir);
  try {
    database.exec('BEGIN IMMEDIATE');
    const created = database
      .prepare(
        'INSERT INTO rbac_role (key, builtin, assignable, created_at) VALUES (?, 0, 1, ?) RETURNING id',
      )
      .get(key, new Date().toISOString()) as { id: number };
    const insert = database.prepare(
      'INSERT INTO rbac_role_permission (role_id, permission, qualifier) VALUES (?, ?, ?)',
    );
    for (const grant of grants) insert.run(created.id, grant.permission, grant.qualifier ?? '');
    database.exec('COMMIT');
  } catch (failure) {
    database.exec('ROLLBACK');
    throw failure;
  } finally {
    database.close();
  }
}

/** Removes the assignments of a role and then the role itself (a custom role made by `insertCustomRole`). */
export function deleteCustomRole(dataDir: string, key: string): void {
  const database = open(dataDir);
  try {
    const role = database
      .prepare('SELECT id FROM rbac_role WHERE key = ? AND builtin = 0')
      .get(key) as { id: number } | undefined;
    if (role === undefined) return;
    database.prepare('DELETE FROM rbac_assignment WHERE role_id = ?').run(role.id);
    database.prepare('DELETE FROM rbac_role WHERE id = ?').run(role.id);
  } finally {
    database.close();
  }
}

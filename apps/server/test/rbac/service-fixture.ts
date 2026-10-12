// A fixture for the tests of the assignment service (T-B-248, T-B-249): a migrated database, a fake
// directory behind a `FakeGraphClient`, a fake clock, a seeded source of randomness, the grants
// service, and a few ways to make an actor. Not a test file.
import { createHash } from 'node:crypto';
import type { Grant } from '@m365portal/shared/rbac/effective';
import type { RolePermission } from '@m365portal/shared/rbac/roles';
import type { ScopeItem } from '@m365portal/shared/rbac/scope';
import { withTransaction } from '../../src/db/index.js';
import { insertRole } from '../../src/rbac/repository.js';
import { createFakeClock } from '../helpers/fake-clock.js';
import type { AppDatabase } from '../../src/db/index.js';
import type { RandomSource } from '../../src/ports/clock.js';
import type { GraphClient } from '../../src/ports/graph.js';
import { createGrantsService, type GrantsService } from '../../src/rbac/grants.js';
import {
  createAssignmentService,
  type AssignmentService,
  type AuditContext,
  type ServiceActor,
} from '../../src/rbac/assignment-service.js';
import { FakeGraphClient } from '../fakes/fake-graph-client.js';
import { FakeDirectory } from '../fakes/fake-tenant/graph/index.js';
import { assign, createMigratedDatabase, TENANT } from '../helpers/rbac-db.js';

/** Deterministic bytes: a counter through SHA-256. */
export function countingRandom(): RandomSource {
  let counter = 0;
  return {
    bytes(length) {
      counter += 1;
      const out = new Uint8Array(length);
      let block = createHash('sha256')
        .update(`seed-${String(counter)}`)
        .digest();
      for (let at = 0; at < length; at += 1) {
        if (at > 0 && at % block.length === 0) block = createHash('sha256').update(block).digest();
        out[at] = block[at % block.length] ?? 0;
      }
      return out;
    },
    float: () => 0,
  };
}

export interface ServiceFixture {
  readonly db: AppDatabase;
  readonly clock: ReturnType<typeof createFakeClock>;
  readonly directory: FakeDirectory;
  readonly fake: FakeGraphClient;
  readonly grants: GrantsService;
  readonly service: AssignmentService;
  /** A user who exists in the directory and in `app_user`. */
  user(upn: string, department?: string): { readonly id: string };
  /** A group that exists in the directory. */
  group(name: string): { readonly id: string };
  /** An actor of kind `user` who holds these built-in or custom roles (unscoped). */
  actorWithRoles(...roles: string[]): ServiceActor;
  /** A custom role with these grants. */
  customRole(key: string, grants: readonly RolePermission[]): void;
  /** An actor of kind `user` holding `role` with this scope (empty: unscoped). */
  actorWithScopedRole(role: string, scope: readonly ScopeItem[]): ServiceActor;
  /** The grants of a user, as the resolver computes them now. */
  grantsOf(oid: string): readonly Grant[];
  audit(): AuditContext;
  auditRows(): { action: string; outcome: string; reason_code: string | null; detail: string }[];
}

export interface FixtureOptions {
  readonly graph?: (fake: FakeGraphClient) => GraphClient;
}

export async function serviceFixture(options: FixtureOptions = {}): Promise<ServiceFixture> {
  const clock = createFakeClock();
  const directory = new FakeDirectory({ clock: { now: () => clock.nowMs() } });
  const fake = new FakeGraphClient(directory);
  const db = await createMigratedDatabase();
  const grants = createGrantsService({ database: () => db, now: () => clock.nowMs() });
  const service = createAssignmentService({
    database: () => db,
    graph: () => options.graph?.(fake) ?? fake,
    now: () => clock.nowMs(),
    random: countingRandom(),
    grantsOf: (actor) => {
      const at = db.sqlite
        .prepare('SELECT groups_resolved_at AS at FROM app_user WHERE oid = ?')
        .get(actor.id) as { at: string | null } | undefined;
      return grants.grantsFor({ oid: actor.id, groupsResolvedAt: at?.at ?? null });
    },
  });

  function known(oid: string): void {
    db.sqlite
      .prepare(
        `INSERT OR IGNORE INTO app_user (tid, oid, upn_label, name_label, first_seen_at, last_signin_at, groups_resolved_at)
         VALUES (?, ?, NULL, 'Test', '2026-10-10T11:00:00.000Z', '2026-10-10T11:00:00.000Z', NULL)`,
      )
      .run(TENANT, oid);
  }
  const grantsOf = (oid: string): readonly Grant[] => {
    const at = db.sqlite
      .prepare('SELECT groups_resolved_at AS at FROM app_user WHERE oid = ?')
      .get(oid) as { at: string | null } | undefined;
    return grants.grantsFor({ oid, groupsResolvedAt: at?.at ?? null });
  };

  return {
    db,
    clock,
    directory,
    fake,
    grants,
    service,
    user(upn, department) {
      const user = directory.addUser({
        userPrincipalName: upn,
        ...(department === undefined ? {} : { department }),
      });
      known(user.id);
      return user;
    },
    group: (name) => directory.addGroup({ displayName: name }),
    actorWithRoles(...roles) {
      const user = directory.addUser({
        userPrincipalName: `actor${String(directory.users.size)}@contoso-fake.example`,
      });
      known(user.id);
      for (const role of roles) assign(db, { principalId: user.id, role });
      return { kind: 'user', id: user.id, grants: grantsOf(user.id) };
    },
    customRole(key, grants) {
      withTransaction(db, (tx) => insertRole(tx, { key, createdAt: clock.iso(), grants }));
    },
    actorWithScopedRole(role, scope) {
      const user = directory.addUser({
        userPrincipalName: `scoped${String(directory.users.size)}@contoso-fake.example`,
      });
      known(user.id);
      assign(db, { principalId: user.id, role, scope });
      return { kind: 'user', id: user.id, grants: grantsOf(user.id) };
    },
    grantsOf,
    audit: () => ({ requestId: 'req-test-0001' }),
    auditRows: () =>
      db.sqlite
        .prepare('SELECT action, outcome, reason_code, detail FROM audit_log ORDER BY seq')
        .all() as { action: string; outcome: string; reason_code: string | null; detail: string }[],
  };
}

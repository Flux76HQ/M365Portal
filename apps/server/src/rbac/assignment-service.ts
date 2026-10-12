// The assignment service (T-B-248, T-B-249, FR-B-508, FR-B-509, FR-B-510, FR-B-515, EB-23, EB-38,
// SC-B-006): creating and deleting assignments, with every rule in the order of contract P29.
//
//   create   the role exists and is assignable -> `owner` takes no scope and no expiry -> a group never
//            gets a role that holds `rbac:manage` or `settings:connection` -> the scope is normalised,
//            at most 50 items, every target used by the role -> `expiresAt` in the future and at most
//            730 days ahead -> EARLY `canGrant` (403 before any Graph traffic) -> the principal exists
//            (`getUser` / `getGroup`: 422, or 503 when Graph is down) -> BEGIN IMMEDIATE: the grants of
//            the actor are read again (a revocation between the request and the write wins), `canGrant`
//            again, the count limits, the duplicate, the insert, the audit entry.
//   remove   the assignment exists -> early `canGrant` for what is removed -> BEGIN IMMEDIATE: grants
//            again, `canGrant` again, the last-Owner rule, delete, audit entry.
//
// The assignment and its audit entry are one transaction: a fault between them rolls both back. The
// limits (5,000 assignments, 100 roles, 200 distinct bound groups, 50 scope items) are rules of this
// service, checked inside the write transaction, and answer 422 `assignment_invalid` with their own
// code; the database does not know them. Ids and times come from the injected random source and
// clock.
//
// A refusal that depends on the rows (`escalation_denied`, `last_owner_protected`) is a `PolicyDenied`,
// which the route wrapper audits and answers. Everything else is a `ProblemError`.
import { LIMITS } from '@m365portal/shared/limits';
import { PERMISSION_RESOURCE } from '@m365portal/shared/permissions';
import { GROUP_FORBIDDEN_PERMISSIONS, type Grant } from '@m365portal/shared/rbac/effective';
import { normalizeScopeItems, type ScopeItem } from '@m365portal/shared/rbac/scope';
import { appendAudit } from '../audit/index.js';
import { withTransaction, type DatabaseHandle, type Tx } from '../db/index.js';
import { ProblemError } from '../http/problem.js';
import type { ActorKind } from '../policy/actor.js';
import { uuidV4, type RandomSource } from '../ports/clock.js';
import type { GraphClient } from '../ports/graph.js';
import { graphProblem } from './graph-problem.js';
import { assertMayGrant, assertNotLastOwner, lastOwnerAbort } from './guards.js';
import {
  countAssignments,
  countRoles,
  deleteAssignment,
  findAssignment,
  findDuplicateAssignment,
  findRoleById,
  findRoleByKey,
  insertAssignment,
  isGroupBound,
  listBoundGroupIds,
  type AssignmentRecord,
  type PrincipalType,
  type RoleRecord,
} from './repository.js';

const DAY_MS = 86_400_000;

/** Who acts, as the service needs it. `grants` are those of the request. */
export interface ServiceActor {
  readonly kind: ActorKind;
  readonly id: string;
  readonly grants: readonly Grant[];
}

/** What the audit entry records about the request. */
export interface AuditContext {
  readonly requestId: string;
  readonly clientIp?: string | undefined;
}

export interface CreateAssignmentInput {
  readonly principalType: PrincipalType;
  readonly principalId: string;
  readonly role: string;
  readonly scope?: readonly unknown[] | undefined;
  readonly expiresAt?: string | null | undefined;
}

export interface AssignmentServiceDeps {
  /** The open database, or a thrown 503. */
  readonly database: () => DatabaseHandle;
  readonly graph: () => GraphClient;
  readonly now: () => number;
  readonly random: RandomSource;
  /** The grants of a `user` actor right now (read inside the write transaction). */
  readonly grantsOf: (actor: ServiceActor) => readonly Grant[];
}

export interface AssignmentService {
  create(
    actor: ServiceActor,
    input: CreateAssignmentInput,
    audit: AuditContext,
  ): Promise<AssignmentRecord>;
  remove(actor: ServiceActor, id: string, audit: AuditContext): Promise<AssignmentRecord>;
}

function invalid(pointer: string, code: string): ProblemError {
  return new ProblemError('assignment_invalid', { errors: [{ pointer, code }] });
}

/** For the creation of a role (Phase D): refuses the 101st role, the built-in five included. */
export function assertRoleCapacity(db: DatabaseHandle): void {
  if (countRoles(db) >= LIMITS.rbac.rolesMax) throw invalid('', 'roles_limit');
}

function scopeTargetsOf(scope: readonly ScopeItem[]): string[] {
  return [...new Set(scope.map((item) => item.target))].sort();
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE'
  );
}

export function createAssignmentService(deps: AssignmentServiceDeps): AssignmentService {
  const iso = (): string => new Date(deps.now()).toISOString();

  /** The grants of the actor at the moment of the write. */
  function grantsNow(actor: ServiceActor): readonly Grant[] {
    return actor.kind === 'user' ? deps.grantsOf(actor) : actor.grants;
  }

  function validateScope(role: RoleRecord, raw: readonly unknown[] | undefined): ScopeItem[] {
    const result = normalizeScopeItems(raw ?? []);
    if (!result.ok) {
      throw invalid(
        result.index === null ? '/scope' : `/scope/${String(result.index)}`,
        result.reason === 'too_many_items' ? 'scope_items_limit' : 'scope_invalid',
      );
    }
    const used = new Set(
      role.grants.map((entry) => PERMISSION_RESOURCE[entry.permission]).filter((t) => t !== null),
    );
    // A scope on a role that has no permission for the item's target changes nothing: refused.
    if (result.items.some((item) => !used.has(item.target))) {
      throw invalid('/scope', 'scope_target_unused');
    }
    return [...result.items];
  }

  function validateExpiry(role: RoleRecord, expiresAt: string | null | undefined): string | null {
    if (expiresAt === undefined || expiresAt === null) return null;
    if (role.key === 'owner') throw invalid('/expiresAt', 'owner_expiry');
    const at = Date.parse(expiresAt);
    const now = deps.now();
    if (
      !Number.isFinite(at) ||
      at <= now ||
      at > now + LIMITS.rbac.assignmentExpiryMaxDays * DAY_MS
    ) {
      throw invalid('/expiresAt', 'expiry_invalid');
    }
    return new Date(at).toISOString();
  }

  async function assertPrincipalExists(input: CreateAssignmentInput): Promise<void> {
    let found: unknown;
    try {
      const graph = deps.graph();
      found =
        input.principalType === 'user'
          ? await graph.getUser(input.principalId, { priority: 'high' })
          : await graph.getGroup(input.principalId);
    } catch (error) {
      throw graphProblem(error);
    }
    if (found === null) throw new ProblemError('principal_unknown');
  }

  function assertLimits(
    tx: Tx,
    input: CreateAssignmentInput,
    scope: readonly ScopeItem[],
    principalId: string,
  ): void {
    if (scope.length > LIMITS.rbac.scopeItemsPerAssignmentMax) {
      throw invalid('/scope', 'scope_items_limit');
    }
    if (countAssignments(tx) >= LIMITS.rbac.assignmentsMax) throw invalid('', 'assignments_limit');
    if (
      input.principalType === 'group' &&
      !isGroupBound(tx, principalId) &&
      listBoundGroupIds(tx).length >= LIMITS.rbac.groupsBoundMax
    ) {
      throw invalid('/principalId', 'groups_limit');
    }
  }

  return {
    async create(actor, input, audit) {
      const db = deps.database();
      const principalId = input.principalId.toLowerCase();

      // 2. The role exists and is assignable (a template key is not a role).
      const role = findRoleByKey(db, input.role);
      if (role === undefined) throw invalid('/role', 'role_unknown');
      if (!role.assignable) throw invalid('/role', 'role_not_assignable');

      // 3. `owner` takes no scope and no expiry.
      if (role.key === 'owner') {
        if ((input.scope ?? []).length > 0) throw invalid('/scope', 'owner_scope');
        if (input.expiresAt !== undefined && input.expiresAt !== null) {
          throw invalid('/expiresAt', 'owner_expiry');
        }
      }

      // 4. A group is not trusted with the control plane (FR-B-515).
      if (
        input.principalType === 'group' &&
        role.grants.some((entry) =>
          (GROUP_FORBIDDEN_PERMISSIONS as readonly string[]).includes(entry.permission),
        )
      ) {
        throw invalid('/role', 'privileged_role_group');
      }

      // 5. The scope. 6. The expiry.
      const scope = validateScope(role, input.scope);
      const expiresAt = validateExpiry(role, input.expiresAt);

      // 7. Early canGrant: a refusal costs no Graph traffic.
      assertMayGrant(actor.grants, role.grants, scope);

      // 8. The principal exists.
      await assertPrincipalExists({ ...input, principalId });

      // 9. The write.
      const id = uuidV4(deps.random);
      try {
        return withTransaction(db, (tx) => {
          const fresh = findRoleById(tx, role.id);
          if (fresh === undefined) throw invalid('/role', 'role_unknown');
          assertMayGrant(grantsNow(actor), fresh.grants, scope);
          assertLimits(tx, input, scope, principalId);
          if (
            findDuplicateAssignment(tx, {
              principalType: input.principalType,
              principalId,
              roleId: fresh.id,
              scope,
            }) !== undefined
          ) {
            throw new ProblemError('assignment_exists');
          }
          const createdAt = iso();
          insertAssignment(tx, {
            id,
            principalType: input.principalType,
            principalId,
            roleId: fresh.id,
            expiresAt,
            source: 'api',
            createdAt,
            createdBy: actor.id,
            scope,
          });
          appendAudit(tx, {
            ts: createdAt,
            actorKind: actor.kind,
            actorId: actor.id,
            action: 'rbac.assignment.create',
            targetType: 'rbac_assignment',
            targetId: id,
            outcome: 'success',
            ...(audit.clientIp === undefined ? {} : { clientIp: audit.clientIp }),
            requestId: audit.requestId,
            detail: {
              principalType: input.principalType,
              principalId,
              role: fresh.key,
              scopeTargets: scopeTargetsOf(scope),
              scopeItems: scope.length,
              ...(expiresAt === null ? {} : { expiresAt }),
              source: 'api',
            },
          });
          const stored = findAssignment(tx, id);
          if (stored === undefined)
            throw new Error('the assignment that was just inserted is missing');
          return stored;
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw new ProblemError('assignment_exists');
        throw error;
      }
    },

    remove(actor, id, audit) {
      const db = deps.database();
      const current = findAssignment(db, id);
      if (current === undefined) return Promise.reject(new ProblemError('not_found'));
      const role = findRoleById(db, current.roleId);
      if (role === undefined) return Promise.reject(new ProblemError('not_found'));
      try {
        // Early: nobody removes what they could not grant.
        assertMayGrant(actor.grants, role.grants, current.scope);
        return Promise.resolve(
          withTransaction(db, (tx) => {
            const record = findAssignment(tx, id);
            if (record === undefined) throw new ProblemError('not_found');
            const fresh = findRoleById(tx, record.roleId);
            if (fresh === undefined) throw new ProblemError('not_found');
            assertMayGrant(grantsNow(actor), fresh.grants, record.scope);
            assertNotLastOwner(tx, record);
            try {
              deleteAssignment(tx, record.id);
            } catch (error) {
              throw lastOwnerAbort(error) ?? error;
            }
            appendAudit(tx, {
              ts: iso(),
              actorKind: actor.kind,
              actorId: actor.id,
              action: 'rbac.assignment.delete',
              targetType: 'rbac_assignment',
              targetId: record.id,
              outcome: 'success',
              ...(audit.clientIp === undefined ? {} : { clientIp: audit.clientIp }),
              requestId: audit.requestId,
              detail: {
                principalType: record.principalType,
                principalId: record.principalId,
                role: record.roleKey,
                reason: 'revoked',
              },
            });
            return record;
          }),
        );
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error('unexpected'));
      }
    },
  };
}

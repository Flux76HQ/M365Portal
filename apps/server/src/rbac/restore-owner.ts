// `POST /api/v1/rbac/restore-owner`, the break-glass recovery path (T-B-252, FR-B-523, SC-B-010, US-B10,
// P32). Only a break-glass session may call it (`actorKinds`); any other actor, an Owner included, gets 403
// `permission_denied`, audited by the wrapper.
//
//   1. `getUser(userId)`: unknown is 422 `principal_unknown`; `accountEnabled` false is 422
//      `principal_unknown` with `errors[]` code `principal_disabled`; Graph unavailable is 503 unless
//      `confirmUnverified` is true, in which case the id is taken as typed (`graphChecked` false).
//      A confirmed id that Graph then reports as unknown or disabled is still refused: the operator
//      accepts an answer that is missing, not one that says no.
//   2. One transaction inserts the `owner` assignment (user principal, source `break_glass`, created by
//      `break-glass`, no scope, no expiry) and the audit entry. An existing Owner assignment is 409.
//
// It is the only path that skips `canGrant`: the break-glass session holds `rbac:manage` and nothing a
// role grants, so `canGrant` would refuse it, and that is the point of the account.
import { RestoreOwnerRequestSchema, AssignmentSchema } from '@m365portal/shared/schemas/rbac';
import { appendAudit } from '../audit/index.js';
import { withTransaction } from '../db/index.js';
import { ProblemError } from '../http/problem.js';
import { defineRoute, type RouteDefinition } from '../http/route.js';
import { uuidV4 } from '../ports/clock.js';
import { auditContextOf, problemAnswer, type RbacContext } from './context.js';
import { graphProblem } from './graph-problem.js';
import {
  findAssignment,
  findDuplicateAssignment,
  findRoleByKey,
  insertAssignment,
  listRoles,
} from './repository.js';
import { assignmentToWire } from './wire.js';

const UNSCOPED_REASON =
  'rbac:manage is a global-only permission: it has no resource type, so no scope applies';

/** The `created_by` of an assignment the recovery path writes. */
export const BREAK_GLASS_CREATOR = 'break-glass';

export function restoreOwnerRoutes(ctx: RbacContext): RouteDefinition[] {
  const { deps } = ctx;

  return [
    defineRoute({
      id: 'rbac.restore.owner',
      method: 'POST',
      path: '/api/v1/rbac/restore-owner',
      access: {
        permission: 'rbac:manage',
        actorKinds: ['break_glass'],
        unscopedReason: UNSCOPED_REASON,
      },
      rateLimit: 'write',
      audit: 'rbac.owner.restore',
      summary: 'Restore an Owner (break-glass)',
      description:
        'Gives a user the role owner. Only a break-glass session may call it. The user is checked in the directory (unknown or disabled accounts are refused); when Graph is down the operator can confirm the id. The only path that skips the escalation check.',
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: RestoreOwnerRequestSchema } },
        },
      },
      responses: {
        201: {
          description: 'The owner assignment.',
          content: { 'application/json': { schema: AssignmentSchema } },
        },
        403: problemAnswer('Not a break-glass session.'),
        409: problemAnswer('The user already holds owner.'),
        422: problemAnswer('The user is unknown or disabled.'),
        503: problemAnswer('Graph or storage is unavailable.'),
      },
      handler: async (c, input) => {
        const userId = input.body.userId.toLowerCase();
        const actor = c.get('actor');
        const audit = auditContextOf(c);

        let graphChecked = true;
        try {
          const user = await deps.clients.graph().getUser(userId, { priority: 'high' });
          if (user === null) throw new ProblemError('principal_unknown');
          if (user.accountEnabled === false) {
            throw new ProblemError('principal_unknown', {
              errors: [{ pointer: '/userId', code: 'principal_disabled' }],
            });
          }
        } catch (error) {
          if (error instanceof ProblemError) throw error;
          const problem = graphProblem(error);
          if (input.body.confirmUnverified !== true) throw problem;
          graphChecked = false;
        }

        const db = deps.requireDatabase();
        const role = findRoleByKey(db, 'owner');
        if (role === undefined) throw new Error('the built-in role owner is missing');
        const id = uuidV4(deps.random);
        const record = withTransaction(db, (tx) => {
          if (
            findDuplicateAssignment(tx, {
              principalType: 'user',
              principalId: userId,
              roleId: role.id,
              scope: [],
            }) !== undefined
          ) {
            throw new ProblemError('assignment_exists');
          }
          const createdAt = new Date(deps.now()).toISOString();
          insertAssignment(tx, {
            id,
            principalType: 'user',
            principalId: userId,
            roleId: role.id,
            expiresAt: null,
            source: 'break_glass',
            createdAt,
            createdBy: BREAK_GLASS_CREATOR,
            scope: [],
          });
          appendAudit(tx, {
            ts: createdAt,
            actorKind: actor.kind,
            actorId: actor.id,
            action: 'rbac.owner.restore',
            targetType: 'app_user',
            targetId: userId,
            outcome: 'success',
            ...(audit.clientIp === undefined ? {} : { clientIp: audit.clientIp }),
            requestId: audit.requestId,
            detail: { assignmentId: id, graphChecked },
          });
          const stored = findAssignment(tx, id);
          if (stored === undefined)
            throw new Error('the assignment that was just inserted is missing');
          return stored;
        });
        const builtin = new Set(
          listRoles(db)
            .filter((entry) => entry.builtin)
            .map((entry) => entry.key),
        );
        return c.json(assignmentToWire(record, builtin), 201, {
          Location: `/api/v1/rbac/assignments/${record.id}`,
        });
      },
    }),
  ];
}

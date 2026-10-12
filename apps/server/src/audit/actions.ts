// The audit actions of Phase B, declared once (FR-B-601, spec 6.9.6, SB-21, SB-30), and the reason
// codes of a denial (FR-B-602).
//
// Phase A has no action list in code, only the action grammar in `writer.ts` (an action is a route
// id or an `entity.verb`); this is the first one. It lists the 19 actions that Phase B adds, each
// with what the spec table says about it: the type of its target, the outcomes it may have, the
// actor kinds that write it and the detail keys it may carry. The writer itself stays generic (a
// route id is an action too); `server/audit-b-coverage.test.ts` (T-B-391) iterates the route table
// and this list and fails when a route declares an action that is not here, or an action here has
// no route or code path (`setup.reopen` and `secrets.app_key.rotate` are CLI paths,
// `auth.session.revoked` is the revalidation path, `setup.tenant.pin` is verification V2).
//
// `audit-integration.test.ts` compares this list with table 6.9.6 of the Phase B spec, row by row.
import type { AuditDetailKey } from './canonical.js';
import type { AuditActorKind } from './writer.js';

type Outcome = 'success' | 'denied' | 'rejected' | 'error';

interface ActionDefinition {
  /** The `target_type` of the entry. */
  readonly targetType: string;
  readonly outcomes: readonly Outcome[];
  readonly actorKinds: readonly AuditActorKind[];
  readonly detailKeys: readonly AuditDetailKey[];
}

function action<const Definition extends ActionDefinition>(definition: Definition): Definition {
  return Object.freeze({
    ...definition,
    outcomes: Object.freeze([...definition.outcomes]),
    actorKinds: Object.freeze([...definition.actorKinds]),
    detailKeys: Object.freeze([...definition.detailKeys]),
  });
}

/** The 19 actions of Phase B, by name. */
export const AUDIT_ACTIONS = Object.freeze({
  'setup.unlock': action({
    targetType: 'setup',
    outcomes: ['success', 'denied'],
    actorKinds: ['setup', 'anonymous'],
    detailKeys: ['reason', 'lockScope'],
  }),
  'setup.step.run': action({
    targetType: 'setup_step',
    outcomes: ['success', 'error', 'denied'],
    actorKinds: ['setup', 'user'],
    detailKeys: ['step', 'subAction', 'status', 'attempt', 'codes', 'mode'],
  }),
  'setup.object.change': action({
    targetType: 'setup_object',
    outcomes: ['success', 'error'],
    actorKinds: ['setup', 'user'],
    detailKeys: ['kind', 'op', 'objectId', 'appId', 'name', 'confirmed'],
  }),
  'setup.tenant.pin': action({
    targetType: 'tenant',
    outcomes: ['success', 'rejected'],
    actorKinds: ['setup'],
    detailKeys: ['tid', 'mode'],
  }),
  'setup.complete': action({
    targetType: 'setup',
    outcomes: ['success'],
    actorKinds: ['user'],
    detailKeys: ['mode'],
  }),
  'setup.reopen': action({
    targetType: 'setup',
    outcomes: ['success'],
    actorKinds: ['cli'],
    detailKeys: ['fromState'],
  }),
  'connection.repair': action({
    targetType: 'setup_step',
    outcomes: ['success', 'error', 'denied'],
    actorKinds: ['user'],
    detailKeys: ['subAction', 'drift', 'status', 'codes'],
  }),
  'connection.verify': action({
    targetType: 'connection',
    outcomes: ['success', 'error', 'denied'],
    actorKinds: ['user'],
    detailKeys: ['checks', 'codes'],
  }),
  'secrets.certificate.create': action({
    targetType: 'certificate',
    outcomes: ['success'],
    actorKinds: ['setup', 'user'],
    detailKeys: ['thumbprintSha1', 'notAfter'],
  }),
  'secrets.app_key.rotate': action({
    targetType: 'secret',
    outcomes: ['success', 'error'],
    actorKinds: ['cli'],
    detailKeys: ['rows', 'fromKeyId', 'toKeyId'],
  }),
  'auth.signin': action({
    targetType: 'app_user',
    outcomes: ['success', 'denied'],
    actorKinds: ['user', 'anonymous'],
    detailKeys: ['reason', 'check', 'mfa', 'groupsResolved', 'purpose'],
  }),
  'auth.stepup': action({
    targetType: 'app_user',
    outcomes: ['success', 'denied'],
    actorKinds: ['user'],
    detailKeys: ['reason', 'check', 'mfa'],
  }),
  'auth.signout': action({
    targetType: 'session',
    outcomes: ['success'],
    actorKinds: ['user', 'break_glass'],
    detailKeys: ['scope', 'sessions'],
  }),
  'auth.session.revoked': action({
    targetType: 'app_user',
    outcomes: ['success'],
    actorKinds: ['system'],
    detailKeys: ['reason', 'sessions'],
  }),
  'breakglass.signin': action({
    targetType: 'break_glass',
    outcomes: ['success', 'denied'],
    actorKinds: ['break_glass', 'anonymous'],
    detailKeys: ['reason'],
  }),
  'breakglass.signout': action({
    targetType: 'break_glass',
    outcomes: ['success'],
    actorKinds: ['break_glass'],
    detailKeys: ['reason'],
  }),
  'rbac.assignment.create': action({
    targetType: 'rbac_assignment',
    outcomes: ['success', 'denied'],
    actorKinds: ['user', 'setup'],
    detailKeys: [
      'principalType',
      'principalId',
      'role',
      'scopeTargets',
      'scopeItems',
      'expiresAt',
      'source',
    ],
  }),
  'rbac.assignment.delete': action({
    targetType: 'rbac_assignment',
    outcomes: ['success', 'denied'],
    actorKinds: ['user'],
    detailKeys: ['principalType', 'principalId', 'role', 'reason'],
  }),
  'rbac.owner.restore': action({
    targetType: 'app_user',
    outcomes: ['success', 'denied'],
    actorKinds: ['break_glass'],
    detailKeys: ['assignmentId', 'graphChecked'],
  }),
});

export type AuditActionName = keyof typeof AUDIT_ACTIONS;

/** The names of the 19 actions, in the order of the spec table. */
export const AUDIT_ACTION_NAMES = Object.freeze(Object.keys(AUDIT_ACTIONS)) as unknown as readonly [
  AuditActionName,
  ...AuditActionName[],
];

/**
 * The `reason_code` of a denial entry (FR-B-602): the three of Phase A (`permission_denied` stays on
 * the rows Phase A wrote and is still the answer for Origin and CSRF denials of other kinds), and the
 * five that Phase B adds. A denial of an anonymous visitor is a 401 and is not audited.
 */
export const DENIAL_REASON_CODES = Object.freeze([
  'permission_denied',
  'origin_not_allowed',
  'csrf_invalid',
  'permission_missing',
  'scope_mismatch',
  'step_up_required',
  'escalation_denied',
  'last_owner_protected',
] as const);

export type DenialReasonCode = (typeof DENIAL_REASON_CODES)[number];

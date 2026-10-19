// The audit actions of Phase D step D1 (FR-D-205, FR-D-304, FR-D-354; spec 6.11.1), declared once and
// kept apart from the 19 actions of Phase B (`actions.ts`), which `audit-integration.test.ts` pins.
//
//   dl.member.add, dl.member.remove          P43, P44: one entry per member plus one summary entry
//   group.member.add, group.member.remove    P53, P54: the same
//   contact.create, contact.update, contact.delete   P49, P50, P51: the names of the changed fields
//   dl.export                                P55 (step D2): rows sent, members skipped, preset, column and option names
//
// The entries hold object ids and counts, never a display name, an address or the value of a field
// (the detail allow-list of `canonical.ts` has no key for them). The success entry is written by the
// service next to the change; a denial is the route wrapper's, under the route id.
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

const MEMBER_DETAIL = [
  'memberId',
  'result',
  'summary',
  'total',
  'added',
  'removed',
  'already',
  'failed',
] as const;

/** The seven actions of step D1 and the export of step D2, by name. */
export const AUDIT_ACTIONS_D = Object.freeze({
  'dl.member.add': action({
    targetType: 'distribution_list',
    outcomes: ['success', 'error', 'denied'],
    actorKinds: ['user'],
    detailKeys: MEMBER_DETAIL,
  }),
  'dl.member.remove': action({
    targetType: 'distribution_list',
    outcomes: ['success', 'error', 'denied'],
    actorKinds: ['user'],
    detailKeys: MEMBER_DETAIL,
  }),
  'group.member.add': action({
    targetType: 'group',
    outcomes: ['success', 'error', 'denied'],
    actorKinds: ['user'],
    detailKeys: MEMBER_DETAIL,
  }),
  'group.member.remove': action({
    targetType: 'group',
    outcomes: ['success', 'error', 'denied'],
    actorKinds: ['user'],
    detailKeys: MEMBER_DETAIL,
  }),
  'contact.create': action({
    targetType: 'contact',
    outcomes: ['success', 'denied'],
    actorKinds: ['user'],
    detailKeys: ['fields'],
  }),
  'contact.update': action({
    targetType: 'contact',
    outcomes: ['success', 'denied'],
    actorKinds: ['user'],
    detailKeys: ['fields'],
  }),
  'contact.delete': action({
    targetType: 'contact',
    outcomes: ['success', 'denied'],
    actorKinds: ['user'],
    detailKeys: ['removed'],
  }),
  // One entry per export, written when the stream ends: `success`, or `error` with the reason `cancelled`
  // (the client stopped), `export_too_large` or the problem code of an Exchange failure mid-stream. The
  // entry holds the rows actually sent (FR-D-405); a cancelled export has no `cancelled` outcome of its own
  // because the table's CHECK allows four outcomes.
  'dl.export': action({
    targetType: 'distribution_list',
    outcomes: ['success', 'error', 'denied'],
    actorKinds: ['user'],
    detailKeys: ['rows', 'skipped', 'preset', 'columns', 'options'],
  }),
});

export type AuditActionNameD = keyof typeof AUDIT_ACTIONS_D;

export const AUDIT_ACTION_NAMES_D = Object.freeze(
  Object.keys(AUDIT_ACTIONS_D),
) as unknown as readonly [AuditActionNameD, ...AuditActionNameD[]];

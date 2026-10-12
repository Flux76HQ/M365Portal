// Step 5, finish (T-B-137, FR-B-219 a to f and h, BCB-01): one transaction that creates the first Owner
// assignment for the designated `oid` (source `wizard`, created by `setup`) with its audit entry, the
// optional assignment of the role Beheerder to an Entra group, stores the default language, writes the
// five rows of the finish step and moves the state to `awaiting_first_signin`. A fault in any part
// rolls back all of it. The state becomes `completed` later, in the sign-in callback (complete.ts).
//
// Before the transaction (no write): the state must be `in_progress` (a replayed finish is 409), no run
// may be active, the four earlier steps must have ended `succeeded` or `warning`, a designated Owner
// must exist and must equal `confirmOwnerOid` (422 `owner_changed`), and a group must exist (app-only
// `getGroup`). The labels of the Owner are read with `getUser` and only decorate the answer.
import { DEFAULT_ORG_NAME } from '@m365portal/shared/branding/org-name';
import type { FinishRequestSchema, FinishResponseSchema } from '@m365portal/shared/schemas/setup';
import { GROUP_FORBIDDEN_PERMISSIONS } from '@m365portal/shared/rbac/effective';
import type { z } from 'zod';
import { appendAudit } from '../audit/index.js';
import { withTransaction, type DatabaseHandle, type Tx } from '../db/index.js';
import { ProblemError } from '../http/problem.js';
import { uuidV4 } from '../ports/clock.js';
import { findDuplicateAssignment, findRoleByKey, insertAssignment } from '../rbac/repository.js';
import { readBranding } from '../branding/repository.js';
import { auditStepRun } from './audit.js';
import type { SetupServices } from './context.js';
import { appGraphOf, requireExistingGroup } from './groups.js';
import { ownerLabelsOf } from './owner-labels.js';
import type { RunActor } from './run-context.js';
import { SetupTransitionError } from './state.js';

export type FinishInput = z.infer<typeof FinishRequestSchema>;
export type FinishResult = z.infer<typeof FinishResponseSchema>;

export interface FinishAudit {
  readonly requestId: string;
  readonly clientIp?: string | undefined;
}

export interface FinishDeps {
  readonly services: SetupServices;
  /** Is a run active? A finish during a run is 409 `setup_step_busy`. */
  readonly busy: () => boolean;
  /** The setup actor, as the engine uses it. */
  readonly actor: RunActor;
}

const PRECONDITION_STEPS = ['environment', 'connect', 'configure', 'verify'] as const;
const READY = new Set(['succeeded', 'warning']);
const OWNER_ROLE = 'owner';
/** The role Beheerder is the built-in `admin` (FR-B-219 c). */
const BEHEERDER_ROLE = 'admin';

/**
 * The organisation name the finish page proposes: the tenant display name, but only while the branding
 * still carries the default name (FR-B-219 a). Never overwrites a name the person chose.
 */
export function proposedOrgName(
  tenantDisplayName: string | null,
  currentOrgName: string | null,
): string | null {
  const stillDefault = currentOrgName === null || currentOrgName === DEFAULT_ORG_NAME;
  if (!stillDefault) return null;
  const name = tenantDisplayName?.trim() ?? '';
  return name.length === 0 ? null : name;
}

function notReady(errors?: { pointer: string; code: string }[]): ProblemError {
  return new ProblemError('setup_step_not_ready', errors === undefined ? {} : { errors });
}

function insertWizardAssignment(
  tx: Tx,
  deps: FinishDeps,
  audit: FinishAudit,
  input: { principalType: 'user' | 'group'; principalId: string; role: string },
): boolean {
  const { services, actor } = deps;
  const role = findRoleByKey(tx, input.role);
  if (role === undefined) throw new Error(`the built-in role ${input.role} is missing`);
  if (
    input.principalType === 'group' &&
    role.grants.some((entry) =>
      (GROUP_FORBIDDEN_PERMISSIONS as readonly string[]).includes(entry.permission),
    )
  ) {
    throw new ProblemError('assignment_invalid', {
      errors: [{ pointer: '/beheerderGroupId', code: 'privileged_role_group' }],
    });
  }
  const principalId = input.principalId.toLowerCase();
  if (
    findDuplicateAssignment(tx, {
      principalType: input.principalType,
      principalId,
      roleId: role.id,
      scope: [],
    }) !== undefined
  ) {
    return false;
  }
  const id = uuidV4(services.deps.random);
  const createdAt = new Date(services.deps.now()).toISOString();
  insertAssignment(tx, {
    id,
    principalType: input.principalType,
    principalId,
    roleId: role.id,
    expiresAt: null,
    source: 'wizard',
    createdAt,
    createdBy: actor.id,
    scope: [],
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
      role: role.key,
      scopeTargets: [],
      scopeItems: 0,
      source: 'wizard',
    },
  });
  return true;
}

function checkPreconditions(
  services: SetupServices,
  db: DatabaseHandle,
  busy: boolean,
  input: FinishInput,
): string {
  const state = services.state.read(db);
  if (state.state !== 'in_progress') throw notReady();
  if (busy) throw new ProblemError('setup_step_busy');
  const steps = services.steps.stepStates(db, state.mode);
  for (const key of PRECONDITION_STEPS) {
    const status = steps.find((step) => step.step === key)?.status;
    if (status === undefined || !READY.has(status)) throw notReady();
  }
  if (state.designatedOwnerOid === null) {
    throw notReady([{ pointer: '/', code: 'owner_missing' }]);
  }
  if (input.confirmOwnerOid.toLowerCase() !== state.designatedOwnerOid.toLowerCase()) {
    throw new ProblemError('validation_failed', {
      errors: [{ pointer: '/confirmOwnerOid', code: 'owner_changed' }],
    });
  }
  return state.designatedOwnerOid;
}

export async function finishSetup(
  deps: FinishDeps,
  input: FinishInput,
  audit: FinishAudit,
): Promise<FinishResult> {
  const { services, actor } = deps;
  const db = services.deps.requireDatabase();
  const owner = checkPreconditions(services, db, deps.busy(), input);

  const groupId = input.beheerderGroupId ?? null;
  if (groupId !== null) await requireExistingGroup(appGraphOf(services.deps), groupId);
  const labels = await ownerLabelsOf(services, owner);

  // The checks above ran before two awaits: the transaction repeats the ones a concurrent request
  // could have changed (the state edge refuses a second finish).
  const brandingName = readBranding(db)?.orgName ?? null;
  const now = services.deps.now();
  const iso = new Date(now).toISOString();
  try {
    withTransaction(db, (tx) => {
      services.state.apply(tx, 'finish');
      const state = services.state.read(tx);
      if (state.designatedOwnerOid?.toLowerCase() !== owner.toLowerCase()) {
        throw new ProblemError('validation_failed', {
          errors: [{ pointer: '/confirmOwnerOid', code: 'owner_changed' }],
        });
      }
      const created = insertWizardAssignment(tx, deps, audit, {
        principalType: 'user',
        principalId: owner,
        role: OWNER_ROLE,
      });
      const groupCreated =
        groupId === null
          ? false
          : insertWizardAssignment(tx, deps, audit, {
              principalType: 'group',
              principalId: groupId,
              role: BEHEERDER_ROLE,
            });
      if (input.language !== undefined) services.state.setLanguage(tx, input.language);

      const row = (sub: string, status: 'succeeded' | 'skipped'): void => {
        services.steps.write(tx, 'finish', sub, {
          status,
          attempt: 1,
          startedAt: iso,
          finishedAt: iso,
          errorCode: null,
          detail: {},
        });
      };
      row('branding', brandingName !== null && brandingName !== DEFAULT_ORG_NAME ? 'succeeded' : 'skipped');
      row('owner', 'succeeded');
      row('beheerder_group', groupId === null ? 'skipped' : 'succeeded');
      row('language', input.language === undefined ? 'skipped' : 'succeeded');
      row('handover', 'succeeded');
      void created;
      void groupCreated;
      services.wizardLog.append(tx, {
        step: 'finish',
        level: 'info',
        messageKey: 'setup.log.run_finished',
        params: { status: 'succeeded' },
      });
      auditStepRun(tx, {
        now,
        actor,
        repair: false,
        step: 'finish',
        status: 'succeeded',
        attempt: 1,
        code: null,
        mode: state.mode,
      });
    });
  } catch (error) {
    if (error instanceof SetupTransitionError) throw notReady();
    throw error;
  }
  services.bootstrap.discard('finish');
  return {
    state: 'awaiting_first_signin',
    designatedOwner: { oid: owner, ...labels },
    signinUrl: '/auth/login?returnTo=%2F',
  };
}

// Manual provisioning mode (T-B-138, FR-B-218, EB-04, SB-20): for a tenant that blocks the device-code
// sign-in (or when the administrator asks), a person does the portal tasks of a checklist and hands the
// product three values. The product still verifies everything itself, app-only, with the certificate.
//
//   prepareManualCertificate   generates and seals a certificate, `pending`, at once (idempotent)
//   manualCertificateFile      the public DER of the pending (else active) certificate, never a key
//   manualChecklist            the desired application, field by field, from `buildDesiredState`
//   applyManualInputs          PUT /setup/manual: mode, application (client) id, proposed tenant, the
//                              first Owner (an `oid`, or a UPN resolved to one with `GraphClient.getUser`)
//
// Applying the inputs writes `connect/manual_inputs` and the `configure` sub-actions as `skipped`
// (without the warning flag: nothing was left undone, the person did it), and puts the verify rows back
// to `pending`. Verification V1 to V3 and V5 then run without a bootstrap token; `audit_reads` is
// `skipped` with `not_checked`, so step 4 ends `warning`; the certificate becomes `active` after V1
// (verify.ts). The checklist links to Learn pages only (the catalogue holds the links).
import type { ManualRequestSchema, ManualResponseSchema } from '@m365portal/shared/schemas/setup';
import {
  buildDesiredState,
  desiredStateChecklist,
  type ChecklistItem,
} from '@m365portal/shared/setup/desired-state';
import { EXCHANGE_APP_ROLES, GRAPH_APP_ROLES } from '@m365portal/shared/setup/graph-roles';
import { subActionsOf } from '@m365portal/shared/setup/steps';
import type { z } from 'zod';
import { withTransaction } from '../db/index.js';
import { ProblemError } from '../http/problem.js';
import { graphProblem } from '../rbac/graph-problem.js';
import { auditStepRun } from './audit.js';
import type { SetupServices } from './context.js';
import type { RunActor } from './run-context.js';

export type ManualInput = z.infer<typeof ManualRequestSchema>;
export type ManualResult = z.infer<typeof ManualResponseSchema>;

export interface ManualDeps {
  readonly services: SetupServices;
  readonly busy: () => boolean;
  readonly actor: RunActor;
}

const DEFAULT_APPLICATION_NAME = 'M365Portal';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function notReady(): ProblemError {
  return new ProblemError('setup_step_not_ready');
}

/** A stable placeholder id per role name: the checklist shows names, so only the mapping matters. */
function placeholderIds(names: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    names.map((name, index) => [
      name,
      `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, '0')}`,
    ]),
  );
}

/**
 * The checklist a person works through in the portal. One item per member of the document the
 * automatic mode sends, in the same order, built by the same function (`buildDesiredState`).
 */
export function manualChecklist(
  services: SetupServices,
  options: { readonly applicationName?: string; readonly exchange?: boolean } = {},
): readonly ChecklistItem[] {
  const exchange = options.exchange ?? true;
  const names = [...GRAPH_APP_ROLES, ...(exchange ? [EXCHANGE_APP_ROLES.required] : [])];
  const roleIds = placeholderIds(names);
  const desired = buildDesiredState({
    baseUrl: services.deps.config.publicOrigin,
    installId: services.state.read(services.deps.requireDatabase()).installId,
    applicationName: options.applicationName ?? DEFAULT_APPLICATION_NAME,
    roleIds,
    exchange,
  });
  return desiredStateChecklist(desired, roleIds);
}

function certificateServices(services: SetupServices) {
  const { secrets } = services.deps;
  const runtime = secrets.services();
  if (runtime === undefined) throw new ProblemError('secrets_unavailable');
  return runtime;
}

/** Generate and seal the certificate if none exists. Returns the first 8 hex digits of its thumbprint. */
export async function prepareManualCertificate(
  services: SetupServices,
  actor: RunActor,
): Promise<{ readonly thumbprint8: string; readonly created: boolean }> {
  const db = services.deps.requireDatabase();
  const certificates = certificateServices(services).certificates;
  const current = certificates.current(db);
  const existing = current.pending ?? current.active;
  if (existing !== undefined) {
    return { thumbprint8: existing.thumbprintSha1.slice(0, 8).toLowerCase(), created: false };
  }
  const created = await certificates.create(db, actor);
  const thumbprint8 = created.thumbprintSha1.slice(0, 8).toLowerCase();
  withTransaction(db, (tx) => {
    services.wizardLog.append(tx, {
      step: 'connect',
      level: 'info',
      messageKey: 'setup.log.certificate_generated',
      params: { thumbprint8 },
    });
  });
  return { thumbprint8, created: true };
}

export interface CertificateFile {
  readonly der: Buffer;
  readonly filename: string;
}

/** The public certificate (pending, else active) as a download, or `undefined` when none exists. */
export function manualCertificateFile(services: SetupServices): CertificateFile | undefined {
  const db = services.deps.requireDatabase();
  const runtime = services.deps.secrets.services();
  if (runtime === undefined) return undefined;
  const current = runtime.certificates.current(db);
  const certificate = current.pending ?? current.active;
  if (certificate === undefined) return undefined;
  const der = db.sqlite
    .prepare('SELECT public_der FROM certificate WHERE id = ?')
    .pluck()
    .get(certificate.id) as Buffer | undefined;
  if (der === undefined) return undefined;
  return {
    der: Buffer.from(der),
    filename: `m365portal-${certificate.thumbprintSha1.slice(0, 8).toLowerCase()}.cer`,
  };
}

export async function applyManualInputs(
  deps: ManualDeps,
  input: ManualInput,
): Promise<ManualResult> {
  const { services, actor } = deps;
  const db = services.deps.requireDatabase();
  const state = services.state.read(db);
  if (state.state !== 'in_progress') throw notReady();
  if (deps.busy()) throw new ProblemError('setup_step_busy');

  const current = certificateServices(services).certificates.current(db);
  if ((current.pending ?? current.active) === undefined) throw notReady();
  const secrets = services.deps.secrets.state();
  if (secrets.status !== 'ok' || secrets.holder === undefined)
    throw new ProblemError('secrets_unavailable');

  const pinned = services.connections.read(db)?.tenantId ?? null;
  const tenantId = input.tenantId.toLowerCase();
  if (pinned !== null && pinned.toLowerCase() !== tenantId)
    throw new ProblemError('tenant_mismatch');

  // The first Owner is resolved with the application's own token: this is also the first proof that the
  // portal tasks were done. A failure to obtain it is "not yet" (503), not a verdict.
  const probe = services.deps.clients.probe({
    tenantId,
    clientId: input.applicationClientId.toLowerCase(),
    holder: secrets.holder,
  });
  let user;
  try {
    await probe.appTokens.get('graph', { skipCache: true });
    user = await probe.graph.getUser(input.firstOwner.value, { priority: 'high' });
  } catch (error) {
    throw graphProblem(error);
  } finally {
    probe.close();
  }
  if (user === null || !GUID.test(user.id)) throw new ProblemError('principal_unknown');

  const now = services.deps.now();
  const iso = new Date(now).toISOString();
  withTransaction(db, (tx) => {
    services.state.setMode(tx, 'manual');
    services.state.setProposedTenant(tx, tenantId);
    services.state.setDesignatedOwner(tx, user.id.toLowerCase());
    services.steps.ensureRows(tx, 'manual');
    services.connections.ensure(tx);
    // The checklist asks for the Exchange permissions and the Entra role (`manualChecklist`, default true),
    // so Exchange is part of what was handed over: verification runs V5, as FR-B-218 and OV-21 say.
    services.connections.update(tx, {
      appId: input.applicationClientId.toLowerCase(),
      exchangeEnabled: true,
    });
    services.steps.write(tx, 'connect', 'manual_inputs', {
      status: 'succeeded',
      attempt: 1,
      startedAt: iso,
      finishedAt: iso,
      errorCode: null,
      detail: { manual: true },
    });
    for (const sub of subActionsOf('configure', 'manual')) {
      services.steps.write(tx, 'configure', sub, {
        status: 'skipped',
        attempt: 0,
        startedAt: iso,
        finishedAt: iso,
        errorCode: null,
        detail: { manual: true },
      });
    }
    for (const sub of subActionsOf('verify', 'manual')) {
      services.steps.write(tx, 'verify', sub, {
        status: 'pending',
        attempt: 0,
        startedAt: null,
        finishedAt: null,
        errorCode: null,
        detail: {},
      });
    }
    services.wizardLog.append(tx, {
      step: 'connect',
      level: 'info',
      messageKey: 'setup.log.manual_checked',
      params: {},
    });
    auditStepRun(tx, {
      now,
      actor,
      repair: false,
      step: 'connect',
      subAction: 'manual_inputs',
      status: 'succeeded',
      attempt: 1,
      code: null,
      mode: 'manual',
    });
  });

  return {
    mode: 'manual',
    applicationClientId: input.applicationClientId.toLowerCase(),
    tenantId,
    designatedOwner: {
      oid: user.id.toLowerCase(),
      upnLabel: user.userPrincipalName,
      nameLabel: user.displayName,
    },
  };
}

// Step 4, verification (T-B-136, FR-B-309, FR-B-316, FR-B-319, EB-09, EB-36; SC-B-002; plan 9.8).
//
//   audit_reads     DELEGATED, while the bootstrap object lives: V4 reads the application, the service
//                   principal, the credential by thumbprint, the app role assignments and the Entra
//                   role assignment and compares them with the desired state (extra roles are drift,
//                   forbidden roles fail), and counts the credentials and owners the panel did not
//                   create (FR-B-319); V6 checks the optional claims. THEN THE BOOTSTRAP OBJECT IS
//                   DISCARDED (FR-B-215a), before any probe. Without a live bootstrap, or in manual
//                   mode, the sub-action is `skipped` with V4 and V6 `not_checked`, so the step ends
//                   `warning`.
//   app_token       V1, app-only, fresh token. The certificate of a manual setup becomes `active` here.
//   organization    V2: the organisation's id equals the proposed tenant; pins it (verify-checks).
//   users           V3.
//   exchange_probe  V5, a warning when it fails.
//
// V1 to V4 failing is `failed`; V5 and V6 failing are `warning`. The proof list is written after every
// sub-action (names, thumbprints and counts, never free text).
import {
  EXCHANGE_APP_ROLES,
  FORBIDDEN_APP_ROLES,
  GRAPH_APP_ROLES,
} from '@m365portal/shared/setup/graph-roles';
import type { ResultCode } from '@m365portal/shared/setup/result-codes';
import { SetupFailure, type SubActionContext, type SubActionDefinition, type SubActionOutcome } from '../context.js';
import { mergeProof, proofItem, readProof, writeProof, type ProofItem } from '../proof.js';
import {
  checkExchange,
  checkOrganization,
  checkToken,
  checkUsers,
  openProbe,
  type CheckResult,
} from './verify-checks.js';
import { desiredOf, ensureResolved, provisionerOf } from './configure/common.js';

/** Store proof items inside one transaction with the step row that produced them. */
function saveProof(ctx: SubActionContext, items: readonly ProofItem[]): void {
  ctx.transact(({ tx, services }) => {
    const existing = readProof(services.connections, tx);
    const mode = services.state.read(tx).mode;
    writeProof(services.connections, tx, mergeProof(existing, items, { generatedAt: ctx.iso(), mode }));
  });
}

function outcomeOf(result: CheckResult): SubActionOutcome {
  const detail = result.detail ?? {};
  switch (result.status) {
    case 'ok':
      return { status: 'succeeded', detail };
    case 'warning':
      return { status: 'warning', ...(result.code === undefined ? {} : { code: result.code }), detail };
    case 'skipped':
      return { status: 'skipped', ...(result.code === undefined ? {} : { code: result.code }), detail };
    case 'failed':
      return { status: 'failed', code: result.code ?? 'drift_detected', detail };
  }
}

/** Run an app-only check on a client of its own, record its proof items, close the client. */
async function appOnly(
  ctx: SubActionContext,
  check: (probe: ReturnType<typeof openProbe>) => Promise<CheckResult>,
): Promise<SubActionOutcome> {
  ctx.checkpoint();
  const probe = openProbe(ctx.services);
  try {
    const result = await check(probe);
    saveProof(ctx, result.items);
    ctx.log('setup.log.verified', {
      check: result.items[0]?.key ?? 'check',
      status: result.status,
    });
    return outcomeOf(result);
  } finally {
    probe.close();
  }
}

// ---------------------------------------------------------------------------------------------
// V4 and V6, delegated
// ---------------------------------------------------------------------------------------------

const sameSet = (left: readonly string[], right: readonly string[]): boolean =>
  new Set(left).size === new Set(right).size && left.every((item) => right.includes(item));

async function readDelegated(ctx: SubActionContext): Promise<SubActionOutcome & { items: ProofItem[] }> {
  const { services, run } = ctx;
  const provisioner = provisionerOf(ctx);
  await ensureResolved(ctx);
  const desired = desiredOf(ctx);
  const connection = services.connections.read(ctx.db);
  const objectId = connection?.appObjectId;
  const appId = connection?.appId;
  const spId = connection?.spObjectId;
  if (objectId == null || appId == null) throw new SetupFailure('drift_detected');
  const now = ctx.iso();
  const items: ProofItem[] = [];
  const drift: string[] = [];

  // The application.
  const app = await provisioner.getApplication(objectId);
  ctx.checkpoint();
  const appOk =
    app !== null &&
    app.signInAudience === desired.signInAudience &&
    sameSet(app.redirectUris ?? [], desired.web.redirectUris) &&
    desired.tags.every((tag) => app.tags?.includes(tag) === true);
  items.push(proofItem('application', appOk ? 'ok' : 'failed', now, appOk ? {} : { code: 'drift_detected' }));
  if (!appOk) drift.push('application');

  // The service principal.
  const sp = await provisioner.findServicePrincipalByAppId(appId);
  items.push(proofItem('service_principal', sp === null ? 'failed' : 'ok', now, sp === null ? { code: 'drift_detected' } : {}));
  if (sp === null) drift.push('service_principal');

  // The credentials: ours by thumbprint, the rest counted (FR-B-319).
  const inventory = await provisioner.inspectApplication(objectId);
  const spInventory = await provisioner.inspectServicePrincipal(appId);
  const certificates = services.deps.secrets.services()?.certificates.current(ctx.db);
  const ours = [certificates?.active, certificates?.pending]
    .filter((certificate) => certificate !== undefined)
    .map((certificate) => certificate.thumbprintSha1.toUpperCase());
  const remote = (inventory.keyCredentials ?? []).map((credential) => credential.thumbprintSha1?.toUpperCase() ?? null);
  const activeThumbprint = certificates?.active?.thumbprintSha1.toUpperCase();
  const present = activeThumbprint !== undefined && remote.includes(activeThumbprint);
  if (inventory.keyCredentials === null) {
    // Graph would not show the credentials (U50): the certificate cannot be compared, which is not drift.
    items.push(proofItem('certificate', 'not_checked', now));
  } else {
    items.push(
      proofItem('certificate', present ? 'ok' : 'failed', now, present
        ? { thumbprint8: activeThumbprint.slice(0, 8).toLowerCase(), notAfter: certificates?.active?.notAfter ?? '' }
        : { code: 'drift_detected' }),
    );
    if (!present) drift.push('certificate');
  }

  // The grants.
  const grants = spId == null ? [] : await provisioner.listAppRoleAssignments(spId);
  const named = (resourceSpId: string | undefined): string[] =>
    grants
      .filter((grant) => grant.resourceId === resourceSpId)
      .map((grant) => run.roleNames[grant.appRoleId] ?? grant.appRoleId);
  const graphHeld = named(run.graphSpId);
  const forbidden = graphHeld.filter((name) => (FORBIDDEN_APP_ROLES as readonly string[]).includes(name));
  const graphMissing = GRAPH_APP_ROLES.filter((name) => !graphHeld.includes(name));
  const graphExtra = graphHeld.filter((name) => !(GRAPH_APP_ROLES as readonly string[]).includes(name));
  items.push(
    proofItem(
      'graph_roles',
      graphMissing.length > 0 || forbidden.length > 0 ? 'failed' : graphExtra.length > 0 ? 'warning' : 'ok',
      now,
      { count: graphHeld.length, extra: graphExtra.length, missing: graphMissing.length },
    ),
  );
  if (graphMissing.length > 0) drift.push('graph_roles');

  if (run.exchangeSpId !== undefined) {
    const wanted: string[] = [
      EXCHANGE_APP_ROLES.required,
      ...(run.roleIds[EXCHANGE_APP_ROLES.whenExposed] === undefined ? [] : [EXCHANGE_APP_ROLES.whenExposed]),
    ];
    const held = named(run.exchangeSpId);
    const missing = wanted.filter((name) => !held.includes(name));
    const extra = held.filter((name) => !wanted.includes(name));
    items.push(
      proofItem('exchange_roles', missing.length > 0 ? 'failed' : extra.length > 0 ? 'warning' : 'ok', now, {
        count: held.length,
        extra: extra.length,
        missing: missing.length,
      }),
    );
    if (missing.length > 0) drift.push('exchange_roles');
    const assignments = spId == null ? [] : await provisioner.listDirectoryRoleAssignments(spId);
    const wantedRole = connection?.exchangeRoleTemplateId;
    const hasRole = wantedRole != null && assignments.some((assignment) => assignment.roleDefinitionId === wantedRole);
    items.push(proofItem('entra_role', hasRole ? 'ok' : 'failed', now, hasRole ? {} : { code: 'drift_detected' }));
    if (!hasRole) drift.push('entra_role');
  } else {
    items.push(proofItem('exchange_roles', 'not_checked', now), proofItem('entra_role', 'not_checked', now));
  }

  // Credentials and owners the panel did not create (FR-B-319): counts only, owner ids are not kept.
  const passwords = (inventory.passwordCredentials ?? 0) + (spInventory?.passwordCredentials ?? 0);
  const foreignKeys =
    (inventory.keyCredentials ?? []).filter((credential) => !ours.includes(credential.thumbprintSha1?.toUpperCase() ?? '')).length +
    (spInventory?.keyCredentials ?? []).length;
  const owners = (inventory.ownerIds ?? []).length + (spInventory?.ownerIds ?? []).length;
  const unreadable =
    inventory.passwordCredentials === null || inventory.keyCredentials === null || inventory.ownerIds === null;
  const foreign = passwords > 0 || foreignKeys > 0;
  const v4Failed = drift.length > 0 || forbidden.length > 0;
  items.push(
    proofItem('check_v4', unreadable && !v4Failed ? 'not_checked' : v4Failed ? 'failed' : foreign ? 'warning' : 'ok', now, {
      passwordCredentials: passwords,
      foreignKeyCredentials: foreignKeys,
      owners,
      ...(v4Failed ? { code: forbidden.length > 0 ? 'forbidden_permission_present' : 'drift_detected' } : foreign ? { code: 'foreign_credential_present' } : {}),
    }),
  );

  // V6: the optional claims.
  const claims = app?.optionalClaims?.idToken ?? [];
  const claimsOk = desired.optionalClaims.idToken.every((wanted) =>
    claims.some((claim) => claim.name === wanted.name),
  );
  items.push(proofItem('check_v6', claimsOk ? 'ok' : 'warning', now, claimsOk ? {} : { code: 'optional_claim_missing' }));

  if (forbidden.length > 0) {
    return { status: 'failed', code: 'forbidden_permission_present', detail: { count: forbidden.length }, items };
  }
  if (drift.length > 0) {
    return { status: 'failed', code: 'drift_detected', detail: { count: drift.length }, items, drift };
  }
  if (foreign) {
    return { status: 'warning', code: 'foreign_credential_present', detail: { count: passwords + foreignKeys }, items };
  }
  if (!claimsOk) return { status: 'warning', code: 'optional_claim_missing', detail: {}, items };
  return { status: 'succeeded', detail: {}, items };
}

export const auditReadsSubAction: SubActionDefinition = {
  step: 'verify',
  key: 'audit_reads',

  async run(ctx) {
    const slot = ctx.services.bootstrap;
    const now = ctx.iso();
    if (ctx.mode === 'manual' || !slot.live()) {
      saveProof(ctx, [proofItem('check_v4', 'not_checked', now), proofItem('check_v6', 'not_checked', now)]);
      return { status: 'skipped', code: 'not_checked', detail: ctx.mode === 'manual' ? { manual: true } : {} };
    }
    const { items, ...outcome } = await readDelegated(ctx);
    saveProof(ctx, items);
    // The delegated reads are done: the bootstrap object goes now, before any propagation probe.
    slot.discard('audit_reads_done');
    ctx.log('setup.log.bootstrap_discarded');
    return outcome as SubActionOutcome;
  },
};

// ---------------------------------------------------------------------------------------------
// V1, V2, V3, V5: app-only
// ---------------------------------------------------------------------------------------------

export const appTokenSubAction: SubActionDefinition & { permanentCode: ResultCode } = {
  step: 'verify',
  key: 'app_token',
  permanentCode: 'token_unavailable',

  async run(ctx) {
    const outcome = await appOnly(ctx, (probe) => checkToken(ctx.services, probe));
    // The certificate of a manual setup is activated only now that it has signed a token (FR-B-218).
    if (outcome.status === 'succeeded') {
      const secrets = ctx.services.deps.secrets.services();
      const pending = secrets?.certificates.current(ctx.db).pending;
      if (secrets !== undefined && pending !== undefined && ctx.mode === 'manual') {
        const activated = secrets.certificates.activate(ctx.db, pending.id);
        ctx.transact(({ tx, services }) => {
          services.connections.update(tx, { certificateId: activated.id });
        });
      }
    }
    return outcome;
  },
};

export const organizationSubAction: SubActionDefinition = {
  step: 'verify',
  key: 'organization',

  async run(ctx) {
    const pinned = ctx.services.connections.read(ctx.db)?.tenantId != null;
    return appOnly(ctx, (probe) => checkOrganization(ctx.services, probe, { pin: !pinned }));
  },
};

export const usersSubAction: SubActionDefinition & { permanentCode: ResultCode } = {
  step: 'verify',
  key: 'users',
  permanentCode: 'users_unreadable',

  async run(ctx) {
    return appOnly(ctx, (probe) => checkUsers(ctx.services, probe));
  },
};

export const exchangeProbeSubAction: SubActionDefinition = {
  step: 'verify',
  key: 'exchange_probe',

  async run(ctx) {
    return appOnly(ctx, (probe) => checkExchange(ctx.services, probe));
  },
};

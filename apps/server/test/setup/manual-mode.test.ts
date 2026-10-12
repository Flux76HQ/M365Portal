// T-B-138: manual provisioning mode (FR-B-218, EB-04, SB-20). The certificate exists at once and only
// its public DER is served; the checklist mirrors the application the automatic mode creates; the three
// inputs are stored and the first Owner is resolved to an oid; verification runs without a bootstrap and
// ends `warning`; the certificate becomes `active` after V1.
import { createHash } from 'node:crypto';
import { EXCHANGE_APP_ROLES, GRAPH_APP_ROLES } from '@m365portal/shared/setup/graph-roles';
import { ManualRequestSchema, ManualResponseSchema } from '@m365portal/shared/schemas/setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProblemError } from '../../src/http/problem.js';
import {
  applyManualInputs,
  manualCertificateFile,
  manualChecklist,
  prepareManualCertificate,
  type ManualDeps,
} from '../../src/setup/manual-mode.js';
import { SETUP_ACTOR } from './support/engine-harness.js';
import { tenantScene, useWizardTimers, type TenantScene } from './support/tenant-scene.js';

beforeEach(() => {
  useWizardTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const depsOf = (scene: TenantScene): ManualDeps => ({ services: scene.services, busy: () => scene.engine.busy(), actor: SETUP_ACTOR });

async function problemOf(work: Promise<unknown>): Promise<ProblemError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof ProblemError) return error;
    throw error;
  }
  throw new Error('the call did not fail');
}

/**
 * A tenant in which a person has done the portal tasks. The automatic run stands in for the person (the
 * objects it creates are the ones the checklist describes); the certificate goes back to `pending`, as it
 * is until the first successful token.
 */
async function tenantWithPortalTasksDone(): Promise<{ scene: TenantScene; appId: string }> {
  const scene = await tenantScene();
  await scene.run(['connect', 'configure']);
  scene.services.bootstrap.discard('exit');
  scene.db.sqlite.exec("UPDATE certificate SET state = 'pending'");
  scene.db.sqlite.exec('UPDATE tenant_connection SET certificate_id = NULL');
  const appId = scene.services.connections.read(scene.db)?.appId;
  if (appId === null || appId === undefined) throw new Error('no application');
  return { scene, appId };
}

describe('the certificate', () => {
  it('is generated and sealed pending at once, once, and only its public DER is served', async () => {
    const scene = await tenantScene();
    expect(manualCertificateFile(scene.services)).toBeUndefined();
    const first = await prepareManualCertificate(scene.services, SETUP_ACTOR);
    const second = await prepareManualCertificate(scene.services, SETUP_ACTOR);
    expect(first.created).toBe(true);
    expect(second).toMatchObject({ created: false, thumbprint8: first.thumbprint8 });
    expect(scene.rows("SELECT state FROM certificate")).toEqual([{ state: 'pending' }]);

    const file = manualCertificateFile(scene.services);
    expect(file?.filename).toBe(`m365portal-${first.thumbprint8}.cer`);
    const sha1 = createHash('sha1').update(file?.der ?? Buffer.alloc(0)).digest('hex');
    expect(sha1.slice(0, 8)).toBe(first.thumbprint8);
    expect(file?.der[0]).toBe(0x30); // a DER SEQUENCE: a certificate
    const text = file?.der.toString('latin1') ?? '';
    expect(text).not.toContain('PRIVATE');
    // The sealed private key is a different blob and is not part of the file.
    const sealed = scene.rows<{ blob: Buffer }>('SELECT blob FROM secret').map((row) => Buffer.from(row.blob));
    expect(sealed.length).toBeGreaterThan(0);
    for (const blob of sealed) expect(file?.der.includes(blob)).toBe(false);
  });
});

describe('the checklist', () => {
  it('equals the application the automatic mode creates, field by field', async () => {
    const scene = await tenantScene();
    await scene.run(['connect', 'configure']);
    const [application] = [...scene.world.graph.directory.applications.values()];
    const checklist = Object.fromEntries(manualChecklist(scene.services).map((item) => [item.key, item.value]));
    expect(checklist).toMatchObject({
      application_name: application?.displayName,
      description: application?.description,
      sign_in_audience: application?.signInAudience,
      tags: application?.tags,
      redirect_uris: application?.web.redirectUris,
      implicit_id_token: application?.web.implicitGrantSettings.enableIdTokenIssuance,
      implicit_access_token: application?.web.implicitGrantSettings.enableAccessTokenIssuance,
      optional_claims: ((application?.optionalClaims as { idToken?: { name: string }[] } | null)?.idToken ?? []).map((claim) => claim.name),
    });
    expect([...(checklist.graph_roles as string[])].sort()).toEqual([...GRAPH_APP_ROLES].sort());
    expect(checklist.exchange_roles).toEqual([EXCHANGE_APP_ROLES.required]);
  });

  it('lists no Exchange role for a tenant without Exchange', async () => {
    const scene = await tenantScene();
    const keys = manualChecklist(scene.services, { exchange: false }).map((item) => item.key);
    expect(keys).not.toContain('exchange_roles');
    expect(keys).toContain('graph_roles');
  });

  it('holds no secret and no link', async () => {
    const scene = await tenantScene();
    const text = JSON.stringify(manualChecklist(scene.services));
    expect(text).not.toMatch(/secret|password|PRIVATE/i);
  });
});

describe('the inputs', () => {
  it('store the mode, the application id, the proposed tenant and the first Owner (a UPN resolves to its oid)', async () => {
    const { scene, appId } = await tenantWithPortalTasksDone();
    const input = ManualRequestSchema.parse({
      applicationClientId: appId,
      tenantId: scene.world.tenantId,
      firstOwner: { kind: 'upn', value: scene.world.admin.userPrincipalName },
    });
    const result = await applyManualInputs(depsOf(scene), input);
    expect(ManualResponseSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({
      mode: 'manual',
      applicationClientId: appId,
      tenantId: scene.world.tenantId,
      designatedOwner: { oid: scene.world.admin.id, upnLabel: scene.world.admin.userPrincipalName },
    });
    expect(scene.services.state.read(scene.db)).toMatchObject({
      mode: 'manual',
      proposedTenantId: scene.world.tenantId,
      designatedOwnerOid: scene.world.admin.id,
    });
    expect(scene.services.connections.read(scene.db)).toMatchObject({ appId, tenantId: null });
    const rows = scene.rows<{ step: string; sub_action: string; status: string }>(
      "SELECT step, sub_action, status FROM setup_step WHERE step IN ('connect', 'configure') AND sub_action <> 'device_code' ORDER BY step, sub_action",
    );
    expect(rows.find((row) => row.sub_action === 'manual_inputs')?.status).toBe('succeeded');
    expect(rows.filter((row) => row.step === 'configure').every((row) => row.status === 'skipped')).toBe(true);
    const [entry] = scene.rows<{ actor_kind: string; detail: string }>(
      "SELECT actor_kind, detail FROM audit_log WHERE action = 'setup.step.run' AND target_id = 'connect' AND detail LIKE '%manual_inputs%'",
    );
    expect(entry?.actor_kind).toBe('setup');
    expect(JSON.parse(entry?.detail ?? '{}')).toMatchObject({ step: 'connect', subAction: 'manual_inputs', mode: 'manual' });
  });

  it('take an oid as the first Owner too, which may be someone other than the signed-in administrator', async () => {
    const { scene, appId } = await tenantWithPortalTasksDone();
    const other = scene.world.graph.directory.addUser({ userPrincipalName: 'second@contoso-fake.example' });
    const result = await applyManualInputs(depsOf(scene), {
      applicationClientId: appId,
      tenantId: scene.world.tenantId,
      firstOwner: { kind: 'oid', value: other.id },
    });
    expect(result.designatedOwner.oid).toBe(other.id);
    expect(scene.services.state.read(scene.db).designatedOwnerOid).toBe(other.id);
  });

  it('with a first Owner that does not exist are 422 principal_unknown and change nothing', async () => {
    const { scene, appId } = await tenantWithPortalTasksDone();
    const problem = await problemOf(
      applyManualInputs(depsOf(scene), {
        applicationClientId: appId,
        tenantId: scene.world.tenantId,
        firstOwner: { kind: 'upn', value: 'nobody@contoso-fake.example' },
      }),
    );
    expect(problem.code).toBe('principal_unknown');
    expect(scene.services.state.read(scene.db).mode).toBe('automatic');
  });

  it('while the application cannot get a token yet are 503 graph_unavailable and change nothing', async () => {
    const { scene } = await tenantWithPortalTasksDone();
    const problem = await problemOf(
      applyManualInputs(depsOf(scene), {
        applicationClientId: '7c1d0e9a-5b2f-4a3e-8d6c-1f0a9b8c7d6e',
        tenantId: scene.world.tenantId,
        firstOwner: { kind: 'upn', value: scene.world.admin.userPrincipalName },
      }),
    );
    expect(problem.code).toBe('graph_unavailable');
    expect(scene.services.state.read(scene.db).mode).toBe('automatic');
  });

  it('for another tenant than the pinned one are 409 tenant_mismatch', async () => {
    const { scene, appId } = await tenantWithPortalTasksDone();
    scene.db.sqlite.prepare('UPDATE tenant_connection SET tenant_id = ?').run('11111111-2222-4333-8444-555555555555');
    const problem = await problemOf(
      applyManualInputs(depsOf(scene), {
        applicationClientId: appId,
        tenantId: scene.world.tenantId,
        firstOwner: { kind: 'upn', value: scene.world.admin.userPrincipalName },
      }),
    );
    expect(problem.code).toBe('tenant_mismatch');
  });

  it('without a certificate, outside step 2 or during a run are 409', async () => {
    const scene = await tenantScene();
    const input = {
      applicationClientId: '7c1d0e9a-5b2f-4a3e-8d6c-1f0a9b8c7d6e',
      tenantId: scene.world.tenantId,
      firstOwner: { kind: 'oid' as const, value: scene.world.admin.id },
    };
    expect((await problemOf(applyManualInputs(depsOf(scene), input))).code).toBe('setup_step_not_ready');
    await prepareManualCertificate(scene.services, SETUP_ACTOR);
    expect((await problemOf(applyManualInputs({ ...depsOf(scene), busy: () => true }, input))).code).toBe('setup_step_busy');
    scene.db.sqlite.prepare("UPDATE setup_state SET state = 'awaiting_first_signin'").run();
    expect((await problemOf(applyManualInputs(depsOf(scene), input))).code).toBe('setup_step_not_ready');
  });
});

describe('verification without a bootstrap', () => {
  it('runs V1 to V3 and V5, writes audit_reads skipped (not_checked), ends warning and activates the certificate after V1', async () => {
    const { scene, appId } = await tenantWithPortalTasksDone();
    await applyManualInputs(depsOf(scene), {
      applicationClientId: appId,
      tenantId: scene.world.tenantId,
      firstOwner: { kind: 'upn', value: scene.world.admin.userPrincipalName },
    });
    expect(scene.rows("SELECT state FROM certificate")).toEqual([{ state: 'pending' }]);
    const deviceRequests = scene.world.entra.control.tokenRequests().filter((r) => (r.grantType ?? '').includes('device')).length;

    await scene.run(['verify'], { mode: 'reconcile' });
    expect(scene.engine.current()?.status).toBe('warning');
    expect(scene.rows("SELECT 1 FROM setup_step WHERE status = 'failed'")).toEqual([]);
    expect(scene.rows("SELECT status, error_code FROM setup_step WHERE sub_action = 'audit_reads'")).toEqual([
      { status: 'skipped', error_code: 'not_checked' },
    ]);
    expect(scene.rows("SELECT state FROM certificate")).toEqual([{ state: 'active' }]);
    expect(scene.services.connections.read(scene.db)?.tenantId).toBe(scene.world.tenantId);
    expect(scene.world.entra.control.tokenRequests().filter((r) => (r.grantType ?? '').includes('device')).length).toBe(deviceRequests);
    const steps = scene.services.steps.stepStates(scene.db, 'manual');
    expect(steps.map((step) => [step.step, step.status])).toEqual([
      ['environment', 'pending'],
      ['connect', 'succeeded'],
      ['configure', 'succeeded'],
      ['verify', 'warning'],
      ['finish', 'pending'],
    ]);
  });
});

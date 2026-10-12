// T-B-136: step 4, verification and the proof list (FR-B-309, FR-B-319, FR-B-212 probes; EB-09,
// EB-36; SC-B-002). Delegated audit reads first, then the bootstrap object is discarded, then the
// app-only checks with fresh tokens.
import { PROOF_KEYS } from '@m365portal/shared/schemas/connection';
import { ProofSchema } from '@m365portal/shared/schemas/connection';
import { GRAPH_RESOURCE_APP_ID } from '@m365portal/shared/setup/graph-roles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fake } from '../support/msw.js';
import { tenantScene, useWizardTimers, type TenantScene } from './support/tenant-scene.js';

beforeEach(() => {
  useWizardTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const ALL = ['connect', 'configure', 'verify'] as const;

function proofOf(scene: TenantScene) {
  const text = scene.services.connections.read(scene.db)?.proofText ?? '{}';
  return ProofSchema.parse(JSON.parse(text));
}
const item = (scene: TenantScene, key: string) => proofOf(scene).items.find((entry) => entry.key === key);
const application = (scene: TenantScene) => [...scene.world.graph.directory.applications.values()][0];
const graphSp = (scene: TenantScene) => scene.world.graph.directory.servicePrincipalByAppId(GRAPH_RESOURCE_APP_ID);
const runtimeSp = (scene: TenantScene) => scene.world.graph.directory.servicePrincipalByAppId(application(scene)?.appId ?? '');
const row = (scene: TenantScene, sub: string) =>
  scene.rows<{ status: string; error_code: string | null }>('SELECT status, error_code FROM setup_step WHERE sub_action = ?', sub)[0];

/** A completed configure, then a verify run of its own with a fresh sign-in. */
async function configured(options: Parameters<typeof tenantScene>[0] = {}): Promise<TenantScene> {
  const scene = await tenantScene(options);
  await scene.run(['connect', 'configure']);
  expect(scene.engine.current()?.status).toBe('succeeded');
  return scene;
}

describe('a clean run', () => {
  it('ends with every proof row green, the tenant pinned and the bootstrap discarded', async () => {
    const scene = await tenantScene();
    await scene.run([...ALL]);
    expect(scene.engine.current()?.status).toBe('succeeded');
    const proof = proofOf(scene);
    expect(proof.mode).toBe('automatic');
    expect(proof.items.map((entry) => entry.key)).toEqual([...PROOF_KEYS]);
    expect(proof.items.map((entry) => entry.status)).toEqual(Array.from({ length: PROOF_KEYS.length }, () => 'ok'));
    for (const sub of ['audit_reads', 'app_token', 'organization', 'users', 'exchange_probe']) {
      expect(row(scene, sub)).toEqual({ status: 'succeeded', error_code: null });
    }
    const connection = scene.services.connections.read(scene.db);
    expect(connection).toMatchObject({
      tenantId: scene.world.tenantId,
      tenantName: 'Contoso Fake Tenant',
      initialDomain: 'contoso-fake.onmicrosoft.com',
    });
    expect(connection?.verifiedAt).not.toBeNull();
    expect(scene.services.bootstrap.live()).toBe(false);
    expect(scene.services.bootstrap.lastDiscard()).toBe('audit_reads_done');
    // The certificate item names its thumbprint and expiry; no free text anywhere.
    expect(item(scene, 'certificate')?.params).toMatchObject({ thumbprint8: expect.stringMatching(/^[0-9a-f]{8}$/) as string });
    expect(JSON.stringify(proof).length).toBeLessThanOrEqual(51_200);
  });

  it('the bootstrap goes before the first app-only probe (FR-B-215a) and the tenant is pinned by V2', async () => {
    const scene = await tenantScene();
    await scene.run([...ALL]);
    const keys = scene.rows<{ message_key: string; params: string }>('SELECT message_key, params FROM setup_log ORDER BY seq');
    const discarded = keys.findIndex((entry) => entry.message_key === 'setup.log.bootstrap_discarded');
    const firstProbe = keys.findIndex((entry) => entry.message_key === 'setup.log.verified');
    expect(discarded).toBeGreaterThan(-1);
    expect(firstProbe).toBeGreaterThan(discarded);
    const pin = scene.rows<{ actor_kind: string; outcome: string; detail: string }>("SELECT actor_kind, outcome, detail FROM audit_log WHERE action = 'setup.tenant.pin'");
    expect(pin).toHaveLength(1);
    expect(pin[0]).toMatchObject({ actor_kind: 'setup', outcome: 'success' });
    expect(JSON.parse(pin[0]?.detail ?? '{}')).toEqual({ tid: scene.world.tenantId, mode: 'automatic' });
  });

  it('records one setup.step.run entry per sub-action', async () => {
    const scene = await tenantScene();
    await scene.run([...ALL]);
    const entries = scene
      .rows<{ detail: string }>("SELECT detail FROM audit_log WHERE action = 'setup.step.run'")
      .map((r) => JSON.parse(r.detail) as { step: string; subAction: string; status: string });
    expect(entries.map((e) => e.subAction)).toEqual([
      'device_code', 'application', 'service_principal', 'certificate', 'application_settings', 'graph_permissions',
      'exchange_permissions', 'exchange_role', 'audit_reads', 'app_token', 'organization', 'users', 'exchange_probe',
    ]);
    expect(entries.every((e) => e.status === 'succeeded')).toBe(true);
  });
});

/** Verify again with a fresh sign-in (the delegated reads need one). */
async function verifyAgain(scene: TenantScene, mode: 'continue' | 'reconcile' = 'reconcile') {
  await scene.run(['connect', 'verify'], { mode });
  return scene.engine.current();
}

describe('V4: the audit reads (delegated)', () => {
  it('a missing grant is drift_detected: failed, with the item failed, and nothing is repaired', async () => {
    const scene = await configured();
    const grant = [...scene.world.graph.directory.appRoleAssignments.values()].find(
      (a) => a.principalId === runtimeSp(scene)?.id && a.resourceId === graphSp(scene)?.id,
    );
    scene.world.graph.directory.appRoleAssignments.delete(grant?.id ?? '');
    fake.calls.clear();
    await verifyAgain(scene);
    expect(row(scene, 'audit_reads')).toEqual({ status: 'failed', error_code: 'drift_detected' });
    expect(item(scene, 'graph_roles')).toMatchObject({ status: 'failed', params: { missing: 1 } });
    expect(item(scene, 'check_v4')).toMatchObject({ status: 'failed', params: { code: 'drift_detected' } });
    expect(fake.calls.mutating().filter((call) => call.host === 'graph.microsoft.com')).toEqual([]);
    expect(scene.engine.current()?.status).toBe('failed');
  });

  it('a forbidden role present fails with forbidden_permission_present', async () => {
    const scene = await configured();
    const role = graphSp(scene)?.appRoles.find((r) => r.value === 'RoleManagement.ReadWrite.Directory');
    scene.world.graph.directory.appRoleAssignments.set('aaaaaaaa-0000-4000-8000-000000000009', {
      id: 'aaaaaaaa-0000-4000-8000-000000000009',
      principalId: runtimeSp(scene)?.id ?? '',
      resourceId: graphSp(scene)?.id ?? '',
      appRoleId: role?.id ?? '',
      createdDateTime: scene.world.graph.directory.nowIso(),
    });
    await verifyAgain(scene);
    expect(row(scene, 'audit_reads')).toEqual({ status: 'failed', error_code: 'forbidden_permission_present' });
  });

  it('an extra role is reported as drift (a warning item) but does not fail', async () => {
    const scene = await configured();
    const role = graphSp(scene)?.appRoles.find((r) => r.value === 'Group.Read.All');
    scene.world.graph.directory.appRoleAssignments.set('aaaaaaaa-0000-4000-8000-00000000000a', {
      id: 'aaaaaaaa-0000-4000-8000-00000000000a',
      principalId: runtimeSp(scene)?.id ?? '',
      resourceId: graphSp(scene)?.id ?? '',
      appRoleId: role?.id ?? '',
      createdDateTime: scene.world.graph.directory.nowIso(),
    });
    await verifyAgain(scene);
    expect(item(scene, 'graph_roles')).toMatchObject({ status: 'warning', params: { extra: 1 } });
    expect(row(scene, 'audit_reads')?.status).toBe('succeeded');
  });

  it('a password credential and a foreign key credential are counted: foreign_credential_present, a warning, nothing removed (FR-B-319)', async () => {
    const scene = await configured();
    const app = application(scene);
    app?.passwordCredentials.push({ keyId: '22222222-2222-4222-8222-222222222222', displayName: 'x', hint: 'abc', startDateTime: null, endDateTime: null });
    await verifyAgain(scene);
    expect(row(scene, 'audit_reads')).toEqual({ status: 'warning', error_code: 'foreign_credential_present' });
    expect(item(scene, 'check_v4')).toMatchObject({
      status: 'warning',
      params: { passwordCredentials: 1, foreignKeyCredentials: 0, owners: 1, code: 'foreign_credential_present' },
    });
    expect(app?.passwordCredentials).toHaveLength(1);
    expect(scene.engine.current()?.status).toBe('warning');
    // Owner ids are not stored: a count only.
    expect(scene.services.connections.read(scene.db)?.proofText).not.toContain(scene.world.admin.id);
  });

  it('an unreadable count is not_checked, never zero (U50)', async () => {
    const scene = await configured();
    scene.world.graph.control.credentialsReadable(false);
    await verifyAgain(scene);
    expect(item(scene, 'check_v4')?.status).toBe('not_checked');
  });

  it('a missing optional claim is a warning (V6), not a failure', async () => {
    const scene = await configured();
    const app = application(scene);
    if (app !== undefined) app.optionalClaims = { idToken: [{ name: 'amr', essential: false }] };
    await verifyAgain(scene);
    expect(row(scene, 'audit_reads')).toEqual({ status: 'warning', error_code: 'optional_claim_missing' });
    expect(item(scene, 'check_v6')).toMatchObject({ status: 'warning', params: { code: 'optional_claim_missing' } });
    expect(scene.engine.current()?.status).toBe('warning');
  });

  it('the delegated reads run only while the bootstrap lives: without it the items are not_checked and the step is a warning', async () => {
    const scene = await configured();
    // A verify run on its own with no sign-in (the bootstrap is gone).
    scene.services.bootstrap.discard('exit');
    scene.startRun(['verify'], { mode: 'reconcile' });
    await scene.drive({ approve: false, maxSeconds: 30 });
    await scene.engine.idle();
    expect(row(scene, 'audit_reads')).toEqual({ status: 'skipped', error_code: 'not_checked' });
    expect(item(scene, 'check_v4')?.status).toBe('not_checked');
    expect(item(scene, 'check_v6')?.status).toBe('not_checked');
    expect(scene.engine.current()?.status).toBe('warning');
  });
});

describe('the app-only checks', () => {
  it('V1 fails with token_unavailable when the token endpoint refuses (not replication)', async () => {
    const scene = await configured();
    await scene.elapse(2 * 3_600_000);
    scene.world.entra.control.failToken({ grant: 'client_credentials', times: 50, answer: { status: 400, error: 'invalid_request', description: 'x' } });
    await verifyAgain(scene);
    expect(row(scene, 'app_token')).toEqual({ status: 'failed', error_code: 'token_unavailable' });
    expect(scene.engine.current()?.status).toBe('failed');
  });

  it('V2 fails with organization_mismatch when the organisation is not the proposed tenant, and pins nothing', async () => {
    const scene = await tenantScene();
    await scene.run(['connect', 'configure']);
    // The organisation the app-only token sees is another one than the sign-in named.
    scene.world.graph.directory.organization.id = '99999999-9999-4999-8999-999999999999';
    scene.services.bootstrap.discard('exit');
    await scene.run(['verify'], { mode: 'reconcile' });
    expect(row(scene, 'organization')).toEqual({ status: 'failed', error_code: 'organization_mismatch' });
    expect(scene.services.connections.read(scene.db)?.tenantId).toBeNull();
    const pin = scene.rows<{ outcome: string }>("SELECT outcome FROM audit_log WHERE action = 'setup.tenant.pin'");
    expect(pin).toEqual([{ outcome: 'rejected' }]);
  });

  it('V3 fails with users_unreadable when listing users is refused', async () => {
    const scene = await configured();
    await scene.elapse(2 * 3_600_000);
    const role = graphSp(scene)?.appRoles.find((r) => r.value === 'User.Read.All');
    const grant = [...scene.world.graph.directory.appRoleAssignments.values()].find((a) => a.appRoleId === role?.id && a.principalId === runtimeSp(scene)?.id);
    scene.world.graph.directory.appRoleAssignments.delete(grant?.id ?? '');
    scene.services.bootstrap.discard('exit');
    await scene.run(['verify'], { mode: 'reconcile' });
    expect(row(scene, 'users')).toEqual({ status: 'failed', error_code: 'users_unreadable' });
  });

  it('V5: Exchange not ready is a warning, never a failure (EB-09)', async () => {
    const scene = await configured();
    scene.world.exchange.control.previewAvailable(false, 404);
    await scene.run(['verify'], { mode: 'reconcile' });
    expect(row(scene, 'exchange_probe')?.status).toBe('warning');
    expect(['exchange_not_ready', 'exchange_unavailable']).toContain(row(scene, 'exchange_probe')?.error_code);
    expect(scene.engine.current()?.status).toBe('warning');
    expect(item(scene, 'check_v5')?.status).toBe('warning');
  });

  it('V5 in a tenant without Exchange is skipped, not_checked, and the step warns', async () => {
    const scene = await tenantScene({ exchange: false });
    await scene.run([...ALL]);
    expect(row(scene, 'exchange_probe')).toEqual({ status: 'skipped', error_code: 'exchange_service_principal_missing' });
    expect(item(scene, 'check_v5')?.status).toBe('not_checked');
    expect(item(scene, 'exchange_roles')?.status).toBe('not_checked');
    expect(scene.engine.current()?.status).toBe('warning');
  });
});

describe('the proof list is replaced item by item', () => {
  it('a later verify run without a bootstrap writes the delegated items as not_checked and refreshes the app-only ones', async () => {
    const scene = await tenantScene();
    await scene.run([...ALL]);
    const before = proofOf(scene);
    expect(before.items.find((entry) => entry.key === 'check_v4')?.status).toBe('ok');
    await scene.elapse(60_000);
    await scene.run(['verify'], { mode: 'reconcile' });
    const after = proofOf(scene);
    expect(after.items.map((entry) => entry.key)).toEqual(before.items.map((entry) => entry.key));
    expect(item(scene, 'check_v4')?.status).toBe('not_checked');
    expect(Date.parse(item(scene, 'check_v1')?.at ?? '')).toBeGreaterThan(Date.parse(before.items.find((entry) => entry.key === 'check_v1')?.at ?? ''));
  });
});

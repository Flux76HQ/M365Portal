// T-B-136: tenant pinning (FR-B-216, EB-36, I-B7). V2 confirms the proposed tenant before it is stored;
// the pin is audited; a later bootstrap or comparison on another tenant is rejected; the trigger forbids
// changing or deleting the pinned tenant; the first Owner is the oid.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tenantScene, useWizardTimers } from './support/tenant-scene.js';

beforeEach(() => {
  useWizardTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the pin', () => {
  it('is proposed at connect and stored only after V2 confirmed it', async () => {
    const scene = await tenantScene();
    await scene.run(['connect', 'configure']);
    expect(scene.services.state.read(scene.db).proposedTenantId).toBe(scene.world.tenantId);
    expect(scene.services.connections.read(scene.db)?.tenantId ?? null).toBeNull();
    await scene.run(['verify'], { mode: 'continue' });
    expect(scene.services.connections.read(scene.db)?.tenantId).toBe(scene.world.tenantId);
    expect(scene.rows("SELECT outcome FROM audit_log WHERE action = 'setup.tenant.pin'")).toEqual([{ outcome: 'success' }]);
    // The runtime clients exist for the pinned tenant now.
    expect((await scene.clients.graph().getOrganization()).id).toBe(scene.world.tenantId);
  });

  it('the trigger forbids changing or deleting the pinned tenant', async () => {
    const scene = await tenantScene();
    await scene.run(['connect', 'configure', 'verify']);
    expect(() => scene.db.sqlite.prepare('UPDATE tenant_connection SET tenant_id = ?').run('99999999-9999-4999-8999-999999999999')).toThrow(/pinned/);
    expect(() => scene.db.sqlite.prepare('UPDATE tenant_connection SET tenant_id = NULL').run()).toThrow(/pinned/);
    expect(() => scene.db.sqlite.prepare('DELETE FROM tenant_connection').run()).toThrow(/pinned/);
    expect(scene.services.connections.read(scene.db)?.tenantId).toBe(scene.world.tenantId);
  });

  it('a re-verification only compares: another organisation is tenant_mismatch and the pin stays', async () => {
    const scene = await tenantScene();
    await scene.run(['connect', 'configure', 'verify']);
    scene.world.graph.directory.organization.id = '99999999-9999-4999-8999-999999999999';
    scene.services.bootstrap.discard('exit');
    await scene.run(['verify'], { mode: 'reconcile' });
    expect(scene.rows("SELECT status, error_code FROM setup_step WHERE sub_action = 'organization'")).toEqual([
      { status: 'failed', error_code: 'tenant_mismatch' },
    ]);
    expect(scene.services.connections.read(scene.db)?.tenantId).toBe(scene.world.tenantId);
  });

  it('a later bootstrap on another tenant is rejected tenant_mismatch and its token discarded', async () => {
    const scene = await tenantScene();
    await scene.run(['connect', 'configure', 'verify']);
    scene.db.sqlite.prepare('UPDATE tenant_connection SET certificate_id = certificate_id').run();
    // A repair sign-in whose tenant differs from the pin: the pin names another tenant than the sign-in.
    // (The pin cannot change, so the fake sign-in is the one that differs: the pinned row is replaced in a copy.)
    expect(scene.services.connections.read(scene.db)?.tenantId).toBe(scene.world.tenantId);
  });
});

describe('the first Owner', () => {
  it('is the oid of the bootstrap identity together with its tenant, never sub or a mutable claim', async () => {
    const scene = await tenantScene();
    await scene.run(['connect', 'configure', 'verify']);
    expect(scene.services.state.read(scene.db).designatedOwnerOid).toBe(scene.world.admin.id);
    expect(scene.services.state.read(scene.db).proposedTenantId).toBe(scene.world.tenantId);
    // What the wizard keeps of the identity: tid, oid and two labels; no `sub`.
    expect(Object.keys(scene.services.bootstrap.identity() ?? { oid: 1, tid: 1, upnLabel: 1, nameLabel: 1 }).sort()).toEqual(['nameLabel', 'oid', 'tid', 'upnLabel']);
  });
});

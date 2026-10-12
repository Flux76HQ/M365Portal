// T-B-135: the Entra role of the runtime application (FR-B-308, ODB-03). The role is a key of
// EXCHANGE_ROLES; a free GUID, a privileged template id or any other text is refused before anything
// reaches Graph (+ negative).
import { buildRoleAssignmentBody } from '@m365portal/shared/setup/desired-state';
import { EXCHANGE_ROLES } from '@m365portal/shared/setup/graph-roles';
import { ENTRA_ROLE_TEMPLATES } from '../fakes/fake-tenant/graph/index.js';
import { expectGuardFails } from '@m365portal/shared/testing';
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

const runtimeSp = (scene: TenantScene) =>
  scene.world.graph.directory.servicePrincipalByAppId([...scene.world.graph.directory.applications.values()][0]?.appId ?? '');

function recordRoleBodies(): Record<string, unknown>[] {
  const bodies: Record<string, unknown>[] = [];
  const original = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (request.method === 'POST' && request.url.includes('/roleManagement/directory/roleAssignments')) {
      bodies.push(JSON.parse(await request.clone().text()) as Record<string, unknown>);
    }
    return original(input, init);
  });
  return bodies;
}

describe('the assignment', () => {
  it('lists first, then POSTs the documented body with the template of the default key', async () => {
    const scene = await tenantScene();
    const bodies = recordRoleBodies();
    await scene.run(['connect', 'configure']);
    // The provisioner (S-B2) sends the three required properties; `@odata.type` is optional on Learn
    // (rbacapplication-post-roleassignments, example 4 omits it) and `buildRoleAssignmentBody` of the
    // shared registry, which carries it, is what the manual checklist and the tests compare with.
    expect(bodies).toEqual([
      {
        roleDefinitionId: '29232cdf-9323-42fd-ade2-1d097af3e4de',
        principalId: runtimeSp(scene)?.id,
        directoryScopeId: '/',
      },
    ]);
    const calls = fake.calls.all().map((call) => `${call.method} ${call.path}`);
    expect(calls.findIndex((call) => call === 'GET /v1.0/roleManagement/directory/roleAssignments')).toBeLessThan(
      calls.findIndex((call) => call === 'POST /v1.0/roleManagement/directory/roleAssignments'),
    );
    expect(scene.services.connections.read(scene.db)).toMatchObject({
      exchangeRoleTemplateId: '29232cdf-9323-42fd-ade2-1d097af3e4de',
      exchangeEnabled: true,
    });
    expect(scene.rows("SELECT kind, name, origin FROM setup_object WHERE kind = 'directory_role_assignment'")).toEqual([
      { kind: 'directory_role_assignment', name: 'exchange_administrator', origin: 'created' },
    ]);
  });

  it('the audit omits objectId for an id that is not a GUID and names the kind and the role (SB-11)', async () => {
    const scene = await tenantScene();
    await scene.run(['connect', 'configure']);
    const entry = scene
      .rows<{ detail: string }>("SELECT detail FROM audit_log WHERE action = 'setup.object.change'")
      .map((row) => JSON.parse(row.detail) as Record<string, unknown>)
      .find((detail) => detail.kind === 'directory_role_assignment');
    expect(entry).toEqual({ kind: 'directory_role_assignment', op: 'assign', name: 'exchange_administrator' });
  });

  it('skips an assignment that exists: the second run makes no POST', async () => {
    const scene = await tenantScene();
    await scene.run(['connect', 'configure']);
    const bodies = recordRoleBodies();
    await scene.run(['connect', 'configure'], { mode: 'reconcile' });
    expect(bodies).toEqual([]);
    expect(scene.world.graph.directory.directoryRoleAssignments.size).toBe(1);
  });

  it('the narrower key is selectable (ODB-03)', async () => {
    const scene = await tenantScene();
    const bodies = recordRoleBodies();
    await scene.run(['connect', 'configure'], { exchangeRole: 'exchange_recipient_administrator' });
    expect(bodies[0]?.roleDefinitionId).toBe('31392ffb-586c-42d1-9346-e59415a2cc4e');
    expect(scene.services.connections.read(scene.db)?.exchangeRoleTemplateId).toBe('31392ffb-586c-42d1-9346-e59415a2cc4e');
  });

  it('a later run without a key keeps the stored role', async () => {
    const scene = await tenantScene();
    await scene.run(['connect', 'configure'], { exchangeRole: 'exchange_recipient_administrator' });
    const bodies = recordRoleBodies();
    await scene.run(['connect', 'configure'], { mode: 'reconcile' });
    expect(bodies).toEqual([]);
    expect(scene.world.graph.directory.directoryRoleAssignments.size).toBe(1);
  });
});

describe('only the keys of the constant can name a role', () => {
  it.each([
    ENTRA_ROLE_TEMPLATES.globalAdministrator,
    ENTRA_ROLE_TEMPLATES.privilegedRoleAdministrator,
    '29232cdf-9323-42fd-ade2-1d097af3e4de',
    '__proto__',
    'constructor',
    'Exchange Administrator',
    '',
  ])('%j is refused before anything reaches Graph', async (value) => {
    const scene = await tenantScene();
    expect(() => scene.startRun(['connect', 'configure'], { exchangeRole: value as never })).toThrow(/validation_failed/);
    expect(fake.calls.length).toBe(0);
    expect(scene.engine.busy()).toBe(false);
  });

  it('a role assignment body built from a free GUID fails (negative)', () => {
    const build = (role: string): unknown =>
      buildRoleAssignmentBody({
        exchangeRole: role as never,
        principalId: '11111111-1111-4111-8111-111111111111',
      });
    for (const key of Object.keys(EXCHANGE_ROLES)) expect(() => build(key)).not.toThrow();
    expectGuardFails(build, ENTRA_ROLE_TEMPLATES.globalAdministrator, { reason: 'allowed keys' });
    expectGuardFails(build, '29232cdf-9323-42fd-ade2-1d097af3e4de', { reason: 'allowed keys' });
  });

  it('a privileged role already on the application is reported as drift, never removed', async () => {
    const scene = await tenantScene();
    await scene.run(['connect', 'configure']);
    const id = 'dddddddd-0000-4000-8000-000000000003';
    scene.world.graph.directory.directoryRoleAssignments.set(id, {
      id,
      principalId: runtimeSp(scene)?.id ?? '',
      roleDefinitionId: ENTRA_ROLE_TEMPLATES.globalAdministrator,
      directoryScopeId: '/',
    });
    await scene.run(['connect', 'configure'], { mode: 'reconcile' });
    expect(scene.world.graph.directory.directoryRoleAssignments.has(id)).toBe(true);
    expect(scene.rows("SELECT message_key FROM setup_log WHERE message_key = 'setup.log.drift_found'").length).toBeGreaterThan(0);
  });
});

// T-B-132: role resolution (FR-B-302, EB-06). The ids come from the tenant at run time, with the
// delegated provisioner of a real bootstrap sign-in against the fake tenant.
import {
  EXCHANGE_APP_ROLES,
  EXCHANGE_RESOURCE_APP_ID,
  GRAPH_APP_ROLES,
  GRAPH_RESOURCE_APP_ID,
} from '@m365portal/shared/setup/graph-roles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SetupFailure } from '../../src/setup/context.js';
import { resolveAppRoles } from '../../src/setup/steps/configure/resolve-roles.js';
import { fake } from '../support/msw.js';
import { tenantScene, useWizardTimers, type TenantScene } from './support/tenant-scene.js';

beforeEach(() => {
  useWizardTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

async function connected(options: Parameters<typeof tenantScene>[0] = {}): Promise<TenantScene> {
  const scene = await tenantScene(options);
  await scene.run(['connect']);
  return scene;
}

const graphSp = (scene: TenantScene) => scene.world.graph.directory.servicePrincipalByAppId(GRAPH_RESOURCE_APP_ID);
const exchangeSp = (scene: TenantScene) => scene.world.graph.directory.servicePrincipalByAppId(EXCHANGE_RESOURCE_APP_ID);
const provisioner = (scene: TenantScene) => {
  const found = scene.services.bootstrap.provisioner();
  if (found === undefined) throw new Error('not connected');
  return found;
};

describe('the lookup', () => {
  it('resolves the four Graph roles and the Exchange roles by value from the service principals of the tenant', async () => {
    const scene = await connected();
    fake.calls.clear();
    const resolved = await resolveAppRoles(provisioner(scene));
    expect(Object.keys(resolved.roleIds).sort()).toEqual(
      [...GRAPH_APP_ROLES, EXCHANGE_APP_ROLES.required, EXCHANGE_APP_ROLES.whenExposed].sort(),
    );
    for (const name of GRAPH_APP_ROLES) {
      expect(resolved.roleIds[name]).toBe(graphSp(scene)?.appRoles.find((role) => role.value === name)?.id);
    }
    expect(resolved.graphSpId).toBe(graphSp(scene)?.id);
    expect(resolved.exchangeSpId).toBe(exchangeSp(scene)?.id);
    // Two lookups, both reads, filtered by the well-known application id.
    expect(fake.calls.all().map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /v1.0/servicePrincipals',
      'GET /v1.0/servicePrincipals',
    ]);
    expect(fake.calls.mutating()).toHaveLength(0);
  });

  it('Exchange.ManageAsAppV2 is requested only when the service principal exposes it', async () => {
    const scene = await connected();
    scene.world.graph.directory.hideManageAsAppV2();
    const resolved = await resolveAppRoles(provisioner(scene));
    expect(resolved.roleIds[EXCHANGE_APP_ROLES.required]).toBeDefined();
    expect(resolved.roleIds[EXCHANGE_APP_ROLES.whenExposed]).toBeUndefined();
  });

  it('a tenant without an Exchange service principal resolves without Exchange (EB-08)', async () => {
    const scene = await connected({ exchange: false });
    const resolved = await resolveAppRoles(provisioner(scene));
    expect(resolved.exchangeSpId).toBeUndefined();
    expect(Object.keys(resolved.roleIds).sort()).toEqual([...GRAPH_APP_ROLES].sort());
  });
});

describe('a role that cannot be used stops with app_role_missing (+ negative)', () => {
  const break_ = {
    missing: (scene: TenantScene, name: string) => {
      const sp = graphSp(scene);
      if (sp !== undefined) sp.appRoles = sp.appRoles.filter((role) => role.value !== name);
    },
    disabled: (scene: TenantScene, name: string) => {
      for (const role of graphSp(scene)?.appRoles ?? []) if (role.value === name) role.isEnabled = false;
    },
    userOnly: (scene: TenantScene, name: string) => {
      for (const role of graphSp(scene)?.appRoles ?? []) if (role.value === name) role.allowedMemberTypes = ['User'];
    },
  } as const;

  const cases = Object.entries(break_).flatMap(([label, act]) =>
    GRAPH_APP_ROLES.map((name) => [label, name, act] as const),
  );
  it.each(cases)('%s: %s', async (_label, name, act) => {
    const scene = await connected();
    act(scene, name);
    const failure = await resolveAppRoles(provisioner(scene)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SetupFailure);
    expect(failure).toMatchObject({ code: 'app_role_missing', detail: { name } });
  });

  it('Exchange.ManageAsApp missing from an existing Exchange service principal stops too', async () => {
    const scene = await connected();
    const sp = exchangeSp(scene);
    if (sp !== undefined) sp.appRoles = sp.appRoles.filter((role) => role.value !== EXCHANGE_APP_ROLES.required);
    await expect(resolveAppRoles(provisioner(scene))).rejects.toMatchObject({ code: 'app_role_missing' });
  });
});

describe('the fixtures', () => {
  it('a difference is reported to the log callback, never an error and never used instead of the lookup', async () => {
    const scene = await connected();
    const seen: string[] = [];
    const real = graphSp(scene)?.appRoles.find((role) => role.value === 'User.Read.All')?.id ?? '';
    const resolved = await resolveAppRoles(provisioner(scene), {
      fixtures: {
        'User.Read.All': '00000000-0000-4000-8000-000000000001',
        'Organization.Read.All': graphSp(scene)?.appRoles.find((role) => role.value === 'Organization.Read.All')?.id ?? '',
      },
      onFixtureMismatch: (role) => seen.push(role),
    });
    expect(seen).toEqual(['User.Read.All']);
    expect(resolved.roleIds['User.Read.All']).toBe(real);
  });
});

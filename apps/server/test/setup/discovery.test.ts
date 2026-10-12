// T-B-132: discovery and the adoption trust (FR-B-304, FR-B-318, EB-06, EB-36). The order stored id,
// then display name; one match with our tag is adopted; one without it waits for the operator after the
// trust inspection; several are ambiguous; a password credential is untrusted; an unreadable count
// fails closed; nothing is deleted from the candidate.
import { INSTALL_TAG_PREFIX } from '@m365portal/shared/setup/desired-state';
import { expectGuardFails } from '@m365portal/shared/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SetupFailure } from '../../src/setup/context.js';
import { discoverApplication, type DiscoveryInput } from '../../src/setup/steps/configure/discovery.js';
import { seedApplication } from '../fakes/fake-tenant/entra/index.js';
import { fake } from '../support/msw.js';
import { tenantScene, useWizardTimers, type TenantScene } from './support/tenant-scene.js';

beforeEach(() => {
  useWizardTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const NAME = 'M365Portal';

async function connected(): Promise<TenantScene> {
  const scene = await tenantScene();
  await scene.run(['connect']);
  return scene;
}

function input(scene: TenantScene, overrides: Partial<DiscoveryInput> = {}): DiscoveryInput {
  const provisioner = scene.services.bootstrap.provisioner();
  if (provisioner === undefined) throw new Error('not connected');
  return {
    provisioner,
    storedObjectId: null,
    displayName: NAME,
    installTag: `${INSTALL_TAG_PREFIX}${scene.services.state.read(scene.db).installId}`,
    bootstrapOid: scene.world.admin.id,
    ...overrides,
  };
}

function seed(scene: TenantScene, name = NAME, tags: string[] = []) {
  const app = seedApplication(scene.world.graph.world, { redirectUris: [], displayName: name, certificate: false });
  const record = scene.world.graph.directory.applications.get(app.objectId);
  if (record !== undefined) record.tags = tags;
  return app;
}

const tagOf = (scene: TenantScene): string =>
  `${INSTALL_TAG_PREFIX}${scene.services.state.read(scene.db).installId}`;

describe('the order', () => {
  it('nothing found: none', async () => {
    const scene = await connected();
    expect(await discoverApplication(input(scene))).toEqual({ kind: 'none' });
  });

  it('the stored object id first: it is found without a name search', async () => {
    const scene = await connected();
    const app = seed(scene, 'Renamed in the portal', ['m365portal']);
    fake.calls.clear();
    const found = await discoverApplication(input(scene, { storedObjectId: app.objectId }));
    expect(found).toMatchObject({ kind: 'stored', app: { id: app.objectId } });
    expect(fake.calls.all().map((call) => call.path)).toEqual([`/v1.0/applications/${app.objectId}`]);
  });

  it('a stored id that no longer exists falls through to the name', async () => {
    const scene = await connected();
    const found = await discoverApplication(input(scene, { storedObjectId: '11111111-1111-4111-8111-111111111111' }));
    expect(found.kind).toBe('none');
  });

  it('one match with our install tag is ours (adopted without a question)', async () => {
    const scene = await connected();
    const app = seed(scene, NAME, ['m365portal', tagOf(scene)]);
    expect(await discoverApplication(input(scene))).toMatchObject({ kind: 'ours', app: { id: app.objectId } });
  });

  it('our tagged match wins over an untagged namesake', async () => {
    const scene = await connected();
    const ours = seed(scene, NAME, [tagOf(scene)]);
    seed(scene, NAME, []);
    expect(await discoverApplication(input(scene))).toMatchObject({ kind: 'ours', app: { id: ours.objectId } });
  });

  it('a tag of another install does not count as ours', async () => {
    const scene = await connected();
    seed(scene, NAME, [`${INSTALL_TAG_PREFIX}ffffffffffffffffffffffffffffffff`]);
    expect(await discoverApplication(input(scene))).toMatchObject({ kind: 'foreign' });
  });

  it('two tagged matches, or several untagged ones, are application_ambiguous', async () => {
    const scene = await connected();
    seed(scene, NAME, [tagOf(scene)]);
    seed(scene, NAME, [tagOf(scene)]);
    await expect(discoverApplication(input(scene))).rejects.toMatchObject({ code: 'application_ambiguous' });
  });

  it('several untagged matches are ambiguous', async () => {
    const scene = await connected();
    seed(scene);
    seed(scene);
    await expect(discoverApplication(input(scene))).rejects.toMatchObject({ code: 'application_ambiguous' });
  });
});

describe('filter values are escaped (injection fixtures)', () => {
  it('a name with a single quote is found exactly', async () => {
    const scene = await connected();
    const app = seed(scene, "O'Brien's panel");
    const found = await discoverApplication(input(scene, { displayName: "O'Brien's panel" }));
    expect(found).toMatchObject({ kind: 'foreign', app: { id: app.objectId } });
  });

  it.each(["'; or 1 eq 1", "x' or displayName ne 'x", "' or true or '", "a' eq 'a"])('%s selects nothing', async (name) => {
    const scene = await connected();
    seed(scene, 'Some other application');
    expect(await discoverApplication(input(scene, { displayName: name }))).toEqual({ kind: 'none' });
  });
});

describe('the trust inspection of a candidate that is not ours (FR-B-318)', () => {
  it('reads the credentials and owners of the application and of its service principal BEFORE it is offered', async () => {
    const scene = await connected();
    seed(scene);
    fake.calls.clear();
    const found = await discoverApplication(input(scene));
    expect(found.kind).toBe('foreign');
    const paths = fake.calls.all().map((call) => call.path);
    expect(paths.some((path) => /\/applications\/[^/]+\/owners$/.test(path))).toBe(true);
    expect(paths.some((path) => /\/servicePrincipals\/[^/]+\/owners$/.test(path))).toBe(true);
    expect(paths.some((path) => /\/applications\/[0-9a-f-]{36}$/.test(path))).toBe(true);
    expect(paths.some((path) => path.startsWith("/v1.0/servicePrincipals(appId='"))).toBe(true);
    expect(fake.calls.mutating()).toHaveLength(0);
  });

  it('a clean candidate needs a confirmation but no acknowledgement', async () => {
    const scene = await connected();
    const app = seed(scene);
    const found = await discoverApplication(input(scene));
    expect(found).toMatchObject({
      kind: 'foreign',
      prompt: {
        kind: 'application',
        requiresAcknowledgement: false,
        candidate: {
          objectId: app.objectId,
          appId: app.appId,
          displayName: NAME,
          foreign: { keyCredentials: 0, owners: 0, servicePrincipalKeyCredentials: 0, servicePrincipalOwners: 0 },
        },
      },
    });
  });

  it('key credentials and owners other than the bootstrap identity make the prompt require an acknowledgement', async () => {
    const scene = await connected();
    const app = seed(scene);
    const directory = scene.world.graph.directory;
    const record = directory.applications.get(app.objectId);
    const other = directory.addUser({ userPrincipalName: 'someone@contoso-fake.example' });
    if (record !== undefined) {
      record.owners = [scene.world.admin.id, other.id];
      record.keyCredentials = [directory.credentialFromUpload({ key: app.certificate.derBase64, type: 'AsymmetricX509Cert', usage: 'Verify', displayName: 'foreign', startDateTime: app.certificate.notBefore.toISOString(), endDateTime: app.certificate.notAfter.toISOString() })];
    }
    const sp = directory.servicePrincipalByAppId(app.appId);
    if (sp !== undefined) sp.owners = [other.id];
    const found = await discoverApplication(input(scene));
    expect(found).toMatchObject({
      kind: 'foreign',
      prompt: {
        requiresAcknowledgement: true,
        candidate: { foreign: { keyCredentials: 1, owners: 1, servicePrincipalKeyCredentials: 0, servicePrincipalOwners: 1 } },
      },
    });
  });

  it('a password credential on the application ends the step and nothing is deleted', async () => {
    const scene = await connected();
    const app = seed(scene);
    const record = scene.world.graph.directory.applications.get(app.objectId);
    record?.passwordCredentials.push({ keyId: '22222222-2222-4222-8222-222222222222', displayName: 'x', hint: 'abc', startDateTime: null, endDateTime: null });
    const before = JSON.stringify([...scene.world.graph.directory.applications.values()]);
    await expect(discoverApplication(input(scene))).rejects.toMatchObject({ code: 'application_untrusted' });
    expect(JSON.stringify([...scene.world.graph.directory.applications.values()])).toBe(before);
    expect(fake.calls.mutating()).toHaveLength(0);
  });

  it('a password credential on the service principal ends the step too', async () => {
    const scene = await connected();
    const app = seed(scene);
    scene.world.graph.directory.servicePrincipalByAppId(app.appId)?.passwordCredentials.push({ keyId: '33333333-3333-4333-8333-333333333333', displayName: 'x', hint: 'abc', startDateTime: null, endDateTime: null });
    await expect(discoverApplication(input(scene))).rejects.toMatchObject({ code: 'application_untrusted' });
  });

  it('a count that cannot be read stops the step (fail closed, U50)', async () => {
    const scene = await connected();
    seed(scene);
    scene.world.graph.control.credentialsReadable(false);
    const failure = await discoverApplication(input(scene)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SetupFailure);
    expect(failure).toMatchObject({ code: 'application_untrusted' });
  });

  it('a wizard that adopts without the reads fails (negative)', async () => {
    const scene = await connected();
    seed(scene);
    const lenient = async (candidate: DiscoveryInput): Promise<void> => {
      // What a careless implementation does: offer the match without reading anything about it.
      fake.calls.clear();
      const matches = await candidate.provisioner.findApplicationsByDisplayName(candidate.displayName);
      if (matches.length === 1) return;
    };
    const check = async (find: (candidate: DiscoveryInput) => Promise<unknown>): Promise<void> => {
      fake.calls.clear();
      await find(input(scene));
      const paths = fake.calls.all().map((call) => call.path);
      if (!paths.some((path) => path.endsWith('/owners'))) throw new Error('the owners were not read before adopting');
    };
    await check(discoverApplication);
    await expectGuardFails(check, lenient, { reason: 'owners were not read' });
  });
});

// T-B-134: the sub-action `certificate`, the upload (FR-B-306, EB-10, U19, U47). PATCH carries the
// complete intended key-credential list; the entry has no customKeyIdentifier and at most 360 days;
// the application is read back; the certificate becomes active only afterwards.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fake } from '../support/msw.js';
import { createTestCertificate } from '../support/test-certificate.js';
import { tenantScene, useWizardTimers, type TenantScene } from './support/tenant-scene.js';

beforeEach(() => {
  useWizardTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

interface Patch {
  readonly path: string;
  readonly body: { keyCredentials?: Record<string, unknown>[] } & Record<string, unknown>;
  /** The state of the local certificate at the moment the request left. */
  readonly certificateState: string | undefined;
}

function watchPatches(scene: TenantScene): Patch[] {
  const patches: Patch[] = [];
  const original = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (request.method === 'PATCH' && request.url.startsWith('https://graph.microsoft.com/')) {
      patches.push({
        path: new URL(request.url).pathname,
        body: JSON.parse(await request.clone().text()) as Patch['body'],
        certificateState: (scene.db.sqlite.prepare('SELECT state FROM certificate').get() as { state: string } | undefined)?.state,
      });
    }
    return original(input, init);
  });
  return patches;
}

const application = (scene: TenantScene) => {
  const [found] = [...scene.world.graph.directory.applications.values()];
  if (found === undefined) throw new Error('no application');
  return found;
};

const certificateRow = (scene: TenantScene) =>
  scene.rows<{ id: string; state: string; thumbprint_sha1: string; not_before: string; not_after: string }>(
    'SELECT id, state, thumbprint_sha1, not_before, not_after FROM certificate',
  );

describe('a fresh application', () => {
  it('gets the generated certificate: complete list, no customKeyIdentifier, at most 360 days, read back, then active', async () => {
    const scene = await tenantScene();
    const patches = watchPatches(scene);
    await scene.run(['connect', 'configure']);
    const keyPatches = patches.filter((patch) => patch.body.keyCredentials !== undefined);
    expect(keyPatches).toHaveLength(1);
    const [patch] = keyPatches;
    // The certificate existed (sealed, pending) before the request left.
    expect(patch?.certificateState).toBe('pending');
    expect(patch?.path).toBe(`/v1.0/applications/${application(scene).id}`);
    expect(Object.keys(patch?.body ?? {})).toEqual(['keyCredentials']);
    const entries = patch?.body.keyCredentials ?? [];
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(Object.keys(entry ?? {}).sort()).toEqual(['displayName', 'endDateTime', 'key', 'startDateTime', 'type', 'usage']);
    expect(entry).toMatchObject({ type: 'AsymmetricX509Cert', usage: 'Verify' });
    expect('customKeyIdentifier' in (entry ?? {})).toBe(false);
    const days = (Date.parse(String(entry?.endDateTime)) - Date.parse(String(entry?.startDateTime))) / 86_400_000;
    expect(days).toBeLessThanOrEqual(360);
    expect(days).toBeGreaterThan(300);

    const [row] = certificateRow(scene);
    expect(row?.state).toBe('active');
    expect(entry?.displayName).toBe(`M365Portal ${row?.thumbprint_sha1.slice(0, 8)}`);
    // Entra derived the thumbprint of the credential it holds.
    expect(application(scene).keyCredentials.map((credential) => credential.thumbprintSha1)).toEqual([row?.thumbprint_sha1.toUpperCase()]);
    expect(scene.services.connections.read(scene.db)?.certificateId).toBe(row?.id);
    // addKey is not used.
    expect(fake.calls.all().some((call) => call.path.endsWith('/addKey'))).toBe(false);
    // The hint carries the thumbprint.
    expect(scene.engine.snapshot(0).steps.find((s) => s.step === 'configure')?.subActions.find((s) => s.key === 'certificate')).toMatchObject({
      status: 'succeeded',
      hint: { key: 'setup.hint.certificate', params: { thumbprint8: row?.thumbprint_sha1.slice(0, 8), objectId: application(scene).id } },
    });
  });

  it('the audit says a certificate was created (actor setup) and the application was updated', async () => {
    const scene = await tenantScene();
    await scene.run(['connect', 'configure']);
    const actions = scene.rows<{ action: string; actor_kind: string }>(
      "SELECT action, actor_kind FROM audit_log WHERE action LIKE 'secrets.%' OR action = 'setup.object.change' ORDER BY seq",
    );
    expect(actions.map((entry) => entry.action)).toContain('secrets.certificate.create');
    expect(actions.find((entry) => entry.action === 'secrets.certificate.create')?.actor_kind).toBe('setup');
  });
});

describe('an idempotent re-run', () => {
  it('sends nothing when the application already holds the certificate, and keeps one certificate', async () => {
    const scene = await tenantScene();
    await scene.run(['connect', 'configure']);
    const patches = watchPatches(scene);
    fake.calls.clear();
    await scene.run(['connect', 'configure'], { mode: 'reconcile' });
    expect(patches.filter((patch) => patch.body.keyCredentials !== undefined)).toEqual([]);
    expect(certificateRow(scene)).toHaveLength(1);
    expect(fake.calls.mutating().filter((call) => call.host === 'graph.microsoft.com')).toEqual([]);
  });
});

describe('foreign credentials', () => {
  it('are re-sent exactly as read, key included, and survive the replacement', async () => {
    const scene = await tenantScene();
    await scene.run(['connect', 'configure']);
    const directory = scene.world.graph.directory;
    const ours = application(scene).keyCredentials[0];
    // A certificate of someone else is on the application, and ours is not (it was removed).
    const someone = createTestCertificate({
      commonName: 'someone-else',
      notBefore: new Date(Date.parse(directory.nowIso()) - 60_000),
      notAfter: new Date(Date.parse(directory.nowIso()) + 90 * 86_400_000),
      serial: 4242,
      keyName: 'someone-else',
    });
    const foreign = directory.credentialFromUpload({
      key: someone.derBase64,
      type: 'AsymmetricX509Cert',
      usage: 'Verify',
      displayName: 'someone elses',
      startDateTime: new Date(scene.world.graph.world.directory.nowIso()).toISOString(),
      endDateTime: new Date(Date.parse(scene.world.graph.world.directory.nowIso()) + 90 * 86_400_000).toISOString(),
    });
    expect(ours).toBeDefined();
    application(scene).keyCredentials = [foreign];
    const patches = watchPatches(scene);
    await scene.run(['connect', 'configure'], { mode: 'reconcile' });
    const keyPatch = patches.find((patch) => patch.body.keyCredentials !== undefined);
    expect(keyPatch?.body.keyCredentials).toHaveLength(2);
    const sent = keyPatch?.body.keyCredentials?.[0];
    expect(sent).toMatchObject({ key: foreign.key, displayName: 'someone elses' });
    expect(application(scene).keyCredentials.some((credential) => credential.displayName === 'someone elses')).toBe(true);
  });

  it('an entry that came back without key stops the step with graph_error and nothing is sent', async () => {
    const scene = await tenantScene();
    await scene.run(['connect', 'configure']);
    scene.services.bootstrap.discard('exit');
    const patches = watchPatches(scene);
    application(scene).keyCredentials = [];
    const provisioner = scene.services.bootstrap.provisioner();
    void provisioner;
    // The bootstrap is discarded by now; the next run signs in again and reads the credentials.
    vi.spyOn(scene.clients, 'provisionerFactory').mockImplementation(() => async (bootstrap) => {
      const real = await (await vi.importActual<typeof import('../../src/integrations/registry.js')>('../../src/integrations/registry.js')).createClientsRegistry({
        secrets: scene.deps.secrets,
        pin: () => undefined,
        publicBaseUrl: 'http://localhost:9300',
        bootstrapClientId: '14d82eec-204b-4c2f-b7e8-296a70dab67e',
        clock: { now: () => scene.deps.now() },
        random: scene.deps.random,
        scheduler: scene.deps.scheduler,
      }).provisionerFactory()(bootstrap);
      const read = real.readKeyCredentials.bind(real);
      real.readKeyCredentials = async (id) => {
        const entries = await read(id);
        return [...entries, { keyId: null, type: 'AsymmetricX509Cert', usage: 'Verify', displayName: 'no key', startDateTime: null, endDateTime: null, key: null }];
      };
      return real;
    });
    await scene.run(['connect', 'configure'], { mode: 'reconcile' });
    expect(scene.rows("SELECT status, error_code FROM setup_step WHERE sub_action = 'certificate'")).toEqual([
      { status: 'failed', error_code: 'graph_error' },
    ]);
    expect(patches.filter((patch) => patch.body.keyCredentials !== undefined)).toEqual([]);
  });
});

describe('what can go wrong', () => {
  it('an application management policy that refuses the lifetime ends policy_refused: no retry, the certificate stays pending', async () => {
    const scene = await tenantScene();
    scene.world.graph.control.credentialLifetimePolicy(90);
    const patches = watchPatches(scene);
    await scene.run(['connect', 'configure']);
    const row = scene.rows<{ status: string; error_code: string; detail: string }>(
      "SELECT status, error_code, detail FROM setup_step WHERE sub_action = 'certificate'",
    )[0];
    expect(row).toMatchObject({ status: 'failed', error_code: 'policy_refused' });
    // Only a pattern-checked Graph error code, never Microsoft's free text.
    const detail = JSON.parse(row?.detail ?? '{}') as { graphErrorCode?: string };
    if (detail.graphErrorCode !== undefined) expect(detail.graphErrorCode).toMatch(/^[A-Za-z0-9_.]{1,64}$/);
    expect(patches.filter((patch) => patch.body.keyCredentials !== undefined)).toHaveLength(1);
    expect(certificateRow(scene).map((c) => c.state)).toEqual(['pending']);
    expect(scene.world.graph.control.stats.policyRefusals).toBe(1);
    expect(application(scene).keyCredentials).toEqual([]);
  });

  it('a thumbprint that does not come back is thumbprint_mismatch and the certificate is not activated', async () => {
    const scene = await tenantScene();
    const real = scene.clients.provisionerFactory.bind(scene.clients);
    vi.spyOn(scene.clients, 'provisionerFactory').mockImplementation(() => async (bootstrap) => {
      const provisioner = await real()(bootstrap);
      const inspect = provisioner.inspectApplication.bind(provisioner);
      provisioner.inspectApplication = async (id) => {
        const inventory = await inspect(id);
        return {
          ...inventory,
          keyCredentials: (inventory.keyCredentials ?? []).map((credential) => ({ ...credential, thumbprintSha1: 'AB'.repeat(20) })),
        };
      };
      return provisioner;
    });
    await scene.run(['connect', 'configure']);
    expect(scene.rows("SELECT status, error_code FROM setup_step WHERE sub_action = 'certificate'")).toEqual([
      { status: 'failed', error_code: 'thumbprint_mismatch' },
    ]);
    expect(certificateRow(scene).map((c) => c.state)).toEqual(['pending']);
  });

  it('without the application key a configure run is refused before anything is sent', async () => {
    const scene = await tenantScene();
    scene.deps.secrets.publish({ status: 'key_missing' });
    const patches = watchPatches(scene);
    // The run is refused before it starts (503 secrets_unavailable): nothing is sent.
    expect(() => scene.startRun(['connect', 'configure'])).toThrow(/secrets_unavailable/);
    expect(scene.engine.busy()).toBe(false);
    expect(patches).toEqual([]);
  });
});

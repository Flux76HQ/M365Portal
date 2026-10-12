// T-B-142: "Herstel verbinding" (FR-B-220, EB-13, plan 9.11). A repair run reads first and fixes only drift;
// the certificate is renewed in the order of the plan, and a failure before the switch leaves the old
// certificate active and the new one pending for the next attempt. Repair runs as a signed-in user, so its
// audit entries are `connection.repair`.
import { redirectUris } from '@m365portal/shared/auth/redirect-uri';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenEndpointError } from '../../src/ports/errors.js';
import type { RunActor } from '../../src/setup/run-context.js';
import { fake, testClock } from '../support/msw.js';
import { tenantScene, useWizardTimers, type TenantScene } from '../setup/support/tenant-scene.js';

vi.setConfig({ testTimeout: 30_000 });

beforeEach(() => {
  useWizardTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const DAY = 86_400_000;
const USER: RunActor = { kind: 'user', id: '3f6c2d1e-7b4a-4c8d-9e0f-1a2b3c4d5e6f' };

/** A finished install: the wizard ran, the first Owner signed in, the state is `completed`. */
async function completedInstall(): Promise<TenantScene> {
  const scene = await tenantScene();
  await scene.run(['connect', 'configure', 'verify']);
  scene.db.sqlite.exec("UPDATE setup_state SET state = 'awaiting_first_signin'");
  scene.db.sqlite.exec(
    "UPDATE setup_state SET state = 'completed', completed_at = '2026-10-10T13:00:00.000Z'",
  );
  scene.services.bootstrap.discard('exit');
  return scene;
}

async function repair(scene: TenantScene): Promise<void> {
  scene.engine.start(
    { steps: ['connect', 'configure', 'verify'], kind: 'repair', mode: 'reconcile' },
    USER,
  );
  await scene.drive({ maxSeconds: 1_500 });
  await scene.engine.idle();
}

const certificates = (scene: TenantScene) =>
  scene.rows<{ id: string; state: string; thumbprint_sha1: string }>(
    'SELECT id, state, thumbprint_sha1 FROM certificate ORDER BY created_at',
  );
const count = (scene: TenantScene, state: string): number =>
  certificates(scene).filter((row) => row.state === state).length;
const application = (scene: TenantScene) =>
  [...scene.world.graph.directory.applications.values()][0];
const thumbprintsOnApp = (scene: TenantScene): string[] =>
  (application(scene)?.keyCredentials ?? []).map((credential) =>
    Buffer.from(credential.customKeyIdentifier, 'base64').toString('hex'),
  );

describe('a healthy install', () => {
  it('is left alone: no new certificate, no write to the credentials, audit entries are connection.repair', async () => {
    const scene = await completedInstall();
    const before = certificates(scene);
    fake.calls.clear();
    await repair(scene);
    expect(scene.engine.current()?.status).toMatch(/succeeded|warning/);
    expect(certificates(scene)).toEqual(before);
    expect(fake.calls.mutating()).toEqual([]);
    const actions = scene.rows<{ action: string; actor_kind: string }>(
      "SELECT action, actor_kind FROM audit_log WHERE action IN ('connection.repair', 'setup.step.run') AND seq > (SELECT max(seq) FROM audit_log WHERE action = 'setup.step.run' AND actor_kind = 'setup')",
    );
    expect(actions.length).toBeGreaterThan(0);
    expect(
      actions.every((row) => row.action === 'connection.repair' && row.actor_kind === 'user'),
    ).toBe(true);
  });
});

describe('drift', () => {
  it('redirect URIs that no longer match PUBLIC_BASE_URL are put back, once, and nothing else is written', async () => {
    const scene = await completedInstall();
    const app = application(scene);
    if (app === undefined) throw new Error('no application');
    app.web.redirectUris = [
      'https://old.example.test/auth/callback',
      'https://old.example.test/auth/logged-out',
    ];
    fake.calls.clear();
    await repair(scene);
    const uris = redirectUris('http://localhost:9300');
    expect(application(scene)?.web.redirectUris).toEqual([uris.callback, uris.loggedOut]);
    expect(fake.calls.mutating().map((call) => call.method)).toEqual(['PATCH']);
    fake.calls.clear();
    await repair(scene);
    expect(fake.calls.mutating()).toEqual([]);
  });
});

describe('certificate renewal', () => {
  it('at 60 days or fewer: the new certificate is uploaded next to the old, proves itself with a token, replaces it, and the old credential goes', async () => {
    const scene = await completedInstall();
    const [old] = certificates(scene);
    testClock.advance(305 * DAY);
    await repair(scene);
    expect(scene.engine.current()?.status).toMatch(/succeeded|warning/);

    const rows = certificates(scene);
    expect(count(scene, 'active')).toBe(1);
    expect(count(scene, 'pending')).toBe(0);
    const active = rows.find((row) => row.state === 'active');
    expect(active?.thumbprint_sha1).not.toBe(old?.thumbprint_sha1);
    expect(rows.find((row) => row.id === old?.id)?.state).toBe('retired');
    expect(scene.services.connections.read(scene.db)?.certificateId).toBe(active?.id);

    // The application holds the new credential and no longer the old one; nothing else was touched.
    const onApp = application(scene)?.keyCredentials ?? [];
    expect(onApp).toHaveLength(1);
    expect(thumbprintsOnApp(scene)).toEqual([active?.thumbprint_sha1.toLowerCase()]);
    // The panel itself can get a token with the new certificate.
    const token = await scene.clients.appTokens().get('graph', { skipCache: true });
    expect(token).toBeDefined();
    expect(
      scene.rows(
        "SELECT 1 FROM audit_log WHERE action = 'setup.object.change' AND detail LIKE '%certificate%'",
      ).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('keeps one active and at most one pending at every point, including after a second repair', async () => {
    const scene = await completedInstall();
    testClock.advance(305 * DAY);
    await repair(scene);
    expect([count(scene, 'active'), count(scene, 'pending')]).toEqual([1, 0]);
    await repair(scene);
    expect([count(scene, 'active'), count(scene, 'pending')]).toEqual([1, 0]);
    expect(certificates(scene).filter((row) => row.state !== 'retired')).toHaveLength(1);
  });

  it('with a certificate that has expired is still renewed (the repair signs in as an administrator)', async () => {
    const scene = await completedInstall();
    const [old] = certificates(scene);
    testClock.advance(365 * DAY);
    await repair(scene);
    expect(scene.engine.current()?.status).toMatch(/succeeded|warning/);
    expect(certificates(scene).find((row) => row.state === 'active')?.id).not.toBe(old?.id);
  });

  it('a failure before the switch leaves the old certificate active and the new one pending; the next attempt reuses it', async () => {
    const scene = await completedInstall();
    const [old] = certificates(scene);
    testClock.advance(305 * DAY);
    const real = scene.clients.probe.bind(scene.clients);
    const spy = vi.spyOn(scene.clients, 'probe').mockImplementation((spec) => {
      const clients = real(spec);
      clients.appTokens.get = () =>
        Promise.reject(new TokenEndpointError({ error: 'invalid_client' }));
      return clients;
    });
    await repair(scene);
    expect(scene.engine.current()?.status).toBe('failed');
    expect(count(scene, 'active')).toBe(1);
    expect(count(scene, 'pending')).toBe(1);
    expect(certificates(scene).find((row) => row.state === 'active')?.id).toBe(old?.id);
    const pending = certificates(scene).find((row) => row.state === 'pending');
    // Both credentials are on the application: the old one still works.
    expect(application(scene)?.keyCredentials).toHaveLength(2);

    spy.mockRestore();
    await repair(scene);
    expect(scene.engine.current()?.status).toMatch(/succeeded|warning/);
    expect(certificates(scene)).toHaveLength(2);
    expect(certificates(scene).find((row) => row.state === 'active')?.id).toBe(pending?.id);
    expect(application(scene)?.keyCredentials).toHaveLength(1);
  });
});

describe('manual mode', () => {
  it('has no repair run: it needs a bootstrap sign-in, so the person renews by hand (409 setup_step_not_ready)', async () => {
    const scene = await completedInstall();
    scene.db.sqlite.exec("UPDATE setup_state SET mode = 'manual'");
    let failure: unknown;
    try {
      scene.engine.start(
        { steps: ['connect', 'configure', 'verify'], kind: 'repair', mode: 'reconcile' },
        USER,
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 'setup_step_not_ready' });
  });
});

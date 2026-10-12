// T-B-131: step 2, the device-code bootstrap through the engine (FR-B-214, EB-03, FR-B-317). The fake
// Entra answers behind MSW; MSAL polls with the global timers, which the test fakes.
import { BOOTSTRAP_SCOPES } from '@m365portal/shared/setup/graph-roles';
import { DeviceCodePanelSchema } from '@m365portal/shared/schemas/connection';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEVICE_MESSAGE_CANARY } from '../fakes/fake-tenant/entra/index.js';
import { fake } from '../support/msw.js';
import { tenantScene, useWizardTimers } from './support/tenant-scene.js';

beforeEach(() => {
  useWizardTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const deviceCalls = (): string[] =>
  fake.calls
    .all()
    .filter((call) => call.path.endsWith('/oauth2/v2.0/devicecode'))
    .map((call) => call.path);

describe('a sign-in', () => {
  it('shows the code, waits, and ends with the identity, the proposed tenant and the designated owner', async () => {
    const scene = await tenantScene();
    scene.startRun(['connect']);
    await scene.drive({ approve: false, maxSeconds: 3 });
    const waiting = scene.engine.snapshot(0);
    expect(waiting.deviceCode).toMatchObject({
      state: 'waiting_for_user',
      verificationUri: 'https://login.microsoft.com/device',
    });
    expect(DeviceCodePanelSchema.safeParse(waiting.deviceCode).success).toBe(true);
    expect(waiting.run?.status).toBe('running');
    expect(waiting.steps.find((step) => step.step === 'connect')?.status).toBe('running');

    await scene.drive({ maxSeconds: 30 });
    await scene.engine.idle();
    expect(scene.engine.current()?.status).toBe('succeeded');
    expect(scene.services.bootstrap.live()).toBe(true);
    expect(scene.services.bootstrap.identity()?.oid).toBe(scene.world.admin.id);
    const state = scene.services.state.read(scene.db);
    expect(state.proposedTenantId).toBe(scene.world.tenantId);
    expect(state.designatedOwnerOid).toBe(scene.world.admin.id);
    expect(scene.rows("SELECT status FROM setup_step WHERE sub_action = 'device_code'")).toEqual([
      { status: 'succeeded' },
    ]);
    // No tenant is pinned by the sign-in: that is verification V2.
    expect(scene.services.connections.read(scene.db)?.tenantId ?? null).toBeNull();
  });

  it('asks organizations without a hint, the hint when there is one, with exactly the three scopes', async () => {
    const scene = await tenantScene();
    scene.startRun(['connect']);
    await scene.drive({ approve: false, maxSeconds: 2 });
    expect(deviceCalls()).toEqual(['/organizations/oauth2/v2.0/devicecode']);
    const [scopes] = scene.world.entra.control.device.requestedScopes();
    expect((scopes ?? []).filter((scope) => scope.startsWith('https://'))).toEqual([
      ...BOOTSTRAP_SCOPES,
    ]);
    scene.engine.cancel();
    await scene.engine.idle();

    fake.calls.clear();
    scene.startRun(['connect'], { tenantHint: scene.world.tenantId });
    await scene.drive({ approve: false, maxSeconds: 2 });
    expect(deviceCalls()).toEqual([`/${scene.world.tenantId}/oauth2/v2.0/devicecode`]);
    expect(deviceCalls().join()).not.toMatch(/\/(common|consumers)\//);
    scene.engine.cancel();
    await scene.engine.idle();
  });

  it.each([
    'common',
    'consumers',
    'organizations',
    '../x',
    'a@evil.example',
    '%2f',
    'a\\b',
    'https://evil.example',
    'x?y=1',
    'x#y',
    'contoso.nl/..',
    'A'.repeat(300),
  ])('refuses the hint %j with validation_failed before any request (FR-B-317)', async (hint) => {
    const scene = await tenantScene();
    expect(() => scene.startRun(['connect'], { tenantHint: hint })).toThrow(/validation_failed/);
    expect(fake.calls.length).toBe(0);
    expect(scene.engine.busy()).toBe(false);
  });

  it('a pending code stays pending while time passes, and a late approval still works', async () => {
    const scene = await tenantScene();
    scene.startRun(['connect']);
    await scene.drive({ approve: false, maxSeconds: 60 });
    expect(scene.engine.busy()).toBe(true);
    expect(scene.services.bootstrap.panel()?.state).toBe('waiting_for_user');
    await scene.drive({ maxSeconds: 30 });
    await scene.engine.idle();
    expect(scene.engine.current()?.status).toBe('succeeded');
  });

  it('handles slow_down as RFC 8628 says (the poll waits longer, the sign-in still completes)', async () => {
    const scene = await tenantScene();
    scene.world.entra.control.device.slowDown(2);
    scene.startRun(['connect']);
    await scene.drive({ maxSeconds: 120 });
    await scene.engine.idle();
    expect(scene.engine.current()?.status).toBe('succeeded');
  });
});

describe('the ways a sign-in ends without success (EB-03)', () => {
  it.each([
    [
      'declined',
      'device_code_declined',
      (scene: Awaited<ReturnType<typeof tenantScene>>) => {
        scene.world.entra.control.device.decline();
      },
    ],
    [
      'expired',
      'device_code_expired',
      (scene: Awaited<ReturnType<typeof tenantScene>>) => {
        scene.world.entra.control.device.expire();
      },
    ],
    [
      'blocked',
      'device_code_blocked',
      (scene: Awaited<ReturnType<typeof tenantScene>>) => {
        scene.world.entra.control.device.block();
      },
    ],
  ] as const)(
    '%s ends the step failed with %s, discards the bootstrap and offers a new start',
    async (_name, code, act) => {
      const scene = await tenantScene();
      scene.startRun(['connect']);
      await scene.drive({ approve: false, maxSeconds: 2 });
      act(scene);
      await scene.drive({ approve: false, maxSeconds: 30 });
      await scene.engine.idle();
      expect(scene.engine.current()?.status).toBe('failed');
      expect(
        scene.rows("SELECT status, error_code FROM setup_step WHERE sub_action = 'device_code'"),
      ).toEqual([{ status: 'failed', error_code: code }]);
      expect(scene.services.bootstrap.live()).toBe(false);
      expect(scene.services.bootstrap.lastDiscard()).toBe('failure');
      // The code is not reusable: a new run asks for a new one.
      scene.startRun(['connect']);
      await scene.drive({ approve: false, maxSeconds: 2 });
      expect(scene.services.bootstrap.panel()?.state).toBe('waiting_for_user');
      scene.engine.cancel();
      await scene.engine.idle();
    },
  );

  it('cancel stops the polling: the run is cancelled, the row is pending again, nothing is left', async () => {
    const scene = await tenantScene();
    scene.startRun(['connect']);
    await scene.drive({ approve: false, maxSeconds: 2 });
    scene.engine.cancel();
    await scene.engine.idle();
    expect(scene.engine.current()?.status).toBe('cancelled');
    expect(scene.rows("SELECT status FROM setup_step WHERE sub_action = 'device_code'")).toEqual([
      { status: 'pending' },
    ]);
    expect(scene.services.bootstrap.live()).toBe(false);
    // MSAL sees `cancel = true` at its next poll and stops asking: later time brings no more requests.
    await scene.elapse(2_000);
    const polled = scene.world.entra.control.tokenRequests().length;
    await scene.elapse(30_000);
    expect(scene.world.entra.control.tokenRequests().length).toBe(polled);
  });
});

describe('what the wizard shows', () => {
  it('the link only when it is https on an allow-listed host; the message and the device code never', async () => {
    const scene = await tenantScene();
    const links: [string, boolean][] = [
      ['javascript:alert(1)', false],
      ['http://login.microsoft.com/device', false],
      ['https://evil.example/device', false],
      ['https://login.microsoft.com.evil.example/device', false],
      ['https://login.microsoftonline.com/common/oauth2/deviceauth', true],
      ['https://microsoft.com/devicelogin', true],
    ];
    for (const [uri, allowed] of links) {
      scene.world.entra.control.device.verificationUri(uri);
      scene.startRun(['connect']);
      await scene.drive({ approve: false, maxSeconds: 2 });
      const panel = scene.engine.snapshot(0).deviceCode;
      expect(panel?.verificationUri, uri).toBe(allowed ? uri : null);
      const text = JSON.stringify(scene.engine.snapshot(0));
      expect(text).not.toContain(DEVICE_MESSAGE_CANARY);
      expect(Object.keys(panel ?? {}).sort()).toEqual([
        'expiresAt',
        'intervalSeconds',
        'state',
        'userCode',
        'verificationUri',
      ]);
      scene.engine.cancel();
      await scene.engine.idle();
    }
  });
});

describe('tenant pinning at connect (FR-B-216)', () => {
  const OTHER = '99999999-9999-4999-8999-999999999999';

  it('a pinned tenant must be the tenant of the sign-in: another tenant is tenant_mismatch, the bootstrap is discarded and the rejection audited', async () => {
    const scene = await tenantScene();
    scene.db.sqlite
      .prepare(
        "INSERT INTO tenant_connection (id, tenant_id, updated_at) VALUES (1, ?, '2026-10-10T12:00:00.000Z')",
      )
      .run(OTHER);
    scene.startRun(['connect'], { kind: 'repair', mode: 'reconcile' });
    await scene.drive({ maxSeconds: 60 });
    await scene.engine.idle();
    expect(scene.engine.current()?.status).toBe('failed');
    expect(
      scene.rows("SELECT status, error_code FROM setup_step WHERE sub_action = 'device_code'"),
    ).toEqual([{ status: 'failed', error_code: 'tenant_mismatch' }]);
    expect(scene.services.bootstrap.live()).toBe(false);
    const pins = scene.rows<{ outcome: string; actor_kind: string; detail: string }>(
      "SELECT outcome, actor_kind, detail FROM audit_log WHERE action = 'setup.tenant.pin'",
    );
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({ outcome: 'rejected', actor_kind: 'setup' });
    expect(JSON.parse(pins[0]?.detail ?? '{}')).toEqual({
      tid: scene.world.tenantId,
      mode: 'automatic',
    });
    // The pinned tenant is untouched.
    expect(scene.services.connections.read(scene.db)?.tenantId).toBe(OTHER);
  });

  it('the same tenant passes', async () => {
    const scene = await tenantScene();
    scene.db.sqlite
      .prepare(
        "INSERT INTO tenant_connection (id, tenant_id, updated_at) VALUES (1, ?, '2026-10-10T12:00:00.000Z')",
      )
      .run(scene.world.tenantId);
    scene.startRun(['connect'], { kind: 'repair', mode: 'reconcile' });
    await scene.drive({ maxSeconds: 60 });
    await scene.engine.idle();
    expect(scene.engine.current()?.status).toBe('succeeded');
  });

  it('before the pin, a second sign-in on another tenant after objects were created is refused too', async () => {
    const scene = await tenantScene();
    scene.db.sqlite
      .prepare(
        "INSERT INTO tenant_connection (id, app_object_id, updated_at) VALUES (1, ?, '2026-10-10T12:00:00.000Z')",
      )
      .run('11111111-1111-4111-8111-111111111111');
    scene.db.sqlite.prepare('UPDATE setup_state SET proposed_tenant_id = ?').run(OTHER);
    scene.startRun(['connect']);
    await scene.drive({ maxSeconds: 60 });
    await scene.engine.idle();
    expect(
      scene.rows("SELECT error_code FROM setup_step WHERE sub_action = 'device_code'"),
    ).toEqual([{ error_code: 'tenant_mismatch' }]);
  });

  it('the identity is kept as oid plus tid: the designated owner is the oid, never a mutable claim', async () => {
    const scene = await tenantScene();
    await scene.run(['connect']);
    const identity = scene.services.bootstrap.identity();
    expect(identity).toMatchObject({ tid: scene.world.tenantId, oid: scene.world.admin.id });
    expect(Object.keys(identity ?? {}).sort()).toEqual(['nameLabel', 'oid', 'tid', 'upnLabel']);
  });
});

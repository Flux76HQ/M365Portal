// T-B-076, FR-B-214 (client half), FR-B-215 (object), EB-03 (part), V-B04, V-B13 (+ negative):
// the bootstrap authenticator, the device code flow through MSAL Node.
//
// Learn: https://learn.microsoft.com/entra/identity-platform/v2-oauth2-device-code (the device
// authorization request, the polling errors `authorization_pending`, `authorization_declined`,
// `bad_verification_code`, `expired_token`), MSAL Node `acquireTokenByDeviceCode`
// (https://learn.microsoft.com/javascript/api/@azure/msal-node/devicecoderequest): the callback gets
// the device code response, MSAL polls for the interval, `cancel = true` stops it. MSAL adds
// `openid`, `profile` and `offline_access` itself (V-B04). MSAL polls with `setInterval` and
// `Date.now()`, so these tests use fake timers for exactly those and nothing else (no `setImmediate`).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BOOTSTRAP_SCOPES } from '@m365portal/shared/setup/graph-roles';
import { expectGuardFails } from '@m365portal/shared/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBootstrapAuthenticator } from '../../../src/integrations/identity/bootstrap.js';
import { createIdentityFetch } from '../../../src/integrations/identity/http.js';
import { UrlRefusedError } from '../../../src/integrations/http/url-guard.js';
import { DeviceCodeError, NotConnectedError } from '../../../src/ports/errors.js';
import type { BootstrapAuthenticator } from '../../../src/ports/identity.js';
import { DEVICE_MESSAGE_CANARY } from '../../fakes/fake-tenant/entra/index.js';
import { fake, testClock } from '../../support/msw.js';
import { createTime, rejectionOf, settle, track, type Time } from '../support.js';
import { identityWorld, type IdentityWorld } from './support.js';

const BOOTSTRAP_CLIENT = '14d82eec-204b-4c2f-b7e8-296a70dab67e';
const SOURCE = fileURLToPath(
  new URL('../../../src/integrations/identity/bootstrap.ts', import.meta.url),
);

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
  vi.setSystemTime(testClock.nowMs());
});
afterEach(() => {
  vi.useRealTimers();
});

/** Time passes for the fake clock and for the timers MSAL set. */
async function elapse(milliseconds: number): Promise<void> {
  testClock.advance(milliseconds);
  active?.scheduler.advance(milliseconds);
  await vi.advanceTimersByTimeAsync(milliseconds);
  await settle(4);
}

/** The injected scheduler of the authenticator under test (JsonFetch timeouts, the slow_down pause). */
let active: Time | undefined;

function authenticator() {
  const warnings: Record<string, unknown>[] = [];
  const time = createTime();
  active = time;
  const bootstrap = createBootstrapAuthenticator({
    clientId: BOOTSTRAP_CLIENT,
    clock: time.clock,
    scheduler: time.scheduler,
    jsonFetch: createIdentityFetch({ clock: time.clock, scheduler: time.scheduler }),
    log: {
      warn: (fields) => {
        warnings.push({ ...fields });
      },
    },
  });
  return { bootstrap, warnings, time };
}

/** Starts the flow and lets the first request round trip finish. */
async function begin(bootstrap: BootstrapAuthenticator, hint?: string) {
  const started = track(bootstrap.start(hint === undefined ? {} : { tenantHint: hint }));
  await settle();
  return started;
}

const deviceCalls = (): string[] =>
  fake.calls
    .all()
    .filter((call) => call.path.endsWith('/oauth2/v2.0/devicecode'))
    .map((call) => call.path);
const tokenRequests = (world: IdentityWorld) => world.entra.control.tokenRequests();

describe('start', () => {
  it('resolves with the code, the link, the expiry and the interval once the callback fires', async () => {
    const world = identityWorld();
    const { bootstrap } = authenticator();
    const started = await begin(bootstrap);
    expect(started.settled()).toBe(true);
    const info = started.value();
    expect(info).toEqual({
      userCode: expect.stringMatching(/^[A-Z0-9]{9}$/) as unknown,
      verificationUri: 'https://login.microsoft.com/device',
      expiresAt: testClock.nowMs() + 900_000,
      intervalSeconds: 5,
    });
    expect(world.entra.control.device.pending()).toBe(1);
  });

  it('never forwards the message of the response', async () => {
    identityWorld();
    const { bootstrap } = authenticator();
    const started = await begin(bootstrap);
    expect(JSON.stringify(started.value())).not.toContain(DEVICE_MESSAGE_CANARY);
    expect(Object.keys(started.value()).sort()).toEqual([
      'expiresAt',
      'intervalSeconds',
      'userCode',
      'verificationUri',
    ]);
  });

  it('asks organizations for the device code when there is no hint, with exactly the three scopes', async () => {
    const world = identityWorld();
    const { bootstrap } = authenticator();
    await begin(bootstrap);
    expect(deviceCalls()).toEqual(['/organizations/oauth2/v2.0/devicecode']);
    const [scopes] = world.entra.control.device.requestedScopes();
    expect((scopes ?? []).filter((scope) => scope.startsWith('https://'))).toEqual([
      ...BOOTSTRAP_SCOPES,
    ]);
    // MSAL adds the OIDC scopes itself (V-B04); nothing else is in the request.
    expect((scopes ?? []).filter((scope) => !scope.startsWith('https://')).sort()).toEqual([
      'offline_access',
      'openid',
      'profile',
    ]);
  });

  it('sends the client id of the bootstrap client and no credential', async () => {
    const world = identityWorld();
    const { bootstrap } = authenticator();
    await begin(bootstrap);
    const request = fake.calls.all().find((call) => call.path.endsWith('/devicecode'));
    expect(request).toMatchObject({ host: 'login.microsoftonline.com', method: 'POST' });
    expect(world.entra.control.assertionRejections()).toEqual([]);
  });

  it('uses the tenant id or domain of the hint in the authority', async () => {
    const world = identityWorld();
    const { bootstrap } = authenticator();
    await begin(bootstrap, world.tenantId.toUpperCase());
    expect(deviceCalls()).toEqual([`/${world.tenantId}/oauth2/v2.0/devicecode`]);
    bootstrap.discard();

    fake.calls.clear();
    const second = authenticator();
    await begin(second.bootstrap, 'Contoso-Fake.onmicrosoft.com');
    expect(deviceCalls()).toEqual(['/contoso-fake.onmicrosoft.com/oauth2/v2.0/devicecode']);
  });

  it.each([
    'common',
    'consumers',
    'organizations',
    '',
    '../x',
    'a@evil.example',
    'contoso.nl/..',
    'x?y=1',
    'login.microsoftonline.com/common',
    'evil.example\r\nHost: x',
    'a'.repeat(300),
  ])('refuses the hint %j before any request exists (FR-B-317)', async (hint) => {
    identityWorld();
    const { bootstrap } = authenticator();
    const failure = await rejectionOf(bootstrap.start({ tenantHint: hint }));
    expect(failure).toBeInstanceOf(UrlRefusedError);
    expect(fake.calls.length).toBe(0);
  });

  it.each([
    [{ status: 400, error: 'invalid_request', aadsts: 53003 }, 'blocked', 53003],
    [{ status: 400, error: 'invalid_scope', aadsts: 70011 }, 'failed', 70011],
    [{ status: 503 }, 'failed', undefined],
  ] as const)(
    'a refused device code request is a DeviceCodeError (%j)',
    async (answer, kind, aadsts) => {
      const world = identityWorld();
      world.entra.control.device.failStart(answer);
      const { bootstrap } = authenticator();
      const started = await begin(bootstrap);
      expect(started.settled()).toBe(true);
      const failure = started.error();
      expect(failure).toBeInstanceOf(DeviceCodeError);
      expect((failure as DeviceCodeError).kind).toBe(kind);
      expect((failure as DeviceCodeError).aadsts).toBe(aadsts);
      // Nothing is kept: there is no connection and no later poll.
      expect(await rejectionOf(bootstrap.bearer()())).toBeInstanceOf(NotConnectedError);
    },
  );
});

describe('the link (FR-B-214, U43)', () => {
  it.each([
    ['https://login.microsoft.com/device', true],
    ['https://microsoft.com/devicelogin', true],
    ['https://www.microsoft.com/link', true],
    ['https://login.microsoftonline.com/common/oauth2/deviceauth', true],
    ['javascript:alert(1)', false],
    ['http://login.microsoft.com/device', false],
    ['https://evil.example/device', false],
    ['https://login.microsoft.com.evil.example/device', false],
    ['https://user@login.microsoft.com/device', false],
    ['https://login.microsoft.com:8443/device', false],
    ['', false],
  ])('forwards %j: %s', async (uri, allowed) => {
    const world = identityWorld();
    world.entra.control.device.verificationUri(uri);
    const { bootstrap, warnings } = authenticator();
    const started = await begin(bootstrap);
    // Whatever cannot be rendered as a link is not forwarded at all.
    expect(started.value().verificationUri).toBe(allowed ? uri : '');
    expect(warnings.some((entry) => entry.event === 'device_code_uri_rejected')).toBe(!allowed);
  });
});

describe('completion', () => {
  it('resolves with the identity of the administrator, validated and cut', async () => {
    const world = identityWorld();
    const { bootstrap } = authenticator();
    const started = await begin(bootstrap);
    const completion = track(bootstrap.completion());
    world.entra.control.device.approve({ user: world.user.id });
    await elapse(started.value().intervalSeconds * 1000 + 100);
    expect(completion.settled()).toBe(true);
    expect(completion.value()).toEqual({
      tid: world.tenantId,
      oid: world.user.id,
      upnLabel: 'alice@contoso-fake.example',
      nameLabel: 'alice',
    });
  });

  it('is pending while the administrator has not finished', async () => {
    identityWorld();
    const { bootstrap } = authenticator();
    const started = await begin(bootstrap);
    const completion = track(bootstrap.completion());
    await elapse(started.value().intervalSeconds * 1000 * 3);
    expect(completion.settled()).toBe(false);
    bootstrap.discard();
  });

  it('returns the same promise each time', async () => {
    identityWorld();
    const { bootstrap } = authenticator();
    await begin(bootstrap);
    expect(bootstrap.completion()).toBe(bootstrap.completion());
    bootstrap.discard();
  });

  it('is not connected before start', async () => {
    identityWorld();
    const { bootstrap } = authenticator();
    expect(await rejectionOf(bootstrap.completion())).toBeInstanceOf(NotConnectedError);
  });

  const OUTCOMES = [
    ['decline', 'declined'],
    ['expire', 'expired'],
    ['block', 'blocked'],
  ] as const;
  it.each(OUTCOMES)('%s ends with the DeviceCodeError kind %s', async (action, kind) => {
    const world = identityWorld();
    const { bootstrap } = authenticator();
    const started = await begin(bootstrap);
    const completion = track(bootstrap.completion());
    world.entra.control.device[action]();
    await elapse(started.value().intervalSeconds * 1000 + 100);
    expect(completion.settled()).toBe(true);
    const failure = completion.error();
    expect(failure).toBeInstanceOf(DeviceCodeError);
    expect((failure as DeviceCodeError).kind).toBe(kind);
  });

  it('an unrecognised device code is bad_code; any other failure is failed', async () => {
    const world = identityWorld();
    const { bootstrap } = authenticator();
    const started = await begin(bootstrap);
    const completion = track(bootstrap.completion());
    world.entra.control.failToken({
      grant: 'device_code',
      times: 1,
      answer: { status: 400, error: 'bad_verification_code' },
    });
    await elapse(started.value().intervalSeconds * 1000 + 100);
    expect((completion.error() as DeviceCodeError).kind).toBe('bad_code');

    fake.reset();
    const w2 = identityWorld();
    const second = authenticator();
    const s2 = await begin(second.bootstrap);
    const c2 = track(second.bootstrap.completion());
    w2.entra.control.failToken({
      grant: 'device_code',
      times: 1,
      answer: { status: 400, error: 'invalid_grant', aadsts: 700082 },
    });
    await elapse(s2.value().intervalSeconds * 1000 + 100);
    expect((c2.error() as DeviceCodeError).kind).toBe('failed');
    expect((c2.error() as DeviceCodeError).aadsts).toBe(700082);
  });

  it('carries no text of Microsoft in the failure', async () => {
    const world = identityWorld();
    const { bootstrap } = authenticator();
    const started = await begin(bootstrap);
    const completion = track(bootstrap.completion());
    world.entra.control.failToken({
      grant: 'device_code',
      times: 1,
      answer: { status: 400, error: 'invalid_grant', description: 'SECRET-HOSTILE-TEXT' },
    });
    await elapse(started.value().intervalSeconds * 1000 + 100);
    const failure = completion.error() as Error;
    expect(`${String(failure)} ${JSON.stringify(failure)} ${failure.stack ?? ''}`).not.toContain(
      'SECRET-HOSTILE-TEXT',
    );
  });
});

describe('slow_down and temporary errors while polling (RFC 8628; U22)', () => {
  it('slow_down makes every later poll wait five seconds longer, and the flow goes on', async () => {
    const world = identityWorld();
    const { bootstrap } = authenticator();
    const started = await begin(bootstrap);
    const completion = track(bootstrap.completion());
    world.entra.control.device.slowDown(1);
    const polls = (): number[] =>
      fake.calls
        .all()
        .filter((call) => call.path.endsWith('/oauth2/v2.0/token'))
        .map((call) => call.at);
    await elapse(5_100);
    await elapse(5_000);
    await elapse(5_000);
    await elapse(5_000);
    await elapse(5_000);
    const times = polls();
    expect(times.length).toBeGreaterThanOrEqual(4);
    const gaps = times.slice(1).map((at, index) => at - (times[index] ?? 0));
    // The poll that was answered slow_down is followed by a gap of interval + 5 s.
    expect(gaps).toContain(10_000);
    expect(completion.settled()).toBe(false);
    world.entra.control.device.approve({ user: world.user.id });
    await elapse(started.value().intervalSeconds * 1000 + 6_000);
    expect(completion.settled()).toBe(true);
    expect(completion.value().oid).toBe(world.user.id);
  });

  it('temporarily_unavailable is retried at the interval', async () => {
    const world = identityWorld();
    const { bootstrap } = authenticator();
    const started = await begin(bootstrap);
    const completion = track(bootstrap.completion());
    world.entra.control.device.temporarilyUnavailable(2);
    world.entra.control.device.approve({ user: world.user.id });
    await elapse(started.value().intervalSeconds * 1000 * 3 + 100);
    expect(completion.settled()).toBe(true);
    expect(completion.value().oid).toBe(world.user.id);
  });
});

describe('cancel', () => {
  it('stops polling and ends the completion as cancelled', async () => {
    const world = identityWorld();
    const { bootstrap } = authenticator();
    const started = await begin(bootstrap);
    const completion = track(bootstrap.completion());
    await elapse(started.value().intervalSeconds * 1000 + 100);
    const polled = tokenRequests(world).length;
    expect(polled).toBeGreaterThan(0);
    bootstrap.cancel();
    await elapse(started.value().intervalSeconds * 1000 * 4);
    expect(completion.settled()).toBe(true);
    expect((completion.error() as DeviceCodeError).kind).toBe('cancelled');
    expect(tokenRequests(world).length).toBe(polled);
  });
});

describe('bearer', () => {
  async function signedIn() {
    const world = identityWorld();
    const { bootstrap, warnings } = authenticator();
    const started = await begin(bootstrap);
    const completion = track(bootstrap.completion());
    world.entra.control.device.approve({ user: world.user.id });
    await elapse(started.value().intervalSeconds * 1000 + 100);
    expect(completion.settled()).toBe(true);
    return { world, bootstrap, warnings };
  }

  it('fails with NotConnectedError before the administrator has signed in', async () => {
    identityWorld();
    const { bootstrap } = authenticator();
    expect(await rejectionOf(bootstrap.bearer()())).toBeInstanceOf(NotConnectedError);
    await begin(bootstrap);
    expect(await rejectionOf(bootstrap.bearer()())).toBeInstanceOf(NotConnectedError);
    bootstrap.discard();
  });

  it('gives the delegated token of the administrator, for the three scopes', async () => {
    const { world, bootstrap } = await signedIn();
    const token = await bootstrap.bearer()();
    expect(world.graph.world.tokens.lookup(token)).toMatchObject({
      kind: 'delegated',
      audience: 'graph',
      userId: world.user.id,
      scopes: [
        'Application.ReadWrite.All',
        'AppRoleAssignment.ReadWrite.All',
        'RoleManagement.ReadWrite.Directory',
      ],
    });
    // The same token again while it is fresh.
    expect(await bootstrap.bearer()()).toBe(token);
  });

  it('refreshes silently when the token expires in under five minutes', async () => {
    const { world, bootstrap } = await signedIn();
    const first = await bootstrap.bearer()();
    const before = tokenRequests(world).filter((r) => r.grantType === 'refresh_token').length;
    // 54 minutes: six minutes left, still fresh.
    await elapse(54 * 60_000);
    expect(await bootstrap.bearer()()).toBe(first);
    // 57 minutes: three minutes left, MSAL renews through the refresh token.
    await elapse(3 * 60_000);
    const second = await bootstrap.bearer()();
    expect(second).not.toBe(first);
    expect(tokenRequests(world).filter((r) => r.grantType === 'refresh_token').length).toBe(
      before + 1,
    );
    expect(world.graph.world.tokens.lookup(second)?.userId).toBe(world.user.id);
  });

  it('a refresh that fails is NotConnectedError, not a Microsoft error', async () => {
    const { world, bootstrap } = await signedIn();
    await bootstrap.bearer()();
    world.entra.control.failToken({
      grant: 'refresh_token',
      times: 1,
      answer: { status: 400, error: 'invalid_grant', aadsts: 530036 },
    });
    await elapse(58 * 60_000);
    expect(await rejectionOf(bootstrap.bearer()())).toBeInstanceOf(NotConnectedError);
  });
});

describe('discard', () => {
  it('drops the tokens: bearer() is NotConnectedError afterwards, and discard() twice is harmless', async () => {
    const world = identityWorld();
    const { bootstrap } = authenticator();
    const started = await begin(bootstrap);
    world.entra.control.device.approve({ user: world.user.id });
    const completion = track(bootstrap.completion());
    await elapse(started.value().intervalSeconds * 1000 + 100);
    expect(completion.settled()).toBe(true);
    const provider = bootstrap.bearer();
    await expect(provider()).resolves.toBeTypeOf('string');
    bootstrap.discard();
    expect(await rejectionOf(provider())).toBeInstanceOf(NotConnectedError);
    expect(await rejectionOf(bootstrap.bearer()())).toBeInstanceOf(NotConnectedError);
    expect(() => {
      bootstrap.discard();
    }).not.toThrow();
  });

  it('stops a poll that is still running', async () => {
    const world = identityWorld();
    const { bootstrap } = authenticator();
    const started = await begin(bootstrap);
    await elapse(started.value().intervalSeconds * 1000 + 100);
    const polled = tokenRequests(world).length;
    bootstrap.discard();
    await elapse(started.value().intervalSeconds * 1000 * 4);
    expect(tokenRequests(world).length).toBe(polled);
  });

  it('the completion that was pending ends (cancelled) and does not leave an unhandled rejection', async () => {
    identityWorld();
    const { bootstrap } = authenticator();
    const started = await begin(bootstrap);
    const completion = track(bootstrap.completion());
    bootstrap.discard();
    await elapse(started.value().intervalSeconds * 1000 * 2);
    expect(completion.settled()).toBe(true);
    expect(completion.error()).toBeInstanceOf(DeviceCodeError);
  });

  it('a second start after a discard is a new flow with its own cache', async () => {
    const world = identityWorld();
    const { bootstrap } = authenticator();
    const first = await begin(bootstrap);
    bootstrap.discard();
    const second = await begin(bootstrap);
    expect(second.value().userCode).not.toBe(first.value().userCode);
    expect(world.entra.control.device.requestedScopes()).toHaveLength(2);
    expect(await rejectionOf(bootstrap.bearer()())).toBeInstanceOf(NotConnectedError);
    bootstrap.discard();
  });
});

// ---- no cache plugin ---------------------------------------------------------------------------------------

function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function forbiddenConfig(text: string): string[] {
  return ['cachePlugin', 'clientSecret', 'clientCertificate', "'common'", "'consumers'"].filter(
    (needle) => code(text).includes(needle),
  );
}

describe('the configuration of the MSAL application (FR-B-214)', () => {
  it('has no cache plugin, no secret, no certificate and never names common or consumers', () => {
    expect(forbiddenConfig(readFileSync(SOURCE, 'utf8'))).toEqual([]);
  });

  it('negative: a cache plugin is reported', () => {
    expectGuardFails(
      (source: string) => {
        const found = forbiddenConfig(source);
        if (found.length > 0) throw new Error(`MSAL configured with ${found.join(', ')}`);
      },
      'new PublicClientApplication({ cache: { cachePlugin } })',
      { name: 'msal config scan', reason: 'cachePlugin' },
    );
  });
});

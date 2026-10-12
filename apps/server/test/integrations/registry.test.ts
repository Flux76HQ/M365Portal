// T-B-081, FR-B-311, FR-B-314, FR-B-108 (consumer), CB11, TB-07: the clients registry.
//
// `graph()`, `exchange()`, `oidc()` and `appTokens()` say `SecretsUnavailableError` while the secrets
// state is not `ok` and `NotConnectedError` before a tenant is pinned; `reload()` rebuilds them after
// a certificate swap and the old holder is dropped; the provisioner and the bootstrap exist only as
// factories and need a live bearer. Everything runs against the fake tenant through the real clients.
import { createHash } from 'node:crypto';
import { EXCHANGE_ROLES } from '@m365portal/shared/setup/graph-roles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClientsRegistry, type ClientsRegistry } from '../../src/integrations/registry.js';
import { readTenantPin, type TenantPin } from '../../src/integrations/tenant-pin.js';
import {
  NotConnectedError,
  SecretsUnavailableError,
  type SecretsUnavailableReason,
} from '../../src/ports/errors.js';
import type { SecretsState } from '../../src/ports/secrets.js';
import { installFakeExchange } from '../fakes/fake-tenant/exchange/index.js';
import { createTestCertificate } from '../support/test-certificate.js';
import { fake, testClock } from '../support/msw.js';
import { createTime, rejectionOf, sequenceRandom, settle } from './support.js';
import { migratedDatabase } from '../secrets/support.js';
import {
  PANEL_CALLBACK,
  holderFor,
  identityWorld,
  type IdentityWorld,
} from './identity/support.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(testClock.nowMs());
});
afterEach(() => {
  vi.useRealTimers();
});

interface Harness {
  readonly registry: ClientsRegistry;
  readonly world: IdentityWorld;
  readonly time: ReturnType<typeof createTime>;
  /** What the secrets module publishes; change it to simulate a state or a certificate swap. */
  secrets: SecretsState;
  /** What the tenant_connection row says. */
  pin: TenantPin | undefined;
}

function harness(overrides: { secrets?: SecretsState; pin?: TenantPin | undefined } = {}): Harness {
  const world = identityWorld();
  world.app.grantGraphRole('Organization.Read.All');
  world.app.grantGraphRole('User.Read.All');
  world.app.grantExchangeRole('Exchange.ManageAsAppV2');
  world.app.assignEntraRole(EXCHANGE_ROLES.exchange_administrator.templateId);
  installFakeExchange(fake, world.graph.world);
  const time = createTime();
  const state: { secrets: SecretsState; pin: TenantPin | undefined } = {
    secrets: overrides.secrets ?? { status: 'ok', holder: world.holder },
    pin:
      'pin' in overrides ? overrides.pin : { tenantId: world.tenantId, clientId: world.app.appId },
  };
  const registry = createClientsRegistry({
    secrets: { state: () => state.secrets },
    pin: () => state.pin,
    publicBaseUrl: 'https://panel.example',
    bootstrapClientId: '14d82eec-204b-4c2f-b7e8-296a70dab67e',
    clock: time.clock,
    random: sequenceRandom(),
    scheduler: time.scheduler,
  });
  return {
    registry,
    world,
    time,
    get secrets() {
      return state.secrets;
    },
    set secrets(value) {
      state.secrets = value;
    },
    get pin() {
      return state.pin;
    },
    set pin(value) {
      state.pin = value;
    },
  };
}

const ACCESSORS = ['graph', 'exchange', 'oidc', 'appTokens'] as const;

describe('secrets that are not usable (FR-B-108)', () => {
  const CASES: readonly [SecretsState['status'], SecretsUnavailableReason][] = [
    ['key_missing', 'app_key_missing'],
    ['key_invalid', 'app_key_invalid'],
    ['certificate_unreadable', 'certificate_unreadable'],
    ['no_certificate', 'no_certificate'],
  ];
  it.each(CASES)('%s: every client says SecretsUnavailableError(%s)', (status, reason) => {
    const h = harness({ secrets: { status } as SecretsState });
    for (const name of ACCESSORS) {
      let failure: unknown;
      try {
        h.registry[name]();
      } catch (caught) {
        failure = caught;
      }
      expect(failure, name).toBeInstanceOf(SecretsUnavailableError);
      expect((failure as SecretsUnavailableError).reason, name).toBe(reason);
    }
  });

  it('an ok state without a holder is no_certificate', () => {
    const h = harness({ secrets: { status: 'ok', holder: undefined } });
    expect(() => h.registry.graph()).toThrow(SecretsUnavailableError);
  });

  it('secrets win over a missing pin: a degraded process is not "not connected"', () => {
    const h = harness({ secrets: { status: 'key_missing' }, pin: undefined });
    expect(() => h.registry.graph()).toThrow(SecretsUnavailableError);
  });
});

describe('no tenant pinned', () => {
  it('every client says NotConnectedError', () => {
    const h = harness({ pin: undefined });
    for (const name of ACCESSORS) expect(() => h.registry[name](), name).toThrow(NotConnectedError);
    expect(() => h.registry.keySet()).toThrow(NotConnectedError);
  });

  it('works once the pin appears and stops working when it goes', async () => {
    const h = harness({ pin: undefined });
    expect(() => h.registry.graph()).toThrow(NotConnectedError);
    h.pin = { tenantId: h.world.tenantId, clientId: h.world.app.appId };
    await expect(h.registry.graph().getOrganization()).resolves.toBeDefined();
    h.pin = undefined;
    expect(() => h.registry.graph()).toThrow(NotConnectedError);
  });
});

describe('the clients, built for the pinned tenant', () => {
  it('graph() calls Graph with an application token', async () => {
    const h = harness();
    const organization = await h.registry.graph().getOrganization();
    expect(organization.id).toBe(h.world.tenantId);
    expect(organization.initialDomain).toBe('contoso-fake.onmicrosoft.com');
  });

  it('exchange() calls the Admin API with an application token', async () => {
    const h = harness();
    expect(h.registry.exchange().capabilities()).toEqual({
      read: ['organizationConfig', 'distributionGroupMembers'],
      write: [],
    });
    await expect(h.registry.exchange().probe()).resolves.toMatchObject({ status: 'ok' });
  });

  it('appTokens() gives tokens of the runtime application', async () => {
    const h = harness();
    const token = await h.registry.appTokens().get('graph');
    expect(h.world.graph.world.tokens.lookup(token.reveal())).toMatchObject({
      kind: 'app',
      appId: h.world.app.appId,
    });
  });

  it('oidc() builds the authorize URL of the pinned tenant and redeems a code with the assertion', async () => {
    const h = harness();
    const oidc = h.registry.oidc();
    const verifier = 'v'.repeat(43);
    const url = oidc.buildAuthorizeUrl({
      state: 'state-1',
      nonce: 'nonce-1',
      codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
    });
    expect(url.searchParams.get('redirect_uri')).toBe(PANEL_CALLBACK);
    const answer = await fetch(url, { redirect: 'manual' });
    const code = new URL(answer.headers.get('location') ?? '').searchParams.get('code') ?? '';
    const { idToken } = await oidc.exchangeCode({ code, codeVerifier: verifier });
    await expect(oidc.validateIdToken(idToken, { nonce: 'nonce-1' })).resolves.toMatchObject({
      oid: h.world.user.id,
    });
  });

  it('builds once: the same objects come back until something changes', () => {
    const h = harness();
    expect(h.registry.graph()).toBe(h.registry.graph());
    expect(h.registry.exchange()).toBe(h.registry.exchange());
    expect(h.registry.oidc()).toBe(h.registry.oidc());
    expect(h.registry.appTokens()).toBe(h.registry.appTokens());
  });
});

describe('reload() and a certificate swap', () => {
  /** A second certificate on the same application, as the rotation registers it. */
  function swapCertificate(h: Harness) {
    const application = h.world.graph.directory.applications.get(h.world.app.objectId);
    const next = createTestCertificate({
      commonName: 'second certificate',
      notBefore: new Date(testClock.nowMs() - 60_000),
      notAfter: new Date(testClock.nowMs() + 300 * 86_400_000),
      serial: 99,
      keyName: 'registry-second',
    });
    if (application === undefined) throw new Error('no application');
    application.keyCredentials = [
      h.world.graph.directory.credentialFromUpload({
        key: next.derBase64,
        type: 'AsymmetricX509Cert',
        usage: 'Verify',
        endDateTime: next.notAfter.toISOString(),
      }),
    ];
    return holderFor({ ...h.world.app, certificate: next });
  }

  it('rebuilds the clients after a swap and closes the token provider that held the old holder', async () => {
    const h = harness();
    const before = h.registry.appTokens();
    await before.get('graph');
    const holder = swapCertificate(h);
    h.secrets = { status: 'ok', holder };
    h.registry.reload();

    const after = h.registry.appTokens();
    expect(after).not.toBe(before);
    expect(await rejectionOf(before.get('graph', { skipCache: true }))).toBeInstanceOf(
      NotConnectedError,
    );
    // The new holder signs; the application no longer has the old certificate, so only the new one works.
    await expect(after.get('graph', { skipCache: true })).resolves.toBeDefined();
    await expect(h.registry.graph().getOrganization()).resolves.toBeDefined();
    expect(h.world.entra.control.assertionRejections()).toEqual([]);
  });

  it('notices a new holder by itself, so a missed reload() cannot keep the old certificate', async () => {
    const h = harness();
    const before = h.registry.graph();
    h.secrets = { status: 'ok', holder: swapCertificate(h) };
    const after = h.registry.graph();
    expect(after).not.toBe(before);
    await expect(after.getOrganization()).resolves.toBeDefined();
  });

  it('reload() on purpose builds new clients even when nothing changed', () => {
    const h = harness();
    const before = h.registry.graph();
    h.registry.reload();
    expect(h.registry.graph()).not.toBe(before);
  });

  it('a changed pin builds clients for the new tenant and client', () => {
    const h = harness();
    const before = h.registry.oidc();
    const other = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';
    h.pin = { tenantId: other, clientId: h.world.app.appId };
    const after = h.registry.oidc();
    expect(after).not.toBe(before);
    const url = after.buildAuthorizeUrl({ state: 's', nonce: 'n', codeChallenge: 'c' });
    expect(url.pathname).toBe(`/${other}/oauth2/v2.0/authorize`);
  });
});

describe('the key set (start, hourly reload, stop)', () => {
  it('start() loads the keys without blocking and then every hour; stop() ends it', async () => {
    const h = harness();
    const fetches = (): number =>
      fake.calls.all().filter((call) => call.path.endsWith('/discovery/v2.0/keys')).length;
    h.registry.start();
    expect(fetches()).toBe(0);
    await settle();
    await vi.waitFor(() => {
      expect(fetches()).toBe(1);
    });
    h.time.scheduler.advance(3_600_000);
    await vi.waitFor(() => {
      expect(fetches()).toBe(2);
    });
    h.registry.stop();
    h.time.scheduler.advance(3_600_000 * 3);
    await settle();
    expect(fetches()).toBe(2);
  });

  it('start() does nothing, and does not fail, while the tenant is not pinned or the secrets are unusable', async () => {
    const h = harness({ pin: undefined });
    expect(() => {
      h.registry.start();
    }).not.toThrow();
    await settle();
    expect(fake.calls.length).toBe(0);
    h.registry.stop();

    const broken = harness({ secrets: { status: 'key_invalid' } });
    expect(() => {
      broken.registry.start();
    }).not.toThrow();
    broken.registry.stop();
  });

  it('after start(), reload() warms the new clients again (the key set stays)', async () => {
    const h = harness();
    h.registry.start();
    await settle();
    const keys = h.registry.keySet();
    h.registry.reload();
    expect(h.registry.keySet()).toBe(keys);
    h.registry.stop();
  });
});

describe('the factories', () => {
  it('createBootstrap() needs neither secrets nor a pinned tenant', () => {
    const h = harness({ secrets: { status: 'key_missing' }, pin: undefined });
    const bootstrap = h.registry.createBootstrap();
    expect(typeof bootstrap.start).toBe('function');
    bootstrap.discard();
  });

  it('every call gives a new authenticator', () => {
    const h = harness();
    expect(h.registry.createBootstrap()).not.toBe(h.registry.createBootstrap());
  });

  it('provisionerFactory() refuses a bootstrap that is not signed in (FR-B-310)', async () => {
    const h = harness({ secrets: { status: 'key_missing' }, pin: undefined });
    const bootstrap = h.registry.createBootstrap();
    const failure = await rejectionOf(h.registry.provisionerFactory()(bootstrap));
    expect(failure).toBeInstanceOf(NotConnectedError);
  });

  it('provisionerFactory() gives a delegated client for a live bearer', async () => {
    const h = harness({ secrets: { status: 'key_missing' }, pin: undefined });
    const token = h.world.graph.world.issueDelegatedToken({
      userId: h.world.user.id,
      scopes: ['Application.ReadWrite.All'],
    });
    const provisioner = await h.registry.provisionerFactory()({
      bearer: () => () => Promise.resolve(token.value),
    });
    expect(typeof provisioner.createApplication).toBe('function');
  });
});

describe('the pin from the database', () => {
  const TENANT = '3c7cb11c-8bac-4236-a49a-b72d55f99656';
  const CLIENT = '55cb3fe3-9ab0-400a-822f-01c693bc44c0';

  it('is nothing without a database or a row, and the ids of the row once the wizard stored them', async () => {
    expect(readTenantPin(undefined)).toBeUndefined();
    const { database } = await migratedDatabase();
    expect(readTenantPin(database)).toBeUndefined();
    database.sqlite
      .prepare(
        "INSERT INTO tenant_connection (id, updated_at) VALUES (1, '2026-10-10T12:00:00.000Z')",
      )
      .run();
    // A row that has no tenant and no application yet (the wizard is still running) is not a pin.
    expect(readTenantPin(database)).toBeUndefined();
    database.sqlite
      .prepare('UPDATE tenant_connection SET tenant_id = ?, app_id = ? WHERE id = 1')
      .run(TENANT, CLIENT);
    expect(readTenantPin(database)).toEqual({ tenantId: TENANT, clientId: CLIENT });
  });

  it('is nothing once the database is closed', async () => {
    const { database } = await migratedDatabase();
    database.sqlite
      .prepare(
        'INSERT INTO tenant_connection (id, tenant_id, app_id, updated_at) VALUES (1, ?, ?, ?)',
      )
      .run(TENANT, CLIENT, '2026-10-10T12:00:00.000Z');
    expect(readTenantPin(database)).toBeDefined();
    database.close();
    expect(readTenantPin(database)).toBeUndefined();
  });
});

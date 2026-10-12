// T-B-083, FR-B-707, RB-10, PBR-09 (+ negative): the strictness of the fake tenant, proven through the
// real clients and MSW. A lenient fake gives false greens (baseline section 2), so each rule below is a
// Learn statement the fake encodes and a test that the fake still refuses what Learn refuses.
// `STRICT_RULES` lists the statements; the gate note and the owner's ledger take them from here.
//
// The simulation encodes OUR reading of Learn; it cannot prove what Microsoft does (spec 8.6). What a
// real tenant must confirm is the owner-verified ledger, not this file.
import { createHash } from 'node:crypto';
import { EXCHANGE_ROLES } from '@m365portal/shared/setup/graph-roles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminApiExchangeClient } from '../../src/integrations/exchange/admin-api-client.js';
import { createHttpGraphClient } from '../../src/integrations/graph/graph-client.js';
import { createTenantProvisioner } from '../../src/integrations/graph/provisioner.js';
import { createMsalAppTokenProvider } from '../../src/integrations/identity/app-token.js';
import { createIdentityFetch } from '../../src/integrations/identity/http.js';
import { createOidcClient } from '../../src/integrations/identity/oidc-client.js';
import { createTenantMetadata } from '../../src/integrations/identity/tenant-metadata.js';
import { createTokenEndpoint } from '../../src/integrations/identity/token-endpoint.js';
import { createIdTokenValidator } from '../../src/integrations/identity/id-token.js';
import { createKeySet } from '../../src/integrations/identity/jwks.js';
import {
  ExchangeForbiddenError,
  GraphNetworkError,
  TokenEndpointError,
} from '../../src/ports/errors.js';
import type { CertificateHolderPort } from '../../src/ports/secrets.js';
import { createTestCertificate } from '../support/test-certificate.js';
import { seedApplication } from './fake-tenant/entra/index.js';
import { installFakeExchange } from './fake-tenant/exchange/index.js';
import { ENTRA_ROLE_TEMPLATES, fakeGuid, installFakeGraph } from './fake-tenant/graph/index.js';
import {
  PANEL_CALLBACK,
  holderFor,
  identityWorld,
  type IdentityWorld,
} from '../integrations/identity/support.js';
import { createTime, raw, rejectionOf, sequenceRandom, settle } from '../integrations/support.js';
import { fake, testClock } from '../support/msw.js';

/** The Learn statements each strict rule encodes (the input of the owner's ledger). */
export const STRICT_RULES: readonly { rule: string; learn: string }[] = [
  {
    rule: 'a client assertion needs x5t#S256 (the SHA-1 x5t alone is refused)',
    learn:
      'https://learn.microsoft.com/entra/identity-platform/certificate-credentials (Header: x5t#S256)',
  },
  {
    rule: 'a client assertion has alg PS256, typ JWT, iss = sub = client id, aud = the tenant token endpoint, a unique jti and an exp at most 10 minutes after nbf',
    learn:
      'https://learn.microsoft.com/entra/identity-platform/certificate-credentials (Header, Claims); the exp limit and the jti replay check are ours (U58, U59)',
  },
  {
    rule: 'client credentials are refused when the request has an Origin header',
    learn:
      'https://learn.microsoft.com/entra/identity-platform/v2-oauth2-auth-code-flow ("prevents the use of client credentials ... in the presence of an Origin header"); the error code is not documented (U62)',
  },
  {
    rule: 'an authorization code is single use and valid for about one minute; PKCE and the redirect URI are checked',
    learn:
      'https://learn.microsoft.com/entra/identity-platform/v2-oauth2-auth-code-flow (Successful response: "about 1 minute"; code_verifier; redirect_uri)',
  },
  {
    rule: 'the redirect URI matches a registered one exactly, except the port of a registered http://localhost URI',
    learn:
      'https://learn.microsoft.com/entra/identity-platform/reply-url (localhost exceptions); .../v2-oauth2-auth-code-flow (redirect_uri)',
  },
  {
    rule: 'an application token snapshots the grants and Entra roles at issue time',
    learn:
      'research-microsoft-b.md section 4 (https://learn.microsoft.com/exchange/permissions-exo/application-rbac and the Admin API authentication page: a role assigned later is not in a token requested before)',
  },
  {
    rule: 'PATCH keyCredentials replaces the whole collection',
    learn:
      'https://learn.microsoft.com/graph/api/application-update and .../application-addkey (update replaces keyCredentials)',
  },
  {
    rule: 'checkMemberGroups takes at most 20 ids and one malformed id fails the request; hidden-membership groups need Member.Read.Hidden',
    learn: 'https://learn.microsoft.com/graph/api/user-checkmembergroups',
  },
  {
    rule: 'an endpoint that is not on the call sheet does not exist',
    learn: 'plan 14.2; the fake answers 404 for a path the product has no reason to call',
  },
  {
    rule: 'the device code flow: authorization_pending, authorization_declined, expired_token, bad_verification_code; slow_down as RFC 8628',
    learn:
      'https://learn.microsoft.com/entra/identity-platform/v2-oauth2-device-code (polling errors); slow_down is undocumented there (U22)',
  },
  {
    rule: 'Conditional Access blocks a sign-in with AADSTS53003',
    learn:
      'https://learn.microsoft.com/entra/identity/conditional-access/troubleshoot-conditional-access; the answer to a poll is ours (U61)',
  },
  {
    rule: 'a new application or group is not visible at once (replication)',
    learn: 'https://learn.microsoft.com/graph/best-practices-concept (eventual consistency)',
  },
  {
    rule: 'throttling answers 429 with Retry-After in seconds or as an HTTP date; 5xx are retryable',
    learn: 'https://learn.microsoft.com/graph/throttling',
  },
  {
    rule: 'an application management policy can refuse a credential lifetime',
    learn: 'https://learn.microsoft.com/graph/api/resources/keycredentialconfiguration (U19)',
  },
];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(testClock.nowMs());
});
afterEach(() => {
  vi.useRealTimers();
});

const GRAPH = 'https://graph.microsoft.com/v1.0';
const WIZARD_SCOPES = [
  'Application.ReadWrite.All',
  'AppRoleAssignment.ReadWrite.All',
  'RoleManagement.ReadWrite.Directory',
];
const VERIFIER = 'v'.repeat(43);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

function wizardProvisioner(graph: ReturnType<typeof installFakeGraph>) {
  const time = createTime();
  const token = graph.world.issueDelegatedToken({
    userId: fakeGuid('admin', 1),
    scopes: WIZARD_SCOPES,
    entraRoleTemplateIds: [ENTRA_ROLE_TEMPLATES.globalAdministrator],
  }).value;
  return {
    time,
    provisioner: createTenantProvisioner(() => Promise.resolve(token), {
      clock: time.clock,
      random: sequenceRandom([0]),
      scheduler: time.scheduler,
    }),
  };
}

const NEW_APPLICATION = {
  displayName: 'M365Portal',
  signInAudience: 'AzureADMyOrg',
  web: {
    redirectUris: ['https://panel.example/auth/callback'],
    implicitGrantSettings: { enableIdTokenIssuance: false, enableAccessTokenIssuance: false },
  },
  requiredResourceAccess: [],
  optionalClaims: { idToken: [] },
} as const;

function certificateCredential(serial: number, keyName: string) {
  const certificate = createTestCertificate({
    commonName: `selftest-${String(serial)}`,
    notBefore: new Date(testClock.nowMs() - 300_000),
    notAfter: new Date(testClock.nowMs() + 300 * 86_400_000),
    serial,
    keyName,
  });
  return {
    type: 'AsymmetricX509Cert',
    usage: 'Verify',
    key: certificate.derBase64,
    displayName: `CN=selftest-${String(serial)}`,
    startDateTime: new Date(testClock.nowMs() - 300_000).toISOString(),
    endDateTime: new Date(testClock.nowMs() + 300 * 86_400_000).toISOString(),
  } as const;
}

function tokenEndpointFor(world: IdentityWorld, signer: CertificateHolderPort) {
  const time = createTime();
  return createTokenEndpoint({
    tenantId: world.tenantId,
    clientId: world.app.appId,
    redirectUri: PANEL_CALLBACK,
    signer,
    jsonFetch: createIdentityFetch({ clock: time.clock, scheduler: time.scheduler }),
    clock: time.clock,
    random: sequenceRandom(),
    scheduler: time.scheduler,
  });
}

async function codeFor(world: IdentityWorld): Promise<string> {
  const url = `https://login.microsoftonline.com/${world.tenantId}/oauth2/v2.0/authorize?${new URLSearchParams(
    {
      client_id: world.app.appId,
      response_type: 'code',
      redirect_uri: PANEL_CALLBACK,
      response_mode: 'query',
      scope: 'openid profile',
      state: 'state-1',
      nonce: 'nonce-1',
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
    },
  ).toString()}`;
  const answer = await fetch(url, { redirect: 'manual' });
  return new URL(answer.headers.get('location') ?? '').searchParams.get('code') ?? '';
}

/** A signer that bends the assertion before the holder signs it: a broken builder. */
function bending(
  holder: CertificateHolderPort,
  bend: (header: Record<string, unknown>, payload: Record<string, unknown>) => void,
): CertificateHolderPort {
  return {
    publicCertificateDer: () => holder.publicCertificateDer(),
    signCompact(header, payload) {
      const claims = JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;
      const head = { ...header };
      bend(head, claims);
      return holder.signCompact(head, new TextEncoder().encode(JSON.stringify(claims)));
    },
  };
}

describe('the list of rules', () => {
  it('names a Learn page for every rule', () => {
    expect(STRICT_RULES.length).toBeGreaterThanOrEqual(14);
    for (const entry of STRICT_RULES)
      expect(entry.learn).toMatch(/learn\.microsoft\.com|research|plan/);
  });
});

describe('Entra is strict about the client assertion', () => {
  it('refuses an assertion without x5t#S256, through the real token endpoint client', async () => {
    const world = identityWorld();
    const broken = bending(world.holder, (header) => {
      Reflect.deleteProperty(header, 'x5t#S256');
    });
    const endpoint = tokenEndpointFor(world, broken);
    const failure = await rejectionOf(
      endpoint.exchangeCode({ code: await codeFor(world), codeVerifier: VERIFIER }),
    );
    expect(failure).toBeInstanceOf(TokenEndpointError);
    expect(failure).toMatchObject({ error: 'invalid_client' });
    expect(world.entra.control.assertionRejections()).toEqual(['missing_x5t_s256']);
  });

  it('refuses the SHA-1 x5t header on its own, and accepts it next to x5t#S256', async () => {
    const world = identityWorld();
    const sha1 = createHash('sha1').update(world.holder.publicCertificateDer()).digest('base64url');
    const only = bending(world.holder, (header) => {
      Reflect.deleteProperty(header, 'x5t#S256');
      header.x5t = sha1;
    });
    await rejectionOf(
      tokenEndpointFor(world, only).exchangeCode({
        code: await codeFor(world),
        codeVerifier: VERIFIER,
      }),
    );
    expect(world.entra.control.assertionRejections()).toEqual(['missing_x5t_s256']);
    const both = bending(world.holder, (header) => {
      header.x5t = sha1;
    });
    await expect(
      tokenEndpointFor(world, both).exchangeCode({
        code: await codeFor(world),
        codeVerifier: VERIFIER,
      }),
    ).resolves.toBeDefined();
  });

  it('refuses a lifetime over 10 minutes, a wrong audience and an issuer that is not the client id', async () => {
    const world = identityWorld();
    const cases: [string, (h: Record<string, unknown>, p: Record<string, unknown>) => void][] = [
      ['lifetime_too_long', (_h, p) => void (p.exp = Number(p.nbf) + 601)],
      [
        'bad_aud',
        (_h, p) => void (p.aud = 'https://login.microsoftonline.com/x/oauth2/v2.0/token'),
      ],
      ['bad_iss', (_h, p) => void (p.iss = 'someone')],
    ];
    for (const [reason, bend] of cases) {
      const endpoint = tokenEndpointFor(world, bending(world.holder, bend));
      await rejectionOf(
        endpoint.exchangeCode({ code: await codeFor(world), codeVerifier: VERIFIER }),
      );
      expect(world.entra.control.assertionRejections().at(-1), reason).toBe(reason);
    }
  });

  it('refuses a replayed jti', async () => {
    const world = identityWorld();
    const stuck = { bytes: (n: number) => new Uint8Array(n).fill(9), float: () => 0.5 };
    const time = createTime();
    const endpoint = createTokenEndpoint({
      tenantId: world.tenantId,
      clientId: world.app.appId,
      redirectUri: PANEL_CALLBACK,
      signer: world.holder,
      jsonFetch: createIdentityFetch({ clock: time.clock, scheduler: time.scheduler }),
      clock: time.clock,
      random: stuck,
      scheduler: time.scheduler,
    });
    await endpoint.exchangeCode({ code: await codeFor(world), codeVerifier: VERIFIER });
    await rejectionOf(
      endpoint.exchangeCode({ code: await codeFor(world), codeVerifier: VERIFIER }),
    );
    expect(world.entra.control.assertionRejections()).toEqual(['jti_reused']);
  });

  it('refuses the certificate of another application and a certificate that has expired', async () => {
    const world = identityWorld();
    const other = seedApplication(world.graph.world, { redirectUris: [] });
    const foreign = tokenEndpointFor(world, holderFor(other));
    await rejectionOf(foreign.exchangeCode({ code: await codeFor(world), codeVerifier: VERIFIER }));
    expect(world.entra.control.assertionRejections()).toEqual(['unknown_certificate']);

    const credential = world.graph.directory.applications.get(world.app.objectId)
      ?.keyCredentials[0];
    if (credential !== undefined)
      credential.endDateTime = new Date(testClock.nowMs() - 1).toISOString();
    await rejectionOf(
      tokenEndpointFor(world, world.holder).exchangeCode({
        code: await codeFor(world),
        codeVerifier: VERIFIER,
      }),
    );
    expect(world.entra.control.assertionRejections().at(-1)).toBe('certificate_expired');
  });

  it('through the real MSAL provider: the assertion MSAL asks for is accepted, a broken signer is not', async () => {
    const world = identityWorld();
    const time = createTime();
    const build = (signer: CertificateHolderPort) =>
      createMsalAppTokenProvider({
        tenantId: world.tenantId,
        clientId: world.app.appId,
        signer,
        clock: time.clock,
        random: sequenceRandom(),
        jsonFetch: createIdentityFetch({ clock: time.clock, scheduler: time.scheduler }),
        scheduler: time.scheduler,
      });
    await expect(build(world.holder).get('graph')).resolves.toBeDefined();
    const broken = bending(world.holder, (header) => {
      Reflect.deleteProperty(header, 'x5t#S256');
    });
    expect(await rejectionOf(build(broken).get('graph'))).toMatchObject({
      error: 'invalid_client',
    });
  });
});

describe('a token snapshots the roles at issue time (research section 4)', () => {
  it('an Entra role assigned after the token was issued is absent from that token, through the real clients', async () => {
    const world = identityWorld();
    installFakeExchange(fake, world.graph.world);
    world.app.grantExchangeRole('Exchange.ManageAsAppV2');
    const time = createTime();
    const tokens = createMsalAppTokenProvider({
      tenantId: world.tenantId,
      clientId: world.app.appId,
      signer: world.holder,
      clock: time.clock,
      random: sequenceRandom(),
      jsonFetch: createIdentityFetch({ clock: time.clock, scheduler: time.scheduler }),
      scheduler: time.scheduler,
    });
    const exchange = new AdminApiExchangeClient({
      tenantId: world.tenantId,
      appTokens: tokens,
      clock: time.clock,
      random: sequenceRandom(),
      scheduler: time.scheduler,
    });
    // The token is requested before the Entra role exists: the Admin API says "forbidden".
    expect(await rejectionOf(exchange.getOrganizationConfig())).toBeInstanceOf(
      ExchangeForbiddenError,
    );
    world.app.assignEntraRole(EXCHANGE_ROLES.exchange_administrator.templateId);
    // MSAL serves the cached token: it still lacks the role.
    expect(await rejectionOf(exchange.getOrganizationConfig())).toBeInstanceOf(
      ExchangeForbiddenError,
    );
    // The propagation probe asks for a fresh token (FR-B-316), and that one has the role.
    expect(await exchange.probe()).toMatchObject({ status: 'ok' });
    // The fresh token replaced the cached one, so the ordinary call works now.
    await expect(exchange.getOrganizationConfig()).resolves.toBeDefined();
  });

  it('a grant made after the token was issued is absent from it too (Graph roles)', async () => {
    const world = identityWorld();
    const early = world.graph.world.issueAppToken(world.app.appId, 'graph');
    world.app.grantGraphRole('Organization.Read.All');
    const late = world.graph.world.issueAppToken(world.app.appId, 'graph');
    expect((await raw('GET', `${GRAPH}/organization`, { token: early.value })).status).toBe(403);
    expect((await raw('GET', `${GRAPH}/organization`, { token: late.value })).status).toBe(200);
  });
});

describe('Graph is strict (through the provisioner and the Graph client)', () => {
  it('PATCH keyCredentials replaces the collection: the other credentials are gone', async () => {
    const graph = installFakeGraph(fake);
    const { provisioner } = wizardProvisioner(graph);
    const application = await provisioner.createApplication(NEW_APPLICATION);
    const first = certificateCredential(1, 'selftest-a');
    const second = certificateCredential(2, 'selftest-b');
    await provisioner.patchApplication(application.id, { keyCredentials: [first, second] });
    expect(await provisioner.readKeyCredentials(application.id)).toHaveLength(2);
    // A patch that mentions only the second one is a patch that DELETES the first.
    await provisioner.patchApplication(application.id, { keyCredentials: [second] });
    const left = await provisioner.readKeyCredentials(application.id);
    expect(left).toHaveLength(1);
    expect(left[0]?.displayName).toBe('CN=selftest-2');
    await provisioner.patchApplication(application.id, { keyCredentials: [] });
    expect(await provisioner.readKeyCredentials(application.id)).toEqual([]);
  });

  it('an endpoint that is not on the call sheet is a 404, a method it does not have a 405', async () => {
    const world = identityWorld();
    world.app.grantGraphRole('User.Read.All');
    const token = world.graph.world.issueAppToken(world.app.appId, 'graph').value;
    for (const path of ['/me', '/users/x/messages', '/beta/organization', '/directoryObjects']) {
      const answer = await raw('GET', `${GRAPH}${path}`, { token });
      expect(answer.status, path).toBe(404);
    }
    expect((await raw('DELETE', `${GRAPH}/organization`, { token })).status).toBe(405);
    expect(
      (await raw('GET', 'https://outlook.office365.com/adminapi/v2.0/x/Other', { token })).status,
    ).toBe(404);
  });

  it('checkMemberGroups: 21 ids and one malformed id are 400 at the fake, and the real client never sends them', async () => {
    const world = identityWorld();
    world.app.grantGraphRole('User.Read.All');
    world.app.grantGraphRole('GroupMember.Read.All');
    const token = world.graph.world.issueAppToken(world.app.appId, 'graph').value;
    const ids = Array.from({ length: 21 }, (_, index) => fakeGuid('group', index));
    const url = `${GRAPH}/users/${world.user.id}/checkMemberGroups`;
    expect((await raw('POST', url, { token, json: { groupIds: ids } })).status).toBe(400);
    expect((await raw('POST', url, { token, json: { groupIds: ['not-a-guid'] } })).status).toBe(
      400,
    );
    expect((await raw('POST', url, { token, json: { groupIds: ids.slice(0, 20) } })).status).toBe(
      200,
    );

    const time = createTime();
    const client = createHttpGraphClient({
      appTokens: {
        get: () => Promise.resolve({ expiresAt: Number.MAX_SAFE_INTEGER, reveal: () => token }),
      },
      clock: time.clock,
      random: sequenceRandom(),
      scheduler: time.scheduler,
    });
    fake.calls.clear();
    await client.checkMemberGroups(world.user.id, ids);
    const posts = fake.calls.all().filter((call) => call.path.endsWith('/checkMemberGroups'));
    expect(posts.map((call) => call.status)).toEqual([200, 200]);
    await rejectionOf(client.checkMemberGroups(world.user.id, [...ids.slice(0, 2), 'not-a-guid']));
    expect(
      fake.calls.all().filter((call) => call.path.endsWith('/checkMemberGroups')),
    ).toHaveLength(2);
  });

  it('a hidden-membership group is left out of checkMemberGroups without Member.Read.Hidden', async () => {
    const world = identityWorld();
    world.app.grantGraphRole('User.Read.All');
    world.app.grantGraphRole('GroupMember.Read.All');
    const visible = world.graph.directory.addGroup({ displayName: 'Visible' });
    const hidden = world.graph.directory.addGroup({
      displayName: 'Hidden',
      hiddenMembership: true,
    });
    world.graph.directory.addMember(visible.id, world.user.id);
    world.graph.directory.addMember(hidden.id, world.user.id);
    const time = createTime();
    const client = createHttpGraphClient({
      appTokens: {
        get: () =>
          Promise.resolve({
            expiresAt: Number.MAX_SAFE_INTEGER,
            reveal: () => world.graph.world.issueAppToken(world.app.appId, 'graph').value,
          }),
      },
      clock: time.clock,
      random: sequenceRandom(),
      scheduler: time.scheduler,
    });
    const found = await client.checkMemberGroups(world.user.id, [visible.id, hidden.id]);
    expect([...found]).toEqual([visible.id]);
  });

  it('a deleted group is null, a deleted user is null, a disabled user says so', async () => {
    const world = identityWorld();
    world.app.grantGraphRole('User.Read.All');
    world.app.grantGraphRole('GroupMember.Read.All');
    const time = createTime();
    const client = createHttpGraphClient({
      appTokens: {
        get: () =>
          Promise.resolve({
            expiresAt: Number.MAX_SAFE_INTEGER,
            reveal: () => world.graph.world.issueAppToken(world.app.appId, 'graph').value,
          }),
      },
      clock: time.clock,
      random: sequenceRandom(),
      scheduler: time.scheduler,
    });
    const group = world.graph.directory.addGroup({ displayName: 'Soon gone' });
    expect(await client.getGroup(group.id)).toMatchObject({ displayName: 'Soon gone' });
    world.graph.directory.groups.delete(group.id);
    client.clearCache();
    expect(await client.getGroup(group.id)).toBeNull();

    const disabled = world.graph.directory.addUser({
      userPrincipalName: 'off@contoso-fake.example',
      accountEnabled: false,
    });
    expect(await client.getUser(disabled.id)).toMatchObject({ accountEnabled: false });
    world.graph.directory.users.delete(disabled.id);
    client.clearCache();
    expect(await client.getUser(disabled.id)).toBeNull();
  });

  it('the Exchange service principal can be missing', async () => {
    const graph = installFakeGraph(fake);
    const { provisioner } = wizardProvisioner(graph);
    expect(
      await provisioner.findServicePrincipalByAppId('00000002-0000-0ff1-ce00-000000000000'),
    ).not.toBeNull();
    graph.directory.removeExchangeServicePrincipal();
    expect(
      await provisioner.findServicePrincipalByAppId('00000002-0000-0ff1-ce00-000000000000'),
    ).toBeNull();
  });
});

describe('the toggles produce the documented answer', () => {
  it('replication delay: a new application is "not found" for the next calls, then it is there', async () => {
    const graph = installFakeGraph(fake);
    graph.control.replicationDelay({ applications: 2 });
    const { provisioner } = wizardProvisioner(graph);
    const application = await provisioner.createApplication(NEW_APPLICATION);
    expect(await provisioner.getApplication(application.id)).toBeNull();
    expect(await provisioner.getApplication(application.id)).toBeNull();
    expect(await provisioner.getApplication(application.id)).toMatchObject({ id: application.id });
    graph.control.replicationDelay({ servicePrincipals: 1 });
    const second = await provisioner.createApplication(NEW_APPLICATION);
    await provisioner.getApplication(second.id);
    const sp = await provisioner.createServicePrincipal(second.appId);
    expect(await provisioner.findServicePrincipalByAppId(sp.appId)).toBeNull();
    expect(await provisioner.findServicePrincipalByAppId(sp.appId)).toMatchObject({ id: sp.id });
  });

  it('throttling: 429 with Retry-After in seconds, as an HTTP date, and without one', async () => {
    const world = identityWorld();
    world.app.grantGraphRole('Organization.Read.All');
    const token = world.graph.world.issueAppToken(world.app.appId, 'graph').value;
    world.graph.control.throttle({ times: 1, seconds: 7 });
    const seconds = await raw('GET', `${GRAPH}/organization`, { token });
    expect(seconds.status).toBe(429);
    expect(seconds.headers.get('retry-after')).toBe('7');
    world.graph.control.throttle({ times: 1, seconds: 7, form: 'httpDate' });
    const date = await raw('GET', `${GRAPH}/organization`, { token });
    expect(date.status).toBe(429);
    expect(date.headers.get('retry-after')).toMatch(
      /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/,
    );
    expect(Date.parse(date.headers.get('retry-after') ?? '') - testClock.nowMs()).toBe(7_000);
    world.graph.control.throttle({ times: 1, seconds: null });
    expect(
      (await raw('GET', `${GRAPH}/organization`, { token })).headers.get('retry-after'),
    ).toBeNull();
  });

  it('the real Graph client waits out a Retry-After in either form and then succeeds', async () => {
    const world = identityWorld();
    world.app.grantGraphRole('User.Read.All');
    const time = createTime();
    const client = createHttpGraphClient({
      appTokens: {
        get: () =>
          Promise.resolve({
            expiresAt: Number.MAX_SAFE_INTEGER,
            reveal: () => world.graph.world.issueAppToken(world.app.appId, 'graph').value,
          }),
      },
      clock: time.clock,
      random: sequenceRandom([0]),
      scheduler: time.scheduler,
    });
    for (const form of ['seconds', 'httpDate'] as const) {
      fake.calls.clear();
      world.graph.control.throttle({ times: 1, seconds: 3, form });
      const call = client.getUser(world.user.id, { priority: 'high' });
      await vi.waitFor(() => {
        expect(fake.calls.length).toBe(1);
      });
      await settle();
      time.elapse(3_000);
      await expect(call).resolves.toMatchObject({ id: world.user.id });
      expect(fake.calls.all().map((entry) => entry.status)).toEqual([429, 200]);
      client.clearCache();
    }
  });

  it('5xx: the next calls answer the status that was asked for', async () => {
    const world = identityWorld();
    world.app.grantGraphRole('Organization.Read.All');
    const token = world.graph.world.issueAppToken(world.app.appId, 'graph').value;
    world.graph.control.failWith({ times: 2, status: 503 });
    expect((await raw('GET', `${GRAPH}/organization`, { token })).status).toBe(503);
    expect((await raw('GET', `${GRAPH}/organization`, { token })).status).toBe(503);
    expect((await raw('GET', `${GRAPH}/organization`, { token })).status).toBe(200);
  });

  it('an application management policy refuses a credential that lives too long', async () => {
    const graph = installFakeGraph(fake);
    graph.control.credentialLifetimePolicy(180);
    const { provisioner } = wizardProvisioner(graph);
    const application = await provisioner.createApplication(NEW_APPLICATION);
    const failure = await rejectionOf(
      provisioner.patchApplication(application.id, {
        keyCredentials: [certificateCredential(7, 'selftest-c')],
      }),
    );
    expect(failure).toBeDefined();
    expect(graph.control.stats.policyRefusals).toBe(1);
  });

  it('a crash after the n-th mutating call: the work was done and the client sees a network failure', async () => {
    const graph = installFakeGraph(fake);
    const { provisioner } = wizardProvisioner(graph);
    fake.control.crashAfterMutating(1);
    const failure = await rejectionOf(provisioner.createApplication(NEW_APPLICATION));
    expect(failure).toBeInstanceOf(GraphNetworkError);
    expect(graph.directory.applications.size).toBe(1);
    expect(fake.calls.mutating()).toHaveLength(1);
    expect(fake.calls.all()[0]?.crashed).toBe(true);
    const found = await provisioner.findApplicationsByDisplayName('M365Portal');
    expect(found).toHaveLength(1);
  });
});

describe('the Entra toggles produce the documented answer', () => {
  const FLOW = 'https://login.microsoftonline.com/organizations/oauth2/v2.0';
  const SCOPE = WIZARD_SCOPES.map((name) => `https://graph.microsoft.com/${name}`).join(' ');

  async function begin(world: IdentityWorld): Promise<string> {
    const answer = await raw('POST', `${FLOW}/devicecode`, {
      text: new URLSearchParams({
        client_id: '14d82eec-204b-4c2f-b7e8-296a70dab67e',
        scope: SCOPE,
      }).toString(),
      contentType: 'application/x-www-form-urlencoded',
    });
    expect(world.entra.control.device.pending()).toBe(1);
    return (answer.body as { device_code: string }).device_code;
  }

  async function poll(deviceCode: string) {
    return raw('POST', `${FLOW}/token`, {
      text: new URLSearchParams({
        client_id: '14d82eec-204b-4c2f-b7e8-296a70dab67e',
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceCode,
      }).toString(),
      contentType: 'application/x-www-form-urlencoded',
    });
  }

  it.each([
    ['decline', 'authorization_declined'],
    ['expire', 'expired_token'],
    ['block', 'access_denied'],
  ] as const)('%s ends the flow with %s', async (action, error) => {
    const world = identityWorld();
    const code = await begin(world);
    world.entra.control.device[action]();
    const answer = await poll(code);
    expect(answer.status).toBe(400);
    expect((answer.body as { error: string }).error).toBe(error);
    if (action === 'block') {
      expect((answer.body as { error_description: string }).error_description).toMatch(
        /^AADSTS53003: /,
      );
    }
  });

  it('slow_down and temporarily_unavailable, then pending again', async () => {
    const world = identityWorld();
    const code = await begin(world);
    world.entra.control.device.slowDown(1);
    world.entra.control.device.temporarilyUnavailable(1);
    const errors: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      errors.push(((await poll(code)).body as { error: string }).error);
    }
    expect(errors).toEqual(['slow_down', 'temporarily_unavailable', 'authorization_pending']);
  });

  it('a device code is gone after 900 seconds', async () => {
    const world = identityWorld();
    const code = await begin(world);
    testClock.advance(900_001);
    expect(((await poll(code)).body as { error: string }).error).toBe('expired_token');
  });

  it('an unknown device code is bad_verification_code', async () => {
    const world = identityWorld();
    await begin(world);
    expect(((await poll('nope')).body as { error: string }).error).toBe('bad_verification_code');
  });

  it('a key rotation puts a second key in the set and dropping the old one removes it', async () => {
    const world = identityWorld();
    const time = createTime();
    const jsonFetch = createIdentityFetch({ clock: time.clock, scheduler: time.scheduler });
    const metadata = createTenantMetadata({
      tenantId: world.tenantId,
      jsonFetch,
      clock: time.clock,
    });
    const keys = createKeySet({
      metadata,
      jsonFetch,
      clock: time.clock,
      scheduler: time.scheduler,
    });
    const validator = createIdTokenValidator({
      tenantId: world.tenantId,
      clientId: world.app.appId,
      keys,
      clock: time.clock,
    });
    const oidc = createOidcClient({
      tenantId: world.tenantId,
      clientId: world.app.appId,
      redirectUri: PANEL_CALLBACK,
      metadata,
      tokenEndpoint: tokenEndpointFor(world, world.holder),
      validator,
    });
    const first = await oidc.exchangeCode({ code: await codeFor(world), codeVerifier: VERIFIER });
    await expect(oidc.validateIdToken(first.idToken, { nonce: 'nonce-1' })).resolves.toBeDefined();
    world.entra.control.rotateKeys();
    world.entra.control.dropOldKeys();
    await keys.reload();
    // A token signed by the dropped key no longer verifies; one signed by the new key does.
    const failure = await rejectionOf(oidc.validateIdToken(first.idToken, { nonce: 'nonce-1' }));
    expect(failure).toMatchObject({ check: 'kid' });
    const second = await oidc.exchangeCode({ code: await codeFor(world), codeVerifier: VERIFIER });
    await expect(oidc.validateIdToken(second.idToken, { nonce: 'nonce-1' })).resolves.toBeDefined();
  });

  it('deleted or disabled users cannot sign in: access_denied at /authorize', async () => {
    const world = identityWorld();
    const record = world.graph.directory.users.get(world.user.id);
    if (record !== undefined) record.accountEnabled = false;
    const disabled = await fetch(
      `https://login.microsoftonline.com/${world.tenantId}/oauth2/v2.0/authorize?${new URLSearchParams(
        {
          client_id: world.app.appId,
          response_type: 'code',
          redirect_uri: PANEL_CALLBACK,
          response_mode: 'query',
          scope: 'openid profile',
          state: 's',
          nonce: 'n',
          code_challenge: CHALLENGE,
          code_challenge_method: 'S256',
        },
      ).toString()}`,
      { redirect: 'manual' },
    );
    expect(new URL(disabled.headers.get('location') ?? '').searchParams.get('error')).toBe(
      'access_denied',
    );
  });
});

describe('negative: a lenient fake would have accepted what these tests refuse', () => {
  it('the same assertion WITH x5t#S256 is accepted, so the refusal above is the missing header and nothing else', async () => {
    const world = identityWorld();
    await expect(
      tokenEndpointFor(world, world.holder).exchangeCode({
        code: await codeFor(world),
        codeVerifier: VERIFIER,
      }),
    ).resolves.toBeDefined();
    expect(world.entra.control.assertionRejections()).toEqual([]);
  });

  it('the same PATCH with BOTH credentials keeps both, so the loss above is the replacement', async () => {
    const graph = installFakeGraph(fake);
    const { provisioner } = wizardProvisioner(graph);
    const application = await provisioner.createApplication(NEW_APPLICATION);
    const first = certificateCredential(1, 'selftest-a');
    const second = certificateCredential(2, 'selftest-b');
    await provisioner.patchApplication(application.id, { keyCredentials: [first] });
    await provisioner.patchApplication(application.id, { keyCredentials: [first, second] });
    expect(await provisioner.readKeyCredentials(application.id)).toHaveLength(2);
  });

  it('a call outside a role set is refused for the missing role and served with it', async () => {
    const world = identityWorld();
    const without = world.graph.world.issueAppToken(world.app.appId, 'graph').value;
    expect((await raw('GET', `${GRAPH}/users?$top=1&$select=id`, { token: without })).status).toBe(
      403,
    );
    world.app.grantGraphRole('User.Read.All');
    const withRole = world.graph.world.issueAppToken(world.app.appId, 'graph').value;
    expect((await raw('GET', `${GRAPH}/users?$top=1&$select=id`, { token: withRole })).status).toBe(
      200,
    );
  });
});

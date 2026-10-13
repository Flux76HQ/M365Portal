// T-B-083, FR-B-707, RB-10, PBR-09 (+ negative): the strictness of the fake tenant, proven through the
// real clients and MSW. A lenient fake gives false greens (baseline section 2), so each rule below is a
// Learn statement the fake encodes and a test that the fake still refuses what Learn refuses.
// `STRICT_RULES` lists the statements; the gate note and the owner's ledger take them from here.
//
// The simulation encodes OUR reading of Learn; it cannot prove what Microsoft does (spec 8.6). What a
// real tenant must confirm is the owner-verified ledger, not this file.
import { createHash } from 'node:crypto';
import { EXCHANGE_ROLES } from '@m365portal/shared/setup/graph-roles';
import { expectGuardFails } from '@m365portal/shared/testing';
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
import { x5tOf } from './fake-tenant/entra/assertion.js';
import { seedApplication } from './fake-tenant/entra/index.js';
import { installFakeExchange } from './fake-tenant/exchange/index.js';
import {
  ENTRA_ROLE_TEMPLATES,
  describeSeed,
  fakeGuid,
  installFakeGraph,
  seedDirectory,
  type FakeGraph,
} from './fake-tenant/graph/index.js';
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

/**
 * The strict rules of the directory routes (Phase C, FR-C-601). Each has a case in the describe block
 * "Graph directory reads are strict" below, found by the `rule` text; the gate note and the owner's
 * ledger (OV-C1 to OV-C6) take them from here.
 */
export const DIRECTORY_STRICT_RULES: readonly { rule: string; learn: string }[] = [
  {
    rule: '$top above 999 is 400',
    learn: 'https://learn.microsoft.com/graph/api/user-list (maximum page size 999)',
  },
  {
    rule: '$skip is 400 on the directory collections',
    learn: 'https://learn.microsoft.com/graph/api/user-list ($skip is not supported)',
  },
  {
    rule: '$filter with $orderby needs ConsistencyLevel: eventual and $count=true',
    learn:
      'https://learn.microsoft.com/graph/aad-advanced-queries; https://learn.microsoft.com/graph/api/user-list',
  },
  {
    rule: 'any $count=true needs the header',
    learn: 'https://learn.microsoft.com/graph/aad-advanced-queries',
  },
  {
    rule: 'the not operator needs the advanced pair',
    learn: 'https://learn.microsoft.com/graph/aad-advanced-queries (not, ne, endsWith)',
  },
  {
    rule: 'startsWith on a non-default property needs the advanced pair',
    learn:
      'https://learn.microsoft.com/graph/aad-advanced-queries (property table; our reading, U70)',
  },
  {
    rule: 'a filter outside the grammar of FR-C-202 and FR-C-301 is 400 Request_UnsupportedQuery',
    learn: 'plan 6; the fake accepts exactly what the product sends',
  },
  {
    rule: 'members and owners need the advanced pair for every query option but $expand',
    learn: 'https://learn.microsoft.com/graph/api/group-list-members; .../group-list-owners',
  },
  {
    rule: 'memberOf of an application token needs Directory.Read.All',
    learn: 'https://learn.microsoft.com/graph/api/user-list-memberof',
  },
  {
    rule: 'the manager call is refused to application tokens by default (U66)',
    learn: 'https://learn.microsoft.com/graph/api/user-list-manager (Application: Not supported)',
  },
  {
    rule: 'members of a hidden-membership group are refused without Member.Read.Hidden (U67)',
    learn: 'https://learn.microsoft.com/graph/api/group-list-members (Member.Read.Hidden)',
  },
  {
    rule: 'owners are empty for distribution, mail-enabled security and synced groups',
    learn: 'https://learn.microsoft.com/graph/api/group-list-owners',
  },
  {
    rule: 'objects the token cannot read come back with id and @odata.type only',
    learn: 'https://learn.microsoft.com/graph/permissions-overview (limited information)',
  },
  {
    rule: 'a page is followed by an opaque $skiptoken in @odata.nextLink',
    learn: 'https://learn.microsoft.com/graph/paging',
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
    const sha1 = x5tOf(world.holder.thumbprintSha1);
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

// ---------------------------------------------------------------------------------------------
// Phase C: the directory reads (T-C-013, T-C-014, T-C-015, FR-C-601)
// ---------------------------------------------------------------------------------------------

const APP_ROLES = ['User.Read.All', 'GroupMember.Read.All', 'GroupMember.ReadWrite.All'] as const;
const EVENTUAL = { ConsistencyLevel: 'eventual' } as const;

function graphUrl(path: string, params: Readonly<Record<string, string>> = {}): string {
  const pairs = Object.entries(params).map(([n, v]) => `${n}=${encodeURIComponent(v)}`);
  return `${GRAPH}${path}${pairs.length === 0 ? '' : `?${pairs.join('&')}`}`;
}

function tokenWith(graph: FakeGraph, roles: readonly string[] = APP_ROLES): string {
  return graph.world.tokens.issue({
    audience: 'graph',
    kind: 'app',
    appId: fakeGuid('selftest-directory-app', 1),
    roles,
  }).value;
}

/** A small directory with the shapes the rules below need. */
function smallDirectory(graph: FakeGraph) {
  const { directory } = graph;
  const boss = directory.addUser({
    userPrincipalName: 'boss@contoso-fake.example',
    displayName: 'Boss',
    department: 'Finance',
  });
  const anna = directory.addUser({
    userPrincipalName: 'anna@contoso-fake.example',
    displayName: 'Anna',
    department: 'Sales',
    managerId: boss.id,
  });
  const bob = directory.addUser({
    userPrincipalName: 'bob@contoso-fake.example',
    displayName: 'Bob',
    accountEnabled: false,
    userType: 'Guest',
  });
  const m365 = directory.addGroup({
    displayName: 'Team',
    groupTypes: ['Unified'],
    mailEnabled: true,
    securityEnabled: false,
    mail: 'team@contoso-fake.example',
  });
  const hidden = directory.addGroup({
    displayName: 'Hidden',
    groupTypes: ['Unified'],
    mailEnabled: true,
    securityEnabled: false,
    hiddenMembership: true,
  });
  const distribution = directory.addGroup({
    displayName: 'Mailing',
    mailEnabled: true,
    securityEnabled: false,
    mail: 'mailing@contoso-fake.example',
  });
  const device = directory.addOtherObject('#microsoft.graph.device', 'Laptop');
  directory.addMember(m365.id, anna.id);
  directory.addMember(m365.id, device.id);
  directory.addOwner(m365.id, boss.id);
  directory.addMember(hidden.id, anna.id);
  directory.addOwner(distribution.id, boss.id);
  return { boss, anna, bob, m365, hidden, distribution, device };
}

describe('Graph directory reads are strict (FR-C-601)', () => {
  it('lists the rules, each with a Learn page or a plan reference', () => {
    expect(DIRECTORY_STRICT_RULES.length).toBeGreaterThanOrEqual(14);
    for (const entry of DIRECTORY_STRICT_RULES) expect(entry.learn.length).toBeGreaterThan(10);
  });

  describe('the refusals', () => {
    interface Refusal {
      readonly rule: string;
      readonly path: string;
      readonly params?: Record<string, string>;
      readonly headers?: Record<string, string>;
      readonly status: number;
      readonly code: string;
    }
    const REFUSALS: readonly Refusal[] = [
      {
        rule: '$top above 999 is 400',
        path: '/users',
        params: { $top: '1000' },
        status: 400,
        code: 'Request_BadRequest',
      },
      {
        rule: '$top above 999 is 400',
        path: '/groups',
        params: { $top: '0' },
        status: 400,
        code: 'Request_BadRequest',
      },
      {
        rule: '$skip is 400 on the directory collections',
        path: '/users',
        params: { $skip: '10' },
        status: 400,
        code: 'Request_UnsupportedQuery',
      },
      {
        rule: '$skip is 400 on the directory collections',
        path: '/groups',
        params: { $skip: '10' },
        status: 400,
        code: 'Request_UnsupportedQuery',
      },
      {
        rule: '$filter with $orderby needs ConsistencyLevel: eventual and $count=true',
        path: '/users',
        params: { $filter: "startsWith(displayName,'a')", $orderby: 'displayName' },
        status: 400,
        code: 'Request_UnsupportedQuery',
      },
      {
        rule: '$filter with $orderby needs ConsistencyLevel: eventual and $count=true',
        path: '/users',
        params: { $filter: "startsWith(displayName,'a')", $orderby: 'displayName', $count: 'true' },
        status: 400,
        code: 'Request_UnsupportedQuery',
      },
      {
        rule: '$filter with $orderby needs ConsistencyLevel: eventual and $count=true',
        path: '/users',
        params: { $filter: "startsWith(displayName,'a')", $orderby: 'displayName' },
        headers: EVENTUAL,
        status: 400,
        code: 'Request_UnsupportedQuery',
      },
      {
        rule: 'any $count=true needs the header',
        path: '/groups',
        params: { $count: 'true' },
        status: 400,
        code: 'Request_UnsupportedQuery',
      },
      {
        rule: 'the not operator needs the advanced pair',
        path: '/groups',
        params: { $filter: "not groupTypes/any(c:c eq 'Unified')" },
        status: 400,
        code: 'Request_UnsupportedQuery',
      },
      {
        rule: 'the not operator needs the advanced pair',
        path: '/users',
        params: { $filter: "userType ne 'Guest'" },
        status: 400,
        code: 'Request_UnsupportedQuery',
      },
      {
        rule: 'the not operator needs the advanced pair',
        path: '/users',
        params: { $filter: 'userType eq null' },
        status: 400,
        code: 'Request_UnsupportedQuery',
      },
      {
        rule: 'startsWith on a non-default property needs the advanced pair',
        path: '/users',
        params: { $filter: "startsWith(userPrincipalName,'a')" },
        status: 400,
        code: 'Request_UnsupportedQuery',
      },
      {
        rule: 'startsWith on a non-default property needs the advanced pair',
        path: '/groups',
        params: { $filter: "startsWith(mailNickname,'a')" },
        status: 400,
        code: 'Request_UnsupportedQuery',
      },
      ...[
        "contains(displayName,'a')",
        "displayName in ('a','b')",
        "displayName ge 'a'",
        "startsWith(displayName,'a') xor startsWith(mail,'a')",
        "endsWith(assignedLicenses,'a')",
        "assignedLicenses/any(c:c eq 'x')",
        'accountEnabled eq 1',
        "startsWith(displayName,'unterminated)",
        "displayName eq'a'",
        "(startsWith(displayName,'a')",
        'unknownFunction(displayName)',
      ].map((filter): Refusal => ({
        rule: 'a filter outside the grammar of FR-C-202 and FR-C-301 is 400 Request_UnsupportedQuery',
        path: '/users',
        params: { $filter: filter },
        headers: EVENTUAL,
        status: 400,
        code: 'Request_UnsupportedQuery',
      })),
      {
        rule: 'a filter outside the grammar of FR-C-202 and FR-C-301 is 400 Request_UnsupportedQuery',
        path: '/users',
        params: { $search: '"displayName:a"' },
        headers: EVENTUAL,
        status: 400,
        code: 'Request_UnsupportedQuery',
      },
      {
        rule: 'a filter outside the grammar of FR-C-202 and FR-C-301 is 400 Request_UnsupportedQuery',
        path: '/users',
        params: { $orderby: 'jobTitle desc' },
        status: 400,
        code: 'Request_UnsupportedQuery',
      },
      {
        rule: 'members and owners need the advanced pair for every query option but $expand',
        path: '/groups/GROUP/members',
        params: { $top: '5' },
        status: 400,
        code: 'Request_UnsupportedQuery',
      },
      {
        rule: 'members and owners need the advanced pair for every query option but $expand',
        path: '/groups/GROUP/owners',
        params: { $select: 'id,displayName' },
        status: 400,
        code: 'Request_UnsupportedQuery',
      },
      {
        rule: 'members and owners need the advanced pair for every query option but $expand',
        path: '/groups/GROUP/members',
        params: { $top: '5', $count: 'true' },
        status: 400,
        code: 'Request_UnsupportedQuery',
      },
      {
        rule: 'members and owners need the advanced pair for every query option but $expand',
        path: '/users/ANNA/transitiveMemberOf/microsoft.graph.group',
        params: { $top: '5' },
        status: 400,
        code: 'Request_UnsupportedQuery',
      },
      {
        rule: 'memberOf of an application token needs Directory.Read.All',
        path: '/users/ANNA/memberOf',
        status: 403,
        code: 'Authorization_RequestDenied',
      },
      {
        rule: 'memberOf of an application token needs Directory.Read.All',
        path: '/users/ANNA/memberOf/microsoft.graph.group',
        status: 403,
        code: 'Authorization_RequestDenied',
      },
      {
        rule: 'the manager call is refused to application tokens by default (U66)',
        path: '/users/ANNA/manager',
        status: 403,
        code: 'Authorization_RequestDenied',
      },
      {
        rule: 'members of a hidden-membership group are refused without Member.Read.Hidden (U67)',
        path: '/groups/HIDDEN/members',
        params: { $top: '5', $count: 'true' },
        headers: EVENTUAL,
        status: 403,
        code: 'Authorization_RequestDenied',
      },
    ];

    it.each(
      REFUSALS.map(
        (refusal, index) =>
          [
            `${String(index + 1)}. ${refusal.rule}: ${refusal.path} ${JSON.stringify(refusal.params ?? {})}`,
            refusal,
          ] as const,
      ),
    )('%s', async (_name, refusal) => {
      const graph = installFakeGraph(fake);
      const ids = smallDirectory(graph);
      const path = refusal.path
        .replace('GROUP', ids.m365.id)
        .replace('HIDDEN', ids.hidden.id)
        .replace('ANNA', ids.anna.id);
      const answer = await raw('GET', graphUrl(path, refusal.params), {
        token: tokenWith(graph),
        ...(refusal.headers === undefined ? {} : { headers: refusal.headers }),
      });
      expect(answer.status).toBe(refusal.status);
      expect((answer.body as { error: { code: string } }).error.code).toBe(refusal.code);
    });

    it('has a case for every rule of the list', () => {
      const covered = new Set(REFUSALS.map((refusal) => refusal.rule));
      const behavioural = new Set([
        'owners are empty for distribution, mail-enabled security and synced groups',
        'objects the token cannot read come back with id and @odata.type only',
        'a page is followed by an opaque $skiptoken in @odata.nextLink',
      ]);
      for (const { rule } of DIRECTORY_STRICT_RULES) {
        expect(covered.has(rule) || behavioural.has(rule), rule).toBe(true);
      }
    });
  });

  describe('what the advanced pair opens', () => {
    it('serves filter, orderby, count, not, or and the lambda with the header and $count=true', async () => {
      const graph = installFakeGraph(fake);
      smallDirectory(graph);
      const token = tokenWith(graph);
      const users = await raw(
        'GET',
        graphUrl('/users', {
          $filter:
            "(startsWith(displayName,'a') or startsWith(mail,'x') or startsWith(userPrincipalName,'zz')) and accountEnabled eq true",
          $orderby: 'displayName desc',
          $select: 'id,displayName,userType',
          $count: 'true',
          $top: '10',
        }),
        { token, headers: EVENTUAL },
      );
      expect(users.status).toBe(200);
      const body = users.body as { value: { displayName: string }[]; '@odata.count': number };
      expect(body.value.map((row) => row.displayName)).toEqual(['Anna']);
      expect(body['@odata.count']).toBe(1);

      const groups = await raw(
        'GET',
        graphUrl('/groups', {
          $filter:
            "not groupTypes/any(c:c eq 'Unified') and mailEnabled eq true and securityEnabled eq false",
          $orderby: 'displayName asc',
          $count: 'true',
          $select: 'id,displayName,groupTypes,mailEnabled,securityEnabled',
        }),
        { token, headers: EVENTUAL },
      );
      expect(groups.status).toBe(200);
      expect(
        (groups.body as { value: { displayName: string }[] }).value.map((r) => r.displayName),
      ).toEqual(['Mailing']);

      const unified = await raw(
        'GET',
        graphUrl('/groups', { $filter: "groupTypes/any(c:c eq 'Unified')" }),
        { token },
      );
      expect((unified.body as { value: unknown[] }).value).toHaveLength(2);
    });

    it('does not need the header for a default query: eq, startsWith on displayName, and (U37 off)', async () => {
      const graph = installFakeGraph(fake);
      smallDirectory(graph);
      const token = tokenWith(graph);
      const answer = await raw(
        'GET',
        graphUrl('/users', {
          $filter:
            "startsWith(displayName,'b') and userType eq 'Guest' and accountEnabled eq false",
          $select: 'id,displayName',
        }),
        { token },
      );
      expect(answer.status).toBe(200);
      expect((answer.body as { value: unknown[] }).value).toHaveLength(1);
    });

    it('orders by display name, case-insensitively, ties by id, in both directions', async () => {
      const graph = installFakeGraph(fake);
      for (const name of ['bravo', 'Alpha', 'alpha', 'Charlie']) {
        graph.directory.addUser({
          userPrincipalName: `${name}@contoso-fake.example`,
          displayName: name,
        });
      }
      const token = tokenWith(graph);
      const names = async (direction: string): Promise<string[]> => {
        const answer = await raw(
          'GET',
          graphUrl('/users', { $orderby: `displayName ${direction}`, $select: 'id,displayName' }),
          { token },
        );
        return (answer.body as { value: { displayName: string }[] }).value.map(
          (r) => r.displayName,
        );
      };
      expect(await names('asc')).toEqual(['Alpha', 'alpha', 'bravo', 'Charlie']);
      expect(await names('desc')).toEqual(['Charlie', 'bravo', 'Alpha', 'alpha'].map((n) => n));
    });
  });

  describe('paging', () => {
    it('follows an opaque @odata.nextLink, in order, without a gap or a duplicate', async () => {
      const graph = installFakeGraph(fake);
      for (let index = 0; index < 25; index += 1) {
        graph.directory.addUser({
          userPrincipalName: `u${String(index).padStart(2, '0')}@contoso-fake.example`,
          displayName: `User ${String(index).padStart(2, '0')}`,
        });
      }
      const token = tokenWith(graph);
      const seen: string[] = [];
      let url: string | undefined = graphUrl('/users', {
        $orderby: 'displayName',
        $top: '10',
        $count: 'true',
        $select: 'id,displayName',
      });
      let pages = 0;
      while (url !== undefined) {
        const answer = await raw('GET', url, { token, headers: EVENTUAL });
        expect(answer.status).toBe(200);
        const body = answer.body as {
          value: { displayName: string }[];
          '@odata.nextLink'?: string;
        };
        seen.push(...body.value.map((r) => r.displayName));
        url = body['@odata.nextLink'];
        if (url !== undefined) {
          const token_ = new URL(url).searchParams.get('$skiptoken') ?? '';
          expect(token_).not.toMatch(/^skip\d+$/);
          expect(token_).not.toMatch(/^\d+$/);
        }
        pages += 1;
      }
      expect(pages).toBe(3);
      expect(seen).toHaveLength(25);
      expect(new Set(seen).size).toBe(25);
      expect(seen).toEqual([...seen].sort());
    });

    it('refuses a skiptoken that is not one it made', async () => {
      const graph = installFakeGraph(fake);
      smallDirectory(graph);
      const answer = await raw('GET', graphUrl('/users', { $skiptoken: 'skip3' }), {
        token: tokenWith(graph),
      });
      expect(answer.status).toBe(400);
    });
  });

  describe('relationships', () => {
    it('lists the groups of a user transitively through the group cast, omitting hidden ones while they are refused (U67)', async () => {
      const graph = installFakeGraph(fake);
      const { anna, m365, hidden } = smallDirectory(graph);
      const outer = graph.directory.addGroup({ displayName: 'Outer' });
      graph.directory.addMember(outer.id, m365.id);
      const token = tokenWith(graph);
      const path = `/users/${anna.id}/transitiveMemberOf/microsoft.graph.group`;
      const query = { $select: 'id,displayName', $top: '10', $count: 'true' };
      const refused = await raw('GET', graphUrl(path, query), { token, headers: EVENTUAL });
      const names = (answer: { body: unknown }): string[] =>
        (answer.body as { value: { displayName: string }[] }).value
          .map((r) => r.displayName)
          .sort();
      expect(names(refused)).toEqual(['Outer', 'Team']);
      graph.control.hiddenMembersRefused(false);
      const open = await raw('GET', graphUrl(path, query), { token, headers: EVENTUAL });
      expect(names(open)).toEqual(['Hidden', 'Outer', 'Team']);
      expect(hidden.hiddenMembership).toBe(true);
    });

    it('serves memberOf to an application token that holds Directory.Read.All', async () => {
      const graph = installFakeGraph(fake);
      const { anna } = smallDirectory(graph);
      const token = tokenWith(graph, [...APP_ROLES, 'Directory.Read.All']);
      const answer = await raw('GET', graphUrl(`/users/${anna.id}/memberOf`), { token });
      expect(answer.status).toBe(200);
    });

    it('answers the manager: 403 for an app by default, 404 without a manager, the object when allowed', async () => {
      const graph = installFakeGraph(fake);
      const { anna, boss } = smallDirectory(graph);
      const token = tokenWith(graph);
      const query = { $select: 'id,displayName,mail,userPrincipalName,department,mailNickname' };
      expect(
        (await raw('GET', graphUrl(`/users/${anna.id}/manager`, query), { token })).status,
      ).toBe(403);
      graph.control.managerForApps('allowed');
      const ok = await raw('GET', graphUrl(`/users/${anna.id}/manager`, query), { token });
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ id: boss.id, displayName: 'Boss', department: 'Finance' });
      const none = await raw('GET', graphUrl(`/users/${boss.id}/manager`, query), { token });
      expect(none.status).toBe(404);
      // A delegated token is not "an application": it is served in the default mode too.
      graph.control.managerForApps('refused');
      const delegated = graph.world.issueDelegatedToken({
        userId: fakeGuid('admin', 3),
        scopes: ['User.Read.All'],
      }).value;
      expect(
        (await raw('GET', graphUrl(`/users/${anna.id}/manager`, query), { token: delegated }))
          .status,
      ).toBe(200);
    });

    it('owners are empty for distribution, mail-enabled security and synced groups, and listed for the rest', async () => {
      const graph = installFakeGraph(fake);
      const { m365, distribution } = smallDirectory(graph);
      const synced = graph.directory.addGroup({
        displayName: 'Synced',
        onPremisesSyncEnabled: true,
      });
      const mailSecurity = graph.directory.addGroup({
        displayName: 'MailSec',
        mailEnabled: true,
        securityEnabled: true,
      });
      for (const group of [synced, mailSecurity]) {
        graph.directory.addOwner(
          group.id,
          graph.directory.addUser({
            userPrincipalName: `o-${group.id.slice(-4)}@contoso-fake.example`,
          }).id,
        );
      }
      const token = tokenWith(graph);
      const owners = async (id: string): Promise<number> => {
        const answer = await raw(
          'GET',
          graphUrl(`/groups/${id}/owners`, {
            $select: 'id,displayName',
            $top: '10',
            $count: 'true',
          }),
          { token, headers: EVENTUAL },
        );
        expect(answer.status).toBe(200);
        return (answer.body as { value: unknown[] }).value.length;
      };
      expect(await owners(m365.id)).toBe(1);
      expect(await owners(distribution.id)).toBe(0);
      expect(await owners(synced.id)).toBe(0);
      expect(await owners(mailSecurity.id)).toBe(0);
    });

    it('shows an object the token cannot read with id and @odata.type only, other properties null', async () => {
      const graph = installFakeGraph(fake);
      const { m365, anna, device } = smallDirectory(graph);
      const query = {
        $select: 'id,displayName,mail,userPrincipalName,department,mailNickname',
        $top: '10',
        $count: 'true',
      };
      const rows = async (roles: readonly string[]): Promise<Record<string, unknown>[]> => {
        const answer = await raw('GET', graphUrl(`/groups/${m365.id}/members`, query), {
          token: tokenWith(graph, roles),
          headers: EVENTUAL,
        });
        expect(answer.status).toBe(200);
        return (answer.body as { value: Record<string, unknown>[] }).value;
      };
      const full = await rows(APP_ROLES);
      expect(full.find((row) => row.id === anna.id)).toMatchObject({
        '@odata.type': '#microsoft.graph.user',
        displayName: 'Anna',
        department: 'Sales',
      });
      expect(full.find((row) => row.id === device.id)).toEqual({
        '@odata.type': '#microsoft.graph.device',
        id: device.id,
        displayName: null,
        mail: null,
        userPrincipalName: null,
        department: null,
        mailNickname: null,
      });
      // GroupMember.Read.All alone: users come back limited (R-C-05).
      const limited = await rows(['GroupMember.Read.All']);
      expect(limited.find((row) => row.id === anna.id)).toMatchObject({
        '@odata.type': '#microsoft.graph.user',
        displayName: null,
        mail: null,
      });
    });

    it('answers an empty members list for a hidden group when the switch says so, owners still listed', async () => {
      const graph = installFakeGraph(fake);
      const { hidden } = smallDirectory(graph);
      graph.directory.addOwner(
        hidden.id,
        graph.directory.addUser({ userPrincipalName: 'h@contoso-fake.example' }).id,
      );
      graph.control.hiddenMembersRefused(false);
      const token = tokenWith(graph);
      const query = { $select: 'id', $top: '10', $count: 'true' };
      const members = await raw('GET', graphUrl(`/groups/${hidden.id}/members`, query), {
        token,
        headers: EVENTUAL,
      });
      expect((members.body as { value: unknown[] }).value).toEqual([]);
      const owners = await raw('GET', graphUrl(`/groups/${hidden.id}/owners`, query), {
        token,
        headers: EVENTUAL,
      });
      expect((owners.body as { value: unknown[] }).value).toHaveLength(1);
      // With Member.Read.Hidden the members come back, whatever the switch says.
      graph.control.hiddenMembersRefused(true);
      const privileged = tokenWith(graph, [...APP_ROLES, 'Member.Read.Hidden']);
      const listed = await raw('GET', graphUrl(`/groups/${hidden.id}/members`, query), {
        token: privileged,
        headers: EVENTUAL,
      });
      expect((listed.body as { value: unknown[] }).value).toHaveLength(1);
    });

    it('omits the basic-only properties of a group when asked (U36, U69)', async () => {
      const graph = installFakeGraph(fake);
      const { m365 } = smallDirectory(graph);
      graph.directory.groups.get(m365.id)!.visibility = 'Private';
      const token = tokenWith(graph);
      const read = async (): Promise<Record<string, unknown>> => {
        const answer = await raw(
          'GET',
          graphUrl(`/groups/${m365.id}`, {
            $select: 'id,displayName,visibility,mailNickname,groupTypes',
          }),
          { token },
        );
        return answer.body as Record<string, unknown>;
      };
      expect(await read()).toMatchObject({ visibility: 'Private' });
      graph.control.omitGroupProperties(true);
      expect(await read()).toMatchObject({
        visibility: null,
        mailNickname: null,
        groupTypes: ['Unified'],
      });
    });
  });

  describe('permissions', () => {
    it('refuses the reads without the role Learn lists, and serves them with it', async () => {
      const graph = installFakeGraph(fake);
      const { anna, m365 } = smallDirectory(graph);
      const none = tokenWith(graph, []);
      const advanced = { $top: '5', $count: 'true', $select: 'id' };
      const calls: [string, Record<string, string>, string, string][] = [
        ['/users', {}, 'User.Read.All', 'GroupMember.Read.All'],
        ['/groups', {}, 'GroupMember.Read.All', 'User.Read.All'],
        [`/groups/${m365.id}/members`, advanced, 'GroupMember.Read.All', 'User.Read.All'],
        [`/groups/${m365.id}/owners`, advanced, 'GroupMember.Read.All', 'User.Read.All'],
        [
          `/users/${anna.id}/transitiveMemberOf/microsoft.graph.group`,
          advanced,
          'User.Read.All',
          'Organization.Read.All',
        ],
      ];
      for (const [path, params, needed, other] of calls) {
        const headers = Object.keys(params).length > 0 ? EVENTUAL : undefined;
        const options = (token: string) => ({
          token,
          ...(headers === undefined ? {} : { headers }),
        });
        expect((await raw('GET', graphUrl(path, params), options(none))).status, path).toBe(403);
        expect(
          (await raw('GET', graphUrl(path, params), options(tokenWith(graph, [other])))).status,
          `${path} with ${other}`,
        ).toBe(403);
        expect(
          (await raw('GET', graphUrl(path, params), options(tokenWith(graph, [needed])))).status,
          `${path} with ${needed}`,
        ).toBe(200);
      }
    });
  });

  describe('the seeded directory (seedDirectory)', () => {
    it('offers 1,200 users and 150 groups of every kind, deterministic for a seed', () => {
      const first = installFakeGraph(fake);
      const seeded = seedDirectory(first.directory);
      const note = describeSeed(seeded);
      expect(first.directory.users.size, note).toBe(1_200);
      expect(first.directory.groups.size, note).toBe(150);
      const ids = seeded.ids;
      expect(first.directory.groups.get(ids.bigGroup)?.members.size, note).toBe(250);
      expect(first.directory.groups.get(ids.hiddenGroup)?.hiddenMembership, note).toBe(true);
      expect(first.directory.users.get(ids.noManagerUser)?.managerId, note).toBeNull();
      expect(first.directory.users.get(ids.userWithManager)?.managerId, note).toBe(
        ids.managerOfWithManager,
      );
      expect(first.directory.users.get(ids.guest)?.userType, note).toBe('Guest');
      expect(first.directory.users.get(ids.disabledUser)?.accountEnabled, note).toBe(false);
      expect(first.directory.users.get(ids.nullTypeUser)?.userType, note).toBeNull();
      expect(first.directory.users.get(ids.quoteUser)?.displayName, note).toContain("'");
      expect(first.directory.users.get(ids.noMailUser)?.mail, note).toBeNull();
      expect(
        Array.from(first.directory.users.get(ids.diacriticUser)?.displayName ?? '').some(
          (char) => char.charCodeAt(0) > 127,
        ),
        note,
      ).toBe(true);
      for (const kind of ['m365', 'security', 'mailsecurity', 'distribution'] as const) {
        expect(seeded.kinds[kind].length, `${note} ${kind}`).toBeGreaterThan(5);
      }
      // Same seed, same directory (ids included); another seed, other memberships.
      fake.reset();
      const second = installFakeGraph(fake);
      const again = seedDirectory(second.directory);
      expect(again.ids).toEqual(seeded.ids);
      expect([...second.directory.users.values()]).toEqual([...first.directory.users.values()]);
      expect([...second.directory.groups.values()].map((group) => [...group.members])).toEqual(
        [...first.directory.groups.values()].map((group) => [...group.members]),
      );
      fake.reset();
      const other = installFakeGraph(fake);
      seedDirectory(other.directory, { seed: 7 });
      expect([...other.directory.users.values()].map((user) => user.managerId)).not.toEqual(
        [...first.directory.users.values()].map((user) => user.managerId),
      );
    });

    it('pages through all 1,200 users in order over HTTP, 999 at a time', async () => {
      const graph = installFakeGraph(fake);
      const seeded = seedDirectory(graph.directory);
      const token = tokenWith(graph);
      let url: string | undefined = graphUrl('/users', {
        $orderby: 'displayName',
        $top: '999',
        $count: 'true',
        $select: 'id,displayName',
      });
      const ids: string[] = [];
      let pages = 0;
      while (url !== undefined) {
        const answer = await raw('GET', url, { token, headers: EVENTUAL });
        const body = answer.body as {
          value: { id: string }[];
          '@odata.nextLink'?: string;
          '@odata.count': number;
        };
        expect(body['@odata.count'], describeSeed(seeded)).toBe(1_200);
        ids.push(...body.value.map((row) => row.id));
        url = body['@odata.nextLink'];
        pages += 1;
      }
      expect(pages).toBe(2);
      expect(new Set(ids).size).toBe(1_200);
    });
  });

  describe('negative: a lenient fake would have accepted what these tests refuse', () => {
    it('the refusal guard fails for a request the fake serves, and for a status that is not the documented one', async () => {
      const graph = installFakeGraph(fake);
      smallDirectory(graph);
      const token = tokenWith(graph);
      const assertRefused = async (request: {
        path: string;
        params: Record<string, string>;
      }): Promise<void> => {
        const answer = await raw('GET', graphUrl(request.path, request.params), { token });
        if (answer.status !== 400)
          throw new Error(`the fake served ${String(answer.status)}, Learn refuses`);
      };
      // Allowed by Learn (default query): the guard must fail on it, which proves it can see a 200.
      await expectGuardFails(
        assertRefused,
        { path: '/users', params: { $top: '999' } },
        { reason: 'the fake served 200' },
      );
      // Refused by Learn: the guard passes.
      await expect(
        assertRefused({ path: '/users', params: { $top: '1000' } }),
      ).resolves.toBeUndefined();
      await expect(
        assertRefused({ path: '/users', params: { $skip: '1' } }),
      ).resolves.toBeUndefined();
    });
  });
});

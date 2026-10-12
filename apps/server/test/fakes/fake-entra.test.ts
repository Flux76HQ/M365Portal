// T-B-064, FR-B-707, PB-19, B-20 (+ negative): the fake Entra.
//
// The fake validates strictly what Microsoft Learn says, because a lenient fake gives false greens
// (baseline section 2). This file pins each rule it applies and each toggle the sign-in fixtures
// F-01 to F-45 and the US-B2 scenarios need. Every Learn statement a rule encodes is cited next to
// the test of that rule; T-B-083 proves the same strictness again through the real clients.
//
//   discovery and keys      https://learn.microsoft.com/entra/identity-platform/v2-protocols-oidc
//                           https://learn.microsoft.com/entra/identity-platform/signing-key-rollover
//   authorize and token     https://learn.microsoft.com/entra/identity-platform/v2-oauth2-auth-code-flow
//   client assertion        https://learn.microsoft.com/entra/identity-platform/certificate-credentials
//   device code             https://learn.microsoft.com/entra/identity-platform/v2-oauth2-device-code
//   sign out                https://learn.microsoft.com/entra/identity-platform/v2-protocols-oidc
import { createHash, createPublicKey, type JsonWebKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createFakeTenant } from './fake-tenant/index.js';
import { createFakeGraph, installFakeGraph } from './fake-tenant/graph/index.js';
import {
  DEVICE_MESSAGE_CANARY,
  HOSTILE_DESCRIPTION,
  buildClientAssertion,
  createFakeEntra,
  installFakeEntra,
  seedApplication,
  type SignInSpec,
} from './fake-tenant/entra/index.js';
import { fromB64url, parseCompact, verifyRs256 } from './fake-tenant/entra/jwt.js';
import { fake, testClock } from '../support/msw.js';

const LOGIN = 'https://login.microsoftonline.com';
const CALLBACK = 'https://panel.example/auth/callback';
const LOGGED_OUT = 'https://panel.example/auth/logged-out';
const BOOTSTRAP_CLIENT = '14d82eec-204b-4c2f-b7e8-296a70dab67e';
const GRAPH_SCOPES = [
  'https://graph.microsoft.com/Application.ReadWrite.All',
  'https://graph.microsoft.com/AppRoleAssignment.ReadWrite.All',
  'https://graph.microsoft.com/RoleManagement.ReadWrite.Directory',
];

function setup(redirectUris: readonly string[] = [CALLBACK, LOGGED_OUT]) {
  const graph = installFakeGraph(fake);
  const entra = installFakeEntra(fake, graph.world);
  const tenant = graph.directory.tenantId;
  const app = seedApplication(graph.world, { redirectUris });
  const user = graph.directory.addUser({ userPrincipalName: 'alice@contoso-fake.example' });
  entra.control.defaultSignIn({ user: user.id });
  return { graph, entra, tenant, app, user };
}

interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly headers: Headers;
  readonly text: string;
}

async function send(
  method: string,
  url: string,
  options: { form?: Record<string, string>; headers?: Record<string, string>; text?: string } = {},
): Promise<Answer> {
  const headers = new Headers(options.headers);
  let body: string | undefined;
  if (options.form !== undefined) {
    body = new URLSearchParams(options.form).toString();
    headers.set('content-type', 'application/x-www-form-urlencoded');
  } else if (options.text !== undefined) {
    body = options.text;
  }
  const response = await fetch(url, {
    method,
    headers,
    redirect: 'manual',
    ...(body === undefined ? {} : { body }),
  });
  const text = await response.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  return { status: response.status, body: parsed, headers: response.headers, text };
}

const CHALLENGE_VERIFIER = 'a'.repeat(43);
const CHALLENGE = createHash('sha256').update(CHALLENGE_VERIFIER).digest('base64url');

function authorizeUrl(tenant: string, overrides: Record<string, string | null> = {}): string {
  const params: Record<string, string> = {
    client_id: 'unset',
    response_type: 'code',
    redirect_uri: CALLBACK,
    response_mode: 'query',
    scope: 'openid profile',
    state: 'state-1',
    nonce: 'nonce-1',
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
  };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === null) Reflect.deleteProperty(params, name);
    else params[name] = value;
  }
  return `${LOGIN}/${tenant}/oauth2/v2.0/authorize?${new URLSearchParams(params).toString()}`;
}

/** Runs /authorize and returns the code the redirect carried. */
async function authorizeCode(
  t: ReturnType<typeof setup>,
  overrides: Record<string, string | null> = {},
): Promise<string> {
  const answer = await send(
    'GET',
    authorizeUrl(t.tenant, { client_id: t.app.appId, ...overrides }),
  );
  expect(answer.status).toBe(302);
  const location = new URL(answer.headers.get('location') ?? '');
  const code = location.searchParams.get('code');
  expect(code, answer.headers.get('location') ?? '').not.toBeNull();
  return code ?? '';
}

function assertionFor(
  t: ReturnType<typeof setup>,
  options: Partial<Parameters<typeof buildClientAssertion>[0]> = {},
): string {
  return buildClientAssertion({
    certificate: t.app.certificate,
    clientId: t.app.appId,
    tenant: t.tenant,
    nowMs: testClock.nowMs(),
    jti: `jti-${String(Math.random())}`,
    ...options,
  });
}

async function redeem(
  t: ReturnType<typeof setup>,
  code: string,
  extra: Record<string, string | null> = {},
  headers: Record<string, string> = {},
): Promise<Answer> {
  const form: Record<string, string> = {
    client_id: t.app.appId,
    grant_type: 'authorization_code',
    code,
    redirect_uri: CALLBACK,
    code_verifier: CHALLENGE_VERIFIER,
    scope: 'openid profile',
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: assertionFor(t),
  };
  for (const [name, value] of Object.entries(extra)) {
    if (value === null) Reflect.deleteProperty(form, name);
    else form[name] = value;
  }
  return send('POST', `${LOGIN}/${t.tenant}/oauth2/v2.0/token`, { form, headers });
}

function idTokenOf(answer: Answer): NonNullable<ReturnType<typeof parseCompact>> {
  const parsed = parseCompact(String(answer.body.id_token));
  expect(parsed).toBeDefined();
  return parsed!;
}

// ---------------------------------------------------------------------------------------------
describe('discovery and keys (v2-protocols-oidc, signing-key-rollover)', () => {
  it('serves a discovery document per tenant with the literal issuer, keys and logout endpoints', async () => {
    const t = setup();
    const answer = await send('GET', `${LOGIN}/${t.tenant}/v2.0/.well-known/openid-configuration`);
    expect(answer.status).toBe(200);
    expect(answer.body.issuer).toBe(`${LOGIN}/${t.tenant}/v2.0`);
    expect(answer.body.jwks_uri).toBe(`${LOGIN}/${t.tenant}/discovery/v2.0/keys`);
    expect(answer.body.end_session_endpoint).toBe(`${LOGIN}/${t.tenant}/oauth2/v2.0/logout`);
    expect(answer.body.authorization_endpoint).toBe(`${LOGIN}/${t.tenant}/oauth2/v2.0/authorize`);
    expect(answer.body.token_endpoint).toBe(`${LOGIN}/${t.tenant}/oauth2/v2.0/token`);
    expect(answer.body.id_token_signing_alg_values_supported).toEqual(['RS256']);
    expect(answer.body.token_endpoint_auth_methods_supported).toContain('private_key_jwt');
  });

  it('shows the issuer of the organizations document as the template, as Entra does (V-B12)', async () => {
    setup();
    const answer = await send(
      'GET',
      `${LOGIN}/organizations/v2.0/.well-known/openid-configuration`,
    );
    expect(answer.status).toBe(200);
    expect(answer.body.issuer).toBe(`${LOGIN}/{tenantid}/v2.0`);
  });

  it('refuses a tenant it does not know', async () => {
    const t = setup();
    const unknown = '11111111-2222-4333-8444-555555555555';
    expect((await send('GET', `${LOGIN}/${unknown}/discovery/v2.0/keys`)).status).toBe(400);
    expect(t.entra.control.keyIds(unknown)).toEqual([]);
  });

  it('rotateKeys adds a key and dropOldKeys removes the older ones', async () => {
    const t = setup();
    const url = `${LOGIN}/${t.tenant}/discovery/v2.0/keys`;
    const before = (await send('GET', url)).body.keys as { kid: string }[];
    expect(before).toHaveLength(1);
    const added = t.entra.control.rotateKeys();
    const during = (await send('GET', url)).body.keys as { kid: string }[];
    expect(during.map((key) => key.kid).sort()).toEqual([before[0]?.kid, added].sort());
    t.entra.control.dropOldKeys();
    const after = (await send('GET', url)).body.keys as { kid: string }[];
    expect(after.map((key) => key.kid)).toEqual([added]);
  });

  it('lists RSA signature keys with n and e, and key sets differ per tenant', async () => {
    const t = setup();
    const foreign = '22222222-3333-4444-8555-666666666666';
    t.entra.control.addTenant(foreign);
    const own = (await send('GET', `${LOGIN}/${t.tenant}/discovery/v2.0/keys`)).body.keys as Record<
      string,
      string
    >[];
    const other = (await send('GET', `${LOGIN}/${foreign}/discovery/v2.0/keys`)).body
      .keys as Record<string, string>[];
    expect(own[0]).toMatchObject({ kty: 'RSA', use: 'sig' });
    expect(typeof own[0]?.n).toBe('string');
    expect(typeof own[0]?.e).toBe('string');
    expect(own[0]?.kid).not.toBe(other[0]?.kid);
    expect(own[0]?.n).not.toBe(other[0]?.n);
  });

  it('keysFault: unavailable answers 503, redirect answers 302, not_json answers text', async () => {
    const t = setup();
    const url = `${LOGIN}/${t.tenant}/discovery/v2.0/keys`;
    t.entra.control.failKeys('unavailable');
    expect((await send('GET', url)).status).toBe(503);
    t.entra.control.failKeys('redirect');
    expect((await send('GET', url)).status).toBe(302);
    t.entra.control.failKeys('not_json');
    expect((await send('GET', url)).body).toEqual({});
    t.entra.control.failKeys(null);
    expect((await send('GET', url)).status).toBe(200);
  });

  it('discoveryFault: a document with another issuer or a jwks_uri on a foreign host', async () => {
    const t = setup();
    const url = `${LOGIN}/${t.tenant}/v2.0/.well-known/openid-configuration`;
    t.entra.control.failDiscovery('issuer_mismatch');
    expect((await send('GET', url)).body.issuer).not.toBe(`${LOGIN}/${t.tenant}/v2.0`);
    t.entra.control.failDiscovery('foreign_hosts');
    const body = (await send('GET', url)).body;
    expect(String(body.jwks_uri)).not.toContain('login.microsoftonline.com');
    expect(String(body.end_session_endpoint)).not.toContain('login.microsoftonline.com');
    t.entra.control.failDiscovery('unavailable');
    expect((await send('GET', url)).status).toBe(503);
  });
});

// ---------------------------------------------------------------------------------------------
describe('GET /authorize (v2-oauth2-auth-code-flow, "Request an authorization code")', () => {
  it('signs in the configured user and redirects with code and state', async () => {
    const t = setup();
    const answer = await send('GET', authorizeUrl(t.tenant, { client_id: t.app.appId }));
    expect(answer.status).toBe(302);
    const location = new URL(answer.headers.get('location') ?? '');
    expect(`${location.origin}${location.pathname}`).toBe(CALLBACK);
    expect(location.searchParams.get('state')).toBe('state-1');
    expect(location.searchParams.get('code')).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(answer.headers.get('cache-control')).toBe('no-store');
  });

  it('shows an error page and never redirects for an unknown client or an unregistered redirect URI', async () => {
    const t = setup();
    const unknownClient = await send(
      'GET',
      authorizeUrl(t.tenant, { client_id: '99999999-aaaa-4bbb-8ccc-dddddddddddd' }),
    );
    expect(unknownClient.status).toBe(400);
    expect(unknownClient.headers.get('location')).toBeNull();
    for (const redirect of [
      'https://panel.example/auth/callback/',
      'https://panel.example/AUTH/callback',
      'https://evil.example/auth/callback',
      'http://panel.example/auth/callback',
    ]) {
      const answer = await send(
        'GET',
        authorizeUrl(t.tenant, { client_id: t.app.appId, redirect_uri: redirect }),
      );
      expect(answer.status, redirect).toBe(400);
      expect(answer.headers.get('location'), redirect).toBeNull();
    }
  });

  it('ignores the port of a registered http://localhost URI and nothing else', async () => {
    const t = setup(['http://localhost/auth/callback']);
    const ok = await send(
      'GET',
      authorizeUrl(t.tenant, {
        client_id: t.app.appId,
        redirect_uri: 'http://localhost:8123/auth/callback',
      }),
    );
    expect(ok.status).toBe(302);
    expect(ok.headers.get('location')).toContain('http://localhost:8123/auth/callback?');
    for (const redirect of [
      'http://localhost:8123/other',
      'https://localhost:8123/auth/callback',
      'http://127.0.0.1:8123/auth/callback',
    ]) {
      const refused = await send(
        'GET',
        authorizeUrl(t.tenant, { client_id: t.app.appId, redirect_uri: redirect }),
      );
      expect(refused.status, redirect).toBe(400);
    }
  });

  const BAD: readonly [string, Record<string, string | null>, string][] = [
    ['response_type=token', { response_type: 'token' }, 'unsupported_response_type'],
    [
      'response_type=code id_token',
      { response_type: 'code id_token' },
      'unsupported_response_type',
    ],
    ['response_mode=fragment', { response_mode: 'fragment' }, 'invalid_request'],
    ['response_mode=form_post', { response_mode: 'form_post' }, 'invalid_request'],
    ['no scope', { scope: null }, 'invalid_request'],
    ['scope without openid', { scope: 'profile' }, 'invalid_request'],
    ['unknown scope', { scope: 'openid https://graph.microsoft.com/User.Read' }, 'invalid_scope'],
    ['no state', { state: null }, 'invalid_request'],
    ['no nonce', { nonce: null }, 'invalid_request'],
    ['no PKCE', { code_challenge: null, code_challenge_method: null }, 'invalid_request'],
    ['PKCE plain', { code_challenge_method: 'plain' }, 'invalid_request'],
    ['challenge without method', { code_challenge_method: null }, 'invalid_request'],
    ['challenge of the wrong length', { code_challenge: 'short' }, 'invalid_request'],
    ['prompt=consent', { prompt: 'consent' }, 'invalid_request'],
    ['prompt=bogus', { prompt: 'bogus' }, 'invalid_request'],
  ];
  it.each(BAD)('redirects the error for %s', async (_name, overrides, error) => {
    const t = setup();
    const answer = await send(
      'GET',
      authorizeUrl(t.tenant, { client_id: t.app.appId, ...overrides }),
    );
    expect(answer.status).toBe(302);
    const location = new URL(answer.headers.get('location') ?? '');
    expect(location.searchParams.get('error')).toBe(error);
    expect(location.searchParams.get('code')).toBeNull();
    // The state comes back with the error when it was sent.
    if (overrides.state !== null) expect(location.searchParams.get('state')).toBe('state-1');
  });

  it('accepts prompt=login and prompt=select_account and records what was asked', async () => {
    const t = setup();
    for (const prompt of ['login', 'select_account']) {
      expect(
        (await send('GET', authorizeUrl(t.tenant, { client_id: t.app.appId, prompt }))).status,
      ).toBe(302);
    }
    const asked = t.entra.control.authorizeRequests();
    expect(asked.map((request) => request.prompt)).toEqual(['login', 'select_account']);
    expect(asked[0]).toMatchObject({
      clientId: t.app.appId,
      redirectUri: CALLBACK,
      scope: 'openid profile',
      responseMode: 'query',
      codeChallengeMethod: 'S256',
    });
    expect(asked[0]?.extraParameters).toEqual([]);
  });

  it('records parameters the product must not send (max_age, claims, login_hint, offline_access)', async () => {
    const t = setup();
    await send(
      'GET',
      authorizeUrl(t.tenant, {
        client_id: t.app.appId,
        max_age: '0',
        claims: '{}',
        login_hint: 'x@y',
        scope: 'openid profile offline_access',
      }),
    );
    const [request] = t.entra.control.authorizeRequests();
    expect(request?.extraParameters.sort()).toEqual(['claims', 'login_hint', 'max_age']);
    expect(request?.scope).toContain('offline_access');
  });

  it('refuses a request that is not for a concrete tenant (the panel uses {tid})', async () => {
    const t = setup();
    for (const authority of ['common', 'organizations', 'consumers']) {
      const url = authorizeUrl(authority, { client_id: t.app.appId });
      expect((await send('GET', url)).status, authority).toBe(400);
    }
  });

  it('answers prompt=none with login_required (there is no session in the fake)', async () => {
    const t = setup();
    const answer = await send(
      'GET',
      authorizeUrl(t.tenant, { client_id: t.app.appId, prompt: 'none' }),
    );
    expect(new URL(answer.headers.get('location') ?? '').searchParams.get('error')).toBe(
      'login_required',
    );
  });

  it('nextSignIn.authorizeError redirects the chosen error with the state', async () => {
    const t = setup();
    t.entra.control.nextSignIn({
      authorizeError: { error: 'invalid_request', description: HOSTILE_DESCRIPTION },
    });
    const answer = await send('GET', authorizeUrl(t.tenant, { client_id: t.app.appId }));
    const location = new URL(answer.headers.get('location') ?? '');
    expect(location.searchParams.get('error')).toBe('invalid_request');
    expect(location.searchParams.get('error_description')?.length).toBeGreaterThan(5_000);
    expect(location.searchParams.get('state')).toBe('state-1');
  });

  it.each([
    [65001, 'consent_required'],
    [90093, 'access_denied'],
    [90094, 'access_denied'],
    [50105, 'access_denied'],
  ] as const)(
    'AADSTS%s is carried at the start of error_description (the product extracts it)',
    async (aadsts, error) => {
      const t = setup();
      t.entra.control.nextSignIn({ authorizeError: { error, aadsts } });
      const answer = await send('GET', authorizeUrl(t.tenant, { client_id: t.app.appId }));
      const location = new URL(answer.headers.get('location') ?? '');
      expect(location.searchParams.get('error_description')).toMatch(
        new RegExp(`^AADSTS${String(aadsts)}: `),
      );
    },
  );

  it('answers access_denied for a user who is disabled or gone', async () => {
    const t = setup();
    t.entra.control.nextSignIn({ user: t.user.id });
    const record = t.graph.directory.users.get(t.user.id);
    if (record !== undefined) record.accountEnabled = false;
    const disabled = await send('GET', authorizeUrl(t.tenant, { client_id: t.app.appId }));
    expect(new URL(disabled.headers.get('location') ?? '').searchParams.get('error')).toBe(
      'access_denied',
    );
    t.graph.directory.users.delete(t.user.id);
    t.entra.control.nextSignIn({ user: t.user.id });
    const gone = await send('GET', authorizeUrl(t.tenant, { client_id: t.app.appId }));
    expect(new URL(gone.headers.get('location') ?? '').searchParams.get('error')).toBe(
      'access_denied',
    );
  });

  it('throws (fails the test) when no sign-in was configured, instead of inventing a user', async () => {
    const graph = installFakeGraph(fake);
    installFakeEntra(fake, graph.world);
    const app = seedApplication(graph.world, { redirectUris: [CALLBACK] });
    // Straight into the fake: through MSW a thrown error would come back as a 500 page.
    await expect(
      fake.fetch(new Request(authorizeUrl(graph.directory.tenantId, { client_id: app.appId }))),
    ).rejects.toThrow(/no sign-in is configured/);
  });
});

// ---------------------------------------------------------------------------------------------
describe('POST /token, authorization_code (v2-oauth2-auth-code-flow, certificate-credentials)', () => {
  it('returns an ID token signed with the current key and an opaque access token, no refresh token', async () => {
    const t = setup();
    const answer = await redeem(t, await authorizeCode(t));
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ token_type: 'Bearer', scope: 'openid profile' });
    expect(answer.body.refresh_token).toBeUndefined();
    expect(String(answer.body.access_token)).not.toContain('.');
    expect(answer.headers.get('cache-control')).toBe('no-store');

    const token = idTokenOf(answer);
    expect(token.header).toMatchObject({ alg: 'RS256', typ: 'JWT' });
    expect(token.payload).toMatchObject({
      iss: `${LOGIN}/${t.tenant}/v2.0`,
      aud: t.app.appId,
      tid: t.tenant,
      oid: t.user.id,
      ver: '2.0',
      nonce: 'nonce-1',
      preferred_username: 'alice@contoso-fake.example',
      amr: ['pwd', 'mfa'],
    });
    expect(typeof token.payload.sub).toBe('string');
    expect(token.payload.sub).not.toBe(t.user.id);
    const nowSeconds = testClock.nowMs() / 1000;
    expect(token.payload.iat).toBe(nowSeconds);
    expect(token.payload.nbf).toBe(nowSeconds);
    expect(token.payload.exp).toBe(nowSeconds + 3600);

    const keys = (await send('GET', `${LOGIN}/${t.tenant}/discovery/v2.0/keys`)).body.keys as {
      kid: string;
    }[] &
      JsonWebKey[];
    const key = keys.find((candidate) => candidate.kid === token.header.kid);
    expect(key).toBeDefined();
    const publicKey = createPublicKey({ key: key as JsonWebKey, format: 'jwk' });
    expect(verifyRs256(token.input, token.signature, publicKey)).toBe(true);
  });

  it('honours offline_access by adding a refresh token (the product must discard it)', async () => {
    const t = setup();
    const code = await authorizeCode(t, { scope: 'openid profile offline_access' });
    const answer = await redeem(t, code, { scope: 'openid profile offline_access' });
    expect(typeof answer.body.refresh_token).toBe('string');
  });

  it('is single use and valid for 60 seconds', async () => {
    const t = setup();
    const code = await authorizeCode(t);
    expect((await redeem(t, code)).status).toBe(200);
    const again = await redeem(t, code);
    expect(again.status).toBe(400);
    expect(again.body.error).toBe('invalid_grant');

    const late = await authorizeCode(t);
    testClock.advance(60_001);
    expect((await redeem(t, late)).body.error).toBe('invalid_grant');

    const inTime = await authorizeCode(t);
    testClock.advance(59_000);
    expect((await redeem(t, inTime)).status).toBe(200);
  });

  it('checks PKCE: a wrong, missing or malformed verifier is invalid_grant', async () => {
    const t = setup();
    for (const verifier of ['b'.repeat(43), null, 'a'.repeat(42), `${'a'.repeat(42)} `]) {
      const answer = await redeem(t, await authorizeCode(t), { code_verifier: verifier });
      expect(answer.body.error, String(verifier)).toBe('invalid_grant');
    }
  });

  it('requires the redirect_uri of the authorize request, exactly', async () => {
    const t = setup();
    const answer = await redeem(t, await authorizeCode(t), { redirect_uri: LOGGED_OUT });
    expect(answer.body.error).toBe('invalid_grant');
    const missing = await redeem(t, await authorizeCode(t), { redirect_uri: null });
    expect(missing.body.error).toBe('invalid_request');
  });

  it('binds the code to the client that asked for it', async () => {
    const t = setup();
    const other = seedApplication(t.graph.world, { redirectUris: [CALLBACK] });
    const code = await authorizeCode(t);
    const answer = await redeem(t, code, {
      client_id: other.appId,
      client_assertion: buildClientAssertion({
        certificate: other.certificate,
        clientId: other.appId,
        tenant: t.tenant,
        nowMs: testClock.nowMs(),
        jti: 'other-1',
      }),
    });
    expect(answer.body.error).toBe('invalid_grant');
  });

  it('refuses scopes that are not OIDC scopes, and unknown grant types', async () => {
    const t = setup();
    const scope = await redeem(t, await authorizeCode(t), {
      scope: 'https://graph.microsoft.com/User.Read',
    });
    expect(scope.body.error).toBe('invalid_scope');
    const grant = await redeem(t, 'x', { grant_type: 'password' });
    expect(grant.body.error).toBe('unsupported_grant_type');
  });

  it('refuses a token request that is not form encoded', async () => {
    const t = setup();
    const answer = await send('POST', `${LOGIN}/${t.tenant}/oauth2/v2.0/token`, {
      text: '{"grant_type":"authorization_code"}',
      headers: { 'content-type': 'application/json' },
    });
    expect(answer.status).toBe(400);
    expect(answer.body.error).toBe('invalid_request');
  });

  it('refuses client credentials sent with an Origin header (Learn: not from a browser)', async () => {
    const t = setup();
    const answer = await redeem(t, await authorizeCode(t), {}, { origin: 'https://panel.example' });
    expect(answer.status).toBe(400);
    expect(t.entra.control.assertionRejections()).toEqual(['origin_header']);
  });

  it('refuses a request without any client authentication, or with a secret instead of a certificate', async () => {
    const t = setup();
    const none = await redeem(t, await authorizeCode(t), {
      client_assertion: null,
      client_assertion_type: null,
    });
    expect(none.body.error).toBe('invalid_client');
    const secret = await redeem(t, await authorizeCode(t), {
      client_assertion: null,
      client_assertion_type: null,
      client_secret: 'secret',
    });
    expect(secret.body.error).toBe('invalid_client');
    const type = await redeem(t, await authorizeCode(t), { client_assertion_type: 'jwt' });
    expect(type.body.error).toBe('invalid_client');
  });

  it('records the token requests with credentials replaced by markers', async () => {
    const t = setup();
    await redeem(t, await authorizeCode(t));
    const [request] = t.entra.control.tokenRequests();
    expect(request).toMatchObject({
      grantType: 'authorization_code',
      hasOrigin: false,
      contentType: 'application/x-www-form-urlencoded',
    });
    expect(request?.fields.client_assertion).toBe('[present]');
    expect(request?.fields.code).toBe('[present]');
    expect(request?.fields.code_verifier).toBe('[present]');
    expect(request?.fields.redirect_uri).toBe(CALLBACK);
    expect(request?.fields.scope).toBe('openid profile');
  });
});

// ---------------------------------------------------------------------------------------------
describe('client assertion, as Learn describes it (certificate-credentials; + negative)', () => {
  async function attempt(
    t: ReturnType<typeof setup>,
    options: Partial<Parameters<typeof buildClientAssertion>[0]>,
  ): Promise<Answer> {
    return redeem(t, await authorizeCode(t), { client_assertion: assertionFor(t, options) });
  }

  it('accepts the assertion Learn describes', async () => {
    const t = setup();
    expect((await attempt(t, {})).status).toBe(200);
    expect(t.entra.control.assertionRejections()).toEqual([]);
  });

  it('accepts the optional x5t header when it matches the registered SHA-1 thumbprint', async () => {
    const t = setup();
    expect((await attempt(t, { includeX5t: true })).status).toBe(200);
  });

  const CASES: readonly [string, Partial<Parameters<typeof buildClientAssertion>[0]>, string][] = [
    ['without x5t#S256', { omitHeader: ['x5t#S256'] }, 'missing_x5t_s256'],
    [
      'with only the SHA-1 x5t header',
      { omitHeader: ['x5t#S256'], includeX5t: true },
      'missing_x5t_s256',
    ],
    ['x5t#S256 of another certificate', { header: { 'x5t#S256': 'AAAA' } }, 'unknown_certificate'],
    ['a wrong x5t next to a right x5t#S256', { header: { x5t: 'AAAA' } }, 'x5t_mismatch'],
    ['alg RS256', { alg: 'RS256' }, 'bad_alg'],
    ['alg none', { alg: 'none' }, 'bad_alg'],
    ['no typ', { omitHeader: ['typ'] }, 'bad_typ'],
    ['typ other than JWT', { header: { typ: 'JOSE' } }, 'bad_typ'],
    ['iss other than the client id', { claims: { iss: 'someone' } }, 'bad_iss'],
    ['sub other than the client id', { claims: { sub: 'someone' } }, 'bad_sub'],
    [
      'aud of another tenant',
      { claims: { aud: `${LOGIN}/33333333-4444-4555-8666-777777777777/oauth2/v2.0/token` } },
      'bad_aud',
    ],
    ['aud that is the v1 endpoint', { claims: { aud: `${LOGIN}/oauth2/token` } }, 'bad_aud'],
    ['aud as an array', { arrayAudience: true }, 'bad_aud'],
    ['no jti', { omitClaims: ['jti'] }, 'missing_jti'],
    ['an empty jti', { claims: { jti: '' } }, 'missing_jti'],
    ['no nbf', { omitClaims: ['nbf'] }, 'missing_nbf'],
    ['no exp', { omitClaims: ['exp'] }, 'missing_exp'],
    ['nbf in the future', { timing: { nbf: 120, exp: 420 } }, 'not_yet_valid'],
    ['exp in the past', { timing: { nbf: -600, exp: -1 } }, 'expired'],
    ['exp more than 10 minutes after nbf', { timing: { nbf: 0, exp: 601 } }, 'lifetime_too_long'],
    ['a signature from another key', { signWithOtherKey: true }, 'bad_signature'],
  ];
  it.each(CASES)('refuses an assertion %s', async (_name, options, reason) => {
    const t = setup();
    const answer = await attempt(t, options);
    expect(answer.status).toBe(400);
    expect(answer.body.error).toBe('invalid_client');
    expect(t.entra.control.assertionRejections()).toEqual([reason]);
  });

  it('accepts exp exactly 10 minutes after nbf and refuses 601 seconds', async () => {
    const t = setup();
    expect((await attempt(t, { timing: { nbf: 0, exp: 600 } })).status).toBe(200);
  });

  it('refuses a reused jti, also from a retry of the same assertion', async () => {
    const t = setup();
    const assertion = assertionFor(t, { jti: 'same-jti' });
    expect((await redeem(t, await authorizeCode(t), { client_assertion: assertion })).status).toBe(
      200,
    );
    const second = await redeem(t, await authorizeCode(t), { client_assertion: assertion });
    expect(second.body.error).toBe('invalid_client');
    expect(t.entra.control.assertionRejections()).toEqual(['jti_reused']);
  });

  it('refuses a malformed assertion with the documented invalid-signature symptom', async () => {
    const t = setup();
    for (const broken of ['a.b', 'not a jwt', 'a.b.c.d', '..']) {
      const answer = await redeem(t, await authorizeCode(t), { client_assertion: broken });
      expect(answer.body.error, broken).toBe('invalid_client');
      expect(String(answer.body.error_description)).toMatch(/^AADSTS700027: /);
    }
  });

  it('refuses a certificate that is not registered on the application, or that has expired', async () => {
    const t = setup();
    const credential = t.graph.directory.applications.get(t.app.objectId)?.keyCredentials[0];
    expect(credential).toBeDefined();
    if (credential === undefined) return;
    credential.endDateTime = new Date(testClock.nowMs() - 1000).toISOString();
    const expired = await attempt(t, {});
    expect(expired.body.error).toBe('invalid_client');
    expect(t.entra.control.assertionRejections()).toEqual(['certificate_expired']);

    const t2 = setup();
    const stripped = t2.graph.directory.applications.get(t2.app.objectId);
    if (stripped !== undefined) stripped.keyCredentials.length = 0;
    expect((await attempt(t2, {})).body.error).toBe('invalid_client');
  });

  it('uses the certificates registered NOW, so a PATCH of keyCredentials takes effect at once', async () => {
    const t = setup();
    const application = t.graph.directory.applications.get(t.app.objectId);
    const saved = application?.keyCredentials ?? [];
    if (application !== undefined) application.keyCredentials = [];
    expect((await attempt(t, {})).status).toBe(400);
    if (application !== undefined) application.keyCredentials = saved;
    expect((await attempt(t, {})).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------
describe('sign-in variants for the fixtures F-01 to F-45 (nextSignIn)', () => {
  async function mint(t: ReturnType<typeof setup>, spec: SignInSpec): Promise<Answer> {
    t.entra.control.nextSignIn(spec);
    return redeem(t, await authorizeCode(t));
  }

  it('amr variants: absent, a string, lists', async () => {
    const t = setup();
    expect(idTokenOf(await mint(t, { omitClaims: ['amr'] })).payload.amr).toBeUndefined();
    expect(idTokenOf(await mint(t, { claims: { amr: 'mfa' } })).payload.amr).toBe('mfa');
    expect(idTokenOf(await mint(t, { claims: { amr: ['ngcmfa'] } })).payload.amr).toEqual([
      'ngcmfa',
    ]);
  });

  it('timing offsets move exp, nbf and iat', async () => {
    const t = setup();
    const token = idTokenOf(await mint(t, { timing: { exp: -61, nbf: 61, iat: 120 } }));
    const now = testClock.nowMs() / 1000;
    expect(token.payload).toMatchObject({ exp: now - 61, nbf: now + 61, iat: now + 120 });
  });

  it('nonce: echo by default, a replacement, or none', async () => {
    const t = setup();
    expect(idTokenOf(await mint(t, {})).payload.nonce).toBe('nonce-1');
    expect(idTokenOf(await mint(t, { nonce: 'other' })).payload.nonce).toBe('other');
    expect('nonce' in idTokenOf(await mint(t, { nonce: null })).payload).toBe(false);
  });

  it('claims, wids, groups and header parameters can be set; others can be removed', async () => {
    const t = setup();
    const token = idTokenOf(
      await mint(t, {
        claims: {
          wids: ['62e90394-69f5-4237-9190-012177145e10'],
          groups: Array.from({ length: 250 }, (_, i) => `g${String(i)}`),
          _claim_names: { groups: 'src1' },
          hasgroups: true,
          ver: '1.0',
        },
        omitClaims: ['oid'],
        header: { jku: 'https://evil.example/keys', crit: ['x'] },
        omitHeader: ['typ'],
      }),
    );
    expect(token.payload.wids).toHaveLength(1);
    expect(token.payload.groups).toHaveLength(250);
    expect(token.payload.ver).toBe('1.0');
    expect('oid' in token.payload).toBe(false);
    expect(token.header.jku).toBe('https://evil.example/keys');
    expect('typ' in token.header).toBe(false);
  });

  it('issuerTenant: a token of a foreign tenant is signed by that tenant key set', async () => {
    const t = setup();
    const foreign = '44444444-5555-4666-8777-888888888888';
    t.entra.control.addTenant(foreign);
    const token = idTokenOf(await mint(t, { issuerTenant: foreign }));
    expect(token.payload.tid).toBe(foreign);
    expect(token.payload.iss).toBe(`${LOGIN}/${foreign}/v2.0`);
    const keys = (await send('GET', `${LOGIN}/${foreign}/discovery/v2.0/keys`)).body.keys as {
      kid: string;
    }[] &
      JsonWebKey[];
    const key = keys.find((candidate) => candidate.kid === token.header.kid);
    expect(key).toBeDefined();
    expect(
      verifyRs256(
        token.input,
        token.signature,
        createPublicKey({ key: key as JsonWebKey, format: 'jwk' }),
      ),
    ).toBe(true);
  });

  it('signers: attacker (own kid), attacker with a real kid, none, HS256 with the public key, PS256, RS384, ES256, old key', async () => {
    const t = setup();
    const ownKeys = (await send('GET', `${LOGIN}/${t.tenant}/discovery/v2.0/keys`)).body.keys as {
      kid: string;
    }[] &
      JsonWebKey[];
    const realKid = ownKeys[0]?.kid;
    const realKey = createPublicKey({ key: ownKeys[0] as JsonWebKey, format: 'jwk' });

    const attackerOwn = idTokenOf(await mint(t, { signer: 'attacker' }));
    expect(attackerOwn.header.kid).not.toBe(realKid);
    expect(verifyRs256(attackerOwn.input, attackerOwn.signature, realKey)).toBe(false);

    const attackerReal = idTokenOf(await mint(t, { signer: 'attacker-real-kid' }));
    expect(attackerReal.header.kid).toBe(realKid);
    expect(verifyRs256(attackerReal.input, attackerReal.signature, realKey)).toBe(false);

    const unsigned = idTokenOf(await mint(t, { signer: 'none' }));
    expect(unsigned.header.alg).toBe('none');
    expect(unsigned.signature).toBe('');

    const hmac = idTokenOf(await mint(t, { signer: 'hs256-public-key' }));
    expect(hmac.header.alg).toBe('HS256');
    expect(hmac.signature.length).toBeGreaterThan(10);

    for (const [signer, alg] of [
      ['ps256', 'PS256'],
      ['rs384', 'RS384'],
      ['es256', 'ES256'],
    ] as const) {
      const token = idTokenOf(await mint(t, { signer }));
      expect(token.header.alg).toBe(alg);
      expect(token.header.kid).toBe(realKid);
    }

    const added = t.entra.control.rotateKeys();
    expect(idTokenOf(await mint(t, {})).header.kid).toBe(added);
    expect(idTokenOf(await mint(t, { signer: 'old' })).header.kid).toBe(realKid);
  });

  it('padBytes makes the token at least that long (F-25)', async () => {
    const t = setup();
    const answer = await mint(t, { padBytes: 9_000 });
    expect(String(answer.body.id_token).length).toBeGreaterThan(9_000);
  });

  it('rawIdToken replaces the whole token (F-26)', async () => {
    const t = setup();
    for (const raw of [
      'a.b',
      'ÿ.ÿ.ÿ',
      `${Buffer.from('[]').toString('base64url')}.${Buffer.from('[]').toString('base64url')}.x`,
    ]) {
      expect((await mint(t, { rawIdToken: raw })).body.id_token).toBe(raw);
    }
  });

  it('is queued: each authorize takes the next spec, then the default', async () => {
    const t = setup();
    t.entra.control.nextSignIn({ claims: { name: 'first' } });
    t.entra.control.nextSignIn({ claims: { name: 'second' } });
    const names: unknown[] = [];
    for (let i = 0; i < 3; i += 1) {
      names.push(idTokenOf(await redeem(t, await authorizeCode(t))).payload.name);
    }
    expect(names).toEqual(['first', 'second', 'alice']);
  });

  it('keeps the user of the spec: a guest of the pinned tenant is an ordinary user', async () => {
    const t = setup();
    const guest = t.graph.directory.addUser({
      userPrincipalName: 'guest_ext#EXT#@contoso-fake.onmicrosoft.com',
      displayName: 'Guest',
    });
    const token = idTokenOf(await mint(t, { user: guest.id }));
    expect(token.payload.oid).toBe(guest.id);
    expect(token.payload.tid).toBe(t.tenant);
  });
});

// ---------------------------------------------------------------------------------------------
describe('token endpoint faults (F-37 to F-41)', () => {
  it('answers invalid_grant / invalid_client / temporarily_unavailable / 503 for N requests, then works', async () => {
    const t = setup();
    t.entra.control.failToken({
      grant: 'authorization_code',
      times: 1,
      answer: { status: 400, error: 'temporarily_unavailable' },
    });
    const code = await authorizeCode(t);
    const first = await redeem(t, code);
    expect(first.status).toBe(400);
    expect(first.body.error).toBe('temporarily_unavailable');
    // The code was not used up by the failed attempt.
    expect((await redeem(t, code)).status).toBe(200);

    t.entra.control.failToken({ times: 2, answer: { status: 503 } });
    const c2 = await authorizeCode(t);
    expect((await redeem(t, c2)).status).toBe(503);
    expect((await redeem(t, c2)).status).toBe(503);
    expect((await redeem(t, c2)).status).toBe(200);

    t.entra.control.failToken({
      times: 1,
      answer: { status: 400, error: 'invalid_client', aadsts: 700027 },
    });
    const bad = await redeem(t, await authorizeCode(t));
    expect(bad.body.error).toBe('invalid_client');
    expect(String(bad.body.error_description)).toMatch(/^AADSTS700027: /);
  });

  it('can hang (the product times out through its own scheduler)', async () => {
    const t = setup();
    t.entra.control.failToken({ times: 1, answer: 'hang' });
    const code = await authorizeCode(t);
    const pending = redeem(t, code);
    const outcome = await Promise.race([
      pending.then(() => 'answered'),
      new Promise<string>((resolve) =>
        setImmediate(() => {
          resolve('still waiting');
        }),
      ),
    ]);
    expect(outcome).toBe('still waiting');
  });
});

// ---------------------------------------------------------------------------------------------
describe('client_credentials (v2-oauth2-client-creds-grant-flow; research section 4)', () => {
  async function appToken(
    t: ReturnType<typeof setup>,
    scope: string,
    extra: Record<string, string | null> = {},
  ): Promise<Answer> {
    const form: Record<string, string> = {
      client_id: t.app.appId,
      grant_type: 'client_credentials',
      scope,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: assertionFor(t),
    };
    for (const [name, value] of Object.entries(extra)) {
      if (value === null) Reflect.deleteProperty(form, name);
      else form[name] = value;
    }
    return send('POST', `${LOGIN}/${t.tenant}/oauth2/v2.0/token`, { form });
  }

  it('issues an opaque token that snapshots the grants at issue time', async () => {
    const t = setup();
    const early = await appToken(t, 'https://graph.microsoft.com/.default');
    expect(early.status).toBe(200);
    expect(early.body).toMatchObject({ token_type: 'Bearer', expires_in: 3600 });
    expect(String(early.body.access_token)).not.toContain('.');
    expect(early.body.id_token).toBeUndefined();
    expect(early.body.refresh_token).toBeUndefined();

    t.app.grantGraphRole('User.Read.All');
    const late = await appToken(t, 'https://graph.microsoft.com/.default');
    const earlyRecord = t.graph.world.tokens.lookup(String(early.body.access_token));
    const lateRecord = t.graph.world.tokens.lookup(String(late.body.access_token));
    expect(earlyRecord?.roles).toEqual([]);
    expect(lateRecord?.roles).toEqual(['User.Read.All']);
    expect(lateRecord).toMatchObject({ kind: 'app', audience: 'graph', appId: t.app.appId });
  });

  it('issues an Exchange token for the Exchange scope', async () => {
    const t = setup();
    const answer = await appToken(t, 'https://outlook.office365.com/.default');
    expect(t.graph.world.tokens.lookup(String(answer.body.access_token))?.audience).toBe(
      'exchange',
    );
  });

  it.each([
    ['a scope that is not .default', 'https://graph.microsoft.com/User.Read.All'],
    ['an unknown resource', 'https://example.com/.default'],
    [
      'two resources',
      'https://graph.microsoft.com/.default https://outlook.office365.com/.default',
    ],
    ['an OIDC scope', 'openid https://graph.microsoft.com/.default'],
    ['no scope', ''],
  ])('refuses %s', async (_name, scope) => {
    const t = setup();
    const answer = await appToken(t, scope, scope === '' ? { scope: null } : {});
    expect(answer.status).toBe(400);
    expect(['invalid_scope', 'invalid_request']).toContain(answer.body.error);
  });

  it('applies the same assertion rule (x5t#S256) and refuses an application without a service principal', async () => {
    const t = setup();
    const answer = await appToken(t, 'https://graph.microsoft.com/.default', {
      client_assertion: assertionFor(t, { omitHeader: ['x5t#S256'] }),
    });
    expect(answer.body.error).toBe('invalid_client');
    expect(t.entra.control.assertionRejections()).toEqual(['missing_x5t_s256']);

    const bare = seedApplication(t.graph.world, { redirectUris: [], servicePrincipal: false });
    const noSp = await send('POST', `${LOGIN}/${t.tenant}/oauth2/v2.0/token`, {
      form: {
        client_id: bare.appId,
        grant_type: 'client_credentials',
        scope: 'https://graph.microsoft.com/.default',
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: buildClientAssertion({
          certificate: bare.certificate,
          clientId: bare.appId,
          tenant: t.tenant,
          nowMs: testClock.nowMs(),
          jti: 'bare-1',
        }),
      },
    });
    expect(noSp.body.error).toBe('invalid_client');
  });

  it('refuses client credentials with an Origin header', async () => {
    const t = setup();
    const response = await send('POST', `${LOGIN}/${t.tenant}/oauth2/v2.0/token`, {
      form: {
        client_id: t.app.appId,
        grant_type: 'client_credentials',
        scope: 'https://graph.microsoft.com/.default',
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: assertionFor(t),
      },
      headers: { origin: 'https://panel.example' },
    });
    expect(response.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------------------------
describe('device code (v2-oauth2-device-code; V-B13, SB-10)', () => {
  async function start(
    _t: ReturnType<typeof setup>,
    form: Record<string, string> = {},
    tenant = 'organizations',
  ): Promise<Answer> {
    return send('POST', `${LOGIN}/${tenant}/oauth2/v2.0/devicecode`, {
      form: { client_id: BOOTSTRAP_CLIENT, scope: GRAPH_SCOPES.join(' '), ...form },
    });
  }
  async function poll(
    _t: ReturnType<typeof setup>,
    deviceCode: string,
    grantType = 'urn:ietf:params:oauth:grant-type:device_code',
    tenant = 'organizations',
  ): Promise<Answer> {
    return send('POST', `${LOGIN}/${tenant}/oauth2/v2.0/token`, {
      form: { client_id: BOOTSTRAP_CLIENT, grant_type: grantType, device_code: deviceCode },
    });
  }

  it('returns the documented fields: no verification_uri_complete, 900 s, interval 5', async () => {
    const t = setup();
    const answer = await start(t);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      verification_uri: 'https://login.microsoft.com/device',
      expires_in: 900,
      interval: 5,
    });
    expect(String(answer.body.user_code)).toMatch(/^[A-Z0-9]{9}$/);
    expect(typeof answer.body.device_code).toBe('string');
    expect(String(answer.body.message)).toContain(DEVICE_MESSAGE_CANARY);
    expect(answer.body.verification_uri_complete).toBeUndefined();
    expect(answer.headers.get('cache-control')).toBe('no-store');
    expect(t.entra.control.device.requestedScopes()).toEqual([GRAPH_SCOPES]);
  });

  it('scales the interval for a test and can return another verification host', async () => {
    const t = setup();
    t.entra.control.device.interval(1);
    t.entra.control.device.verificationUri('javascript:alert(1)');
    const answer = await start(t);
    expect(answer.body.interval).toBe(1);
    expect(answer.body.verification_uri).toBe('javascript:alert(1)');
  });

  it('is pending until the user signs in, then issues tokens for both grant spellings', async () => {
    const t = setup();
    const flow = await start(t);
    const code = String(flow.body.device_code);
    const pending = await poll(t, code);
    expect(pending.status).toBe(400);
    expect(pending.body.error).toBe('authorization_pending');

    t.entra.control.device.approve({ user: t.user.id });
    for (const grant of ['urn:ietf:params:oauth:grant-type:device_code', 'device_code']) {
      const done = await poll(t, code, grant);
      expect(done.status, grant).toBe(200);
      expect(typeof done.body.refresh_token).toBe('string');
      const record = t.graph.world.tokens.lookup(String(done.body.access_token));
      expect(record).toMatchObject({ kind: 'delegated', audience: 'graph', userId: t.user.id });
      expect(record?.scopes).toEqual([
        'Application.ReadWrite.All',
        'AppRoleAssignment.ReadWrite.All',
        'RoleManagement.ReadWrite.Directory',
      ]);
      expect(record?.entraRoleTemplateIds).toEqual(['62e90394-69f5-4237-9190-012177145e10']);
      const id = parseCompact(String(done.body.id_token));
      expect(id?.payload).toMatchObject({ oid: t.user.id, tid: t.tenant, aud: BOOTSTRAP_CLIENT });
    }
  });

  it('the approved user can carry other Entra roles', async () => {
    const t = setup();
    const flow = await start(t);
    t.entra.control.device.approve({
      user: t.user.id,
      entraRoleTemplateIds: ['e8611ab8-c189-46e8-94e1-60213ab1f814'],
    });
    const done = await poll(t, String(flow.body.device_code));
    expect(
      t.graph.world.tokens.lookup(String(done.body.access_token))?.entraRoleTemplateIds,
    ).toEqual(['e8611ab8-c189-46e8-94e1-60213ab1f814']);
  });

  it.each([
    ['decline', 'authorization_declined'],
    ['expire', 'expired_token'],
    ['block', 'access_denied'],
  ] as const)('%s ends the flow with %s', async (action, error) => {
    const t = setup();
    const flow = await start(t);
    t.entra.control.device[action]();
    const answer = await poll(t, String(flow.body.device_code));
    expect(answer.status).toBe(400);
    expect(answer.body.error).toBe(error);
    if (action === 'block') expect(String(answer.body.error_description)).toMatch(/^AADSTS53003: /);
  });

  it('expires by the clock after 900 seconds', async () => {
    const t = setup();
    const flow = await start(t);
    testClock.advance(900_001);
    expect((await poll(t, String(flow.body.device_code))).body.error).toBe('expired_token');
  });

  it('answers bad_verification_code for a code it never issued', async () => {
    const t = setup();
    expect((await poll(t, 'not-a-device-code')).body.error).toBe('bad_verification_code');
  });

  it('slow_down and temporarily_unavailable are toggles that count down', async () => {
    const t = setup();
    const flow = await start(t);
    const code = String(flow.body.device_code);
    t.entra.control.device.slowDown(1);
    t.entra.control.device.temporarilyUnavailable(1);
    expect((await poll(t, code)).body.error).toBe('slow_down');
    expect((await poll(t, code)).body.error).toBe('temporarily_unavailable');
    expect((await poll(t, code)).body.error).toBe('authorization_pending');
  });

  it('enforceInterval answers slow_down for a poll that comes sooner than the interval', async () => {
    const t = setup();
    t.entra.control.device.enforceInterval(true);
    const code = String((await start(t)).body.device_code);
    expect((await poll(t, code)).body.error).toBe('authorization_pending');
    expect((await poll(t, code)).body.error).toBe('slow_down');
    testClock.advance(10_000);
    expect((await poll(t, code)).body.error).toBe('authorization_pending');
  });

  it('refuses a device code request without a client id, scope, or with a secret', async () => {
    const t = setup();
    expect((await start(t, { client_id: '' })).status).toBe(400);
    expect((await start(t, { scope: '' })).status).toBe(400);
    expect((await start(t, { client_id: 'not-a-guid' })).status).toBe(400);
    expect((await start(t, { client_secret: 'x' })).status).toBe(400);
    expect((await start(t, { client_assertion: 'x' })).status).toBe(400);
  });

  it('accepts the OIDC scopes MSAL adds, and refuses a scope it does not know', async () => {
    const t = setup();
    const withOidc = await start(t, {
      scope: [...GRAPH_SCOPES, 'openid', 'profile', 'offline_access'].join(' '),
    });
    expect(withOidc.status).toBe(200);
    const unknown = await start(t, { scope: 'https://graph.microsoft.com/Nope.All' });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toBe('invalid_scope');
  });

  it('refuses a poll with a credential (a public client) and a poll for another client id', async () => {
    const t = setup();
    const code = String((await start(t)).body.device_code);
    const credential = await send('POST', `${LOGIN}/organizations/oauth2/v2.0/token`, {
      form: {
        client_id: BOOTSTRAP_CLIENT,
        grant_type: 'device_code',
        device_code: code,
        client_assertion: 'x',
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      },
    });
    expect(credential.status).toBe(400);
    const other = await send('POST', `${LOGIN}/organizations/oauth2/v2.0/token`, {
      form: {
        client_id: '55555555-6666-4777-8888-999999999999',
        grant_type: 'device_code',
        device_code: code,
      },
    });
    expect(other.body.error).toBe('bad_verification_code');
  });

  it('refreshes: the refresh grant returns a new access token that snapshots the user roles again', async () => {
    const t = setup();
    const flow = await start(t);
    t.entra.control.device.approve({ user: t.user.id });
    const done = await poll(t, String(flow.body.device_code));
    const refreshed = await send('POST', `${LOGIN}/organizations/oauth2/v2.0/token`, {
      form: {
        client_id: BOOTSTRAP_CLIENT,
        grant_type: 'refresh_token',
        refresh_token: String(done.body.refresh_token),
        scope: GRAPH_SCOPES.join(' '),
      },
    });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.access_token).not.toBe(done.body.access_token);
    expect(typeof refreshed.body.refresh_token).toBe('string');
    const bad = await send('POST', `${LOGIN}/organizations/oauth2/v2.0/token`, {
      form: {
        client_id: BOOTSTRAP_CLIENT,
        grant_type: 'refresh_token',
        refresh_token: 'nope',
      },
    });
    expect(bad.body.error).toBe('invalid_grant');
  });

  it('serves the device grant on the pinned tenant path as well', async () => {
    const t = setup();
    const flow = await start(t, {}, t.tenant);
    t.entra.control.device.approve({ user: t.user.id });
    expect((await poll(t, String(flow.body.device_code), 'device_code', t.tenant)).status).toBe(
      200,
    );
  });
});

// ---------------------------------------------------------------------------------------------
describe('logout (v2-protocols-oidc, "Send a sign-out request")', () => {
  it('redirects to a registered post_logout_redirect_uri and records the sign-out', async () => {
    const t = setup();
    const answer = await send(
      'GET',
      `${LOGIN}/${t.tenant}/oauth2/v2.0/logout?${new URLSearchParams({ post_logout_redirect_uri: LOGGED_OUT }).toString()}`,
    );
    expect(answer.status).toBe(302);
    expect(answer.headers.get('location')).toBe(LOGGED_OUT);
    expect(t.entra.control.logouts()).toEqual([
      { tenantId: t.tenant, postLogoutRedirectUri: LOGGED_OUT, redirected: true },
    ]);
  });

  it('does not redirect to a URI that is not registered, and does not fail either', async () => {
    const t = setup();
    for (const uri of ['https://evil.example/', 'https://panel.example/other', '']) {
      const answer = await send(
        'GET',
        `${LOGIN}/${t.tenant}/oauth2/v2.0/logout?${new URLSearchParams({ post_logout_redirect_uri: uri }).toString()}`,
      );
      expect(answer.status, uri).toBe(200);
      expect(answer.headers.get('location'), uri).toBeNull();
    }
    expect(t.entra.control.logouts().every((entry) => !entry.redirected)).toBe(true);
  });

  it('answers a plain sign-out without a redirect URI, by GET and by POST', async () => {
    const t = setup();
    expect((await send('GET', `${LOGIN}/${t.tenant}/oauth2/v2.0/logout`)).status).toBe(200);
    expect(
      (await send('POST', `${LOGIN}/${t.tenant}/oauth2/v2.0/logout`, { text: '' })).status,
    ).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------
describe('structure', () => {
  it('serves only the documented Entra routes (an unknown path is the core 404)', async () => {
    const t = setup();
    for (const path of [
      `/${t.tenant}/oauth2/token`,
      `/${t.tenant}/oauth2/v2.0/userinfo`,
      `/${t.tenant}/v2.0/.well-known/openid-configuration/extra`,
      `/${t.tenant}/discovery/keys`,
    ]) {
      expect((await send('GET', `${LOGIN}${path}`)).status, path).toBe(404);
    }
  });

  it('reset() of a tenant with the module mounted for good restores one key, no toggles, no records', async () => {
    const clock = { now: () => testClock.nowMs() };
    const graph = createFakeGraph({ clock });
    const entra = createFakeEntra({ clock, world: graph.world });
    const own = createFakeTenant({ clock, modules: [graph.module, entra.module] });
    const app = seedApplication(graph.world, { redirectUris: [CALLBACK] });
    const user = graph.directory.addUser({ userPrincipalName: 'bob@contoso-fake.example' });
    entra.control.defaultSignIn({ user: user.id });
    entra.control.rotateKeys();
    entra.control.failKeys('unavailable');
    entra.control.device.interval(1);
    const answer = await own.fetch(
      new Request(authorizeUrl(graph.directory.tenantId, { client_id: app.appId })),
    );
    expect(answer.status).toBe(302);
    expect(entra.control.authorizeRequests()).toHaveLength(1);

    own.reset();
    expect(entra.control.keyIds()).toHaveLength(1);
    expect(entra.control.authorizeRequests()).toEqual([]);
    expect(entra.control.tokenRequests()).toEqual([]);
    const keys = await own.fetch(
      new Request(`${LOGIN}/${graph.directory.tenantId}/discovery/v2.0/keys`),
    );
    expect(keys.status).toBe(200);
    // The default sign-in is gone with the rest: an authorize without one is a failure of the test.
    graph.directory.addUser({ id: user.id, userPrincipalName: 'bob@contoso-fake.example' });
    const app2 = seedApplication(graph.world, { redirectUris: [CALLBACK] });
    await expect(
      own.fetch(new Request(authorizeUrl(graph.directory.tenantId, { client_id: app2.appId }))),
    ).rejects.toThrow();
  });

  it('keeps the key id out of the public key bytes (kid is derived, not the modulus)', async () => {
    const t = setup();
    const keys = (await send('GET', `${LOGIN}/${t.tenant}/discovery/v2.0/keys`)).body.keys as {
      kid: string;
      n: string;
    }[];
    expect(fromB64url(keys[0]?.kid ?? '').length).toBeGreaterThan(10);
    expect(keys[0]?.kid).not.toContain(keys[0]?.n.slice(0, 10) ?? '?');
  });
});

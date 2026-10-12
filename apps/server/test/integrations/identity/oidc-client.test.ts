// T-B-079, FR-B-402 (the request), FR-B-403 step 6, FR-B-410 (the URL), FR-B-418, FR-B-217 (+ negative):
// the sign-in client. Our own code-flow client and `jose`, no MSAL on this path (B-05, V-B04).
//
// Learn, https://learn.microsoft.com/entra/identity-platform/v2-oauth2-auth-code-flow: the authorize
// request, the code redemption with a certificate assertion, the error codes of the token endpoint;
// client credentials are refused when an `Origin` header is present.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { expectGuardFails } from '@m365portal/shared/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIdentityFetch } from '../../../src/integrations/identity/http.js';
import { createIdTokenValidator } from '../../../src/integrations/identity/id-token.js';
import { createKeySet } from '../../../src/integrations/identity/jwks.js';
import { createOidcClient } from '../../../src/integrations/identity/oidc-client.js';
import { createTenantMetadata } from '../../../src/integrations/identity/tenant-metadata.js';
import { createTokenEndpoint } from '../../../src/integrations/identity/token-endpoint.js';
import { IdTokenError, TokenEndpointError } from '../../../src/ports/errors.js';
import { fake, testClock } from '../../support/msw.js';
import { createTime, rejectionOf, sequenceRandom, settle, track } from '../support.js';
import { PANEL_CALLBACK, identityWorld, type IdentityWorld } from './support.js';

const SOURCE_DIRECTORY = fileURLToPath(
  new URL('../../../src/integrations/identity/', import.meta.url),
);
const VERIFIER = 'v'.repeat(43);
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
const STATE = 's'.repeat(43);
const NONCE = 'n'.repeat(43);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(testClock.nowMs());
});
afterEach(() => {
  vi.useRealTimers();
});

function clientFor(world: IdentityWorld) {
  const time = createTime();
  const jsonFetch = createIdentityFetch({ clock: time.clock, scheduler: time.scheduler });
  const metadata = createTenantMetadata({ tenantId: world.tenantId, jsonFetch, clock: time.clock });
  const keys = createKeySet({ metadata, jsonFetch, clock: time.clock, scheduler: time.scheduler });
  const tokenEndpoint = createTokenEndpoint({
    tenantId: world.tenantId,
    clientId: world.app.appId,
    redirectUri: PANEL_CALLBACK,
    signer: world.holder,
    jsonFetch,
    clock: time.clock,
    random: sequenceRandom(),
    scheduler: time.scheduler,
  });
  const client = createOidcClient({
    tenantId: world.tenantId,
    clientId: world.app.appId,
    redirectUri: PANEL_CALLBACK,
    metadata,
    tokenEndpoint,
    validator: createIdTokenValidator({
      tenantId: world.tenantId,
      clientId: world.app.appId,
      keys,
      clock: time.clock,
    }),
  });
  return { client, time };
}

async function authorize(_world: IdentityWorld, client: ReturnType<typeof clientFor>['client']) {
  const url = client.buildAuthorizeUrl({ state: STATE, nonce: NONCE, codeChallenge: CHALLENGE });
  const answer = await fetch(url, { redirect: 'manual' });
  return (
    new URL(answer.headers.get('location') ?? 'https://invalid.example/').searchParams.get(
      'code',
    ) ?? ''
  );
}

describe('buildAuthorizeUrl', () => {
  it('has exactly the parameters of FR-B-402, on the authorize endpoint of the pinned tenant', () => {
    const world = identityWorld();
    const { client } = clientFor(world);
    const url = client.buildAuthorizeUrl({ state: STATE, nonce: NONCE, codeChallenge: CHALLENGE });
    expect(`${url.origin}${url.pathname}`).toBe(
      `https://login.microsoftonline.com/${world.tenantId}/oauth2/v2.0/authorize`,
    );
    expect(Object.fromEntries(url.searchParams.entries())).toEqual({
      client_id: world.app.appId,
      response_type: 'code',
      redirect_uri: PANEL_CALLBACK,
      response_mode: 'query',
      scope: 'openid profile',
      state: STATE,
      nonce: NONCE,
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
    });
    expect(url.hash).toBe('');
  });

  it.each(['login', 'select_account'] as const)('adds prompt=%s', (prompt) => {
    const world = identityWorld();
    const { client } = clientFor(world);
    const url = client.buildAuthorizeUrl({
      state: STATE,
      nonce: NONCE,
      codeChallenge: CHALLENGE,
      prompt,
    });
    expect(url.searchParams.get('prompt')).toBe(prompt);
  });

  it.each(['none', 'consent', 'create', 'LOGIN', '', 'login select_account', 'x&max_age=0'])(
    'drops the prompt %j',
    (prompt) => {
      const world = identityWorld();
      const { client } = clientFor(world);
      const url = client.buildAuthorizeUrl({
        state: STATE,
        nonce: NONCE,
        codeChallenge: CHALLENGE,
        prompt: prompt as 'login',
      });
      expect(url.searchParams.has('prompt')).toBe(false);
      expect(url.searchParams.has('max_age')).toBe(false);
    },
  );

  it('never sends max_age, claims, login_hint, offline_access or an id_token response type', () => {
    const world = identityWorld();
    const { client } = clientFor(world);
    const url = client.buildAuthorizeUrl({
      state: STATE,
      nonce: NONCE,
      codeChallenge: CHALLENGE,
      prompt: 'login',
    });
    for (const name of ['max_age', 'claims', 'login_hint', 'domain_hint']) {
      expect(url.searchParams.has(name)).toBe(false);
    }
    expect(url.search).not.toContain('offline_access');
    expect(url.searchParams.get('response_type')).toBe('code');
  });

  it('is accepted by the fake Entra: the request is complete and the redirect carries code and state', async () => {
    const world = identityWorld();
    const { client } = clientFor(world);
    const code = await authorize(world, client);
    expect(code).not.toBe('');
    const [request] = world.entra.control.authorizeRequests();
    expect(request).toMatchObject({
      scope: 'openid profile',
      responseMode: 'query',
      codeChallengeMethod: 'S256',
      prompt: null,
      extraParameters: [],
    });
  });

  it.each([
    ['state', { state: '' }],
    ['nonce', { nonce: '' }],
    ['code challenge', { codeChallenge: '' }],
    ['state with a control character', { state: 'a\r\nb' }],
    ['a state that is too long', { state: 'a'.repeat(257) }],
  ])('refuses an empty or hostile %s', (_name, change) => {
    const world = identityWorld();
    const { client } = clientFor(world);
    expect(() =>
      client.buildAuthorizeUrl({ state: STATE, nonce: NONCE, codeChallenge: CHALLENGE, ...change }),
    ).toThrow();
  });
});

describe('exchangeCode', () => {
  it('posts the form of FR-B-403 step 6 and returns the ID token and nothing else', async () => {
    const world = identityWorld();
    const { client } = clientFor(world);
    const code = await authorize(world, client);
    const result = await client.exchangeCode({ code, codeVerifier: VERIFIER });
    expect(Object.keys(result)).toEqual(['idToken']);
    expect(result.idToken.split('.')).toHaveLength(3);

    const [request] = world.entra.control.tokenRequests();
    expect(request).toMatchObject({
      tenant: world.tenantId,
      grantType: 'authorization_code',
      hasOrigin: false,
      contentType: 'application/x-www-form-urlencoded',
      status: 200,
    });
    expect(request?.fields).toEqual({
      grant_type: 'authorization_code',
      code: '[present]',
      redirect_uri: PANEL_CALLBACK,
      code_verifier: '[present]',
      client_id: world.app.appId,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: '[present]',
      scope: 'openid profile',
    });
    expect(world.entra.control.assertionRejections()).toEqual([]);
  });

  it('sends the request to the token endpoint of the tenant on the login host only', async () => {
    const world = identityWorld();
    const { client } = clientFor(world);
    const code = await authorize(world, client);
    fake.calls.clear();
    await client.exchangeCode({ code, codeVerifier: VERIFIER });
    expect(fake.calls.all().map((call) => `${call.method} ${call.host}${call.path}`)).toEqual([
      `POST login.microsoftonline.com/${world.tenantId}/oauth2/v2.0/token`,
    ]);
  });

  it('discards the access token unread and never asks for a refresh token (FR-B-418)', async () => {
    const world = identityWorld();
    const { client } = clientFor(world);
    const code = await authorize(world, client);
    const result = await client.exchangeCode({ code, codeVerifier: VERIFIER });
    const answerAccessToken = world.graph.world.tokens;
    expect(JSON.stringify(result)).not.toContain('fk-');
    expect(answerAccessToken.issued).toBeGreaterThan(0);
    const [request] = world.entra.control.tokenRequests();
    expect(request?.fields.scope).not.toContain('offline_access');
  });

  it('signs a new assertion for every request', async () => {
    const world = identityWorld();
    const { client } = clientFor(world);
    for (let index = 0; index < 3; index += 1) {
      const code = await authorize(world, client);
      await client.exchangeCode({ code, codeVerifier: VERIFIER });
    }
    expect(world.entra.control.assertionRejections()).toEqual([]);
    expect(world.entra.control.tokenRequests()).toHaveLength(3);
  });

  it('an unusable code is a TokenEndpointError invalid_grant, with the number and without the text', async () => {
    const world = identityWorld();
    const { client } = clientFor(world);
    const failure = await rejectionOf(
      client.exchangeCode({ code: 'not-a-code', codeVerifier: VERIFIER }),
    );
    expect(failure).toBeInstanceOf(TokenEndpointError);
    expect(failure).toMatchObject({ error: 'invalid_grant', status: 400, retryable: false });
    expect(JSON.stringify(failure)).not.toContain('Trace ID');
  });

  it('invalid_client carries the AADSTS number and nothing of the description (F-39)', async () => {
    const world = identityWorld();
    const { client } = clientFor(world);
    const code = await authorize(world, client);
    world.entra.control.failToken({
      times: 1,
      answer: { status: 400, error: 'invalid_client', aadsts: 700027, description: 'SECRET-TEXT' },
    });
    const failure = await rejectionOf(client.exchangeCode({ code, codeVerifier: VERIFIER }));
    expect(failure).toMatchObject({ error: 'invalid_client', aadsts: 700027 });
    expect(`${String(failure)}${JSON.stringify(failure)}`).not.toContain('SECRET-TEXT');
  });

  it('retries once after one second on temporarily_unavailable (F-40)', async () => {
    const world = identityWorld();
    const { client, time } = clientFor(world);
    const code = await authorize(world, client);
    world.entra.control.failToken({
      times: 1,
      answer: { status: 400, error: 'temporarily_unavailable' },
    });
    const attempt = track(client.exchangeCode({ code, codeVerifier: VERIFIER }));
    await vi.waitFor(() => {
      expect(world.entra.control.tokenRequests()).toHaveLength(1);
    });
    await vi.waitFor(() => {
      expect(time.scheduler.pending()).toBe(1);
    });
    expect(attempt.settled()).toBe(false);
    time.elapse(999);
    await settle();
    expect(world.entra.control.tokenRequests()).toHaveLength(1);
    time.elapse(1);
    await vi.waitFor(() => {
      expect(attempt.settled()).toBe(true);
    });
    expect(attempt.value().idToken).toBeTypeOf('string');
    expect(world.entra.control.tokenRequests()).toHaveLength(2);
    expect(world.entra.control.assertionRejections()).toEqual([]);
  });

  it('gives up after the one retry: 503 twice is temporarily_unavailable (F-41)', async () => {
    const world = identityWorld();
    const { client, time } = clientFor(world);
    const code = await authorize(world, client);
    world.entra.control.failToken({ times: 5, answer: { status: 503 } });
    const attempt = track(client.exchangeCode({ code, codeVerifier: VERIFIER }));
    await vi.waitFor(() => {
      expect(time.scheduler.pending()).toBe(1);
    });
    time.elapse(1_000);
    await vi.waitFor(() => {
      expect(attempt.settled()).toBe(true);
    });
    expect(attempt.error()).toBeInstanceOf(TokenEndpointError);
    expect(attempt.error()).toMatchObject({ error: 'temporarily_unavailable', retryable: true });
    expect(world.entra.control.tokenRequests()).toHaveLength(2);
  });

  it('does not retry anything else', async () => {
    const world = identityWorld();
    const { client } = clientFor(world);
    const code = await authorize(world, client);
    world.entra.control.failToken({ times: 5, answer: { status: 400, error: 'invalid_grant' } });
    await rejectionOf(client.exchangeCode({ code, codeVerifier: VERIFIER }));
    expect(world.entra.control.tokenRequests()).toHaveLength(1);
  });

  it('times out after ten seconds on the injected scheduler and does not retry (F-41)', async () => {
    const world = identityWorld();
    const { client, time } = clientFor(world);
    const code = await authorize(world, client);
    world.entra.control.failToken({ times: 1, answer: 'hang' });
    const attempt = track(client.exchangeCode({ code, codeVerifier: VERIFIER }));
    await vi.waitFor(() => {
      expect(time.scheduler.pending()).toBe(1);
    });
    time.elapse(9_999);
    await settle();
    expect(attempt.settled()).toBe(false);
    time.elapse(1);
    await vi.waitFor(() => {
      expect(attempt.settled()).toBe(true);
    });
    expect(attempt.error()).toMatchObject({ error: 'temporarily_unavailable', retryable: true });
    // No retry pause is armed: a timeout is not retried.
    await settle();
    expect(time.scheduler.pending()).toBe(0);
  });

  it.each([
    ['a redirect', { status: 302 }],
    ['an answer without an id_token', { status: 200 }],
  ])('%s is a TokenEndpointError', async (_name, answer) => {
    const world = identityWorld();
    const { client } = clientFor(world);
    const code = await authorize(world, client);
    world.entra.control.failToken({ times: 1, answer });
    const failure = await rejectionOf(client.exchangeCode({ code, codeVerifier: VERIFIER }));
    expect(failure).toBeInstanceOf(TokenEndpointError);
  });

  it('refuses a code or a verifier that is empty or too long before any request', async () => {
    const world = identityWorld();
    const { client } = clientFor(world);
    for (const bad of [
      { code: '', codeVerifier: VERIFIER },
      { code: 'c', codeVerifier: '' },
      { code: 'c'.repeat(5_000), codeVerifier: VERIFIER },
    ]) {
      await expect(client.exchangeCode(bad)).rejects.toThrow();
    }
    expect(fake.calls.length).toBe(0);
  });
});

describe('validateIdToken and endSessionUrl', () => {
  it('validates against the pinned tenant, the client id and the nonce', async () => {
    const world = identityWorld();
    const { client } = clientFor(world);
    const code = await authorize(world, client);
    const { idToken } = await client.exchangeCode({ code, codeVerifier: VERIFIER });
    await expect(client.validateIdToken(idToken, { nonce: NONCE })).resolves.toMatchObject({
      tid: world.tenantId,
      oid: world.user.id,
    });
    const failure = await rejectionOf(client.validateIdToken(idToken, { nonce: 'other' }));
    expect(failure).toBeInstanceOf(IdTokenError);
    expect((failure as IdTokenError).check).toBe('nonce');
  });

  it('endSessionUrl is the end_session_endpoint of the tenant', async () => {
    const world = identityWorld();
    const { client } = clientFor(world);
    const url = await client.endSessionUrl();
    expect(url.href).toBe(`https://login.microsoftonline.com/${world.tenantId}/oauth2/v2.0/logout`);
    expect(url.search).toBe('');
  });

  it('endSessionUrl falls back to the constructed form when the document is refused', async () => {
    const world = identityWorld();
    world.entra.control.failDiscovery('foreign_hosts');
    const { client } = clientFor(world);
    const url = await client.endSessionUrl();
    expect(url.hostname).toBe('login.microsoftonline.com');
    expect(url.pathname).toBe(`/${world.tenantId}/oauth2/v2.0/logout`);
  });
});

// ---- MSAL is not on the sign-in path, and the token response is read for two fields only ---------------

function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const SIGN_IN_PATH = [
  'oidc-client.ts',
  'token-endpoint.ts',
  'id-token.ts',
  'jwks.ts',
  'tenant-metadata.ts',
  'client-assertion.ts',
  'aadsts.ts',
];

function offenders(files: readonly { name: string; text: string }[]): string[] {
  return files
    .filter((file) => code(file.text).includes('@azure/msal-node'))
    .map((file) => file.name);
}

describe('the sign-in path (FR-B-418, T-B-082)', () => {
  const files = SIGN_IN_PATH.map((name) => ({
    name,
    text: readFileSync(`${SOURCE_DIRECTORY}${name}`, 'utf8'),
  }));

  it('imports no MSAL', () => {
    expect(offenders(files)).toEqual([]);
  });

  it('negative: a sign-in file that imports MSAL is reported', () => {
    expectGuardFails(
      (list: { name: string; text: string }[]) => {
        const found = offenders(list);
        if (found.length > 0) throw new Error(`MSAL on the sign-in path in ${found.join(', ')}`);
      },
      [
        {
          name: 'oidc-client.ts',
          text: "import { PublicClientApplication } from '@azure/msal-node';",
        },
      ],
      { name: 'msal scan', reason: 'oidc-client.ts' },
    );
  });

  it('the token endpoint file reads id_token and the error fields and never names access_token or refresh_token', () => {
    const text = code(readFileSync(`${SOURCE_DIRECTORY}token-endpoint.ts`, 'utf8'));
    expect(text).toContain('id_token');
    expect(text).not.toContain('access_token');
    expect(text).not.toContain('refresh_token');
  });
});

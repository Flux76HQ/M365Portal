// T-B-075, FR-B-112 (callback half), FR-B-316, V-B04 (+ negative): application tokens through MSAL.
//
// Learn: client credentials with a certificate assertion
// (https://learn.microsoft.com/entra/identity-platform/v2-oauth2-client-creds-grant-flow,
// .../certificate-credentials), MSAL Node `ConfidentialClientApplication` with a client-assertion
// callback (https://learn.microsoft.com/entra/msal/javascript/node/certificate-credentials). V-B04
// observed that MSAL 7 calls the callback on EVERY acquire, cache hits included, with
// `{clientId, tokenEndpoint}`, makes no discovery request for the Microsoft authority, uses the global
// `fetch`, sends no `Origin` header and honours `skipCache`.
import { readFileSync } from 'node:fs';
import { inspect } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import { createMsalAppTokenProvider } from '../../../src/integrations/identity/app-token.js';
import { createIdentityFetch } from '../../../src/integrations/identity/http.js';
import {
  IntegrationError,
  NotConnectedError,
  TokenEndpointError,
} from '../../../src/ports/errors.js';
import type { CertificateHolderPort } from '../../../src/ports/secrets.js';
import { HOSTILE_DESCRIPTION } from '../../fakes/fake-tenant/entra/index.js';
import { fake } from '../../support/msw.js';
import { createTime, rejectionOf, sequenceRandom } from '../support.js';
import { identityWorld, type IdentityWorld } from './support.js';

const APP_TOKEN_SOURCE = fileURLToPath(
  new URL('../../../src/integrations/identity/app-token.ts', import.meta.url),
);

function provider(world: IdentityWorld, signer?: CertificateHolderPort) {
  const warnings: Record<string, unknown>[] = [];
  const time = createTime();
  const tokens = createMsalAppTokenProvider({
    tenantId: world.tenantId,
    clientId: world.app.appId,
    signer: signer ?? world.holder,
    clock: time.clock,
    random: sequenceRandom(),
    jsonFetch: createIdentityFetch({ clock: time.clock, scheduler: time.scheduler }),
    scheduler: time.scheduler,
    log: {
      warn: (fields) => {
        warnings.push({ ...fields });
      },
    },
  });
  return { tokens, warnings };
}

/** A holder that counts how often it is asked to sign. */
function counting(world: IdentityWorld): {
  signer: CertificateHolderPort;
  readonly signed: number;
} {
  let signed = 0;
  return {
    signer: {
      publicCertificateDer: () => world.holder.publicCertificateDer(),
      signCompact: (header, payload) => {
        signed += 1;
        return world.holder.signCompact(header, payload);
      },
    },
    get signed() {
      return signed;
    },
  };
}

const tokenCalls = (): number =>
  fake.calls.all().filter((call) => call.path.endsWith('/oauth2/v2.0/token')).length;

describe('an application token for Graph and Exchange', () => {
  it('asks the token endpoint of the tenant with the .default scope and a certificate assertion', async () => {
    const world = identityWorld();
    world.app.grantGraphRole('User.Read.All');
    const { tokens } = provider(world);
    const token = await tokens.get('graph');
    const record = world.graph.world.tokens.lookup(token.reveal());
    expect(record).toMatchObject({ kind: 'app', audience: 'graph', appId: world.app.appId });
    expect(record?.roles).toEqual(['User.Read.All']);

    const [request] = world.entra.control.tokenRequests();
    expect(request).toMatchObject({
      tenant: world.tenantId,
      grantType: 'client_credentials',
      hasOrigin: false,
      contentType: expect.stringContaining('application/x-www-form-urlencoded') as unknown,
    });
    expect(request?.fields).toMatchObject({
      client_id: world.app.appId,
      scope: 'https://graph.microsoft.com/.default',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: '[present]',
    });
    expect(Object.keys(request?.fields ?? {})).not.toContain('client_secret');
    expect(world.entra.control.assertionRejections()).toEqual([]);
  });

  it('asks for the Exchange resource when told to', async () => {
    const world = identityWorld();
    const { tokens } = provider(world);
    const token = await tokens.get('exchange');
    expect(world.graph.world.tokens.lookup(token.reveal())?.audience).toBe('exchange');
    expect(world.entra.control.tokenRequests()[0]?.fields.scope).toBe(
      'https://outlook.office365.com/.default',
    );
  });

  it('makes no discovery request: only the token endpoint of the tenant is reached', async () => {
    const world = identityWorld();
    const { tokens } = provider(world);
    await tokens.get('graph');
    const hosts = fake.calls.all().map((call) => `${call.host}${call.path}`);
    expect(hosts).toEqual([`login.microsoftonline.com/${world.tenantId}/oauth2/v2.0/token`]);
  });

  it('serves a second request from the MSAL cache, and skipCache asks again', async () => {
    const world = identityWorld();
    const { tokens } = provider(world);
    const first = await tokens.get('graph');
    const second = await tokens.get('graph');
    expect(second.reveal()).toBe(first.reveal());
    expect(tokenCalls()).toBe(1);
    const fresh = await tokens.get('graph', { skipCache: true });
    expect(fresh.reveal()).not.toBe(first.reveal());
    expect(tokenCalls()).toBe(2);
    const again = await tokens.get('graph', { skipCache: false });
    expect(again.reveal()).toBe(fresh.reveal());
    expect(tokenCalls()).toBe(2);
  });

  it('keeps Graph and Exchange apart in the cache', async () => {
    const world = identityWorld();
    const { tokens } = provider(world);
    const graph = await tokens.get('graph');
    const exchange = await tokens.get('exchange');
    expect(exchange.reveal()).not.toBe(graph.reveal());
    expect((await tokens.get('graph')).reveal()).toBe(graph.reveal());
    expect((await tokens.get('exchange')).reveal()).toBe(exchange.reveal());
  });

  it('signs a new assertion on EVERY acquire, cache hits included (V-B04)', async () => {
    const world = identityWorld();
    const spy = counting(world);
    const { tokens } = provider(world, spy.signer);
    await tokens.get('graph');
    await tokens.get('graph');
    await tokens.get('graph', { skipCache: true });
    await tokens.get('exchange');
    expect(spy.signed).toBe(4);
    expect(tokenCalls()).toBe(3);
  });

  it('a token requested before a role was granted lacks it; skipCache gets the new one (research 4)', async () => {
    const world = identityWorld();
    const { tokens } = provider(world);
    const early = await tokens.get('graph');
    world.app.grantGraphRole('User.Read.All');
    expect((await tokens.get('graph')).reveal()).toBe(early.reveal());
    const late = await tokens.get('graph', { skipCache: true });
    expect(world.graph.world.tokens.lookup(early.reveal())?.roles).toEqual([]);
    expect(world.graph.world.tokens.lookup(late.reveal())?.roles).toEqual(['User.Read.All']);
  });
});

describe('the token object', () => {
  it('reveals its value in reveal() only', async () => {
    const world = identityWorld();
    const { tokens } = provider(world);
    const token = await tokens.get('graph');
    const value = token.reveal();
    expect(value.length).toBeGreaterThan(10);
    for (const shown of [
      JSON.stringify(token),
      (token as { toString(): string }).toString(),
      (token as { toString(): string }).toString(),
      inspect(token, { depth: 5, showHidden: true }),
      JSON.stringify({ token }),
    ]) {
      expect(shown).not.toContain(value);
    }
    expect(JSON.stringify(token)).toBe('"[redacted]"');
    expect(Object.keys(token)).toEqual(['expiresAt']);
  });

  it('has an expiry in epoch milliseconds', async () => {
    const world = identityWorld();
    const { tokens } = provider(world);
    const token = await tokens.get('graph');
    expect(Number.isSafeInteger(token.expiresAt)).toBe(true);
    expect(token.expiresAt).toBeGreaterThan(0);
  });
});

describe('failures carry a code and a number, never Microsoft text', () => {
  it('maps invalid_client with AADSTS700027 and drops the description', async () => {
    const world = identityWorld();
    world.entra.control.failToken({
      grant: 'client_credentials',
      times: 1,
      answer: {
        status: 400,
        error: 'invalid_client',
        aadsts: 700027,
        description: HOSTILE_DESCRIPTION,
      },
    });
    const { tokens, warnings } = provider(world);
    const failure = await rejectionOf(tokens.get('graph'));
    expect(failure).toBeInstanceOf(TokenEndpointError);
    expect(failure).toMatchObject({ error: 'invalid_client', aadsts: 700027 });
    const text = `${String(failure)} ${JSON.stringify(failure)} ${(failure as Error).stack ?? ''} ${JSON.stringify(warnings)}`;
    expect(text).not.toContain('script');
    expect(text).not.toContain('xxxx');
    expect(text).not.toContain('Trace ID');
  });

  it('is a typed error also for an answer that is not JSON (503) or a crash', async () => {
    const world = identityWorld();
    world.entra.control.failToken({
      grant: 'client_credentials',
      times: 1,
      answer: { status: 503 },
    });
    const { tokens } = provider(world);
    expect(await rejectionOf(tokens.get('graph'))).toBeInstanceOf(IntegrationError);
  });

  it('a certificate the application does not have is a failure of the token endpoint (OV-04 symptom)', async () => {
    const world = identityWorld();
    world.graph.directory.applications.get(world.app.objectId)?.keyCredentials.splice(0);
    const { tokens } = provider(world);
    const failure = await rejectionOf(tokens.get('graph'));
    expect(failure).toMatchObject({ error: 'invalid_client' });
  });

  it('never puts the assertion or the token in a log line', async () => {
    const world = identityWorld();
    world.entra.control.failToken({ times: 1, answer: { status: 400, error: 'invalid_client' } });
    const { tokens, warnings } = provider(world);
    await rejectionOf(tokens.get('graph'));
    expect(JSON.stringify(warnings)).not.toMatch(/eyJ/);
  });
});

describe('closing', () => {
  it('a closed provider is not connected any more and its MSAL cache is gone', async () => {
    const world = identityWorld();
    const { tokens } = provider(world);
    await tokens.get('graph');
    tokens.close();
    expect(await rejectionOf(tokens.get('graph'))).toBeInstanceOf(NotConnectedError);
    tokens.close();
  });
});

// ---- no secret anywhere in the code -----------------------------------------------------------------

function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Config members that would give MSAL a secret, a key or a cache that outlives the process. */
function forbiddenConfig(text: string): string[] {
  return ['clientSecret', 'clientCertificate', 'cachePlugin', 'piiLoggingEnabled: true'].filter(
    (needle) => code(text).includes(needle),
  );
}

describe('the configuration of the MSAL application (FR-B-112, FR-B-316)', () => {
  it('has no clientSecret, no clientCertificate and no cachePlugin, and no PII logging', () => {
    const text = readFileSync(APP_TOKEN_SOURCE, 'utf8');
    expect(forbiddenConfig(text)).toEqual([]);
    expect(code(text)).toContain('piiLoggingEnabled: false');
    expect(code(text)).toContain('clientAssertion');
  });

  it('negative: a source with a client secret is reported', () => {
    expectGuardFails(
      (source: string) => {
        const found = forbiddenConfig(source);
        if (found.length > 0) throw new Error(`MSAL configured with ${found.join(', ')}`);
      },
      'new ConfidentialClientApplication({ auth: { clientId, clientSecret: s } });',
      { name: 'msal config scan', reason: 'clientSecret' },
    );
  });
});

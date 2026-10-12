// T-B-077, FR-B-404, FR-B-410, V-B12 (+ negative): the tenant discovery document.
//
// Learn, https://learn.microsoft.com/entra/identity-platform/v2-protocols-oidc: the document at
// `/{tenant}/v2.0/.well-known/openid-configuration` lists `jwks_uri`, `end_session_endpoint` and the
// rest; the keys are per tenant (signing-key-rollover). The product fetches it once per 24 hours and
// on demand, accepts it only when the issuer is the literal `https://login.microsoftonline.com/<tid>/v2.0`
// and the two URLs are https on `login.microsoftonline.com`, and otherwise uses the constructed
// forms (with a warning). The authorize and token endpoints are always constructed.
import { describe, expect, it } from 'vitest';
import { createIdentityFetch } from '../../../src/integrations/identity/http.js';
import { createTenantMetadata } from '../../../src/integrations/identity/tenant-metadata.js';
import { SimulatedNetworkFailure } from '../../fakes/fake-tenant/index.js';
import { fakeGuid } from '../../fakes/fake-tenant/graph/index.js';
import { fake } from '../../support/msw.js';
import { createTime, mountScript } from '../support.js';
import { identityWorld } from './support.js';

const LOGIN = 'https://login.microsoftonline.com';
const TENANT = fakeGuid('tenant', 1);
const DOC_PATH = `/${TENANT}/v2.0/.well-known/openid-configuration`;

interface Logged {
  readonly fields: Record<string, unknown>;
  readonly message: string;
}

function metadata(tenantId = TENANT) {
  const time = createTime();
  const warnings: Logged[] = [];
  const api = createTenantMetadata({
    tenantId,
    jsonFetch: createIdentityFetch({ clock: time.clock, scheduler: time.scheduler }),
    clock: time.clock,
    log: {
      warn: (fields, message) => {
        warnings.push({ fields: { ...fields }, message });
      },
    },
  });
  return { api, time, warnings };
}

const constructed = {
  issuer: `${LOGIN}/${TENANT}/v2.0`,
  authorizationEndpoint: `${LOGIN}/${TENANT}/oauth2/v2.0/authorize`,
  tokenEndpoint: `${LOGIN}/${TENANT}/oauth2/v2.0/token`,
  jwksUri: `${LOGIN}/${TENANT}/discovery/v2.0/keys`,
  endSessionEndpoint: `${LOGIN}/${TENANT}/oauth2/v2.0/logout`,
};

function documentCalls(): number {
  return fake.calls.all().filter((call) => call.path === DOC_PATH).length;
}

describe('the document of the tenant', () => {
  it('is fetched from the tenant discovery URL and its endpoints are used', async () => {
    identityWorld();
    const { api, warnings } = metadata();
    expect(await api.get()).toEqual({ ...constructed, source: 'discovery' });
    expect(warnings).toEqual([]);
    expect(documentCalls()).toBe(1);
  });

  it('is fetched once per 24 hours', async () => {
    identityWorld();
    const { api, time } = metadata();
    await api.get();
    await api.get();
    time.elapse(23 * 3_600_000 + 59 * 60_000);
    await api.get();
    expect(documentCalls()).toBe(1);
    time.elapse(2 * 60_000);
    await api.get();
    expect(documentCalls()).toBe(2);
  });

  it('is fetched on demand', async () => {
    identityWorld();
    const { api } = metadata();
    await api.get();
    await api.refresh();
    expect(documentCalls()).toBe(2);
  });

  it('is fetched once for callers that ask at the same time', async () => {
    identityWorld();
    const { api } = metadata();
    await Promise.all([api.get(), api.get(), api.get()]);
    expect(documentCalls()).toBe(1);
  });

  it('asks only the login host, with GET and no body', async () => {
    identityWorld();
    const { api } = metadata();
    await api.get();
    const [call] = fake.calls.all();
    expect(call).toMatchObject({
      host: 'login.microsoftonline.com',
      method: 'GET',
      path: DOC_PATH,
    });
  });
});

describe('the constructed endpoints (V-B12)', () => {
  it('replace a document with another issuer, with a warning', async () => {
    const world = identityWorld();
    world.entra.control.failDiscovery('issuer_mismatch');
    const { api, warnings } = metadata();
    expect(await api.get()).toEqual({ ...constructed, source: 'constructed' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.fields).toMatchObject({
      event: 'tenant_metadata_rejected',
      reason: 'issuer',
    });
    expect(JSON.stringify(warnings)).not.toContain('keys.attacker');
  });

  it('replace a document whose jwks_uri and end_session_endpoint are on another host', async () => {
    const world = identityWorld();
    world.entra.control.failDiscovery('foreign_hosts');
    const { api, warnings } = metadata();
    expect(await api.get()).toEqual({ ...constructed, source: 'constructed' });
    expect(warnings[0]?.fields).toMatchObject({
      event: 'tenant_metadata_rejected',
      reason: 'endpoints',
    });
  });

  it('are used when the document cannot be fetched', async () => {
    const world = identityWorld();
    world.entra.control.failDiscovery('unavailable');
    const { api, warnings } = metadata();
    expect(await api.get()).toEqual({ ...constructed, source: 'constructed' });
    expect(warnings[0]?.fields).toMatchObject({
      event: 'tenant_metadata_rejected',
      reason: 'unavailable',
    });
  });

  it('are retried after five minutes, not on every call, and not held for 24 hours', async () => {
    const world = identityWorld();
    world.entra.control.failDiscovery('unavailable');
    const { api, time } = metadata();
    await api.get();
    await api.get();
    expect(documentCalls()).toBe(1);
    world.entra.control.failDiscovery(null);
    time.elapse(5 * 60_000 + 1);
    expect((await api.get()).source).toBe('discovery');
    expect(documentCalls()).toBe(2);
  });

  it('always build the authorize and token endpoints, whatever the document says', async () => {
    const document = {
      issuer: constructed.issuer,
      jwks_uri: `${LOGIN}/${TENANT}/discovery/v2.0/keys`,
      end_session_endpoint: `${LOGIN}/${TENANT}/oauth2/v2.0/logout`,
      authorization_endpoint: 'https://evil.example/authorize',
      token_endpoint: 'https://evil.example/token',
    };
    mountScript('login.microsoftonline.com', 'GET', DOC_PATH, [{ status: 200, body: document }]);
    const { api } = metadata();
    const endpoints = await api.get();
    expect(endpoints.authorizationEndpoint).toBe(constructed.authorizationEndpoint);
    expect(endpoints.tokenEndpoint).toBe(constructed.tokenEndpoint);
    expect(endpoints.source).toBe('discovery');
  });

  const REJECTED: readonly [string, Record<string, unknown>][] = [
    ['issuer with a trailing slash', { issuer: `${constructed.issuer}/` }],
    ['issuer in the v1 form', { issuer: `https://sts.windows.net/${TENANT}/` }],
    ['issuer of the template', { issuer: `${LOGIN}/{tenantid}/v2.0` }],
    [
      'issuer with an upper-case host',
      { issuer: `https://LOGIN.microsoftonline.com/${TENANT}/v2.0` },
    ],
    ['no issuer', { issuer: undefined }],
    [
      'jwks_uri over http',
      { jwks_uri: `http://login.microsoftonline.com/${TENANT}/discovery/v2.0/keys` },
    ],
    [
      'jwks_uri on a look-alike host',
      { jwks_uri: 'https://login.microsoftonline.com.evil.example/keys' },
    ],
    [
      'jwks_uri with user information',
      { jwks_uri: 'https://login.microsoftonline.com@evil.example/keys' },
    ],
    ['jwks_uri with a port', { jwks_uri: 'https://login.microsoftonline.com:8443/keys' }],
    ['jwks_uri that is not a string', { jwks_uri: 5 }],
    ['no jwks_uri', { jwks_uri: undefined }],
    [
      'end_session_endpoint on another host',
      { end_session_endpoint: 'https://evil.example/logout' },
    ],
    [
      'end_session_endpoint over http',
      { end_session_endpoint: `http://login.microsoftonline.com/${TENANT}/oauth2/v2.0/logout` },
    ],
    ['no end_session_endpoint', { end_session_endpoint: undefined }],
  ];
  it.each(REJECTED)('refuse a document with %s (+ negative)', async (_name, change) => {
    const good = {
      issuer: constructed.issuer,
      jwks_uri: constructed.jwksUri,
      end_session_endpoint: constructed.endSessionEndpoint,
    };
    mountScript('login.microsoftonline.com', 'GET', DOC_PATH, [
      { status: 200, body: { ...good, ...change } },
    ]);
    const { api, warnings } = metadata();
    expect(await api.get()).toEqual({ ...constructed, source: 'constructed' });
    expect(warnings).toHaveLength(1);
  });

  it('accept the same document without the change (the table above fails for the right reason)', async () => {
    mountScript('login.microsoftonline.com', 'GET', DOC_PATH, [
      {
        status: 200,
        body: {
          issuer: constructed.issuer,
          jwks_uri: constructed.jwksUri,
          end_session_endpoint: constructed.endSessionEndpoint,
        },
      },
    ]);
    const { api, warnings } = metadata();
    expect((await api.get()).source).toBe('discovery');
    expect(warnings).toEqual([]);
  });

  it('accept a jwks_uri on the login host at another path', async () => {
    mountScript('login.microsoftonline.com', 'GET', DOC_PATH, [
      {
        status: 200,
        body: {
          issuer: constructed.issuer,
          jwks_uri: `${LOGIN}/common/discovery/v2.0/keys`,
          end_session_endpoint: constructed.endSessionEndpoint,
        },
      },
    ]);
    const { api } = metadata();
    expect((await api.get()).jwksUri).toBe(`${LOGIN}/common/discovery/v2.0/keys`);
  });

  it('treat a redirect, an answer that is not JSON and a non-object as unavailable', async () => {
    for (const step of [
      { status: 302, headers: { location: 'https://evil.example/' } },
      { status: 200, body: [] },
      { status: 200, body: 'text' },
    ]) {
      fake.reset();
      mountScript('login.microsoftonline.com', 'GET', DOC_PATH, [step]);
      const { api, warnings } = metadata();
      expect((await api.get()).source, JSON.stringify(step)).toBe('constructed');
      expect(warnings).toHaveLength(1);
    }
  });

  it('never throws because the fetch failed: sign-in must keep its keys and logout URL', async () => {
    mountScript('login.microsoftonline.com', 'GET', DOC_PATH, [
      () => {
        throw new SimulatedNetworkFailure();
      },
    ]);
    const { api, warnings } = metadata();
    expect((await api.get()).source).toBe('constructed');
    expect(warnings).toHaveLength(1);
  });
});

describe('construction', () => {
  it('needs a tenant id (a GUID)', () => {
    const time = createTime();
    for (const tenantId of ['', 'common', 'organizations', '../x', 'contoso.onmicrosoft.com']) {
      expect(() =>
        createTenantMetadata({
          tenantId,
          jsonFetch: createIdentityFetch({ clock: time.clock, scheduler: time.scheduler }),
          clock: time.clock,
        }),
      ).toThrow();
    }
  });

  it('lower-cases a tenant id', async () => {
    identityWorld();
    const { api } = metadata(TENANT.toUpperCase());
    expect((await api.get()).issuer).toBe(`${LOGIN}/${TENANT}/v2.0`);
  });
});

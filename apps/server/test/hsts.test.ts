// T-A-028, FR-A-043, E-16, BC-01, baseline section 13: `Strict-Transport-Security` follows the host.
//
// `includeSubDomains` is a promise about every subdomain of the host, at every depth, for the whole
// max-age, in every browser that saw it once. A self-hosted panel cannot know which hosts its
// operator owns, so the flag is an opt-in (`HSTS_INCLUDE_SUBDOMAINS`) and applies only to the one
// host the operator declared in `PUBLIC_BASE_URL`. Every other host on https still gets plain
// `max-age`: dropping the flag is not a reason to drop the header.
//
// The test asserts BOTH directions for every host: the flags are present for the declared host and
// absent for every other host, and the plain header is present on all of them. A rule that stops
// matching sends no header at all, which is a quieter regression than the one it was written to
// catch, so "absent" is not enough.
//
// Negative fixtures: `assertHstsRules` runs the whole table against a function. The real function
// passes; one that always adds `includeSubDomains`, one that ignores the host, one that drops the
// whole header for other hosts and one that sends it over http must fail it on purpose.
import { expectGuardFails } from '@m365portal/shared/testing';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { loadConfig, type AppConfig } from '../src/config/index.js';
import { hstsHeaderValue } from '../src/http/hsts.js';
import { requestContext, type AppEnv } from '../src/http/request-context.js';
import { securityHeaders } from '../src/http/security-headers.js';
import { requestHost } from '../src/http/trust-proxy.js';
import { createTestApp } from './helpers/test-app.js';

const DECLARED = 'panel.example.com';
const BASE = { PUBLIC_BASE_URL: `https://${DECLARED}` };
const INCLUDE = { ...BASE, HSTS_INCLUDE_SUBDOMAINS: 'true' };
const PRELOAD = { ...INCLUDE, HSTS_PRELOAD: 'true' };

function configOf(env: Record<string, string>): AppConfig {
  const result = loadConfig(env);
  if (!result.ok) throw new Error(`configuration refused: ${JSON.stringify(result.issues)}`);
  return result.config;
}

interface Scenario {
  readonly name: string;
  readonly env: Record<string, string>;
  readonly https: boolean;
  /** The `Host` header as the client sent it; `null` for none. */
  readonly host: string | null;
  readonly expected: string | undefined;
}

const YEAR = 'max-age=31536000';

/** Rows for one configuration and a list of `[host, expected]` pairs. */
function rows(
  label: string,
  env: Record<string, string>,
  pairs: readonly (readonly [string | null, string | undefined])[],
  https = true,
): Scenario[] {
  return pairs.map(([host, expected]) => ({
    name: `${label}, Host ${host === null ? '(none)' : JSON.stringify(host)}`,
    env,
    https,
    host,
    expected,
  }));
}

/** The expected header, written out by hand for every row: no logic shared with the code. */
const SCENARIOS: readonly Scenario[] = [
  // Default: no opt-in. Plain max-age on every https host, flags nowhere.
  ...rows('defaults', BASE, [
    [DECLARED, YEAR],
    ['alias.example.com', YEAR],
    ['203.0.113.9', YEAR],
    [null, YEAR],
  ]),

  // includeSubDomains opted in: present for the declared host in every spelling, absent elsewhere.
  ...rows('includeSubDomains', INCLUDE, [
    [DECLARED, `${YEAR}; includeSubDomains`],
    ['PANEL.EXAMPLE.COM', `${YEAR}; includeSubDomains`],
    ['Panel.Example.Com', `${YEAR}; includeSubDomains`],
    [`${DECLARED}.`, `${YEAR}; includeSubDomains`],
    [`${DECLARED}:8443`, `${YEAR}; includeSubDomains`],
    [`${DECLARED}:443`, `${YEAR}; includeSubDomains`],
    ['Panel.Example.Com.:443', `${YEAR}; includeSubDomains`],
    // Every other host on https: the plain header, never the flag, never nothing.
    ['alias.example.com', YEAR],
    ['other.example.org', YEAR],
    ['203.0.113.9', YEAR],
    ['203.0.113.9:8443', YEAR],
    ['[2001:db8::1]', YEAR],
    ['[2001:db8::1]:443', YEAR],
    ['internal', YEAR],
    ['localhost', YEAR],
    ['localhost.', YEAR],
    ['LOCALHOST:9300', YEAR],
    ['sub.panel.example.com', YEAR],
    ['deep.sub.panel.example.com', YEAR],
    ['xpanel.example.com', YEAR],
    ['panel.example.com.evil.test', YEAR],
    ['panel.example.com..', YEAR],
    ['panel_example_com', YEAR],
    ['bad host', YEAR],
    ['panel.example.com/', YEAR],
    ['user@panel.example.com', YEAR],
    ['', YEAR],
    [null, YEAR],
  ]),

  // preload opted in as well: the same host condition.
  ...rows('includeSubDomains and preload', PRELOAD, [
    [DECLARED, `${YEAR}; includeSubDomains; preload`],
    ['PANEL.EXAMPLE.COM:443', `${YEAR}; includeSubDomains; preload`],
    ['alias.example.com', YEAR],
    ['sub.panel.example.com', YEAR],
    ['203.0.113.9', YEAR],
    [null, YEAR],
  ]),
  ...rows('max-age of two years with preload', { ...PRELOAD, HSTS_MAX_AGE: '63072000' }, [
    [DECLARED, 'max-age=63072000; includeSubDomains; preload'],
    ['alias.example.com', 'max-age=63072000'],
  ]),

  // Max-age is the configured one, and zero is a header too (it withdraws a policy).
  ...rows('max-age 600 with includeSubDomains', { ...INCLUDE, HSTS_MAX_AGE: '600' }, [
    [DECLARED, 'max-age=600; includeSubDomains'],
    ['alias.example.com', 'max-age=600'],
  ]),
  ...rows('max-age 0', { ...BASE, HSTS_MAX_AGE: '0' }, [
    [DECLARED, 'max-age=0'],
    [null, 'max-age=0'],
  ]),

  // The declared host may itself be an address, a trailing-dot name or an IPv6 literal.
  ...rows(
    'declared IPv4 address',
    { PUBLIC_BASE_URL: 'https://203.0.113.9', HSTS_INCLUDE_SUBDOMAINS: 'true' },
    [
      ['203.0.113.9', `${YEAR}; includeSubDomains`],
      ['203.0.113.9:8443', `${YEAR}; includeSubDomains`],
      ['203.0.113.10', YEAR],
      [DECLARED, YEAR],
    ],
  ),
  ...rows(
    'declared IPv6 literal',
    { PUBLIC_BASE_URL: 'https://[2001:db8::1]:8443', HSTS_INCLUDE_SUBDOMAINS: 'true' },
    [
      ['[2001:db8::1]:8443', `${YEAR}; includeSubDomains`],
      ['[2001:DB8::1]', `${YEAR}; includeSubDomains`],
      ['[2001:db8::2]', YEAR],
    ],
  ),
  ...rows(
    'declared name with a trailing dot',
    { PUBLIC_BASE_URL: 'https://panel.example.com.', HSTS_INCLUDE_SUBDOMAINS: 'true' },
    [
      [DECLARED, `${YEAR}; includeSubDomains`],
      [`${DECLARED}.`, `${YEAR}; includeSubDomains`],
      ['alias.example.com', YEAR],
    ],
  ),

  // Over http (and no trusted proxy that says otherwise): nothing, whatever the opt-ins.
  ...rows(
    'http, defaults',
    {},
    [
      ['localhost:9300', undefined],
      [null, undefined],
    ],
    false,
  ),
  ...rows(
    'http, every opt-in',
    {
      // Phase B: http is only possible for localhost (FR-B-103).
      PUBLIC_BASE_URL: 'http://localhost:9300',
      HSTS_INCLUDE_SUBDOMAINS: 'true',
      HSTS_PRELOAD: 'true',
    },
    [
      ['localhost', undefined],
      ['alias.example.com', undefined],
      [null, undefined],
    ],
    false,
  ),
];

/** What a candidate computes: the header value for a scenario, or `undefined` for no header. */
type HeaderFor = (scenario: Scenario) => string | undefined;

function assertHstsRules(headerFor: HeaderFor): void {
  for (const scenario of SCENARIOS) {
    const actual = headerFor(scenario);
    if (actual !== scenario.expected) {
      throw new Error(
        `${scenario.name}: expected ${String(scenario.expected)}, got ${String(actual)}`,
      );
    }
  }
}

/** The real rule, fed the way the pipeline feeds it: the host through `requestHost`. */
const realRule: HeaderFor = (scenario) => {
  const headers = new Headers();
  if (scenario.host !== null) headers.set('host', scenario.host);
  return hstsHeaderValue({
    config: configOf(scenario.env),
    https: scenario.https,
    host: requestHost({ headers }),
  });
};

describe('hstsHeaderValue (FR-A-043, E-16)', () => {
  it('passes the whole table', () => {
    expect(() => {
      assertHstsRules(realRule);
    }).not.toThrow();
  });

  it.each(SCENARIOS.map((scenario) => [scenario.name, scenario] as const))(
    '%s',
    (_name, scenario) => {
      expect(realRule(scenario)).toBe(scenario.expected);
    },
  );

  it('asserts both directions for every host: flags present for the declared host, absent elsewhere', () => {
    const flagged = SCENARIOS.filter(
      (scenario) => scenario.expected?.includes('includeSubDomains') === true,
    );
    const plain = SCENARIOS.filter(
      (scenario) =>
        scenario.https &&
        scenario.expected !== undefined &&
        !scenario.expected.includes('includeSubDomains'),
    );
    const silent = SCENARIOS.filter((scenario) => !scenario.https);
    // The table has to contain all three kinds of row, or one direction is not tested at all.
    expect(flagged.length).toBeGreaterThanOrEqual(10);
    expect(plain.length).toBeGreaterThanOrEqual(25);
    expect(silent.length).toBeGreaterThanOrEqual(5);
    for (const scenario of flagged) expect(realRule(scenario)).toContain('includeSubDomains');
    for (const scenario of plain) expect(realRule(scenario)).toMatch(/^max-age=\d+$/);
    for (const scenario of silent) expect(realRule(scenario)).toBeUndefined();
  });

  it('puts preload only after includeSubDomains, in that order', () => {
    const value = hstsHeaderValue({
      config: configOf(PRELOAD),
      https: true,
      host: DECLARED,
    });
    expect(value).toBe(`${YEAR}; includeSubDomains; preload`);
  });

  it('never sends preload without includeSubDomains, even for a configuration built by hand', () => {
    const config = configOf(BASE);
    const handBuilt = {
      ...config,
      hsts: { maxAgeSeconds: 31_536_000, includeSubDomains: false, preload: true },
    };
    expect(hstsHeaderValue({ config: handBuilt, https: true, host: DECLARED })).toBe(YEAR);
    const shortLived = {
      ...config,
      hsts: { maxAgeSeconds: 600, includeSubDomains: true, preload: true },
    };
    expect(hstsHeaderValue({ config: shortLived, https: true, host: DECLARED })).toBe(
      'max-age=600; includeSubDomains',
    );
  });
});

describe('the HSTS guard (negative fixtures)', () => {
  const alwaysIncludeSubDomains: HeaderFor = (scenario) => {
    const value = realRule(scenario);
    return value === undefined || value.includes('includeSubDomains')
      ? value
      : `${value}; includeSubDomains`;
  };

  const alwaysIncludePreload: HeaderFor = (scenario) => {
    const value = realRule(scenario);
    return value === undefined || value.includes('preload')
      ? value
      : `${value}; includeSubDomains; preload`;
  };

  const ignoresHost: HeaderFor = (scenario) => {
    // The declared host is always the answer: the flag follows the configuration only.
    const config = configOf(scenario.env);
    return hstsHeaderValue({ config, https: scenario.https, host: config.publicHost });
  };

  const usesTheRawHostHeader: HeaderFor = (scenario) => {
    const config = configOf(scenario.env);
    return hstsHeaderValue({
      config,
      https: scenario.https,
      host: scenario.host ?? undefined,
    });
  };

  const dropsTheHeaderForOtherHosts: HeaderFor = (scenario) => {
    const value = realRule(scenario);
    const config = configOf(scenario.env);
    const declared = scenario.host?.toLowerCase().startsWith(config.publicHost) === true;
    return declared || !scenario.https ? value : undefined;
  };

  const sendsOverHttp: HeaderFor = (scenario) => realRule({ ...scenario, https: true });

  const dropsTheHeaderWithoutHost: HeaderFor = (scenario) =>
    scenario.host === null ? undefined : realRule(scenario);

  const ignoresMaxAge: HeaderFor = (scenario) =>
    realRule(scenario)?.replace(/max-age=\d+/, 'max-age=31536000');

  it('passes for the real rule', () => {
    expect(() => {
      assertHstsRules(realRule);
    }).not.toThrow();
  });

  it.each([
    ['always adds includeSubDomains', alwaysIncludeSubDomains],
    ['always adds includeSubDomains and preload', alwaysIncludePreload],
    ['ignores the host', ignoresHost],
    ['compares the Host header as it came, without normalising it', usesTheRawHostHeader],
    ['drops the whole header for other hosts', dropsTheHeaderForOtherHosts],
    ['sends the header over http', sendsOverHttp],
    ['sends no header when there is no Host', dropsTheHeaderWithoutHost],
    ['ignores HSTS_MAX_AGE', ignoresMaxAge],
  ] as const)('fails for a rule that %s', (_name, candidate) => {
    expectGuardFails(assertHstsRules, candidate, { reason: /expected/ });
  });
});

// ---------------------------------------------------------------------------------------------
// Through the pipeline: the effective scheme and the Host header of a real request
// ---------------------------------------------------------------------------------------------

function buildApp(env: Record<string, string>) {
  return () => {
    const config = configOf(env);
    const app = new Hono<AppEnv>();
    app.use(requestContext({ config }));
    app.use(securityHeaders({ config }));
    app.get('/page', (c) => c.html('<p>page</p>'));
    app.get('/api/v1/thing', (c) => c.json({ ok: true }));
    return app;
  };
}

async function strictTransport(
  env: Record<string, string>,
  options: {
    peer?: string;
    headers?: Record<string, string>;
    host?: string | null;
    path?: string;
  } = {},
): Promise<string | null> {
  const harness = await createTestApp({ buildApp: buildApp(env) });
  const client = harness.clientFor(options.peer === undefined ? {} : { peer: options.peer });
  const response = await client.get(options.path ?? '/api/v1/thing', {
    ...(options.headers === undefined ? {} : { headers: options.headers }),
    ...(options.host === undefined ? {} : { host: options.host }),
  });
  return response.headers.get('strict-transport-security');
}

describe('Strict-Transport-Security in the pipeline (FR-A-043)', () => {
  it('is sent over https from PUBLIC_BASE_URL, on a JSON response and on HTML', async () => {
    expect(await strictTransport(BASE, { host: DECLARED })).toBe(YEAR);
    expect(await strictTransport(BASE, { host: DECLARED, path: '/page' })).toBe(YEAR);
  });

  it('is not sent over http, and a forged X-Forwarded-Proto does not change that', async () => {
    expect(await strictTransport({}, {})).toBeNull();
    expect(await strictTransport({}, { headers: { 'x-forwarded-proto': 'https' } })).toBeNull();
  });

  it('is not sent for a forged X-Forwarded-Proto from a peer outside the trusted list', async () => {
    const env = { TRUST_PROXY: '10.0.0.0/8' };
    expect(
      await strictTransport(env, {
        peer: '203.0.113.9',
        headers: { 'x-forwarded-proto': 'https' },
      }),
    ).toBeNull();
  });

  it('is sent when a trusted proxy says https', async () => {
    const env = { TRUST_PROXY: '10.0.0.0/8' };
    expect(
      await strictTransport(env, { peer: '10.0.0.1', headers: { 'x-forwarded-proto': 'https' } }),
    ).toBe(YEAR);
    expect(
      await strictTransport({ TRUST_PROXY: '1' }, { headers: { 'x-forwarded-proto': 'https' } }),
    ).toBe(YEAR);
  });

  it('is not sent when the trusted proxy says http', async () => {
    const env = { TRUST_PROXY: '10.0.0.0/8' };
    expect(
      await strictTransport(env, { peer: '10.0.0.1', headers: { 'x-forwarded-proto': 'http' } }),
    ).toBeNull();
  });

  it('adds the flags only for the declared host, behind a trusted proxy as well', async () => {
    const env = {
      // Phase B: http is only possible for localhost (FR-B-103); the proxy says it was https.
      PUBLIC_BASE_URL: 'http://localhost:9300',
      TRUST_PROXY: '10.0.0.0/8',
      HSTS_INCLUDE_SUBDOMAINS: 'true',
    };
    const options = { peer: '10.0.0.1', headers: { 'x-forwarded-proto': 'https' } };
    expect(await strictTransport(env, { ...options, host: 'localhost' })).toBe(
      `${YEAR}; includeSubDomains`,
    );
    expect(await strictTransport(env, { ...options, host: 'alias.example.com' })).toBe(YEAR);
    expect(await strictTransport(env, { ...options, host: null })).toBe(YEAR);
  });

  it('follows the Host of the request: one app, two hosts, two answers', async () => {
    const harness = await createTestApp({ buildApp: buildApp(INCLUDE) });
    const declared = await harness.client.get('/api/v1/thing', { host: `${DECLARED}:8443` });
    const alias = await harness.client.get('/api/v1/thing', { host: 'alias.example.com' });
    const none = await harness.client.get('/api/v1/thing', { host: null });
    expect(declared.headers.get('strict-transport-security')).toBe(`${YEAR}; includeSubDomains`);
    expect(alias.headers.get('strict-transport-security')).toBe(YEAR);
    expect(none.headers.get('strict-transport-security')).toBe(YEAR);
  });
});

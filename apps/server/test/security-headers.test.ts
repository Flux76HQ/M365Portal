// T-A-028, FR-A-040 to FR-A-043, FR-A-047, FR-A-049, E-16, plan 8.1 and Appendix A: every response
// carries the security headers of its profile, whoever produced it.
//
// The three profiles are `html` (the shell and the offline page), `worker` (`/sw.js`) and `other`
// (everything else: API, images, health, errors). The guard `assertSecurityHeaders` states each
// profile once, as the plan writes it, and every response type of the server is run through it.
//
// Negative fixtures (tasks.md section 0.3): the guard is proven by taking a correct set of headers
// and removing each header in turn, then breaking the policy in each way FR-A-041 forbids. A guard
// that has never been seen to fail is an assumption.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TRUSTED_TYPES_POLICY_NAME } from '@m365portal/shared/limits';
import { expectGuardFails } from '@m365portal/shared/testing';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { loadConfigOrThrow } from '../src/config/index.js';
import { buildCsp, createNonce, OTHER_CSP, WORKER_CSP } from '../src/http/csp.js';
import { createErrorHandler, errorBoundary, notFoundHandler } from '../src/http/error-handler.js';
import { FEATURE_POLICY, DISABLED_FEATURES } from '../src/http/permissions-policy.js';
import { problemResponse } from '../src/http/problem.js';
import { requestContext, type AppEnv } from '../src/http/request-context.js';
import {
  headersForProfile,
  profileOf,
  rejectOptions,
  securityHeaders,
  type HeaderProfile,
} from '../src/http/security-headers.js';
import { createCaptureLogger } from './helpers/capture-logger.js';
import { createTestApp, type TestAppContext } from './helpers/test-app.js';

const planPath = fileURLToPath(new URL('../../../specs/001-m365portal/plan.md', import.meta.url));

// ---------------------------------------------------------------------------------------------
// The expectations, written out from plan 8.1 and Appendix A
// ---------------------------------------------------------------------------------------------

/** The policy of the shell, as plan 8.1 writes it. */
function expectedHtmlCsp(nonce: string | undefined, https: boolean): string {
  const token = nonce === undefined ? '' : ` 'nonce-${nonce}'`;
  return [
    "default-src 'none'",
    `script-src 'self'${token}`,
    `style-src 'self'${token}`,
    "img-src 'self'",
    "font-src 'self'",
    "connect-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "require-trusted-types-for 'script'",
    'trusted-types m365portal-sw',
    ...(https ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
}

const EXPECTED_WORKER_CSP = "default-src 'none'; connect-src 'self'; frame-ancestors 'none'";
const EXPECTED_OTHER_CSP = "default-src 'none'; frame-ancestors 'none'; sandbox";

const EVERY_PROFILE = {
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex, nofollow',
} as const;

const PROFILE_HEADERS: Readonly<Record<HeaderProfile, Readonly<Record<string, string>>>> = {
  html: {
    ...EVERY_PROFILE,
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-embedder-policy': 'require-corp',
    'x-frame-options': 'DENY',
  },
  worker: { ...EVERY_PROFILE, 'cross-origin-embedder-policy': 'require-corp' },
  other: { ...EVERY_PROFILE },
};

/** Headers that belong to one profile and must not appear on another (plan 8.1: "n/a"). */
const PROFILE_ONLY = [
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'x-frame-options',
] as const;

/** Never on any response (FR-A-040, FR-A-047). */
const NEVER = ['server', 'x-powered-by'] as const;

function planList(label: string): string[] {
  const text = readFileSync(planPath, 'utf8');
  const start = text.indexOf('## Appendix A.');
  const end = text.indexOf('## Appendix B.');
  if (start < 0 || end < 0) throw new Error('plan.md has no Appendix A');
  const line = text
    .slice(start, end)
    .split('\n')
    .find((candidate) => candidate.startsWith(`**${label}`));
  if (line === undefined) throw new Error(`plan.md Appendix A has no "${label}" line`);
  const names = [...line.matchAll(/`([a-z-]+)`/g)].map((match) => match[1] ?? '');
  if (names.length === 0) throw new Error(`plan.md Appendix A: "${label}" lists no names`);
  return names;
}

const INCLUDED = planList('Included (recognised)');
const RECOGNISED_NOT_SET = planList('Recognised but not set');
const NOT_RECOGNISED = planList('Not recognised by Chromium 141');

interface Expectation {
  readonly profile: HeaderProfile;
  readonly https: boolean;
  /** html only: does the policy carry the nonce of this request? The offline page does not. */
  readonly nonce?: 'present' | 'absent';
  /** The exact `Strict-Transport-Security` value, or `null` for none. Not checked when omitted. */
  readonly hsts?: string | null;
}

function directivesOf(policy: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const part of policy.split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name !== undefined && name !== '') directives.set(name, values);
  }
  return directives;
}

function nonceOf(policy: string): string | undefined {
  return /'nonce-([^']+)'/.exec(policy)?.[1];
}

/** Throws when `headers` are not the correct set for the expectation. */
function assertSecurityHeaders(input: { headers: Headers; expect: Expectation }): void {
  const { headers, expect: wanted } = input;
  const fail = (message: string): never => {
    throw new Error(`${wanted.profile}: ${message}`);
  };

  // Content-Security-Policy
  const policy = headers.get('content-security-policy');
  if (policy === null) return fail('no Content-Security-Policy');
  if (wanted.profile === 'html') {
    const nonce = nonceOf(policy);
    if (wanted.nonce === 'absent') {
      if (nonce !== undefined) fail('the policy carries a nonce');
      if (policy !== expectedHtmlCsp(undefined, wanted.https)) fail(`wrong policy: ${policy}`);
    } else {
      if (nonce === undefined) return fail('the policy carries no nonce');
      if (Buffer.from(nonce, 'base64').length < 16) fail('the nonce has fewer than 128 bits');
      if (policy !== expectedHtmlCsp(nonce, wanted.https)) fail(`wrong policy: ${policy}`);
    }
    // The properties of FR-A-041, checked on the parsed policy and not only on the string.
    const directives = directivesOf(policy);
    for (const name of ['script-src', 'style-src']) {
      for (const value of directives.get(name) ?? []) {
        if (/^'unsafe-(inline|eval)'$/.test(value)) fail(`${name} allows ${value}`);
        if (value === '*' || value.startsWith('data:') || value === 'https:' || value === 'http:') {
          fail(`${name} allows ${value}`);
        }
      }
    }
    if (directives.has('upgrade-insecure-requests') !== wanted.https) {
      fail('upgrade-insecure-requests must be present exactly over https');
    }
    if (directives.get('trusted-types')?.join(' ') !== TRUSTED_TYPES_POLICY_NAME) {
      fail('trusted-types must name the one policy');
    }
    if (directives.get('require-trusted-types-for')?.join(' ') !== "'script'") {
      fail("require-trusted-types-for 'script' is missing");
    }
  } else {
    const expectedPolicy = wanted.profile === 'worker' ? EXPECTED_WORKER_CSP : EXPECTED_OTHER_CSP;
    if (policy !== expectedPolicy) fail(`wrong policy: ${policy}`);
  }

  // The fixed headers of the profile, and the headers of the other profiles that must be absent.
  const fixed = PROFILE_HEADERS[wanted.profile];
  for (const [name, value] of Object.entries(fixed)) {
    const actual = headers.get(name);
    if (actual === null) fail(`${name} is missing`);
    if (actual !== value) fail(`${name} is ${String(actual)}, not ${value}`);
  }
  for (const name of PROFILE_ONLY) {
    if (!(name in fixed) && headers.has(name)) fail(`${name} does not belong to this profile`);
  }

  // Permissions-Policy: the verified list, `name=()` each, plus clipboard-write=(self).
  const features = headers.get('permissions-policy');
  if (features === null) fail('Permissions-Policy is missing');
  const tokens = (features ?? '').split(', ');
  const expectedTokens = [...INCLUDED.map((name) => `${name}=()`), 'clipboard-write=(self)'];
  if ([...tokens].sort().join('|') !== [...expectedTokens].sort().join('|')) {
    fail('Permissions-Policy is not the verified list of plan Appendix A');
  }

  // HSTS
  if (wanted.hsts !== undefined && headers.get('strict-transport-security') !== wanted.hsts) {
    fail(`Strict-Transport-Security is ${String(headers.get('strict-transport-security'))}`);
  }

  // Never.
  for (const name of NEVER) if (headers.has(name)) fail(`${name} is present`);
  for (const name of headers.keys()) {
    if (name.startsWith('access-control-')) fail(`${name} is present: no CORS (FR-A-047)`);
  }
}

// ---------------------------------------------------------------------------------------------
// The application under test: a route for every kind of response
// ---------------------------------------------------------------------------------------------

function fixtureApp(env: Record<string, string>) {
  return (context: TestAppContext): Hono<AppEnv> => {
    const config = loadConfigOrThrow(env);
    const handler = createErrorHandler({ log: createCaptureLogger(context.logs) });
    const app = new Hono<AppEnv>();
    app.use(requestContext({ config }));
    app.use(securityHeaders({ config }));
    app.use(rejectOptions());
    app.use(errorBoundary(handler));
    app.onError(handler);
    app.notFound(notFoundHandler);

    app.get('/api/v1/json', (c) => c.json({ ok: true }));
    app.get('/page', (c) => {
      const nonce = c.get('nonce')();
      return c.html(
        `<!doctype html><script nonce="${nonce}">1</script><style nonce="${nonce}"></style>`,
      );
    });
    app.get('/offline.html', (c) => c.html('<!doctype html><p>offline</p>'));
    app.get('/sw.js', (c) => c.body('self.skip = 1', 200, { 'content-type': 'text/javascript' }));
    app.get('/assets/app.js', (c) => c.body('1', 200, { 'content-type': 'text/javascript' }));
    app.get('/assets/app.css', (c) => c.body('a{}', 200, { 'content-type': 'text/css' }));
    app.get('/branding/logo.png', (c) => c.body('png', 200, { 'content-type': 'image/png' }));
    app.get('/robots.txt', (c) => c.text('User-agent: *\nDisallow: /\n'));
    app.get('/redirect', (c) => c.redirect('/page'));
    // `Response.redirect` has immutable headers: the middleware must not be defeated by that.
    app.get('/immutable-redirect', () => Response.redirect(`${context.publicOrigin}/page`, 302));
    app.get('/api/v1/method', (c) => problemResponse(c, 'method_not_allowed', { allow: ['GET'] }));
    app.get('/api/v1/too-large', (c) => problemResponse(c, 'payload_too_large'));
    app.get('/api/v1/limited', (c) => problemResponse(c, 'rate_limited', { retryAfterSeconds: 3 }));
    app.get('/api/v1/boom', () => {
      throw new Error('boom');
    });
    app.get('/api/v1/thrown-string', () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'a plain string';
    });
    // A handler or a library that sets what must never be sent.
    app.get('/api/v1/leaky', (c) =>
      c.json({ ok: true }, 200, {
        Server: 'Hono/4',
        'X-Powered-By': 'Express',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Expose-Headers': 'X-Request-Id',
        // A handler cannot weaken the policy of its profile, nor borrow a header of another one.
        'Content-Security-Policy': 'default-src *',
        'Cross-Origin-Opener-Policy': 'unsafe-none',
        'Cross-Origin-Embedder-Policy': 'unsafe-none',
        'X-Frame-Options': 'SAMEORIGIN',
        'Referrer-Policy': 'unsafe-url',
        'Permissions-Policy': 'camera=*',
        // An HSTS value no rule allowed: over http, or the flags on a host that was never declared.
        'Strict-Transport-Security': 'max-age=99999999; includeSubDomains; preload',
      }),
    );
    app.get('/leaky-page', (c) => {
      const nonce = c.get('nonce')();
      return c.html(`<!doctype html><script nonce="${nonce}">1</script>`, 200, {
        'Content-Security-Policy': "default-src * 'unsafe-inline' 'unsafe-eval'",
        'Cross-Origin-Opener-Policy': 'unsafe-none',
        'Cross-Origin-Embedder-Policy': 'unsafe-none',
        'X-Frame-Options': 'SAMEORIGIN',
        'X-Content-Type-Options': 'sniff',
        'Strict-Transport-Security': 'max-age=99999999; includeSubDomains; preload',
      });
    });
    return app;
  };
}

interface ResponseKind {
  readonly name: string;
  readonly method?: string;
  readonly path: string;
  readonly status: number;
  readonly profile: HeaderProfile;
  readonly nonce?: 'present' | 'absent';
  readonly headers?: Record<string, string>;
}

const KINDS: readonly ResponseKind[] = [
  { name: 'JSON', path: '/api/v1/json', status: 200, profile: 'other' },
  { name: 'HTML', path: '/page', status: 200, profile: 'html', nonce: 'present' },
  {
    name: 'HTML on HEAD',
    method: 'HEAD',
    path: '/page',
    status: 200,
    profile: 'html',
    nonce: 'present',
  },
  {
    name: 'the offline page',
    path: '/offline.html',
    status: 200,
    profile: 'html',
    nonce: 'absent',
  },
  { name: 'the service worker', path: '/sw.js', status: 200, profile: 'worker' },
  { name: 'a script', path: '/assets/app.js', status: 200, profile: 'other' },
  { name: 'a style sheet', path: '/assets/app.css', status: 200, profile: 'other' },
  { name: 'an image', path: '/branding/logo.png', status: 200, profile: 'other' },
  { name: 'robots.txt', path: '/robots.txt', status: 200, profile: 'other' },
  { name: 'a redirect', path: '/redirect', status: 302, profile: 'other' },
  {
    name: 'a redirect with immutable headers',
    path: '/immutable-redirect',
    status: 302,
    profile: 'other',
  },
  { name: 'a 404', path: '/api/v1/missing', status: 404, profile: 'other' },
  { name: 'a 405', path: '/api/v1/method', status: 405, profile: 'other' },
  { name: 'a 413', path: '/api/v1/too-large', status: 413, profile: 'other' },
  { name: 'a 429', path: '/api/v1/limited', status: 429, profile: 'other' },
  { name: 'a 500 from the error handler', path: '/api/v1/boom', status: 500, profile: 'other' },
  {
    name: 'a 500 from a thrown string',
    path: '/api/v1/thrown-string',
    status: 500,
    profile: 'other',
  },
  {
    name: 'a response that sets forbidden headers',
    path: '/api/v1/leaky',
    status: 200,
    profile: 'other',
  },
  {
    name: 'a page that sets its own security headers',
    path: '/leaky-page',
    status: 200,
    profile: 'html',
    nonce: 'present',
  },
  {
    name: 'a CORS preflight (answered 405)',
    method: 'OPTIONS',
    path: '/api/v1/json',
    status: 405,
    profile: 'other',
    headers: {
      origin: 'https://evil.example',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
  },
  {
    name: 'OPTIONS on an unknown path',
    method: 'OPTIONS',
    path: '/nowhere',
    status: 405,
    profile: 'other',
  },
];

const HTTPS_ENV = { PUBLIC_BASE_URL: 'https://panel.example.com' };

describe.each([
  ['http', {}, false],
  ['https', HTTPS_ENV, true],
] as const)('a response over %s carries the headers of its profile', (_scheme, env, https) => {
  it.each(KINDS.map((kind) => [kind.name, kind] as const))('%s', async (_name, kind) => {
    const harness = await createTestApp({ buildApp: fixtureApp(env) });
    const response = await harness.client.request(kind.method ?? 'GET', kind.path, {
      ...(kind.headers === undefined ? {} : { headers: kind.headers }),
      ...(https ? { host: 'panel.example.com' } : {}),
    });
    expect(response.status).toBe(kind.status);

    expect(() => {
      assertSecurityHeaders({
        headers: response.headers,
        expect: {
          profile: kind.profile,
          https,
          ...(kind.nonce === undefined ? {} : { nonce: kind.nonce }),
          hsts: https ? 'max-age=31536000' : null,
        },
      });
    }).not.toThrow();
  });
});

describe('profiles', () => {
  it.each([
    ['/sw.js', 'text/javascript', 'worker'],
    ['/sw.js', null, 'worker'],
    ['/sw.js/', 'text/javascript', 'other'],
    ['/sw.js.map', 'application/json', 'other'],
    ['/x/sw.js', 'text/javascript', 'other'],
    ['/page', 'text/html; charset=UTF-8', 'html'],
    ['/page', 'TEXT/HTML', 'html'],
    ['/api/v1/json', 'application/json', 'other'],
    ['/api/v1/missing', 'application/problem+json', 'other'],
    ['/assets/app.js', 'text/javascript', 'other'],
    ['/anything', null, 'other'],
    ['/anything', 'text/plain', 'other'],
    ['/anything', 'text/html-sandboxed', 'other'],
  ] as const)('%s with %s is %s', (path, contentType, profile) => {
    expect(profileOf(path, contentType)).toBe(profile);
  });

  it('gives the shell, the worker and everything else three different policies', () => {
    const html = headersForProfile({ profile: 'html', nonce: createNonce(), https: false });
    const worker = headersForProfile({ profile: 'worker', nonce: undefined, https: false });
    const other = headersForProfile({ profile: 'other', nonce: undefined, https: false });
    expect(
      new Set([
        html['Content-Security-Policy'],
        worker['Content-Security-Policy'],
        other['Content-Security-Policy'],
      ]).size,
    ).toBe(3);
    expect(worker['Content-Security-Policy']).toBe(WORKER_CSP);
    expect(other['Content-Security-Policy']).toBe(OTHER_CSP);
    expect(WORKER_CSP).toBe(EXPECTED_WORKER_CSP);
    expect(OTHER_CSP).toBe(EXPECTED_OTHER_CSP);
  });

  it('puts COOP and X-Frame-Options on html only, and COEP on html and worker only', () => {
    const names = (profile: HeaderProfile): string[] =>
      Object.keys(headersForProfile({ profile, nonce: undefined, https: false })).map((n) =>
        n.toLowerCase(),
      );
    expect(names('html')).toEqual(expect.arrayContaining([...PROFILE_ONLY]));
    expect(names('worker')).toContain('cross-origin-embedder-policy');
    expect(names('worker')).not.toContain('cross-origin-opener-policy');
    expect(names('worker')).not.toContain('x-frame-options');
    for (const name of PROFILE_ONLY) expect(names('other')).not.toContain(name);
  });

  it('adds Strict-Transport-Security only when it is handed one', () => {
    expect(
      headersForProfile({
        profile: 'other',
        nonce: undefined,
        https: true,
        strictTransport: 'max-age=1',
      })['Strict-Transport-Security'],
    ).toBe('max-age=1');
    expect(
      'Strict-Transport-Security' in
        headersForProfile({ profile: 'other', nonce: undefined, https: true }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// The nonce (FR-A-041)
// ---------------------------------------------------------------------------------------------

describe('the nonce', () => {
  it('is fresh for every request, at least 128 bits, and the one the page was given', async () => {
    const harness = await createTestApp({ buildApp: fixtureApp({}) });
    const nonces: string[] = [];
    for (let request = 0; request < 25; request += 1) {
      const response = await harness.client.get('/page');
      const nonce = nonceOf(response.headers.get('content-security-policy') ?? '');
      expect(nonce).toBeDefined();
      expect(Buffer.from(nonce ?? '', 'base64').length).toBeGreaterThanOrEqual(16);
      // The handler drew the nonce through the context: the page and the policy agree.
      const body = await response.text();
      expect(body).toContain(`<script nonce="${nonce ?? ''}">`);
      expect(body).toContain(`<style nonce="${nonce ?? ''}">`);
      nonces.push(nonce ?? '');
    }
    expect(new Set(nonces).size).toBe(25);
  });

  it('is base64 and is never reused between two draws', () => {
    const drawn = new Set(Array.from({ length: 500 }, () => createNonce()));
    expect(drawn.size).toBe(500);
    for (const nonce of drawn) expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });

  it('is drawn once per request, however often the page asks', async () => {
    const harness = await createTestApp({
      buildApp: (context) => {
        const config = loadConfigOrThrow({});
        const app = new Hono<AppEnv>();
        app.use(requestContext({ config }));
        app.use(securityHeaders({ config }));
        app.get('/twice', (c) => c.html(`${c.get('nonce')()}|${c.get('nonce')()}`));
        expect(context.dataDir).toBeTruthy();
        return app;
      },
    });
    const response = await harness.client.get('/twice');
    const [first, second] = (await response.text()).split('|');
    expect(first).toBe(second);
    expect(response.headers.get('content-security-policy')).toContain(`'nonce-${first ?? ''}'`);
  });

  it('is not drawn for a response that is not html', async () => {
    const harness = await createTestApp({ buildApp: fixtureApp({}) });
    const response = await harness.client.get('/api/v1/json');
    expect(response.headers.get('content-security-policy')).not.toContain('nonce');
  });

  it('is shown in no log and no other header', async () => {
    const harness = await createTestApp({ buildApp: fixtureApp({}) });
    const response = await harness.client.get('/page');
    const nonce = nonceOf(response.headers.get('content-security-policy') ?? '') ?? '';
    for (const [name, value] of response.headers) {
      if (name === 'content-security-policy') continue;
      expect(value, name).not.toContain(nonce);
    }
    expect(harness.logs.text()).not.toContain(nonce);
  });
});

describe('buildCsp, the one function that builds the policy (FR-A-041)', () => {
  it('builds the shell policy of plan 8.1 for both schemes', () => {
    const nonce = createNonce();
    expect(buildCsp({ nonce, https: false })).toBe(expectedHtmlCsp(nonce, false));
    expect(buildCsp({ nonce, https: true })).toBe(expectedHtmlCsp(nonce, true));
    expect(buildCsp({ nonce: undefined, https: false })).toBe(expectedHtmlCsp(undefined, false));
  });

  it('names the Trusted Types policy of the shared package', () => {
    expect(buildCsp({ nonce: undefined, https: false })).toContain(
      `trusted-types ${TRUSTED_TYPES_POLICY_NAME}`,
    );
    expect(TRUSTED_TYPES_POLICY_NAME).toBe('m365portal-sw');
  });

  it('adds upgrade-insecure-requests only over https', () => {
    expect(buildCsp({ nonce: undefined, https: true })).toContain('upgrade-insecure-requests');
    expect(buildCsp({ nonce: undefined, https: false })).not.toContain('upgrade-insecure-requests');
  });

  it('allows no unsafe-inline, unsafe-eval, wildcard or data: in script-src or style-src', () => {
    for (const https of [false, true]) {
      const directives = directivesOf(buildCsp({ nonce: createNonce(), https }));
      for (const name of ['script-src', 'style-src']) {
        const values = directives.get(name) ?? [];
        expect(values[0]).toBe("'self'");
        expect(values).toHaveLength(2);
        expect(values.join(' ')).not.toMatch(/unsafe-|\*|data:|blob:|https?:/);
      }
      expect(directives.get('default-src')).toEqual(["'none'"]);
    }
  });

  it('refuses a nonce that could break out of the header', () => {
    for (const nonce of ["a'; script-src *", 'abc\r\nSet-Cookie: x=1', '', 'short', 'a b']) {
      expect(() => buildCsp({ nonce, https: false })).toThrow(/nonce/);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Permissions-Policy (plan Appendix A)
// ---------------------------------------------------------------------------------------------

describe('the Permissions-Policy header', () => {
  it('is the list verified in Chromium 141 (plan Appendix A): each name disabled, plus clipboard-write=(self)', () => {
    expect([...DISABLED_FEATURES].sort()).toEqual([...INCLUDED].sort());
    const tokens = FEATURE_POLICY.split(', ');
    expect(tokens).toHaveLength(INCLUDED.length + 1);
    for (const name of INCLUDED) expect(tokens).toContain(`${name}=()`);
    expect(tokens).toContain('clipboard-write=(self)');
  });

  it('holds no name that Chromium 141 does not recognise: a console warning fails every e2e test', () => {
    const names = FEATURE_POLICY.split(', ').map((token) => token.split('=')[0]);
    for (const unknown of NOT_RECOGNISED) expect(names).not.toContain(unknown);
  });

  it('leaves out the names that are recognised but not capabilities', () => {
    const names = FEATURE_POLICY.split(', ').map((token) => token.split('=')[0]);
    for (const skipped of RECOGNISED_NOT_SET) expect(names).not.toContain(skipped);
  });

  it('has the structured-header shape: name=() and one name=(self)', () => {
    for (const token of FEATURE_POLICY.split(', ')) {
      expect(token).toMatch(/^[a-z]+(?:-[a-z]+)*=(?:\(\)|\(self\))$/);
    }
    expect(FEATURE_POLICY.split(', ').filter((token) => token.endsWith('(self)'))).toEqual([
      'clipboard-write=(self)',
    ]);
  });

  it('names no feature twice', () => {
    expect(new Set(DISABLED_FEATURES).size).toBe(DISABLED_FEATURES.length);
  });

  it('is on every profile', () => {
    for (const profile of ['html', 'worker', 'other'] as const) {
      const headers = headersForProfile({ profile, nonce: undefined, https: false });
      expect(headers['Permissions-Policy']).toBe(FEATURE_POLICY);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// No CORS, no Server header (FR-A-040, FR-A-047, FR-A-049)
// ---------------------------------------------------------------------------------------------

describe('no CORS, no Server, X-Robots-Tag everywhere', () => {
  it('removes the Server, X-Powered-By and Access-Control-* headers a handler set', async () => {
    const harness = await createTestApp({ buildApp: fixtureApp({}) });
    const response = await harness.client.get('/api/v1/leaky');
    expect(response.status).toBe(200);
    for (const name of ['server', 'x-powered-by']) expect(response.headers.has(name)).toBe(false);
    expect(
      [...response.headers.keys()].filter((name) => name.startsWith('access-control-')),
    ).toEqual([]);
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(await response.json()).toEqual({ ok: true });
  });

  it('does not answer a preflight: OPTIONS is a 405 problem with Allow and no CORS header', async () => {
    const harness = await createTestApp({ buildApp: fixtureApp({}) });
    const response = await harness.client.request('OPTIONS', '/api/v1/json', {
      headers: {
        origin: 'https://evil.example',
        'access-control-request-method': 'DELETE',
      },
    });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    expect(
      [...response.headers.keys()].filter((name) => name.startsWith('access-control-')),
    ).toEqual([]);
    expect(await response.json()).toMatchObject({ code: 'method_not_allowed', status: 405 });
  });

  it('takes the Allow list from the route table, when it is given one', async () => {
    const harness = await createTestApp({
      buildApp: () => {
        const config = loadConfigOrThrow({});
        const app = new Hono<AppEnv>();
        app.use(requestContext({ config }));
        app.use(securityHeaders({ config }));
        app.use(
          rejectOptions((request) =>
            new URL(request.url).pathname === '/rw' ? ['GET', 'PUT', 'HEAD'] : ['GET'],
          ),
        );
        return app;
      },
    });
    const rw = await harness.client.request('OPTIONS', '/rw');
    expect(rw.headers.get('allow')).toBe('GET, HEAD, PUT');
    const other = await harness.client.request('OPTIONS', '/other');
    expect(other.headers.get('allow')).toBe('GET');
  });

  it('serves a robots.txt that disallows everything (FR-A-049)', async () => {
    const harness = await createTestApp({ buildApp: fixtureApp({}) });
    const response = await harness.client.get('/robots.txt');
    expect(await response.text()).toContain('Disallow: /');
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });
});

// ---------------------------------------------------------------------------------------------
// The guard fails on purpose (negative fixtures)
// ---------------------------------------------------------------------------------------------

describe('the headers guard (negative fixtures)', () => {
  const nonce = createNonce();

  function good(profile: HeaderProfile, https: boolean): Headers {
    const headers = headersForProfile({
      profile,
      nonce: profile === 'html' ? nonce : undefined,
      https,
    });
    return new Headers(headers);
  }

  const expectationFor = (profile: HeaderProfile, https: boolean): Expectation => ({
    profile,
    https,
    ...(profile === 'html' ? { nonce: 'present' as const } : {}),
  });

  it.each([
    ['html', false],
    ['html', true],
    ['worker', false],
    ['other', true],
  ] as const)('accepts the correct %s headers (https %s)', (profile, https) => {
    expect(() => {
      assertSecurityHeaders({
        headers: good(profile, https),
        expect: expectationFor(profile, https),
      });
    }).not.toThrow();
  });

  describe.each(['html', 'worker', 'other'] as const)(
    'removing a header from the %s profile',
    (profile) => {
      const names = [...good(profile, false).keys()];
      it.each(names)('fails without %s', (name) => {
        const headers = good(profile, false);
        headers.delete(name);
        expectGuardFails(
          assertSecurityHeaders,
          { headers, expect: expectationFor(profile, false) },
          {
            reason: profile,
          },
        );
      });
    },
  );

  it('fails when the policy has no nonce, a reused nonce of 64 bits, or the wrong nonce position', () => {
    const noNonce = good('html', false);
    noNonce.set('content-security-policy', expectedHtmlCsp(undefined, false));
    expectGuardFails(
      assertSecurityHeaders,
      { headers: noNonce, expect: expectationFor('html', false) },
      {
        reason: 'carries no nonce',
      },
    );

    const short = good('html', false);
    short.set(
      'content-security-policy',
      expectedHtmlCsp(Buffer.alloc(8, 7).toString('base64'), false),
    );
    expectGuardFails(
      assertSecurityHeaders,
      { headers: short, expect: expectationFor('html', false) },
      {
        reason: 'fewer than 128 bits',
      },
    );
  });

  it.each([
    [
      'unsafe-inline in script-src',
      (p: string) => p.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"),
      /wrong policy|unsafe-inline/,
    ],
    [
      'unsafe-eval in script-src',
      (p: string) => p.replace("script-src 'self'", "script-src 'self' 'unsafe-eval'"),
      /wrong policy|unsafe-eval/,
    ],
    [
      'unsafe-inline in style-src',
      (p: string) => p.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'"),
      /wrong policy|unsafe-inline/,
    ],
    [
      'a wildcard in script-src',
      (p: string) => p.replace("script-src 'self'", "script-src * 'self'"),
      /wrong policy|allows \*/,
    ],
    [
      'data: in script-src',
      (p: string) => p.replace("script-src 'self'", "script-src 'self' data:"),
      /wrong policy|data:/,
    ],
    [
      'data: in style-src',
      (p: string) => p.replace("style-src 'self'", "style-src 'self' data:"),
      /wrong policy|data:/,
    ],
    [
      'default-src open',
      (p: string) => p.replace("default-src 'none'", "default-src 'self'"),
      /wrong policy/,
    ],
    [
      'no Trusted Types',
      (p: string) => p.replace("; require-trusted-types-for 'script'", ''),
      /wrong policy|require-trusted-types-for/,
    ],
    [
      'another Trusted Types policy',
      (p: string) => p.replace('trusted-types m365portal-sw', 'trusted-types default'),
      /wrong policy|trusted-types/,
    ],
    [
      'frames allowed',
      (p: string) => p.replace("frame-ancestors 'none'", "frame-ancestors 'self'"),
      /wrong policy/,
    ],
  ] as const)('fails for %s', (_name, mutate, reason) => {
    const headers = good('html', false);
    headers.set('content-security-policy', mutate(headers.get('content-security-policy') ?? ''));
    expectGuardFails(
      assertSecurityHeaders,
      { headers, expect: expectationFor('html', false) },
      { reason },
    );
  });

  it('fails for upgrade-insecure-requests over http, and without it over https', () => {
    const overHttp = good('html', false);
    overHttp.set('content-security-policy', expectedHtmlCsp(nonce, true));
    expectGuardFails(
      assertSecurityHeaders,
      { headers: overHttp, expect: expectationFor('html', false) },
      {
        reason: /wrong policy|upgrade-insecure-requests/,
      },
    );
    const overHttps = good('html', false);
    expectGuardFails(
      assertSecurityHeaders,
      { headers: overHttps, expect: expectationFor('html', true) },
      {
        reason: /wrong policy|upgrade-insecure-requests/,
      },
    );
  });

  it.each([
    ['Server', 'Hono'],
    ['X-Powered-By', 'Express'],
    ['Access-Control-Allow-Origin', '*'],
    ['Access-Control-Allow-Methods', 'GET'],
  ])('fails when %s is present', (name, value) => {
    const headers = good('other', false);
    headers.set(name, value);
    expectGuardFails(
      assertSecurityHeaders,
      { headers, expect: expectationFor('other', false) },
      {
        reason: /is present/,
      },
    );
  });

  it('fails for a header with the wrong value', () => {
    for (const [name, value] of [
      ['referrer-policy', 'origin'],
      ['x-content-type-options', 'sniff'],
      ['cross-origin-resource-policy', 'cross-origin'],
      ['x-robots-tag', 'noindex'],
    ] as const) {
      const headers = good('other', false);
      headers.set(name, value);
      expectGuardFails(
        assertSecurityHeaders,
        { headers, expect: expectationFor('other', false) },
        {
          reason: name,
        },
      );
    }
  });

  it('fails when a header of another profile leaks into this one', () => {
    for (const name of PROFILE_ONLY) {
      const headers = good('other', false);
      headers.set(name, 'x');
      expectGuardFails(
        assertSecurityHeaders,
        { headers, expect: expectationFor('other', false) },
        {
          reason: 'does not belong to this profile',
        },
      );
    }
  });

  it('fails when the Permissions-Policy loses a name, gains one, or loses the clipboard exception', () => {
    const features = good('other', false).get('permissions-policy') ?? '';
    const variants = [
      features.replace('camera=(), ', ''),
      `${features}, battery=()`,
      features.replace(', clipboard-write=(self)', ''),
      features.replace('clipboard-write=(self)', 'clipboard-write=()'),
    ];
    for (const variant of variants) {
      const headers = good('other', false);
      headers.set('permissions-policy', variant);
      expectGuardFails(
        assertSecurityHeaders,
        { headers, expect: expectationFor('other', false) },
        {
          reason: 'Permissions-Policy',
        },
      );
    }
  });

  it('fails when Strict-Transport-Security is missing over https or present over http', () => {
    expectGuardFails(
      assertSecurityHeaders,
      {
        headers: good('other', true),
        expect: { ...expectationFor('other', true), hsts: 'max-age=31536000' },
      },
      { reason: 'Strict-Transport-Security' },
    );
    const withHsts = good('other', false);
    withHsts.set('strict-transport-security', 'max-age=31536000');
    expectGuardFails(
      assertSecurityHeaders,
      { headers: withHsts, expect: { ...expectationFor('other', false), hsts: null } },
      { reason: 'Strict-Transport-Security' },
    );
  });
});

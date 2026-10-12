// The routing decision of the service worker (FR-A-140, PD-17, E-08): an allow-list over the decoded,
// normalised path. The table below is hostile on purpose: no spelling of /api may be anything but
// `pass`, and nothing outside the two cache patterns may be cache-first.
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import { decideRoute, type RouteDecision } from '../src/sw/routing';

const ORIGIN = 'https://panel.example';
const HASH = 'a'.repeat(64);

function decide(path: string, mode: RequestMode = 'no-cors', method = 'GET', origin = ORIGIN) {
  return decideRoute({ url: `${ORIGIN}${path}`, mode, method }, origin);
}

describe('decideRoute: the allowed cases', () => {
  it.each([
    ['/assets/index-abc123.js', 'cache-first'],
    ['/assets/inter-latin-wght-normal-Dx9.woff2', 'cache-first'],
    ['/assets/a.b_c-d.css', 'cache-first'],
    [`/branding/${HASH}.png`, 'cache-first'],
    ['/offline.css', 'cache-first'],
    ['/offline.js', 'cache-first'],
    ['/assets/x.js?v=1', 'cache-first'],
    ['/assets/x.js#frag', 'cache-first'],
  ] as [string, RouteDecision][])('%s is %s', (path, expected) => {
    expect(decide(path)).toBe(expected);
  });

  it.each(['/', '/users', '/settings/appearance', '/some/deep/page', '/offline.html'])(
    'a navigation to %s is navigate',
    (path) => {
      expect(decide(path, 'navigate')).toBe('navigate');
    },
  );

  it('does not depend on the request mode for an asset', () => {
    for (const mode of ['cors', 'no-cors', 'same-origin'] as const) {
      expect(decide('/assets/x.js', mode)).toBe('cache-first');
    }
  });
});

describe('decideRoute: /api in every spelling is pass', () => {
  const spellings = [
    '/api',
    '/api/v1/me',
    '/api/',
    '/API/v1/me',
    '/Api/v1/me',
    '/%61pi/v1/me',
    '/%41PI/v1/me',
    '/api%2Fv1/me',
    '/api%2fv1/me',
    '/%2561pi/v1/me',
    '/%252561pi/v1/me',
    '//api/v1/me',
    '///api/v1/me',
    '/\\api/v1/me',
    '/%5capi/v1/me',
    '/assets/..%2fapi/x',
    '/assets/%2e%2e/api/x',
    '/assets/../api/v1/me',
    '/assets/./../api/v1/me',
    '/api./v1/me',
    '/api../v1/me',
    '/api%00/x',
    '/api;x=1/v1/me',
    '/./api/v1/me',
    '/x/../api/v1/me',
    `/branding/..%2f..%2fapi/v1/me`,
  ];

  for (const mode of ['navigate', 'cors', 'no-cors', 'same-origin'] as const) {
    it.each(spellings)(`%s is pass (mode ${mode})`, (path) => {
      expect(decide(path, mode)).toBe('pass');
    });
  }

  it('is pass for every method', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD', 'get', 'Get']) {
      expect(decide('/api/v1/me', 'cors', method)).toBe('pass');
    }
  });
});

describe('decideRoute: everything that is not on the allow-list is pass', () => {
  it.each([
    '/assets',
    '/assets/',
    '/assets/sub/x.js',
    '/assets/%78.js',
    '/assets/x%2ejs',
    '/assets/x.js%00',
    '/assets/x js',
    '/assets/..',
    '/assets/x\\y.js',
    '/ASSETS/x.js',
    '/assets//x.js',
    '//assets/x.js',
    '/assets/x.js/',
    `/branding/${'A'.repeat(64)}.png`,
    `/branding/${'a'.repeat(63)}.png`,
    `/branding/${'a'.repeat(65)}.png`,
    `/branding/${HASH}.svg`,
    `/branding/${HASH}.png/`,
    `/branding/${HASH}.PNG`,
    `/branding/sub/${HASH}.png`,
    '/branding',
    '/branding/',
    '/branding/current.png',
    '/manifest.webmanifest',
    '/favicon.ico',
    '/sw.js',
    '/offline.html',
    '/offline.css/',
    '/offline.js.map',
    '/Offline.css',
    '/x/offline.css',
    '/healthz',
  ])('the subresource %s is pass', (path) => {
    expect(decide(path)).toBe('pass');
  });

  it('is pass for a non-GET method', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
      expect(decide('/assets/x.js', 'cors', method)).toBe('pass');
      expect(decide(`/branding/${HASH}.png`, 'cors', method)).toBe('pass');
      expect(decide('/users', 'navigate', method)).toBe('pass');
    }
  });

  it('is pass for another origin, whatever the path', () => {
    for (const url of [
      'https://evil.example/assets/x.js',
      'http://panel.example/assets/x.js',
      'https://panel.example:8443/assets/x.js',
      'https://panel.example.evil.example/assets/x.js',
      'https://user@evil.example/assets/x.js',
    ]) {
      expect(decideRoute({ url, mode: 'cors', method: 'GET' }, ORIGIN)).toBe('pass');
      expect(decideRoute({ url, mode: 'navigate', method: 'GET' }, ORIGIN)).toBe('pass');
    }
  });

  it('is pass for a url it cannot parse or a scheme that is not http(s)', () => {
    for (const url of [
      '',
      'not a url',
      'blob:https://panel.example/uuid',
      'data:text/plain,x',
      'chrome-extension://abc/assets/x.js',
    ]) {
      expect(decideRoute({ url, mode: 'no-cors', method: 'GET' }, ORIGIN)).toBe('pass');
    }
  });
});

describe('decideRoute: navigations', () => {
  it('are navigate for GET on this origin, never cache-first', () => {
    expect(decide('/assets/x.js', 'navigate')).toBe('navigate');
    expect(decide(`/branding/${HASH}.png`, 'navigate')).toBe('navigate');
  });

  it('never claim an API path, a healthcheck or the worker itself', () => {
    expect(decide('/api/v1/me', 'navigate')).toBe('pass');
    expect(decide('/sw.js', 'navigate')).toBe('pass');
  });
});

// ---------------------------------------------------------------------------------------------
// Phase B (T-B-299; FR-B-417 web half; AM-12, PB-18): the sign-in flow never goes through the worker
// ---------------------------------------------------------------------------------------------

describe('decideRoute: /auth in every spelling is pass (the redirects and cookies of the sign-in flow)', () => {
  const spellings = [
    '/auth',
    '/auth/',
    '/auth/login',
    '/auth/login?returnTo=%2Fusers&prompt=login',
    '/auth/callback?code=abc&state=def',
    '/auth/logged-out',
    '/AUTH/login',
    '/Auth/Callback',
    '/%61uth/login',
    '/%41UTH/login',
    '/auth%2Flogin',
    '/auth%2flogin',
    '/%2561uth/login',
    '/%252561uth/login',
    '//auth/login',
    '///auth/login',
    '/\\auth/login',
    '/%5cauth/login',
    '/auth./login',
    '/auth../login',
    '/auth%00/x',
    '/auth;x=1/login',
    '/./auth/login',
    '/x/../auth/login',
    '/assets/..%2fauth/x',
    '/assets/%2e%2e/auth/x',
    '/assets/../auth/login',
    `/branding/..%2f..%2fauth/login`,
  ];

  for (const mode of ['navigate', 'cors', 'no-cors', 'same-origin'] as const) {
    it.each(spellings)(`%s is pass (mode ${mode})`, (path) => {
      expect(decide(path, mode)).toBe('pass');
    });
  }

  it('is pass for every method', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD', 'get', 'Get']) {
      expect(decide('/auth/login', 'cors', method)).toBe('pass');
      expect(decide('/auth/callback', 'navigate', method)).toBe('pass');
    }
  });
});

describe('decideRoute: the public pages are network-first navigations, never a cache hit', () => {
  it.each([
    '/signin',
    '/signin?error=session_expired&returnTo=%2Fusers',
    '/signin?signedout=1',
    '/setup',
    '/setup/anything',
    '/no-access',
    '/no-access?reason=no_role&ref=req-0123456789',
    '/break-glass',
  ])('a navigation to %s is navigate', (path) => {
    expect(decide(path, 'navigate')).toBe('navigate');
  });

  it.each(['/signin', '/setup', '/setup/anything', '/no-access', '/break-glass'])(
    'a subresource request for %s is pass',
    (path) => {
      for (const mode of ['cors', 'no-cors', 'same-origin'] as const) {
        expect(decide(path, mode)).toBe('pass');
      }
    },
  );
});

describe('decideRoute: hostile encodings of /auth/, /api/ and /setup never reach a cache branch', () => {
  // The cache branch is `cache-first`: a response stored under a spelling of these paths would be served
  // to the next visitor without the server. Whatever the mode, none may decide it.
  const bases = ['auth', 'api', 'setup', 'signin'];
  const variants = (base: string): string[] => {
    const upper = base.toUpperCase();
    const first = base.charCodeAt(0).toString(16);
    const doubleEncoded = `%25${first}${base.slice(1)}`;
    return [
      `/${base}`,
      `/${upper}`,
      `/${base[0]?.toUpperCase() ?? ''}${base.slice(1)}`,
      `/%${first}${base.slice(1)}`,
      `/%${first.toUpperCase()}${base.slice(1)}`,
      `/${doubleEncoded}`,
      `/%25${doubleEncoded.slice(1)}`,
      `/${base}%2F`,
      `/${base}%2f..%2fassets%2fx.js`,
      `/${base}.`,
      `/${base}..`,
      `/${base}%2e`,
      `/\\${base}`,
      `/%5c${base}`,
      `//${base}`,
      `/./${base}`,
      `/x/../${base}`,
      `/assets/..%2f${base}`,
      `/assets/../${base}`,
      `/branding/..%2f${base}`,
      `/${base}/..%2f..%2fassets/x.js`,
      `/assets/x.js/../../${base}`,
    ];
  };

  for (const base of bases) {
    for (const path of variants(base)) {
      it(`${path} is never cache-first`, () => {
        for (const mode of ['navigate', 'cors', 'no-cors', 'same-origin'] as const) {
          expect(decide(path, mode), `${path} (${mode})`).not.toBe('cache-first');
        }
      });
    }
  }
});

describe('a router that stores a page of the sign-in flow fails the guard (+ negative)', () => {
  const paths = [
    '/signin',
    '/signin?error=x',
    '/setup',
    '/setup/anything',
    '/no-access',
    '/break-glass',
  ];

  /** The guard: no page of the flow may be decided `cache-first`, and `/auth/*` and `/api/*` must be `pass`. */
  function assertSafe(decideFunction: (path: string, mode: RequestMode) => RouteDecision): void {
    for (const path of paths) {
      if (decideFunction(path, 'navigate') === 'cache-first')
        throw new Error(`${path} would be cached`);
    }
    for (const path of ['/auth/login', '/auth/callback?code=x', '/api/v1/me']) {
      if (decideFunction(path, 'navigate') !== 'pass') throw new Error(`${path} must be pass`);
    }
  }

  it('passes for the real router', () => {
    expect(() => {
      assertSafe((path, mode) => decide(path, mode));
    }).not.toThrow();
  });

  it('fails for a router that caches a navigation to /signin', () => {
    expectGuardFails(
      assertSafe,
      (path, mode) => (path.startsWith('/signin') ? 'cache-first' : decide(path, mode)),
      { name: 'service-worker routing', reason: '/signin would be cached' },
    );
  });

  it('fails for a router that answers /auth/* itself', () => {
    expectGuardFails(
      assertSafe,
      (path, mode) => (path.startsWith('/auth/') ? 'navigate' : decide(path, mode)),
      { name: 'service-worker routing', reason: '/auth/login must be pass' },
    );
  });
});

// T-B-006, FR-B-401 (shared half), FR-B-713, CB4: the names and attributes of the three cookies are
// built in one place, `src/auth/cookies.ts`, from `PUBLIC_BASE_URL` (spec 6.9.3).
//
// The matrix below is written out again from the spec table and is run through a guard that throws
// on any deviation. The guard is proven with negative fixtures (tasks.md section 0.3): an
// implementation that drops the `__Host-` prefix on https, one that sets `Domain`, one that leaves
// `Secure` on `http://localhost`, and so on, must each fail it.
import { describe, expect, it } from 'vitest';
import {
  COOKIE_KINDS,
  cookieNames,
  serializeCookie,
  serializeCookieDeletion,
  type CookieKind,
} from '../src/auth/cookies.js';
import { expectGuardFails } from '../src/testing/index.js';

/** 43 base64url characters: 256 bits (FR-B-401). */
const VALUE = 'Zm9vYmFyYmF6cXV4MDEyMzQ1Njc4OWFiY2RlZmdoaWo';
const HTTPS = 'https://panel.example.org';
const LOCALHOST = 'http://localhost:9300';

interface CookieApi {
  readonly cookieNames: (publicBaseUrl: string) => Readonly<Record<CookieKind, string>>;
  readonly serializeCookie: (kind: CookieKind, value: string, publicBaseUrl: string) => string;
  readonly serializeCookieDeletion: (kind: CookieKind, publicBaseUrl: string) => string;
}

const REAL: CookieApi = { cookieNames, serializeCookie, serializeCookieDeletion };

/** Spec 6.9.3, one row per cookie: the names on https and on localhost, the attributes. */
const MATRIX: Readonly<
  Record<
    CookieKind,
    {
      readonly https: string;
      readonly plain: string;
      readonly sameSite: 'Strict' | 'Lax';
      readonly maxAge: number | undefined;
    }
  >
> = {
  session: {
    https: '__Host-m365portal_session',
    plain: 'm365portal_session',
    sameSite: 'Strict',
    maxAge: undefined,
  },
  oidc: {
    https: '__Host-m365portal_oidc',
    plain: 'm365portal_oidc',
    sameSite: 'Lax',
    maxAge: 600,
  },
  setup: {
    https: '__Host-m365portal_setup',
    plain: 'm365portal_setup',
    sameSite: 'Strict',
    maxAge: undefined,
  },
};

function attributesOf(header: string): string[] {
  return header
    .split('; ')
    .slice(1)
    .map((part) => part.trim());
}

/** Throws unless `api` produces exactly the cookies of spec 6.9.3. */
function assertCookieMatrix(api: CookieApi): void {
  const problems: string[] = [];
  for (const [baseUrl, secure] of [
    [HTTPS, true],
    [LOCALHOST, false],
    ['http://localhost', false],
  ] as const) {
    const names = api.cookieNames(baseUrl);
    for (const kind of COOKIE_KINDS) {
      const row = MATRIX[kind];
      const expectedName = secure ? row.https : row.plain;
      if (names[kind] !== expectedName) {
        problems.push(`${baseUrl}: ${kind} is named ${names[kind]}, expected ${expectedName}`);
      }
      const header = api.serializeCookie(kind, VALUE, baseUrl);
      const attributes = attributesOf(header);
      const lower = attributes.map((attribute) => attribute.toLowerCase());
      if (!header.startsWith(`${expectedName}=${VALUE};`)) {
        problems.push(`${baseUrl}: ${kind} does not start with name=value`);
      }
      if (!attributes.includes('HttpOnly')) problems.push(`${baseUrl}: ${kind} lacks HttpOnly`);
      if (!attributes.includes('Path=/')) problems.push(`${baseUrl}: ${kind} lacks Path=/`);
      if (lower.some((attribute) => attribute.startsWith('domain'))) {
        problems.push(`${baseUrl}: ${kind} sets Domain`);
      }
      if (lower.some((attribute) => attribute.startsWith('expires'))) {
        problems.push(`${baseUrl}: ${kind} sets Expires`);
      }
      if (attributes.includes('Secure') !== secure) {
        problems.push(
          `${baseUrl}: ${kind} has Secure ${String(!secure)}, expected ${String(secure)}`,
        );
      }
      if (!attributes.includes(`SameSite=${row.sameSite}`)) {
        problems.push(`${baseUrl}: ${kind} lacks SameSite=${row.sameSite}`);
      }
      const maxAge = attributes.find((attribute) => attribute.toLowerCase().startsWith('max-age='));
      if (
        row.maxAge === undefined ? maxAge !== undefined : maxAge !== `Max-Age=${String(row.maxAge)}`
      ) {
        problems.push(
          `${baseUrl}: ${kind} has ${maxAge ?? 'no Max-Age'}, expected ${String(row.maxAge)}`,
        );
      }

      // Deleting repeats every attribute and adds Max-Age=0.
      const deletion = api.serializeCookieDeletion(kind, baseUrl);
      const deleted = attributesOf(deletion);
      if (!deletion.startsWith(`${expectedName}=;`)) {
        problems.push(`${baseUrl}: deleting ${kind} does not empty the value`);
      }
      if (!deleted.includes('Max-Age=0'))
        problems.push(`${baseUrl}: deleting ${kind} lacks Max-Age=0`);
      for (const attribute of attributes.filter(
        (candidate) => !candidate.toLowerCase().startsWith('max-age='),
      )) {
        if (!deleted.includes(attribute)) {
          problems.push(`${baseUrl}: deleting ${kind} does not repeat ${attribute}`);
        }
      }
      if (
        deleted.filter((attribute) => attribute.toLowerCase().startsWith('max-age=')).length !== 1
      ) {
        problems.push(`${baseUrl}: deleting ${kind} has more or fewer than one Max-Age`);
      }
    }
  }
  if (problems.length > 0) throw new Error(`cookie matrix differs: ${problems.join('; ')}`);
}

describe('cookie names and attributes (spec 6.9.3)', () => {
  it('matches the matrix of the spec on https and on http://localhost', () => {
    expect(() => {
      assertCookieMatrix(REAL);
    }).not.toThrow();
  });

  it.each(COOKIE_KINDS)('%s: the exact header on https', (kind) => {
    const row = MATRIX[kind];
    const maxAge = row.maxAge === undefined ? '' : `; Max-Age=${String(row.maxAge)}`;
    expect(serializeCookie(kind, VALUE, HTTPS)).toBe(
      `${row.https}=${VALUE}; Path=/; HttpOnly; Secure; SameSite=${row.sameSite}${maxAge}`,
    );
  });

  it.each(COOKIE_KINDS)(
    '%s: the exact header on http://localhost (no Secure, plain name)',
    (kind) => {
      const row = MATRIX[kind];
      const maxAge = row.maxAge === undefined ? '' : `; Max-Age=${String(row.maxAge)}`;
      expect(serializeCookie(kind, VALUE, LOCALHOST)).toBe(
        `${row.plain}=${VALUE}; Path=/; HttpOnly; SameSite=${row.sameSite}${maxAge}`,
      );
    },
  );

  it.each(COOKIE_KINDS)('%s: a deletion repeats the attributes with Max-Age=0', (kind) => {
    const row = MATRIX[kind];
    expect(serializeCookieDeletion(kind, HTTPS)).toBe(
      `${row.https}=; Path=/; HttpOnly; Secure; SameSite=${row.sameSite}; Max-Age=0`,
    );
    expect(serializeCookieDeletion(kind, LOCALHOST)).toBe(
      `${row.plain}=; Path=/; HttpOnly; SameSite=${row.sameSite}; Max-Age=0`,
    );
  });

  it('the session and setup cookies are browser-session cookies; only the transaction cookie expires', () => {
    expect(serializeCookie('session', VALUE, HTTPS)).not.toMatch(/Max-Age|Expires/i);
    expect(serializeCookie('setup', VALUE, HTTPS)).not.toMatch(/Max-Age|Expires/i);
    expect(serializeCookie('oidc', VALUE, HTTPS)).toContain('Max-Age=600');
  });

  it('names are the same for every https origin and ignore a port', () => {
    expect(cookieNames('https://panel.example.org:8443')).toEqual(cookieNames(HTTPS));
    expect(cookieNames('http://localhost:1234')).toEqual(cookieNames('http://localhost'));
  });

  it('names the three cookies once each, with distinct names', () => {
    expect([...COOKIE_KINDS]).toEqual(['session', 'oidc', 'setup']);
    for (const url of [HTTPS, LOCALHOST]) {
      const names = Object.values(cookieNames(url));
      expect(new Set(names).size).toBe(3);
    }
  });

  it.each([
    ['empty', ''],
    ['42 characters', VALUE.slice(1)],
    ['44 characters', `${VALUE}A`],
    ['padding', `${VALUE.slice(0, 42)}=`],
    ['a standard base64 plus sign', `${VALUE.slice(0, 42)}+`],
    ['a slash', `${VALUE.slice(0, 42)}/`],
    ['a space', `${VALUE.slice(0, 42)} `],
    ['a semicolon', `${VALUE.slice(0, 42)};`],
    ['a line break', `${VALUE.slice(0, 42)}\n`],
    ['a non-ASCII letter', `${VALUE.slice(0, 42)}é`],
  ])('refuses a value that is not 43 base64url characters: %s', (_label, value) => {
    expect(() => serializeCookie('session', value, HTTPS)).toThrow(/43 base64url/);
  });

  it.each([
    'http://127.0.0.1:9300',
    'http://[::1]:9300',
    'http://panel.example.org',
    'ftp://panel.example.org',
    'not a url',
    '',
  ])('refuses a base URL that is neither https nor http://localhost: %s', (url) => {
    expect(() => cookieNames(url)).toThrow(/PUBLIC_BASE_URL|base URL/);
    expect(() => serializeCookie('session', VALUE, url)).toThrow();
    expect(() => serializeCookieDeletion('session', url)).toThrow();
  });
});

describe('the cookie matrix guard (negative fixtures)', () => {
  const dropsHostPrefix: CookieApi = {
    ...REAL,
    cookieNames: (url) =>
      Object.fromEntries(
        Object.entries(REAL.cookieNames(url)).map(([kind, name]) => [
          kind,
          name.replace('__Host-', ''),
        ]),
      ) as Record<CookieKind, string>,
  };

  it('fails when the __Host- prefix is dropped on https', () => {
    expectGuardFails(assertCookieMatrix, dropsHostPrefix, {
      name: 'cookie matrix',
      reason: /is named m365portal_session, expected __Host-m365portal_session/,
    });
  });

  it('fails when Domain is set', () => {
    const withDomain: CookieApi = {
      ...REAL,
      serializeCookie: (kind, value, url) =>
        `${REAL.serializeCookie(kind, value, url)}; Domain=panel.example.org`,
    };
    expectGuardFails(assertCookieMatrix, withDomain, {
      name: 'cookie matrix',
      reason: 'sets Domain',
    });
  });

  it('fails when Expires is set', () => {
    const withExpires: CookieApi = {
      ...REAL,
      serializeCookie: (kind, value, url) =>
        `${REAL.serializeCookie(kind, value, url)}; Expires=Thu, 01 Jan 2099 00:00:00 GMT`,
    };
    expectGuardFails(assertCookieMatrix, withExpires, {
      name: 'cookie matrix',
      reason: 'sets Expires',
    });
  });

  it('fails when Secure is missing on https or present on localhost', () => {
    const noSecure: CookieApi = {
      ...REAL,
      serializeCookie: (kind, value, url) =>
        REAL.serializeCookie(kind, value, url).replace('; Secure', ''),
    };
    expectGuardFails(assertCookieMatrix, noSecure, {
      name: 'cookie matrix',
      reason: 'has Secure false, expected true',
    });
    const alwaysSecure: CookieApi = {
      ...REAL,
      serializeCookie: (kind, value, url) =>
        `${REAL.serializeCookie(kind, value, url).replace('; Secure', '')}; Secure`,
    };
    expectGuardFails(assertCookieMatrix, alwaysSecure, {
      name: 'cookie matrix',
      reason: 'has Secure true, expected false',
    });
  });

  it('fails when the session cookie is SameSite=Lax or the transaction cookie loses its Max-Age', () => {
    const lax: CookieApi = {
      ...REAL,
      serializeCookie: (kind, value, url) =>
        REAL.serializeCookie(kind, value, url).replace('SameSite=Strict', 'SameSite=Lax'),
    };
    expectGuardFails(assertCookieMatrix, lax, {
      name: 'cookie matrix',
      reason: 'lacks SameSite=Strict',
    });
    const noMaxAge: CookieApi = {
      ...REAL,
      serializeCookie: (kind, value, url) =>
        REAL.serializeCookie(kind, value, url).replace('; Max-Age=600', ''),
    };
    expectGuardFails(assertCookieMatrix, noMaxAge, {
      name: 'cookie matrix',
      reason: 'oidc has no Max-Age, expected 600',
    });
  });

  it('fails when a deletion forgets an attribute or Max-Age=0', () => {
    const forgetful: CookieApi = {
      ...REAL,
      serializeCookieDeletion: (kind, url) =>
        REAL.serializeCookieDeletion(kind, url).replace('; HttpOnly', ''),
    };
    expectGuardFails(assertCookieMatrix, forgetful, {
      name: 'cookie matrix',
      reason: 'does not repeat HttpOnly',
    });
    const noMaxAgeZero: CookieApi = {
      ...REAL,
      serializeCookieDeletion: (kind, url) =>
        REAL.serializeCookieDeletion(kind, url).replace('; Max-Age=0', ''),
    };
    expectGuardFails(assertCookieMatrix, noMaxAgeZero, {
      name: 'cookie matrix',
      reason: 'lacks Max-Age=0',
    });
  });

  it('fails when HttpOnly or Path is missing', () => {
    const noHttpOnly: CookieApi = {
      ...REAL,
      serializeCookie: (kind, value, url) =>
        REAL.serializeCookie(kind, value, url).replace('; HttpOnly', ''),
    };
    expectGuardFails(assertCookieMatrix, noHttpOnly, {
      name: 'cookie matrix',
      reason: 'lacks HttpOnly',
    });
    const noPath: CookieApi = {
      ...REAL,
      serializeCookie: (kind, value, url) =>
        REAL.serializeCookie(kind, value, url).replace('; Path=/', ''),
    };
    expectGuardFails(assertCookieMatrix, noPath, { name: 'cookie matrix', reason: 'lacks Path=/' });
  });
});

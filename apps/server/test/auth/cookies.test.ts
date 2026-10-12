// T-B-181: FR-B-401, FR-B-417 (part). The server side of the three cookies: values drawn from the
// injected RandomSource, headers built through the shared serializer only, a duplicate cookie counts
// as absent (fail closed) and is logged once, a malformed value is absent.
import { cookieNames } from '@m365portal/shared/auth/cookies';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it, vi } from 'vitest';
import { clearCookie, newCookieId, readAuthCookies, setCookie } from '../../src/auth/cookies.js';
import { countingRandom } from '../secrets/support.js';

const HTTPS = 'https://panel.example.test';
const LOCAL = 'http://localhost:9300';
const VALUE = 'A'.repeat(43);
const BUILDS_SET_COOKIE = /serializeCookie(Deletion)?\b|['"]set-cookie['"]\s*,/i;

function setCookieOf(action: (headers: Headers) => void): string[] {
  const headers = new Headers();
  action(headers);
  return headers.getSetCookie();
}

describe('server/auth/cookies: values', () => {
  it('draws 256 random bits from the injected source as 43 base64url characters', () => {
    const asked: number[] = [];
    const random = {
      bytes: (length: number) => {
        asked.push(length);
        return countingRandom(7).bytes(length);
      },
      float: () => 0.5,
    };
    const id = newCookieId(random);
    expect(asked).toEqual([32]);
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('is deterministic for a seeded source and different between draws', () => {
    const random = countingRandom(3);
    const first = newCookieId(random);
    const second = newCookieId(random);
    expect(first).not.toBe(second);
    expect(newCookieId(countingRandom(3))).toBe(first);
  });
});

describe('server/auth/cookies: the attribute matrix', () => {
  it.each([
    [
      'session',
      HTTPS,
      `__Host-m365portal_session=${VALUE}; Path=/; HttpOnly; Secure; SameSite=Strict`,
    ],
    [
      'oidc',
      HTTPS,
      `__Host-m365portal_oidc=${VALUE}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    ],
    ['setup', HTTPS, `__Host-m365portal_setup=${VALUE}; Path=/; HttpOnly; Secure; SameSite=Strict`],
    ['session', LOCAL, `m365portal_session=${VALUE}; Path=/; HttpOnly; SameSite=Strict`],
    ['oidc', LOCAL, `m365portal_oidc=${VALUE}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`],
    ['setup', LOCAL, `m365portal_setup=${VALUE}; Path=/; HttpOnly; SameSite=Strict`],
  ] as const)('sets the %s cookie on %s', (kind, base, expected) => {
    expect(
      setCookieOf((headers) => {
        setCookie(headers, kind, VALUE, base);
      }),
    ).toEqual([expected]);
  });

  it.each([HTTPS, LOCAL])('never has a Domain or an Expires attribute (%s)', (base) => {
    for (const kind of ['session', 'oidc', 'setup'] as const) {
      const [line] = setCookieOf((headers) => {
        setCookie(headers, kind, VALUE, base);
      });
      expect(line).not.toMatch(/Domain|Expires/i);
      expect(line?.startsWith('__Host-') === base.startsWith('https')).toBe(true);
      expect((line ?? '').includes('; Secure')).toBe(base.startsWith('https'));
    }
  });

  it('a deletion repeats every attribute and ends with Max-Age=0', () => {
    for (const base of [HTTPS, LOCAL]) {
      for (const kind of ['session', 'oidc', 'setup'] as const) {
        const [set] = setCookieOf((headers) => {
          setCookie(headers, kind, VALUE, base);
        });
        const [cleared] = setCookieOf((headers) => {
          clearCookie(headers, kind, base);
        });
        const attributes = (line: string | undefined): string[] =>
          (line ?? '')
            .split('; ')
            .slice(1)
            .filter((part) => !part.startsWith('Max-Age'));
        expect(cleared?.startsWith(`${cookieNames(base)[kind]}=;`)).toBe(true);
        expect(attributes(cleared)).toEqual(attributes(set));
        expect(cleared?.endsWith('; Max-Age=0')).toBe(true);
      }
    }
  });

  it('adds to the header list instead of replacing a cookie already set', () => {
    const headers = new Headers();
    setCookie(headers, 'session', VALUE, HTTPS);
    clearCookie(headers, 'oidc', HTTPS);
    expect(headers.getSetCookie()).toHaveLength(2);
  });

  it('refuses a value that is not a 256-bit id', () => {
    expect(() => {
      setCookie(new Headers(), 'session', 'short', HTTPS);
    }).toThrow(TypeError);
  });
});

describe('server/auth/cookies: reading', () => {
  const names = cookieNames(HTTPS);

  it('reads the three cookies by exact name', () => {
    const other = 'B'.repeat(43);
    const third = 'C'.repeat(43);
    const read = readAuthCookies(
      `${names.session}=${VALUE}; ${names.oidc}=${other}; ${names.setup}=${third}; x=1`,
      HTTPS,
    );
    expect(read).toEqual({ session: VALUE, oidc: other, setup: third, duplicates: [] });
  });

  it('counts two cookies of one name as absent and logs cookie_duplicate once per name', () => {
    const warn = vi.fn();
    const header = `${names.session}=${VALUE}; ${names.session}=${'B'.repeat(43)}; ${names.session}=${'C'.repeat(43)}`;
    const read = readAuthCookies(header, HTTPS, { warn });
    expect(read.session).toBeUndefined();
    expect(read.duplicates).toEqual(['session']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ event: 'cookie_duplicate', cookie: 'session' });
    // The value never reaches the log.
    expect(JSON.stringify(warn.mock.calls)).not.toContain(VALUE);
  });

  it('counts a duplicate even when one of the two values is malformed', () => {
    const read = readAuthCookies(`${names.oidc}=${VALUE}; ${names.oidc}=bad`, HTTPS);
    expect(read.oidc).toBeUndefined();
    expect(read.duplicates).toEqual(['oidc']);
  });

  it.each([
    '',
    'short',
    `${'A'.repeat(42)}=`,
    'A'.repeat(44),
    `${'A'.repeat(42)} `,
    `${'A'.repeat(42)}!`,
  ])('treats the malformed value %j as absent', (value) => {
    const read = readAuthCookies(`${names.session}=${value}`, HTTPS);
    expect(read.session).toBeUndefined();
    expect(read.duplicates).toEqual([]);
  });

  it('ignores the other deployment’s names (plain names on https are not the cookie)', () => {
    expect(readAuthCookies(`m365portal_session=${VALUE}`, HTTPS).session).toBeUndefined();
    expect(readAuthCookies(`__Host-m365portal_session=${VALUE}`, LOCAL).session).toBeUndefined();
  });

  it('handles an absent header', () => {
    expect(readAuthCookies(null, HTTPS)).toEqual({
      session: undefined,
      oidc: undefined,
      setup: undefined,
      duplicates: [],
    });
  });
});

describe('server/auth/cookies: the only place that writes a Set-Cookie header', () => {
  it('no other file of apps/server/src appends a Set-Cookie header or calls the shared serializers', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join, relative } = await import('node:path');
    const root = new URL('../../src', import.meta.url).pathname;
    const offenders: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory)) {
        const path = join(directory, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith('.ts')) {
          const text = readFileSync(path, 'utf8');
          const mine = relative(root, path) === join('auth', 'cookies.ts');
          if (!mine && BUILDS_SET_COOKIE.test(text)) {
            // The cache-header middleware only copies headers it was given (replaceResponse).
            if (relative(root, path) !== join('http', 'cache-headers.ts'))
              offenders.push(relative(root, path));
          }
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });

  it('fails on a file that builds its own (negative)', () => {
    expectGuardFails((text: string) => {
      if (BUILDS_SET_COOKIE.test(text)) throw new Error('builds a Set-Cookie header');
    }, "h.append('Set-Cookie', x)");
  });
});

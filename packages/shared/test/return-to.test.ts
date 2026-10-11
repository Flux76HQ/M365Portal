// T-B-180, FR-B-402 (shared half), EB-17, F-43, CB12: `safeReturnTo`, the one function that decides
// where a sign-in may land. The server applies it when the login transaction is created, and the
// web sign-in page applies the same function to the `returnTo` it reads from its own URL before it
// navigates. A value is kept only when it is a same-origin path; everything else becomes `/`.
//
// Cases: the attack list of F-43 (named), a table of values that must survive, and a seeded property
// run that checks the invariants on 20,000 generated values. The negative fixtures are guards that
// let `//evil` through, or forget the length cap, and must be seen failing.
import { describe, expect, it } from 'vitest';
import { LIMITS } from '../src/limits.js';
import { RETURN_TO_DEFAULT, RETURN_TO_MAX_CHARS, safeReturnTo } from '../src/auth/return-to.js';
import { expectGuardFails } from '../src/testing/index.js';

/** The attack list of F-43 plus the variants the spec text implies. All must become `/`. */
const ATTACKS: readonly (readonly [string, string])[] = [
  ['protocol-relative', '//evil'],
  ['protocol-relative with path', '//evil.test/path'],
  ['backslash after the slash', '/\\evil'],
  ['backslash later', '/ok\\evil'],
  ['absolute https', 'https://evil'],
  ['absolute http', 'http://evil'],
  ['javascript scheme', 'javascript:alert(1)'],
  ['data scheme', 'data:text/html,x'],
  ['api route', '/api/v1/me'],
  ['api route, upper case', '/API/v1/me'],
  ['setup page', '/setup'],
  ['setup sub-page', '/setup/token'],
  ['setup prefix', '/setupx'],
  ['setup, mixed case', '/Setup'],
  ['CRLF injection', '/ok\r\nSet-Cookie: x=1'],
  ['LF only', '/ok\nx'],
  ['tab', '/ok\tx'],
  ['NUL', '/ok\u0000x'],
  ['DEL', '/ok\u007fx'],
  ['C1 control', '/ok\u0085x'],
  ['line separator', '/ok\u2028x'],
  ['paragraph separator', '/ok\u2029x'],
  ['double slash later', '/a//b'],
  ['double slash in the query', '/a?u=https://evil'],
  ['300 characters', `/${'a'.repeat(299)}`],
  ['encoded protocol-relative', '/%2f%2fevil'],
  ['encoded backslash', '/%5cevil'],
  ['encoded CRLF', '/ok%0d%0aSet-Cookie:x'],
  ['encoded NUL', '/ok%00x'],
  ['no leading slash', 'users'],
  ['dot segment only', './users'],
  ['empty', ''],
  ['space only', ' '],
  ['leading space', ' /users'],
  ['leading tab', '\t/users'],
];

/** Values that are fine and must come back unchanged. */
const KEPT: readonly string[] = [
  '/',
  '/users',
  '/users/42',
  '/settings/access',
  '/settings/connection?tab=log',
  '/users?q=a&page=2#top',
  '/signin',
  '/no-access',
  '/apix',
  '/api',
  '/a b',
  '/ünïcode',
  `/${'a'.repeat(RETURN_TO_MAX_CHARS - 1)}`,
];

describe('safeReturnTo', () => {
  it('uses the length limit of the spec and a root default', () => {
    expect(RETURN_TO_MAX_CHARS).toBe(256);
    expect(RETURN_TO_MAX_CHARS).toBe(LIMITS.signIn.returnToMaxChars);
    expect(RETURN_TO_DEFAULT).toBe('/');
  });

  it.each(ATTACKS)('turns the attack "%s" into /', (_name, value) => {
    expect(safeReturnTo(value)).toBe('/');
  });

  it.each(
    KEPT.map((value) => [
      value.length > 60 ? `${value.slice(0, 20)}... (${String(value.length)})` : value,
      value,
    ]),
  )('keeps %s unchanged', (_name, value) => {
    expect(safeReturnTo(value)).toBe(value);
  });

  it('accepts exactly 256 characters and refuses 257', () => {
    expect(safeReturnTo(`/${'a'.repeat(255)}`)).toHaveLength(256);
    expect(safeReturnTo(`/${'a'.repeat(256)}`)).toBe('/');
  });

  it('turns anything that is not a string into /', () => {
    for (const value of [
      undefined,
      null,
      0,
      1,
      true,
      {},
      [],
      ['/users'],
      () => '/users',
      Symbol('x'),
    ]) {
      expect(safeReturnTo(value)).toBe('/');
    }
    expect(safeReturnTo(new String('/users'))).toBe('/');
  });

  it('is idempotent: a safe value stays the same when applied again', () => {
    for (const [, value] of ATTACKS)
      expect(safeReturnTo(safeReturnTo(value))).toBe(safeReturnTo(value));
    for (const value of KEPT) expect(safeReturnTo(safeReturnTo(value))).toBe(value);
  });

  describe('property run (seeded, 20,000 values)', () => {
    // A small seeded generator (mulberry32): the seed is printed when an invariant breaks.
    const SEED = 0x5eed_b180;
    function rng(seed: number): () => number {
      let state = seed >>> 0;
      return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    const ALPHABET = [
      '/',
      '/',
      '/',
      '\\',
      '.',
      ':',
      '%',
      '2',
      'f',
      '5',
      'c',
      '0',
      'd',
      'a',
      'a',
      'b',
      'x',
      '?',
      '#',
      '&',
      '=',
      ' ',
      '\n',
      '\r',
      '\t',
      '\u0000',
      '\u007f',
      '\u0085',
      '\u2028',
      'ü',
      '@',
      'api',
      'setup',
      '/api/',
      '//',
      'http:',
      'javascript:',
    ];

    it('returns "/" or the input, and what it returns satisfies every rule of FR-B-402', () => {
      const next = rng(SEED);
      for (let i = 0; i < 20_000; i += 1) {
        const length = Math.floor(next() * 14);
        let value = next() < 0.7 ? '/' : '';
        for (let j = 0; j < length; j += 1)
          value += ALPHABET[Math.floor(next() * ALPHABET.length)] ?? '';
        if (next() < 0.01) value += 'z'.repeat(RETURN_TO_MAX_CHARS);
        const out = safeReturnTo(value);
        const context = `seed ${String(SEED)}, case ${String(i)}, value ${JSON.stringify(value)}`;
        if (out === '/') continue;
        expect(out, context).toBe(value);
        expect(out.startsWith('/'), context).toBe(true);
        expect(out.includes('//'), context).toBe(false);
        expect(out.includes('\\'), context).toBe(false);
        expect(/\p{Cc}|[\u2028\u2029]/u.test(out), context).toBe(false);
        expect(out.length, context).toBeLessThanOrEqual(RETURN_TO_MAX_CHARS);
        expect(/^\/(api\/|setup)/i.test(out), context).toBe(false);
        // Parsed against an origin, it must stay on that origin and keep the path.
        const url = new URL(out, 'https://panel.example.test');
        expect(url.origin, context).toBe('https://panel.example.test');
      }
    });
  });

  describe('negative fixtures (a guard nobody has seen fail is an assumption)', () => {
    const guard = (impl: (value: unknown) => string) => (input: string) => {
      if (impl(input) !== '/') throw new Error(`let through: ${JSON.stringify(input)}`);
    };

    it('a function that only checks the leading slash lets //evil through', () => {
      const leadingSlashOnly = (v: unknown): string =>
        typeof v === 'string' && v.startsWith('/') ? v : '/';
      expectGuardFails(guard(leadingSlashOnly), '//evil', { reason: 'let through' });
      expectGuardFails(guard(leadingSlashOnly), '/\\evil', { reason: 'let through' });
      expectGuardFails(guard(leadingSlashOnly), '/api/v1/me', { reason: 'let through' });
      guard(safeReturnTo)('//evil');
    });

    it('a function without the length cap lets 300 characters through', () => {
      const noCap = (v: unknown): string =>
        typeof v === 'string' && v.startsWith('/') && !v.includes('//') && !v.includes('\\')
          ? v
          : '/';
      expectGuardFails(guard(noCap), `/${'a'.repeat(299)}`, { reason: 'let through' });
      guard(safeReturnTo)(`/${'a'.repeat(299)}`);
    });

    it('a function that skips the control-character rule lets CRLF through', () => {
      const noControl = (v: unknown): string =>
        typeof v === 'string' &&
        v.startsWith('/') &&
        !v.includes('//') &&
        !v.includes('\\') &&
        v.length <= 256
          ? v
          : '/';
      expectGuardFails(guard(noControl), '/ok\r\nSet-Cookie: x=1', { reason: 'let through' });
      guard(safeReturnTo)('/ok\r\nSet-Cookie: x=1');
    });
  });
});

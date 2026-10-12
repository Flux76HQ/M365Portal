// T-A-034: FR-A-044, E-09, E-14, A-31 to A-33, plan 8.3.
//
// Every request under /api/v1 with a method other than GET, HEAD or OPTIONS must
//   1. carry an `Origin` equal to the serialised origin of `PUBLIC_BASE_URL` (`Origin: null` fails,
//      a missing one fails, the `Host` header is never consulted);
//   2. if `Sec-Fetch-Site` is present, have it `same-origin`;
//   3. carry an `X-CSRF-Token`: `v1.<iat>.<exp>.<nonce>.<mac>`, an HMAC-SHA-256 under a 32-byte key
//      that lives in memory for the life of the process, valid for 8 hours, accepted while `iat` is
//      at most 5 minutes in the future and `exp` plus 60 s has not passed, compared in constant time.
// A failure answers 403 `origin_not_allowed` (with `expectedOrigin`) or `csrf_invalid`, and never says
// which part failed beyond the code. A GET route that writes an audit entry applies the
// `Sec-Fetch-Site` rule too (absent, `same-origin` and `none` pass; `same-site` and `cross-site` do not).
//
// The clock is the injected fake one: no test waits.
//
// Negative fixtures (tasks.md section 0.3): `assertWriteGuards` and `assertAuditedRead` run the full
// matrix against guards with one defect each (no Origin check, the `Host` header used, `Origin: null`
// accepted, no expiry, no signature check, ...), and must fail on every one.
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LIMITS } from '@m365portal/shared/limits';
import { IsoTimestampSchema } from '@m365portal/shared/schemas/common';
import { CsrfResponseSchema } from '@m365portal/shared/schemas/meta';
import { expectGuardFails } from '@m365portal/shared/testing';
import { Hono, type MiddlewareHandler } from 'hono';
import { describe, expect, it } from 'vitest';
import { loadConfigOrThrow } from '../src/config/index.js';
import {
  auditedReadGuard,
  checkAuditedReadOrigin,
  checkWriteOrigin,
  isWriteMethod,
  originAndCsrfGuard,
  originGuard,
  type Denial,
} from '../src/http/origin.js';
import { createCsrf, csrfGuard, type Csrf } from '../src/http/csrf.js';
import { createErrorHandler, errorBoundary, notFoundHandler } from '../src/http/error-handler.js';
import { problemResponse } from '../src/http/problem.js';
import { requestContext, type AppEnv } from '../src/http/request-context.js';
import { createFakeClock, type FakeClock } from './helpers/fake-clock.js';
import { ANONYMOUS_ACTOR } from '../src/policy/actor.js';
import { ADMIN, createFixtureApp } from './helpers/http-app.js';
import { readJson } from './helpers/http-client.js';

const EXPECTED = 'http://localhost:9090';
const TOKEN_PATTERN = /^v1\.\d+\.\d+\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;
const TTL_SECONDS = LIMITS.csrfTokenLifetimeMs / 1000;
const FUTURE_LIMIT_SECONDS = 300;
const LEEWAY_SECONDS = 60;

/** A token generator for tests: a fixed key, a fake clock, nonces counted up from 1. */
function makeCsrf(clock: FakeClock, key: Uint8Array = Buffer.alloc(32, 7)): Csrf {
  let counter = 0;
  return createCsrf({
    now: () => clock.nowMs(),
    key,
    random: (length) => {
      counter += 1;
      return Buffer.alloc(length, counter);
    },
  });
}

// ---------------------------------------------------------------------------------------------
// The pieces, without HTTP
// ---------------------------------------------------------------------------------------------

describe('isWriteMethod (plan 8.3)', () => {
  it.each([
    'POST',
    'PUT',
    'PATCH',
    'DELETE',
    'PROPFIND',
    'MKCOL',
    'x-custom',
    'post',
    'delete',
    '',
  ])('treats %j as a write', (method) => {
    expect(isWriteMethod(method)).toBe(true);
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])('treats %s as a read', (method) => {
    expect(isWriteMethod(method)).toBe(false);
  });
});

describe('checkWriteOrigin: Origin and Sec-Fetch-Site (plan 8.3, steps 1 and 2)', () => {
  const same = EXPECTED;

  it.each([
    ['equal, no Sec-Fetch-Site', same, null],
    ['equal, same-origin', same, 'same-origin'],
  ])('accepts Origin %s', (_name, origin, secFetchSite) => {
    expect(checkWriteOrigin({ origin, secFetchSite, expectedOrigin: EXPECTED })).toEqual({
      ok: true,
    });
  });

  it.each([
    ['same-site', 'sec_fetch_site'],
    ['cross-site', 'sec_fetch_site'],
    ['none', 'sec_fetch_site'],
    ['', 'sec_fetch_site'],
    ['bogus', 'sec_fetch_site'],
    ['Same-Origin', 'sec_fetch_site'],
    ['SAME-ORIGIN', 'sec_fetch_site'],
    ['same-origin, cross-site', 'sec_fetch_site'],
    [' same-origin', 'sec_fetch_site'],
  ])('refuses an equal Origin with Sec-Fetch-Site %j', (secFetchSite) => {
    const result = checkWriteOrigin({ origin: same, secFetchSite, expectedOrigin: EXPECTED });
    expect(result.ok).toBe(false);
  });

  it.each([
    [null, 'origin_missing'],
    ['null', 'origin_null'],
    ['https://evil.example', 'origin_mismatch'],
    ['http://localhost:9999', 'origin_mismatch'],
    ['http://localhost', 'origin_mismatch'],
    ['https://localhost:9090', 'origin_mismatch'],
    ['http://127.0.0.1:9090', 'origin_mismatch'],
    ['http://LOCALHOST:9090', 'origin_mismatch'],
    ['HTTP://localhost:9090', 'origin_mismatch'],
    ['http://localhost:9090/', 'origin_mismatch'],
    ['http://localhost:9090/path', 'origin_mismatch'],
    ['http://localhost:9090 ', 'origin_mismatch'],
    ['http://localhost:9090, http://evil.example', 'origin_mismatch'],
    ['http://localhost:9090@evil.example', 'origin_mismatch'],
    ['http://evil.example@localhost:9090', 'origin_mismatch'],
    ['http://localhost:9090.evil.example', 'origin_mismatch'],
    ['http://localhost:90900', 'origin_mismatch'],
    ['http://sub.localhost:9090', 'origin_mismatch'],
    ['http://localhost.:9090', 'origin_mismatch'],
    ['', 'origin_mismatch'],
    ['*', 'origin_mismatch'],
    ['file://', 'origin_mismatch'],
  ])(
    'refuses Origin %j with the internal reason %s, whatever Sec-Fetch-Site says',
    (origin, reason) => {
      for (const secFetchSite of [null, 'same-origin']) {
        expect(checkWriteOrigin({ origin, secFetchSite, expectedOrigin: EXPECTED })).toEqual({
          ok: false,
          reason,
        });
      }
    },
  );

  it('names the Origin first when both fail', () => {
    expect(
      checkWriteOrigin({
        origin: 'https://evil.example',
        secFetchSite: 'cross-site',
        expectedOrigin: EXPECTED,
      }),
    ).toEqual({ ok: false, reason: 'origin_mismatch' });
  });

  it('compares with the expected origin it is given, not with a constant', () => {
    expect(
      checkWriteOrigin({
        origin: 'https://panel.example.com',
        secFetchSite: null,
        expectedOrigin: 'https://panel.example.com',
      }),
    ).toEqual({ ok: true });
    expect(
      checkWriteOrigin({
        origin: EXPECTED,
        secFetchSite: null,
        expectedOrigin: 'https://panel.example.com',
      }).ok,
    ).toBe(false);
  });
});

describe('checkAuditedReadOrigin: the Sec-Fetch-Site rule for a GET that writes an audit entry', () => {
  it.each([null, 'same-origin', 'none'])('lets %j through', (value) => {
    expect(checkAuditedReadOrigin(value)).toEqual({ ok: true });
  });

  it.each([
    'same-site',
    'cross-site',
    '',
    'bogus',
    'None',
    'Same-Origin',
    'same-origin, none',
    ' none',
  ])('refuses %j', (value) => {
    expect(checkAuditedReadOrigin(value)).toEqual({ ok: false, reason: 'sec_fetch_site' });
  });
});

// ---------------------------------------------------------------------------------------------
// The token
// ---------------------------------------------------------------------------------------------

describe('the token: v1.<iat>.<exp>.<nonce>.<mac> (plan 8.3, step 3)', () => {
  it('has the format, a lifetime of 8 hours and an expiry in the response shape', () => {
    const clock = createFakeClock('2026-10-10T12:00:00.000Z');
    const csrf = makeCsrf(clock);

    const issued = csrf.issue('');

    expect(issued.token).toMatch(TOKEN_PATTERN);
    const [version, iat, exp] = issued.token.split('.');
    expect(version).toBe('v1');
    expect(Number(iat)).toBe(Date.parse('2026-10-10T12:00:00.000Z') / 1000);
    expect(Number(exp) - Number(iat)).toBe(TTL_SECONDS);
    expect(TTL_SECONDS).toBe(8 * 3_600);
    expect(issued.expiresAt).toBe('2026-10-10T20:00:00.000Z');
    expect(IsoTimestampSchema.safeParse(issued.expiresAt).success).toBe(true);
    expect(CsrfResponseSchema.safeParse(issued).success).toBe(true);
  });

  it('is HMAC-SHA-256 of "v1.<iat>.<exp>.<nonce>.<binding>" under the key', () => {
    const clock = createFakeClock('2026-10-10T12:00:00.000Z');
    const key = Buffer.alloc(32, 9);
    const csrf = makeCsrf(clock, key);

    for (const binding of ['', 'session-1', 'sess.ion']) {
      const { token } = csrf.issue(binding);
      const [version = '', iat = '', exp = '', nonce = '', mac = ''] = token.split('.');
      const expected = createHmac('sha256', key)
        .update(`${version}.${iat}.${exp}.${nonce}.${binding}`)
        .digest('base64url');
      expect(mac).toBe(expected);
    }
  });

  it('carries 16 random bytes as the nonce, different every time', () => {
    const clock = createFakeClock();
    const csrf = createCsrf({ now: () => clock.nowMs() });
    const nonces = new Set(
      Array.from({ length: 200 }, () => csrf.issue('').token.split('.')[3] ?? ''),
    );

    expect(nonces.size).toBe(200);
    for (const nonce of nonces) expect(Buffer.from(nonce, 'base64url')).toHaveLength(16);
  });

  it('is accepted by the generator that issued it, now and until it expires, and as often as it is shown', () => {
    const clock = createFakeClock();
    const csrf = makeCsrf(clock);
    const { token } = csrf.issue('');

    expect(csrf.validate(token, '')).toEqual({ ok: true });
    expect(csrf.validate(token, '')).toEqual({ ok: true });
    clock.advance(TTL_SECONDS * 1000);
    expect(csrf.validate(token, '')).toEqual({ ok: true });
  });

  it('does not use a key it was not given: two generators do not accept each other (a key per process)', () => {
    const clock = createFakeClock();
    const first = createCsrf({ now: () => clock.nowMs() });
    const second = createCsrf({ now: () => clock.nowMs() });

    expect(second.validate(first.issue('').token, '')).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(first.validate(first.issue('').token, '')).toEqual({ ok: true });
  });

  it('refuses a key that is shorter than 32 bytes', () => {
    const clock = createFakeClock();
    for (const length of [0, 1, 16, 31]) {
      expect(() => createCsrf({ now: () => clock.nowMs(), key: Buffer.alloc(length, 1) })).toThrow(
        RangeError,
      );
    }
    expect(() => createCsrf({ now: () => clock.nowMs(), key: Buffer.alloc(32, 1) })).not.toThrow();
    expect(() => createCsrf({ now: () => clock.nowMs(), key: Buffer.alloc(64, 1) })).not.toThrow();
  });

  it('takes the binding on both sides, so that Phase B binds a token to a session without a new signature', () => {
    const clock = createFakeClock();
    const csrf = makeCsrf(clock);
    const { token } = csrf.issue('session-a');

    expect(csrf.validate(token, 'session-a')).toEqual({ ok: true });
    expect(csrf.validate(token, 'session-b')).toEqual({ ok: false, reason: 'bad_signature' });
    expect(csrf.validate(token, '')).toEqual({ ok: false, reason: 'bad_signature' });
    expect(csrf.validate(csrf.issue('').token, 'session-a')).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('refuses a clock that is not a number instead of minting a token with NaN in it', () => {
    const csrf = createCsrf({ now: () => Number.NaN });
    expect(() => csrf.issue('')).toThrow(RangeError);
  });

  it('compares the signature in constant time (the source says how; timing itself is not measured here)', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../src/http/csrf.ts', import.meta.url)),
      'utf8',
    );
    expect(source).toContain('timingSafeEqual');
    expect(source).not.toMatch(/\bmac\s*(?:===|!==)\s/);
  });
});

describe('validate: the states of a token (plan 8.3, E-09)', () => {
  function minted(): { clock: FakeClock; csrf: Csrf; token: string } {
    const clock = createFakeClock('2026-10-10T12:00:00.000Z');
    const csrf = makeCsrf(clock);
    return { clock, csrf, token: csrf.issue('').token };
  }

  it.each([
    [null, 'missing'],
    [undefined, 'missing'],
    ['', 'missing'],
  ])('reports %j as %s', (value, reason) => {
    const { csrf } = minted();
    expect(csrf.validate(value, '')).toEqual({ ok: false, reason });
  });

  it.each([
    'garbage',
    'v1',
    'v1.1.2.3.4',
    'v2.1.2.AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    ' ',
    'Bearer abc',
    'v1.....',
    'v1.1.2.3',
    'a'.repeat(5_000),
    'v1.1.2.AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.extra',
    'v1.1.2.AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'v1.1.2.AAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'v1.01.2.AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'v1.-1.2.AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'v1.1.2.AAAAAAAAAAAAAAAAAAAAA+.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/',
    'v1.1.2.AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    'v1.1e3.2.AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'v1.1.2.AAAAAAAAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n',
  ])('reports %j as malformed', (value) => {
    const { csrf } = minted();
    expect(csrf.validate(value, '')).toEqual({ ok: false, reason: 'malformed' });
  });

  it('does not accept the same signature spelled differently: the two unused bits of its last character must be zero', () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    for (let round = 0; round < 8; round += 1) {
      const clock = createFakeClock(`2026-10-10T12:00:0${String(round)}.000Z`);
      const csrf = makeCsrf(clock, Buffer.alloc(32, 40 + round));
      const { token } = csrf.issue('');
      const last = token.slice(-1);
      // The last of 43 characters holds 4 bits of signature and 2 bits that mean nothing.
      expect(alphabet.indexOf(last) % 4).toBe(0);
      const respelled = `${token.slice(0, -1)}${alphabet.charAt(alphabet.indexOf(last) + 1)}`;

      // Node decodes both spellings to the same 32 bytes ...
      expect(Buffer.from(respelled.split('.')[4] ?? '', 'base64url')).toEqual(
        Buffer.from(token.split('.')[4] ?? '', 'base64url'),
      );
      // ... and only the canonical one is a token.
      expect(csrf.validate(token, '')).toEqual({ ok: true });
      expect(csrf.validate(respelled, '')).toEqual({ ok: false, reason: 'bad_signature' });
    }
  });

  it('reports a flipped character of the signature as a bad signature', () => {
    const { csrf, token } = minted();
    const last = token.slice(-1);
    const flipped = `${token.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`;
    expect(csrf.validate(flipped, '')).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it.each([
    ['iat', 1, '1'],
    ['exp', 2, '1'],
    ['nonce', 3, 'AAAAAAAAAAAAAAAAAAAAAA'],
  ])(
    'reports a changed %s as a bad signature: the whole token is signed',
    (_name, index, value) => {
      const { csrf, token } = minted();
      const parts = token.split('.');
      parts[index] = index === 1 || index === 2 ? String(Number(parts[index]) + 1) : value;
      expect(csrf.validate(parts.join('.'), '')).toEqual({ ok: false, reason: 'bad_signature' });
    },
  );

  it('reports a token of another key as a bad signature, not as malformed', () => {
    const { clock, token } = minted();
    const other = makeCsrf(clock, Buffer.alloc(32, 8));
    expect(other.validate(token, '')).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('accepts a token up to 60 s after exp, and refuses it from the first millisecond after that', () => {
    const { clock, csrf, token } = minted();
    clock.advance((TTL_SECONDS + LEEWAY_SECONDS) * 1000);
    expect(csrf.validate(token, '')).toEqual({ ok: true });
    clock.advance(1);
    expect(csrf.validate(token, '')).toEqual({ ok: false, reason: 'expired' });
    clock.advance(86_400_000);
    expect(csrf.validate(token, '')).toEqual({ ok: false, reason: 'expired' });
  });

  describe('a token whose iat is in the future (a clock that ran ahead, or stepped back)', () => {
    function mintedAhead(secondsAhead: number): { csrf: Csrf; token: string } {
      const clock = createFakeClock('2026-10-10T12:00:00.000Z');
      const key = Buffer.alloc(32, 5);
      const ahead = createFakeClock(clock.nowMs() + secondsAhead * 1000);
      return { csrf: makeCsrf(clock, key), token: makeCsrf(ahead, key).issue('').token };
    }

    it('accepts an iat up to 5 minutes ahead', () => {
      const { csrf, token } = mintedAhead(FUTURE_LIMIT_SECONDS);
      expect(csrf.validate(token, '')).toEqual({ ok: true });
    });

    it('refuses an iat 300.2 seconds ahead: the limit is read in milliseconds, not rounded to the second', () => {
      const clock = createFakeClock('2026-10-10T12:00:00.800Z');
      const key = Buffer.alloc(32, 5);
      const ahead = createFakeClock('2026-10-10T12:05:01.000Z');
      const token = makeCsrf(ahead, key).issue('').token;

      // iat is 12:05:01.000 and now is 12:00:00.800: 300.2 s ahead.
      expect(makeCsrf(clock, key).validate(token, '')).toEqual({
        ok: false,
        reason: 'not_yet_valid',
      });
      // At 12:00:01.000 it is exactly 300 s ahead, which is allowed.
      clock.set('2026-10-10T12:00:01.000Z');
      expect(makeCsrf(clock, key).validate(token, '')).toEqual({ ok: true });
    });

    it('refuses an iat one second beyond that', () => {
      const { csrf, token } = mintedAhead(FUTURE_LIMIT_SECONDS + 1);
      expect(csrf.validate(token, '')).toEqual({ ok: false, reason: 'not_yet_valid' });
    });

    it('refuses a token after the clock stepped back by more than 5 minutes (E-09)', () => {
      const { clock, csrf, token } = minted();
      clock.stepBack((FUTURE_LIMIT_SECONDS + 1) * 1000);
      expect(csrf.validate(token, '')).toEqual({ ok: false, reason: 'not_yet_valid' });
    });

    it('accepts a token after the clock stepped back by less than that', () => {
      const { clock, csrf, token } = minted();
      clock.stepBack(FUTURE_LIMIT_SECONDS * 1000);
      expect(csrf.validate(token, '')).toEqual({ ok: true });
    });
  });

  describe('the numbers: iat and exp are read in canonical decimal form only', () => {
    const key = Buffer.alloc(32, 7);

    /** A token signed with the test key, with whatever text the test puts in iat and exp. */
    function forged(iat: string, exp: string): string {
      const nonce = 'A'.repeat(22);
      const mac = createHmac('sha256', key)
        .update(`v1.${iat}.${exp}.${nonce}.`)
        .digest('base64url');
      return `v1.${iat}.${exp}.${nonce}.${mac}`;
    }

    it.each([
      0, 1, 9, 10, 99, 100, 123_456_789, 999_999_999, 9_999_999_999, 99_999_999_999,
      100_000_000_000, 999_999_971_199, 90_000_000, 9_000_000_000, 8_000_000_000,
    ])(
      'accepts a token issued at %i s since the epoch, and one whose expiry has one digit more',
      (seconds) => {
        const clock = createFakeClock(seconds * 1000);
        const csrf = makeCsrf(clock, key);
        expect(csrf.validate(csrf.issue('').token, '')).toEqual({ ok: true });
      },
    );

    it.each([
      ['a leading zero in iat', (now: number) => forged(`0${String(now)}`, String(now + 60))],
      ['a leading zero in exp', (now: number) => forged(String(now), `0${String(now + 60)}`)],
      ['a 13-digit iat', () => forged('1000000000000', '100000000000')],
      ['a 13-digit exp', (now: number) => forged(String(now), '1000000000000')],
      ['a plus sign', (now: number) => forged(`+${String(now)}`, String(now + 60))],
    ])('reports %s as malformed, even when the signature is right', (_name, make) => {
      const clock = createFakeClock('2026-10-10T12:00:00.000Z');
      const csrf = makeCsrf(clock, key);
      const now = Math.floor(clock.nowMs() / 1000);
      expect(csrf.validate(make(now), '')).toEqual({ ok: false, reason: 'malformed' });
    });

    it('accepts the same token written canonically, so the forging above is fair', () => {
      const clock = createFakeClock('2026-10-10T12:00:00.000Z');
      const csrf = makeCsrf(clock, key);
      const now = Math.floor(clock.nowMs() / 1000);
      expect(csrf.validate(forged(String(now), String(now + 60)), '')).toEqual({ ok: true });
    });
  });

  it('checks the signature before it reports a time problem, so a forged token learns nothing about the clock', () => {
    const { clock, csrf, token } = minted();
    const parts = token.split('.');
    parts[1] = '1';
    clock.advance(TTL_SECONDS * 2 * 1000);
    expect(csrf.validate(parts.join('.'), '')).toEqual({ ok: false, reason: 'bad_signature' });
  });
});

// ---------------------------------------------------------------------------------------------
// The matrix over HTTP
// ---------------------------------------------------------------------------------------------

interface Deps {
  readonly clock: FakeClock;
  readonly key: Buffer;
  readonly csrf: Csrf;
  readonly denials: Denial[];
  readonly handled: { count: number };
}

type GuardFactory = (deps: Deps) => MiddlewareHandler<AppEnv>[];

const config = loadConfigOrThrow({ PORT: '9090' });

function realGuards(): GuardFactory {
  return (deps) => [
    originAndCsrfGuard({
      expectedOrigin: config.publicOrigin,
      csrf: deps.csrf,
      onDenied: (_c, denial) => {
        deps.denials.push(denial);
      },
    }),
  ];
}

function buildAppWith(deps: Deps, guards: GuardFactory): Hono<AppEnv> {
  const log = { error: () => undefined, warn: () => undefined };
  const app = new Hono<AppEnv>();
  app.use(requestContext({ config }));
  app.use(errorBoundary(createErrorHandler({ log })));
  const handler: MiddlewareHandler<AppEnv> = async (c) => {
    deps.handled.count += 1;
    return await Promise.resolve(c.json({ handled: true }));
  };
  const chain: MiddlewareHandler<AppEnv>[] = [...guards(deps), handler];
  // The overload with a list of paths takes any number of handlers.
  app.on(['POST', 'PUT', 'PATCH', 'DELETE', 'PROPFIND', 'GET'], ['/w'], ...chain);
  app.onError(createErrorHandler({ log }));
  app.notFound(notFoundHandler);
  return app;
}

function makeDeps(): Deps {
  const clock = createFakeClock('2026-10-10T12:00:00.000Z');
  const key = Buffer.alloc(32, 3);
  return { clock, key, csrf: makeCsrf(clock, key), denials: [], handled: { count: 0 } };
}

interface Row {
  readonly name: string;
  readonly method?: string;
  readonly origin?: string | null;
  readonly secFetchSite?: string | null;
  readonly host?: string | null;
  /** How to produce the `X-CSRF-Token` header. */
  readonly token?:
    'valid' | 'none' | 'empty' | 'malformed' | 'flipped' | 'expired' | 'future' | 'other-key';
  readonly expect: 'ok' | 'origin_not_allowed' | 'csrf_invalid';
}

const ORIGIN_ROWS: readonly Row[] = [
  { name: 'equal origin, no Sec-Fetch-Site', expect: 'ok' },
  { name: 'equal origin, same-origin', secFetchSite: 'same-origin', expect: 'ok' },
  { name: 'equal origin, same-site', secFetchSite: 'same-site', expect: 'origin_not_allowed' },
  { name: 'equal origin, cross-site', secFetchSite: 'cross-site', expect: 'origin_not_allowed' },
  { name: 'equal origin, none', secFetchSite: 'none', expect: 'origin_not_allowed' },
  {
    name: 'equal origin, bogus Sec-Fetch-Site',
    secFetchSite: 'bogus',
    expect: 'origin_not_allowed',
  },
  { name: 'foreign origin', origin: 'https://evil.example', expect: 'origin_not_allowed' },
  {
    name: 'foreign origin, same-origin',
    origin: 'https://evil.example',
    secFetchSite: 'same-origin',
    expect: 'origin_not_allowed',
  },
  {
    name: 'foreign origin, cross-site',
    origin: 'https://evil.example',
    secFetchSite: 'cross-site',
    expect: 'origin_not_allowed',
  },
  { name: 'Origin: null', origin: 'null', expect: 'origin_not_allowed' },
  {
    name: 'Origin: null, same-origin',
    origin: 'null',
    secFetchSite: 'same-origin',
    expect: 'origin_not_allowed',
  },
  { name: 'no Origin, no Sec-Fetch-Site', origin: null, expect: 'origin_not_allowed' },
  {
    name: 'no Origin, same-origin',
    origin: null,
    secFetchSite: 'same-origin',
    expect: 'origin_not_allowed',
  },
  { name: 'scheme mismatch', origin: 'https://localhost:9090', expect: 'origin_not_allowed' },
  { name: 'port mismatch', origin: 'http://localhost:9091', expect: 'origin_not_allowed' },
  { name: 'no port', origin: 'http://localhost', expect: 'origin_not_allowed' },
  { name: 'upper-case host', origin: 'http://LOCALHOST:9090', expect: 'origin_not_allowed' },
  {
    name: 'the same machine by address',
    origin: 'http://127.0.0.1:9090',
    expect: 'origin_not_allowed',
  },
  { name: 'a trailing slash', origin: 'http://localhost:9090/', expect: 'origin_not_allowed' },
  {
    name: 'a look-alike host',
    origin: 'http://localhost:9090.evil.example',
    expect: 'origin_not_allowed',
  },
  // The Host header is never used (A-31): a rebinding page that is served from the attacker's own
  // name and carries a perfectly valid token still fails on its Origin.
  {
    name: 'DNS rebinding: Host and Origin are the attacker, token valid',
    host: 'evil.example:9090',
    origin: 'http://evil.example:9090',
    expect: 'origin_not_allowed',
  },
  {
    name: 'DNS rebinding: Host is the attacker, Origin is not sent',
    host: 'evil.example:9090',
    origin: null,
    expect: 'origin_not_allowed',
  },
  {
    name: 'Host is a stranger but Origin is the configured one',
    host: 'evil.example:9090',
    expect: 'ok',
  },
  { name: 'no Host header at all', host: null, expect: 'ok' },
  {
    name: 'Host matches a foreign Origin',
    host: 'evil.example',
    origin: 'http://evil.example',
    expect: 'origin_not_allowed',
  },
];

const TOKEN_ROWS: readonly Row[] = [
  { name: 'a valid token', token: 'valid', expect: 'ok' },
  { name: 'no token', token: 'none', expect: 'csrf_invalid' },
  { name: 'an empty token', token: 'empty', expect: 'csrf_invalid' },
  { name: 'a malformed token', token: 'malformed', expect: 'csrf_invalid' },
  { name: 'a token with a wrong signature', token: 'flipped', expect: 'csrf_invalid' },
  { name: 'an expired token', token: 'expired', expect: 'csrf_invalid' },
  { name: 'a token from the future', token: 'future', expect: 'csrf_invalid' },
  { name: 'a token of another process', token: 'other-key', expect: 'csrf_invalid' },
  {
    name: 'a bad token and a bad origin: the origin is reported',
    token: 'flipped',
    origin: 'https://evil.example',
    expect: 'origin_not_allowed',
  },
  {
    name: 'no token and no origin: the origin is reported',
    token: 'none',
    origin: null,
    expect: 'origin_not_allowed',
  },
  {
    name: 'no token, cross-site: the origin is reported',
    token: 'none',
    secFetchSite: 'cross-site',
    expect: 'origin_not_allowed',
  },
];

const METHOD_ROWS: readonly Row[] = ['POST', 'PUT', 'PATCH', 'DELETE', 'PROPFIND'].flatMap(
  (method) => [
    { name: `${method} with everything right`, method, expect: 'ok' as const },
    {
      name: `${method} with no token`,
      method,
      token: 'none' as const,
      expect: 'csrf_invalid' as const,
    },
    {
      name: `${method} with the wrong origin`,
      method,
      origin: 'https://evil.example',
      expect: 'origin_not_allowed' as const,
    },
  ],
);

function tokenFor(row: Row, deps: Deps): string | null {
  const kind = row.token ?? 'valid';
  const { clock, key, csrf } = deps;
  switch (kind) {
    case 'valid':
      return csrf.issue('').token;
    case 'none':
      return null;
    case 'empty':
      return '';
    case 'malformed':
      return 'not-a-token';
    case 'flipped': {
      const token = csrf.issue('').token;
      return `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    }
    case 'expired': {
      const earlier = makeCsrf(
        createFakeClock(clock.nowMs() - (TTL_SECONDS + LEEWAY_SECONDS + 1) * 1000),
        key,
      );
      return earlier.issue('').token;
    }
    case 'future': {
      const later = makeCsrf(
        createFakeClock(clock.nowMs() + (FUTURE_LIMIT_SECONDS + 1) * 1000),
        key,
      );
      return later.issue('').token;
    }
    case 'other-key':
      return makeCsrf(clock, Buffer.alloc(32, 99)).issue('').token;
  }
}

async function send(app: Hono<AppEnv>, deps: Deps, row: Row): Promise<Response> {
  const headers = new Headers();
  const origin = row.origin === undefined ? EXPECTED : row.origin;
  if (origin !== null) headers.set('origin', origin);
  if (row.secFetchSite !== undefined && row.secFetchSite !== null) {
    headers.set('sec-fetch-site', row.secFetchSite);
  }
  const host = row.host === undefined ? 'localhost:9090' : row.host;
  if (host !== null) headers.set('host', host);
  const token = tokenFor(row, deps);
  if (token !== null) headers.set('x-csrf-token', token);
  headers.set('content-type', 'application/json');
  return await app.fetch(
    new Request(`${EXPECTED}/w`, { method: row.method ?? 'POST', headers, body: '{}' }),
  );
}

/** Throws unless the guards give every row of the matrix its expected outcome. */
async function assertWriteGuards(guards: GuardFactory): Promise<void> {
  for (const row of [...ORIGIN_ROWS, ...TOKEN_ROWS, ...METHOD_ROWS]) {
    const deps = makeDeps();
    const app = buildAppWith(deps, guards);
    const response = await send(app, deps, row);
    const body = (await response.json()) as { code?: string; handled?: boolean };
    const outcome =
      response.status === 200 ? 'ok' : (body.code ?? `status ${String(response.status)}`);
    if (outcome !== row.expect) {
      throw new Error(`${row.name}: expected ${row.expect}, got ${outcome}`);
    }
    if ((outcome === 'ok') !== (deps.handled.count === 1)) {
      throw new Error(`${row.name}: the handler ran ${String(deps.handled.count)} times`);
    }
  }
}

describe('the full matrix of Origin, Sec-Fetch-Site and token states (FR-A-044)', () => {
  it.each([...ORIGIN_ROWS, ...TOKEN_ROWS, ...METHOD_ROWS].map((row) => [row.name, row] as const))(
    '%s',
    async (_name, row) => {
      const deps = makeDeps();
      const app = buildAppWith(deps, realGuards());

      const response = await send(app, deps, row);

      if (row.expect === 'ok') {
        expect(response.status).toBe(200);
        expect(deps.handled.count).toBe(1);
        expect(deps.denials).toEqual([]);
        return;
      }
      expect(response.status).toBe(403);
      expect(response.headers.get('content-type')).toBe('application/problem+json');
      expect(await response.json()).toMatchObject({ status: 403, code: row.expect });
      expect(deps.handled.count).toBe(0);
      expect(deps.denials).toHaveLength(1);
      expect(deps.denials[0]?.code).toBe(row.expect);
    },
  );

  it('passes the whole matrix for the real guards', async () => {
    await expect(assertWriteGuards(realGuards())).resolves.toBeUndefined();
  });
});

describe('what the client is told (plan 8.3, step 4)', () => {
  it('origin_not_allowed carries the expected origin and names PUBLIC_BASE_URL (E-14, A-63)', async () => {
    const deps = makeDeps();
    const app = buildAppWith(deps, realGuards());

    const response = await send(app, deps, {
      name: 'wrong origin',
      origin: 'http://127.0.0.1:9090',
      expect: 'origin_not_allowed',
    });
    const body = (await response.json()) as {
      code: string;
      detail: string;
      expectedOrigin: string;
    };

    expect(response.status).toBe(403);
    expect(body.code).toBe('origin_not_allowed');
    expect(body.expectedOrigin).toBe('http://localhost:9090');
    expect(body.detail).toContain('PUBLIC_BASE_URL');
  });

  it('never says which part failed: the body of every refusal has the same shape as every other', async () => {
    const deps = makeDeps();
    const app = buildAppWith(deps, realGuards());
    const seen = new Map<string, Set<string>>();
    for (const row of [...ORIGIN_ROWS, ...TOKEN_ROWS].filter(
      (candidate) => candidate.expect !== 'ok',
    )) {
      const response = await send(app, deps, row);
      const body = (await response.json()) as Record<string, unknown>;
      const rest = Object.fromEntries(
        Object.entries(body).filter(([name]) => name !== 'requestId'),
      );
      const code = String(body.code);
      const bucket = seen.get(code) ?? new Set<string>();
      bucket.add(JSON.stringify(rest));
      seen.set(code, bucket);
    }

    // One body per code, however the request failed.
    expect([...seen.keys()].sort()).toEqual(['csrf_invalid', 'origin_not_allowed']);
    for (const bodies of seen.values()) expect(bodies.size).toBe(1);
  });

  it('csrf_invalid has no expectedOrigin: the member belongs to origin_not_allowed only', async () => {
    const deps = makeDeps();
    const app = buildAppWith(deps, realGuards());
    const response = await send(app, deps, {
      name: 'no token',
      token: 'none',
      expect: 'csrf_invalid',
    });
    expect(await response.json()).not.toHaveProperty('expectedOrigin');
  });

  it('does not echo what the client sent: not the origin, not the token', async () => {
    const deps = makeDeps();
    const app = buildAppWith(deps, realGuards());
    const response = await app.fetch(
      new Request(`${EXPECTED}/w`, {
        method: 'POST',
        headers: { origin: 'https://canary-origin.example', 'x-csrf-token': 'canary-token-value' },
        body: '{}',
      }),
    );
    const text = await response.text();
    expect(text).not.toContain('canary-origin');
    expect(text).not.toContain('canary-token');
  });
});

describe('the guard runs on writes and only on writes (plan 8.3)', () => {
  it.each(['GET', 'HEAD'])('lets %s through with no Origin and no token', async (method) => {
    const deps = makeDeps();
    const app = buildAppWith(deps, realGuards());
    const response = await app.fetch(new Request(`${EXPECTED}/w`, { method }));
    expect(response.status).toBe(200);
    expect(deps.denials).toEqual([]);
  });

  it('is told about a denial once, with the code and an internal reason, before the response exists', async () => {
    const deps = makeDeps();
    const order: string[] = [];
    const guards: GuardFactory = (d) => [
      originAndCsrfGuard({
        expectedOrigin: config.publicOrigin,
        csrf: d.csrf,
        onDenied: async (_c, denial) => {
          await Promise.resolve();
          order.push(`denied:${denial.code}:${denial.reason}`);
        },
      }),
    ];
    const app = buildAppWith(deps, guards);

    const response = await send(app, deps, {
      name: 'no token',
      token: 'none',
      expect: 'csrf_invalid',
    });
    order.push('responded');

    expect(response.status).toBe(403);
    expect(order).toEqual(['denied:csrf_invalid:missing', 'responded']);
  });

  it('reports the internal reason of each failure to the denial hook, and only there', async () => {
    const expectations: readonly (readonly [Row, string, string])[] = [
      [
        { name: 'a', origin: null, expect: 'origin_not_allowed' },
        'origin_not_allowed',
        'origin_missing',
      ],
      [
        { name: 'b', origin: 'null', expect: 'origin_not_allowed' },
        'origin_not_allowed',
        'origin_null',
      ],
      [
        { name: 'c', origin: 'https://evil.example', expect: 'origin_not_allowed' },
        'origin_not_allowed',
        'origin_mismatch',
      ],
      [
        { name: 'd', secFetchSite: 'cross-site', expect: 'origin_not_allowed' },
        'origin_not_allowed',
        'sec_fetch_site',
      ],
      [{ name: 'e', token: 'none', expect: 'csrf_invalid' }, 'csrf_invalid', 'missing'],
      [{ name: 'f', token: 'malformed', expect: 'csrf_invalid' }, 'csrf_invalid', 'malformed'],
      [{ name: 'g', token: 'flipped', expect: 'csrf_invalid' }, 'csrf_invalid', 'bad_signature'],
      [{ name: 'h', token: 'expired', expect: 'csrf_invalid' }, 'csrf_invalid', 'expired'],
      [{ name: 'i', token: 'future', expect: 'csrf_invalid' }, 'csrf_invalid', 'not_yet_valid'],
    ];
    for (const [row, code, reason] of expectations) {
      const deps = makeDeps();
      const app = buildAppWith(deps, realGuards());
      await send(app, deps, row);
      expect(deps.denials, row.name).toEqual([{ code, reason }]);
    }
  });

  it('fails closed when the denial hook fails: no handler, no 200, the error handler answers', async () => {
    const deps = makeDeps();
    const guards: GuardFactory = (d) => [
      originAndCsrfGuard({
        expectedOrigin: config.publicOrigin,
        csrf: d.csrf,
        onDenied: () => {
          throw new Error('audit unavailable');
        },
      }),
    ];
    const app = buildAppWith(deps, guards);

    const response = await send(app, deps, {
      name: 'no token',
      token: 'none',
      expect: 'csrf_invalid',
    });

    expect(response.status).toBe(500);
    expect(deps.handled.count).toBe(0);
  });

  it('works without a denial hook', async () => {
    const deps = makeDeps();
    const guards: GuardFactory = (d) => [
      originAndCsrfGuard({ expectedOrigin: config.publicOrigin, csrf: d.csrf }),
    ];
    const app = buildAppWith(deps, guards);
    const response = await send(app, deps, {
      name: 'no token',
      token: 'none',
      expect: 'csrf_invalid',
    });
    expect(response.status).toBe(403);
  });

  it('takes the binding from the request, so that a session id can be bound later', async () => {
    const deps = makeDeps();
    const guards: GuardFactory = (d) => [
      originAndCsrfGuard({
        expectedOrigin: config.publicOrigin,
        csrf: d.csrf,
        binding: (c) => c.req.header('x-test-session') ?? '',
      }),
    ];
    const app = buildAppWith(deps, guards);
    const token = deps.csrf.issue('session-a').token;
    const call = (session: string): Promise<Response> =>
      Promise.resolve(
        app.fetch(
          new Request(`${EXPECTED}/w`, {
            method: 'POST',
            headers: { origin: EXPECTED, 'x-csrf-token': token, 'x-test-session': session },
            body: '{}',
          }),
        ),
      );

    expect((await call('session-a')).status).toBe(200);
    expect((await call('session-b')).status).toBe(403);
  });

  it('exposes the two checks separately, for a route that needs only one', async () => {
    const deps = makeDeps();
    const originOnly: GuardFactory = () => [originGuard({ expectedOrigin: config.publicOrigin })];
    const tokenOnly: GuardFactory = (d) => [csrfGuard({ csrf: d.csrf })];

    const a = buildAppWith(deps, originOnly);
    expect((await send(a, deps, { name: 'x', token: 'none', expect: 'ok' })).status).toBe(200);
    expect(
      (
        await send(a, deps, {
          name: 'y',
          origin: 'https://evil.example',
          expect: 'origin_not_allowed',
        })
      ).status,
    ).toBe(403);

    const b = buildAppWith(deps, tokenOnly);
    expect(
      (await send(b, deps, { name: 'z', origin: 'https://evil.example', expect: 'ok' })).status,
    ).toBe(200);
    expect((await send(b, deps, { name: 'w', token: 'none', expect: 'csrf_invalid' })).status).toBe(
      403,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// A GET that writes an audit entry (FR-A-044)
// ---------------------------------------------------------------------------------------------

interface AuditedDeps {
  readonly auditRows: string[];
}

function buildAuditedApp(
  deps: AuditedDeps,
  guard: MiddlewareHandler<AppEnv> | undefined,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use(requestContext({ config }));
  // The handler stands for "assemble the export and append the audit row".
  const writesAudit = (c: { json: (value: unknown) => Response }): Response => {
    deps.auditRows.push('branding.export');
    return c.json({ exported: true });
  };
  if (guard === undefined) app.get('/export', writesAudit);
  else app.get('/export', guard, writesAudit);
  app.get('/plain', (c) => c.json({ plain: true }));
  return app;
}

async function getWith(
  app: Hono<AppEnv>,
  path: string,
  headers: Record<string, string>,
): Promise<Response> {
  return await app.fetch(new Request(`${EXPECTED}${path}`, { headers }));
}

/** Throws unless the guard on an audited GET follows the rule of FR-A-044. */
async function assertAuditedRead(makeGuard: () => MiddlewareHandler<AppEnv>): Promise<void> {
  const cases: readonly (readonly [string | null, boolean])[] = [
    [null, true],
    ['same-origin', true],
    ['none', true],
    ['same-site', false],
    ['cross-site', false],
  ];
  for (const [value, allowed] of cases) {
    const deps: AuditedDeps = { auditRows: [] };
    const app = buildAuditedApp(deps, makeGuard());
    const response = await getWith(
      app,
      '/export',
      value === null ? {} : { 'sec-fetch-site': value },
    );
    if (allowed && (response.status !== 200 || deps.auditRows.length !== 1)) {
      throw new Error(`Sec-Fetch-Site ${String(value)} was refused`);
    }
    if (!allowed) {
      if (response.status !== 403)
        throw new Error(`Sec-Fetch-Site ${String(value)} was let through`);
      if (((await response.json()) as { code: string }).code !== 'origin_not_allowed') {
        throw new Error(`Sec-Fetch-Site ${String(value)}: the code is not origin_not_allowed`);
      }
      if (deps.auditRows.length !== 0)
        throw new Error(`Sec-Fetch-Site ${String(value)} wrote an audit row`);
    }
  }
}

describe('an audited GET applies the Sec-Fetch-Site rule (FR-A-044)', () => {
  it('lets absent, same-origin and none through, and each one writes its audit row', async () => {
    for (const value of [null, 'same-origin', 'none']) {
      const deps: AuditedDeps = { auditRows: [] };
      const app = buildAuditedApp(deps, auditedReadGuard({ expectedOrigin: config.publicOrigin }));

      const response = await getWith(
        app,
        '/export',
        value === null ? {} : { 'sec-fetch-site': value },
      );

      expect(response.status, String(value)).toBe(200);
      expect(deps.auditRows).toEqual(['branding.export']);
    }
  });

  it('answers 403 origin_not_allowed for same-site and cross-site, with no audit row and the expected origin', async () => {
    for (const value of ['same-site', 'cross-site']) {
      const deps: AuditedDeps = { auditRows: [] };
      const app = buildAuditedApp(deps, auditedReadGuard({ expectedOrigin: config.publicOrigin }));

      const response = await getWith(app, '/export', { 'sec-fetch-site': value });

      expect(response.status, value).toBe(403);
      expect(await response.json()).toMatchObject({
        code: 'origin_not_allowed',
        expectedOrigin: 'http://localhost:9090',
      });
      expect(deps.auditRows).toEqual([]);
    }
  });

  it.each(['', 'bogus', 'Same-Origin'])('fails closed for the unknown value %j', async (value) => {
    const deps: AuditedDeps = { auditRows: [] };
    const app = buildAuditedApp(deps, auditedReadGuard({ expectedOrigin: config.publicOrigin }));
    const response = await getWith(app, '/export', { 'sec-fetch-site': value });
    expect(response.status).toBe(403);
    expect(deps.auditRows).toEqual([]);
  });

  it('looks at Sec-Fetch-Site only: a GET carries no token, and an Origin it sends is not judged', async () => {
    const deps: AuditedDeps = { auditRows: [] };
    const app = buildAuditedApp(deps, auditedReadGuard({ expectedOrigin: config.publicOrigin }));

    const response = await getWith(app, '/export', { origin: 'https://evil.example' });

    expect(response.status).toBe(200);
    expect(deps.auditRows).toEqual(['branding.export']);
  });

  it('does not touch a GET route without an audit entry, whatever Sec-Fetch-Site says', async () => {
    const deps: AuditedDeps = { auditRows: [] };
    const app = buildAuditedApp(deps, auditedReadGuard({ expectedOrigin: config.publicOrigin }));

    for (const value of ['cross-site', 'same-site', 'same-origin', 'none']) {
      const response = await getWith(app, '/plain', { 'sec-fetch-site': value });
      expect(response.status, value).toBe(200);
    }
  });

  it('is not audited when it refuses (a refused GET is a read, PA-15): the hook is not offered one', async () => {
    const deps: AuditedDeps = { auditRows: [] };
    const app = buildAuditedApp(deps, auditedReadGuard({ expectedOrigin: config.publicOrigin }));
    const response = await getWith(app, '/export', { 'sec-fetch-site': 'cross-site' });
    expect(response.status).toBe(403);
    expect(deps.auditRows).toHaveLength(0);
  });

  it('passes the audited-read guard of this file for the real guard', async () => {
    await expect(
      assertAuditedRead(() => auditedReadGuard({ expectedOrigin: config.publicOrigin })),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// The guards that must fail the matrix
// ---------------------------------------------------------------------------------------------

interface Defects {
  readonly skipOrigin?: boolean;
  readonly useHost?: boolean;
  readonly acceptNullOrigin?: boolean;
  readonly acceptMissingOriginWhenSameOrigin?: boolean;
  readonly ignoreFetchSite?: boolean;
  readonly acceptNoneFetchSite?: boolean;
  readonly ignoreExpiry?: boolean;
  readonly ignoreFuture?: boolean;
  readonly ignoreSignature?: boolean;
  readonly skipToken?: boolean;
  readonly tokenBeforeOrigin?: boolean;
}

/** A guard that is right unless a defect says otherwise; the proof that each defect is what fails. */
function referenceGuards(defects: Defects = {}): GuardFactory {
  return (deps) => [
    async (c, next) => {
      if (!isWriteMethod(c.req.method)) {
        await next();
        return;
      }
      const origin = c.req.header('origin') ?? null;
      const site = c.req.header('sec-fetch-site') ?? null;
      const host = c.req.header('host') ?? null;

      const originFails = (): boolean => {
        if (defects.skipOrigin === true) return false;
        const expected = defects.useHost === true ? `http://${host ?? ''}` : config.publicOrigin;
        if (origin === null) {
          return !(defects.acceptMissingOriginWhenSameOrigin === true && site === 'same-origin');
        }
        if (origin === 'null') return defects.acceptNullOrigin !== true;
        if (origin !== expected) return true;
        if (defects.ignoreFetchSite === true || site === null) return false;
        if (site === 'same-origin') return false;
        return !(defects.acceptNoneFetchSite === true && site === 'none');
      };
      const tokenFails = (): boolean => {
        if (defects.skipToken === true) return false;
        const token = c.req.header('x-csrf-token') ?? null;
        const parts = token?.split('.') ?? [];
        if (parts.length !== 5 || parts[0] !== 'v1') return true;
        const [version, iat, exp, nonce, mac] = parts as [string, string, string, string, string];
        const expected = createHmac('sha256', deps.key)
          .update(`${version}.${iat}.${exp}.${nonce}.`)
          .digest('base64url');
        if (defects.ignoreSignature !== true && mac !== expected) return true;
        const now = deps.clock.nowMs();
        if (defects.ignoreFuture !== true && Number(iat) * 1000 > now + FUTURE_LIMIT_SECONDS * 1000)
          return true;
        return defects.ignoreExpiry !== true && now > (Number(exp) + LEEWAY_SECONDS) * 1000;
      };

      const checks: readonly (readonly [() => boolean, 'origin_not_allowed' | 'csrf_invalid'])[] =
        defects.tokenBeforeOrigin === true
          ? [
              [tokenFails, 'csrf_invalid'],
              [originFails, 'origin_not_allowed'],
            ]
          : [
              [originFails, 'origin_not_allowed'],
              [tokenFails, 'csrf_invalid'],
            ];
      for (const [fails, code] of checks) {
        if (fails()) {
          return code === 'origin_not_allowed'
            ? problemResponse(c, 'origin_not_allowed', { expectedOrigin: config.publicOrigin })
            : problemResponse(c, 'csrf_invalid');
        }
      }
      await next();
      return undefined;
    },
  ];
}

describe('the matrix guard', () => {
  it('passes for the real guards', async () => {
    await expect(assertWriteGuards(realGuards())).resolves.toBeUndefined();
  });

  it('passes for the reference guards of this test, which proves the fixtures are fair', async () => {
    await expect(assertWriteGuards(referenceGuards())).resolves.toBeUndefined();
  });

  it.each([
    ['skips the Origin check', { skipOrigin: true }, 'equal origin, same-site'],
    ['uses the Host header instead of PUBLIC_BASE_URL', { useHost: true }, 'DNS rebinding'],
    ['accepts Origin: null', { acceptNullOrigin: true }, 'Origin: null'],
    [
      'accepts a missing Origin when Sec-Fetch-Site is same-origin',
      { acceptMissingOriginWhenSameOrigin: true },
      'no Origin, same-origin',
    ],
    ['ignores Sec-Fetch-Site', { ignoreFetchSite: true }, 'equal origin, same-site'],
    [
      'accepts Sec-Fetch-Site: none on a write',
      { acceptNoneFetchSite: true },
      'equal origin, none',
    ],
    ['never lets a token expire', { ignoreExpiry: true }, 'expired token'],
    ['accepts a token from the future', { ignoreFuture: true }, 'from the future'],
    ['does not check the signature', { ignoreSignature: true }, 'wrong signature'],
    ['does not check the token at all', { skipToken: true }, 'no token'],
    ['checks the token before the Origin', { tokenBeforeOrigin: true }, 'the origin is reported'],
  ] as const)('fails for a guard that %s', async (_name, defects, row) => {
    await expectGuardFails(assertWriteGuards, referenceGuards(defects), { reason: row });
  });
});

describe('the audited-read guard', () => {
  it('fails for a guard that lets every Sec-Fetch-Site through (an audited GET without the check)', async () => {
    await expectGuardFails(
      assertAuditedRead,
      (): MiddlewareHandler<AppEnv> => async (_c, next) => {
        await next();
      },
      { reason: 'was let through' },
    );
  });

  it('fails for a guard that refuses none', async () => {
    const strict = (): MiddlewareHandler<AppEnv> => async (c, next) => {
      if (c.req.header('sec-fetch-site') !== 'same-origin') {
        return problemResponse(c, 'origin_not_allowed', { expectedOrigin: config.publicOrigin });
      }
      await next();
      return undefined;
    };
    await expectGuardFails(assertAuditedRead, strict, { reason: 'was refused' });
  });

  it('fails for a guard that refuses with the wrong code', async () => {
    const wrongCode = (): MiddlewareHandler<AppEnv> => async (c, next) => {
      if (['same-site', 'cross-site'].includes(c.req.header('sec-fetch-site') ?? '')) {
        return problemResponse(c, 'csrf_invalid');
      }
      await next();
      return undefined;
    };
    await expectGuardFails(assertAuditedRead, wrongCode, {
      reason: 'the code is not origin_not_allowed',
    });
  });
});

// ---------------------------------------------------------------------------------------------
// T-A-042: GET /api/v1/csrf (R5, FR-A-027, FR-A-044)
// ---------------------------------------------------------------------------------------------

describe('GET /api/v1/csrf (R5)', () => {
  const CSRF = '/api/v1/csrf';

  it('returns a token the validator accepts, and when it expires', async () => {
    const app = await createFixtureApp({ system: {} });
    const response = await app.client.get(CSRF);
    expect(response.status).toBe(200);
    const body = await readJson(response);
    const parsed = CsrfResponseSchema.parse(body);
    expect(parsed.token).toMatch(TOKEN_PATTERN);
    expect(app.csrf.validate(parsed.token, '')).toEqual({ ok: true });
    // Issued now, valid for 8 hours: the expiry is read from the injected clock.
    expect(Date.parse(parsed.expiresAt)).toBe(app.clock.nowMs() + LIMITS.csrfTokenLifetimeMs);
  });

  it('issues a token bound to the empty binding of Phase A, and not to any other', async () => {
    const app = await createFixtureApp({ system: {} });
    const { token } = CsrfResponseSchema.parse(await readJson(await app.client.get(CSRF)));
    expect(app.csrf.validate(token, 'session-1').ok).toBe(false);
  });

  it('is no-store, uncompressed and not cacheable by a proxy', async () => {
    const app = await createFixtureApp({ system: {} });
    const response = await app.client.get(CSRF, { headers: { 'accept-encoding': 'br, gzip' } });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.headers.get('etag')).toBeNull();
  });

  it('is public, and the token it returns lets a write through (the client flow)', async () => {
    const app = await createFixtureApp({ system: {}, signedIn: ADMIN });
    const response = await app.client.post('/api/v1/fixture/things', { json: { name: 'x' } });
    expect(response.status).toBe(201);
  });

  it('gives each request its own token', async () => {
    const app = await createFixtureApp({ system: {} });
    const first = CsrfResponseSchema.parse(await readJson(await app.client.get(CSRF)));
    const second = CsrfResponseSchema.parse(await readJson(await app.client.get(CSRF)));
    expect(first.token).not.toBe(second.token);
  });

  it('keeps answering after a token expired: a new one is valid', async () => {
    const app = await createFixtureApp({ system: {}, signedIn: ADMIN });
    const old = CsrfResponseSchema.parse(await readJson(await app.client.get(CSRF)));
    app.clock.advance(LIMITS.csrfTokenLifetimeMs + 120_000);
    // The session stayed in use meanwhile (its deadlines slid): only the token is old.
    app.identity.db.sqlite
      .prepare('UPDATE session SET last_seen_at = ?, absolute_expires_at = ?')
      .run(app.clock.iso(), new Date(app.clock.nowMs() + 3_600_000).toISOString());
    const stale = await app.client.post('/api/v1/fixture/things', {
      json: { name: 'x' },
      csrf: { token: old.token },
    });
    expect(stale.status).toBe(403);
    expect((await readJson<{ code: string }>(stale)).code).toBe('csrf_invalid');
    const fresh = await app.client.post('/api/v1/fixture/things', {
      json: { name: 'x' },
      csrf: { token: await app.client.csrfToken({ refresh: true }) },
    });
    expect(fresh.status).toBe(201);
  });

  it('is rated as a read', async () => {
    const app = await createFixtureApp({ system: {} });
    const route = app.http.table.routes.find((candidate) => candidate.id === 'meta.csrf');
    expect(route?.rateLimit).toBe('read');
    expect(route?.access).toEqual({ public: true });
  });
});

// ---------------------------------------------------------------------------------------------
// Phase B: the binding is computed from the cookies as sent (T-B-241, FR-B-408, FR-B-205, SB-09)
// ---------------------------------------------------------------------------------------------

describe('the CSRF token is bound to the cookies the browser sent (FR-B-408)', () => {
  const PING = '/api/v1/fixture/ping';
  const SESSION = 'm365portal_session';
  const SETUP = 'm365portal_setup';
  const id = (letter: string): string => letter.repeat(43);
  const cookie = (...pairs: string[]): Record<string, string> => ({ cookie: pairs.join('; ') });

  async function post(
    app: Awaited<ReturnType<typeof createFixtureApp>>,
    tokenFrom: Record<string, string>,
    sendWith: Record<string, string>,
  ): Promise<number> {
    // A token fetched by a browser that held `tokenFrom`, used by a browser that holds `sendWith`.
    const token = await app.clientFor({ headers: tokenFrom }).csrfToken();
    const response = await app
      .clientFor({ headers: sendWith })
      .post(PING, { json: {}, csrf: { token } });
    return response.status;
  }

  const matrix: readonly {
    readonly name: string;
    readonly tokenFrom: Record<string, string>;
    readonly sendWith: Record<string, string>;
    readonly status: number;
  }[] = [
    { name: 'anonymous with anonymous', tokenFrom: {}, sendWith: {}, status: 200 },
    {
      name: 'a user with the same session',
      tokenFrom: cookie(`${SESSION}=${id('a')}`),
      sendWith: cookie(`${SESSION}=${id('a')}`),
      status: 200,
    },
    {
      name: 'a user token used by an anonymous browser',
      tokenFrom: cookie(`${SESSION}=${id('a')}`),
      sendWith: {},
      status: 403,
    },
    {
      name: 'an anonymous token used by a user',
      tokenFrom: {},
      sendWith: cookie(`${SESSION}=${id('a')}`),
      status: 403,
    },
    {
      name: "another user's token",
      tokenFrom: cookie(`${SESSION}=${id('a')}`),
      sendWith: cookie(`${SESSION}=${id('b')}`),
      status: 403,
    },
    {
      name: 'a setup actor with the same setup session',
      tokenFrom: cookie(`${SETUP}=${id('s')}`),
      sendWith: cookie(`${SETUP}=${id('s')}`),
      status: 200,
    },
    {
      name: 'a user token used as a setup actor',
      tokenFrom: cookie(`${SESSION}=${id('a')}`),
      sendWith: cookie(`${SETUP}=${id('t')}`),
      status: 403,
    },
    {
      name: 'an Owner holding both cookies, with a token fetched holding both',
      tokenFrom: cookie(`${SESSION}=${id('a')}`, `${SETUP}=${id('s')}`),
      sendWith: cookie(`${SETUP}=${id('s')}`, `${SESSION}=${id('a')}`),
      status: 200,
    },
    {
      name: 'an Owner holding both cookies, with a token fetched holding the session only',
      tokenFrom: cookie(`${SESSION}=${id('a')}`),
      sendWith: cookie(`${SESSION}=${id('a')}`, `${SETUP}=${id('s')}`),
      status: 403,
    },
    {
      name: 'an Owner holding both cookies, with a token fetched holding the setup cookie only',
      tokenFrom: cookie(`${SETUP}=${id('s')}`),
      sendWith: cookie(`${SESSION}=${id('a')}`, `${SETUP}=${id('s')}`),
      status: 403,
    },
    {
      name: 'a rotated session (sign-in, step-up, logout): the old token fails',
      tokenFrom: cookie(`${SESSION}=${id('a')}`),
      sendWith: cookie(`${SESSION}=${id('r')}`),
      status: 403,
    },
    {
      name: 'a duplicated session cookie counts as absent, like an anonymous browser',
      tokenFrom: {},
      sendWith: cookie(`${SESSION}=${id('a')}`, `${SESSION}=${id('a')}`),
      status: 200,
    },
    {
      name: 'a cookie of another name is not part of the binding',
      tokenFrom: {},
      sendWith: cookie(`tracking=${id('z')}`),
      status: 200,
    },
  ];

  it.each(matrix)('$name', async ({ tokenFrom, sendWith, status }) => {
    const app = await createFixtureApp({ system: {} });
    expect(await post(app, tokenFrom, sendWith)).toBe(status);
    if (status === 403) expect(app.calls.of('fixture.ping')).toBe(0);
  });

  it('answers the refusal with csrf_invalid and nothing about the cookies', async () => {
    const app = await createFixtureApp({ system: {} });
    const token = await app.clientFor({ headers: cookie(`${SESSION}=${id('a')}`) }).csrfToken();
    const response = await app
      .clientFor({ headers: cookie(`${SESSION}=${id('b')}`) })
      .post(PING, { json: {}, csrf: { token } });
    const body = await readJson<Record<string, unknown>>(response);
    expect(body.code).toBe('csrf_invalid');
    expect(JSON.stringify(body)).not.toContain(id('a'));
    expect(JSON.stringify(body)).not.toContain(id('b'));
  });

  it('lets the client recover once: after a rotation it fetches a new token and the write goes through', async () => {
    const app = await createFixtureApp({ system: {} });
    const before = app.clientFor({ headers: cookie(`${SESSION}=${id('a')}`) });
    const old = await before.csrfToken();
    const after = app.clientFor({ headers: cookie(`${SESSION}=${id('r')}`) });
    expect((await after.post(PING, { json: {}, csrf: { token: old } })).status).toBe(403);
    expect((await after.post(PING, { json: {} })).status).toBe(200);
  });

  it('computes the binding with no database: the fixture has none', async () => {
    const app = await createFixtureApp({ system: {} });
    const client = app.clientFor({
      headers: cookie(`${SESSION}=${id('a')}`, `${SETUP}=${id('s')}`),
    });
    expect((await client.post(PING, { json: {} })).status).toBe(200);
  });

  it('does not resolve the actor to check the token', async () => {
    let resolved = 0;
    const app = await createFixtureApp({
      system: {},
      resolveActor: () => {
        resolved += 1;
        return ANONYMOUS_ACTOR;
      },
    });
    const client = app.clientFor({ headers: cookie(`${SESSION}=${id('a')}`) });
    const token = await client.csrfToken();
    await client.post(PING, { json: {}, csrf: { token: `${token}x` } });
    expect(resolved).toBe(0);
  });

  it('needs no token for the sign-in navigations: they are GETs', async () => {
    const app = await createFixtureApp({ system: {} });
    expect((await app.client.get('/api/v1/fixture/read')).status).toBe(200);
  });
});

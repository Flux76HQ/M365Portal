// T-B-241, FR-B-408, FR-B-205 (binding), SB-09: `hashSessionId` and `csrfBindingFor` are the single
// implementations of the session-id hash and of the CSRF binding, and the cookie reader that feeds
// them counts a cookie that appears twice as absent.
import { createHash } from 'node:crypto';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import { readPanelCookies } from '../src/policy/cookies.js';
import { csrfBindingFor, csrfBindingOfHeaders, hashSessionId } from '../src/policy/session-hash.js';

const SESSION = 'S'.repeat(43);
const SETUP = 'T'.repeat(43);
const NAMES = { session: 'm365portal_session', setup: 'm365portal_setup' } as const;
const HOST_NAMES = {
  session: '__Host-m365portal_session',
  setup: '__Host-m365portal_setup',
} as const;

describe('hashSessionId: SHA-256 as lower-case hex of the cookie value', () => {
  it.each([
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    [
      'The quick brown fox jumps over the lazy dog',
      'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592',
    ],
  ])('hashes %j (known answer)', (value, expected) => {
    expect(hashSessionId(value)).toBe(expected);
  });

  it('is lower case, 64 characters, and equals node:crypto', () => {
    const value = 'A'.repeat(43);
    const hash = hashSessionId(value);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(createHash('sha256').update(value).digest('hex'));
  });
});

describe('csrfBindingFor: the two hashes, joined by a dot (SB-09)', () => {
  it('is empty when there is no cookie', () => {
    expect(csrfBindingFor({})).toBe('');
  });

  it('is the hash of the session cookie when only that one is present', () => {
    expect(csrfBindingFor({ session: SESSION })).toBe(hashSessionId(SESSION));
  });

  it('is the hash of the setup cookie when only that one is present', () => {
    expect(csrfBindingFor({ setup: SETUP })).toBe(hashSessionId(SETUP));
  });

  it('is session hash, a dot, setup hash when both are present (an Owner who reopened setup)', () => {
    expect(csrfBindingFor({ session: SESSION, setup: SETUP })).toBe(
      `${hashSessionId(SESSION)}.${hashSessionId(SETUP)}`,
    );
  });

  it('treats an empty value as absent', () => {
    expect(csrfBindingFor({ session: '', setup: SETUP })).toBe(hashSessionId(SETUP));
  });
});

describe('readPanelCookies: the cookies as sent', () => {
  it('reads the two cookies of the plain names', () => {
    const cookies = readPanelCookies(`${NAMES.session}=${SESSION}; ${NAMES.setup}=${SETUP}`, NAMES);
    expect(cookies).toEqual({ session: SESSION, setup: SETUP, duplicates: [] });
  });

  it('reads the __Host- names exactly, and the plain names not at all on https', () => {
    expect(readPanelCookies(`${HOST_NAMES.session}=${SESSION}`, HOST_NAMES).session).toBe(SESSION);
    expect(readPanelCookies(`${NAMES.session}=${SESSION}`, HOST_NAMES).session).toBeUndefined();
  });

  it('ignores other cookies and a different case of the name', () => {
    const header = `other=1; M365PORTAL_SESSION=${SESSION}; xm365portal_session=${SESSION}`;
    expect(readPanelCookies(header, NAMES).session).toBeUndefined();
  });

  it('counts a cookie that appears twice as absent, and says so', () => {
    const header = `${NAMES.session}=${SESSION}; ${NAMES.session}=${'X'.repeat(43)}; ${NAMES.setup}=${SETUP}`;
    expect(readPanelCookies(header, NAMES)).toEqual({
      session: undefined,
      setup: SETUP,
      duplicates: ['session'],
    });
  });

  it('counts a duplicate with the same value as absent as well', () => {
    const header = `${NAMES.setup}=${SETUP}; ${NAMES.setup}=${SETUP}`;
    expect(readPanelCookies(header, NAMES).setup).toBeUndefined();
  });

  it('keeps a value that contains an equals sign, and trims the spaces around a pair', () => {
    const cookies = readPanelCookies(`  ${NAMES.session} = abc=def ;x=y`, NAMES);
    expect(cookies.session).toBe('abc=def');
  });

  it('reads nothing from no header, an empty header or a header without pairs', () => {
    for (const header of [null, undefined, '', ';', 'no-equals', '=value']) {
      expect(readPanelCookies(header, NAMES)).toEqual({
        session: undefined,
        setup: undefined,
        duplicates: [],
      });
    }
  });

  it('does not parse a value as a quoted string', () => {
    expect(readPanelCookies(`${NAMES.session}="${SESSION}"`, NAMES).session).toBe(`"${SESSION}"`);
  });
});

describe('csrfBindingOfHeaders: from the Cookie header and the base URL, with no database', () => {
  it('uses the plain names on http://localhost and the __Host- names on https', () => {
    const http = new Headers({ cookie: `${NAMES.session}=${SESSION}` });
    expect(csrfBindingOfHeaders(http, 'http://localhost:9300')).toBe(hashSessionId(SESSION));
    expect(csrfBindingOfHeaders(http, 'https://panel.example.com')).toBe('');
    const https = new Headers({ cookie: `${HOST_NAMES.setup}=${SETUP}` });
    expect(csrfBindingOfHeaders(https, 'https://panel.example.com')).toBe(hashSessionId(SETUP));
  });

  it('is the empty string for an anonymous browser', () => {
    expect(csrfBindingOfHeaders(new Headers(), 'http://localhost:9300')).toBe('');
  });
});

/** The rule behind the binding: what the binding must tell apart. Throws on a function that does not. */
function assertBindingRules(bindingOf: (cookie: string | null) => string): void {
  const session = `${NAMES.session}=${SESSION}`;
  const setup = `${NAMES.setup}=${SETUP}`;
  const other = `${NAMES.session}=${'O'.repeat(43)}`;
  const expectDifferent = (left: string | null, right: string | null, what: string): void => {
    if (bindingOf(left) === bindingOf(right)) throw new Error(`the binding cannot tell ${what}`);
  };
  expectDifferent(null, session, 'a user from an anonymous browser');
  expectDifferent(session, other, 'two sessions');
  expectDifferent(session, setup, 'a user from a setup actor');
  expectDifferent(session, `${session}; ${setup}`, 'a user from an Owner holding both cookies');
  expectDifferent(
    setup,
    `${session}; ${setup}`,
    'a setup actor from an Owner holding both cookies',
  );
  if (bindingOf(`${session}; ${setup}`) !== bindingOf(`${setup}; ${session}`)) {
    throw new Error('the binding depends on the order of the cookies');
  }
  if (bindingOf(`${NAMES.session}=${SESSION}; ${NAMES.session}=${SESSION}`) !== bindingOf(null)) {
    throw new Error('a duplicated cookie was not counted as absent');
  }
}

describe('the binding rules', () => {
  it('hold for the real binding', () => {
    expect(() => {
      assertBindingRules((cookie) =>
        csrfBindingOfHeaders(
          new Headers(cookie === null ? {} : { cookie }),
          'http://localhost:9300',
        ),
      );
    }).not.toThrow();
  });

  it('negative fixture: a binding that ignores the cookies fails', () => {
    expectGuardFails(assertBindingRules, () => '', { reason: 'cannot tell' });
  });

  it('negative fixture: a binding of the session cookie only fails for the Owner who holds both', () => {
    expectGuardFails(
      assertBindingRules,
      (cookie) => csrfBindingFor({ session: readPanelCookies(cookie, NAMES).session }),
      { reason: 'an Owner holding both cookies' },
    );
  });

  it('negative fixture: a binding that takes the first of two equal cookies fails', () => {
    expectGuardFails(
      assertBindingRules,
      (cookie) => {
        const match = new RegExp(`${NAMES.session}=([^;]+)`).exec(cookie ?? '');
        const setupMatch = new RegExp(`${NAMES.setup}=([^;]+)`).exec(cookie ?? '');
        return csrfBindingFor({
          ...(match?.[1] === undefined ? {} : { session: match[1] }),
          ...(setupMatch?.[1] === undefined ? {} : { setup: setupMatch[1] }),
        });
      },
      { reason: 'duplicated cookie' },
    );
  });
});

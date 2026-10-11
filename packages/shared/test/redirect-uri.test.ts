// T-B-007, FR-B-103, TB-04, CB4, research-microsoft-b section 2.2 (Learn: reply-url): the one
// module that builds the redirect URIs the app registration holds (`redirectUris`) and the one the
// authorize request sends (`authorizeRedirectUri`), and that decides which `PUBLIC_BASE_URL` can be
// registered at all (`parsePublicBaseUrl`).
//
// The table is written out from research section 2.2 and run through a guard that throws on any
// deviation; the guard is proven with negative fixtures (tasks.md section 0.3). The round trip with
// the `PUBLIC_BASE_URL` schema of `server/config.test.ts` (T-B-009) is added by that task.
import { describe, expect, it } from 'vitest';
import {
  CALLBACK_PATH,
  LOGGED_OUT_PATH,
  RedirectUriError,
  authorizeRedirectUri,
  parsePublicBaseUrl,
  postLogoutRedirectUri,
  redirectUris,
  type RedirectUriFailure,
} from '../src/auth/redirect-uri.js';
import { expectGuardFails } from '../src/testing/index.js';

interface ValidRow {
  readonly baseUrl: string;
  /** The two URIs registered on the application. */
  readonly registered: readonly [callback: string, loggedOut: string];
  /** The redirect URI sent in the authorize request. */
  readonly sent: string;
  readonly origin: string;
}

/** Valid base URLs, each with the strings that must come out (research 2.2). */
const VALID: readonly ValidRow[] = [
  {
    baseUrl: 'https://panel.example.org',
    registered: [
      'https://panel.example.org/auth/callback',
      'https://panel.example.org/auth/logged-out',
    ],
    sent: 'https://panel.example.org/auth/callback',
    origin: 'https://panel.example.org',
  },
  {
    baseUrl: 'https://panel.example.org/',
    registered: [
      'https://panel.example.org/auth/callback',
      'https://panel.example.org/auth/logged-out',
    ],
    sent: 'https://panel.example.org/auth/callback',
    origin: 'https://panel.example.org',
  },
  {
    baseUrl: 'https://panel.example.org:8443',
    registered: [
      'https://panel.example.org:8443/auth/callback',
      'https://panel.example.org:8443/auth/logged-out',
    ],
    sent: 'https://panel.example.org:8443/auth/callback',
    origin: 'https://panel.example.org:8443',
  },
  {
    baseUrl: 'HTTPS://Panel.Example.ORG',
    registered: [
      'https://panel.example.org/auth/callback',
      'https://panel.example.org/auth/logged-out',
    ],
    sent: 'https://panel.example.org/auth/callback',
    origin: 'https://panel.example.org',
  },
  {
    baseUrl: 'https://443.example.org:443',
    registered: [
      'https://443.example.org/auth/callback',
      'https://443.example.org/auth/logged-out',
    ],
    sent: 'https://443.example.org/auth/callback',
    origin: 'https://443.example.org',
  },
  {
    // Learn: the port is ignored when a localhost redirect URI is matched, so none is registered;
    // the request sends the real origin, port included.
    baseUrl: 'http://localhost:9300',
    registered: ['http://localhost/auth/callback', 'http://localhost/auth/logged-out'],
    sent: 'http://localhost:9300/auth/callback',
    origin: 'http://localhost:9300',
  },
  {
    baseUrl: 'http://localhost',
    registered: ['http://localhost/auth/callback', 'http://localhost/auth/logged-out'],
    sent: 'http://localhost/auth/callback',
    origin: 'http://localhost',
  },
  {
    baseUrl: 'http://localhost:80',
    registered: ['http://localhost/auth/callback', 'http://localhost/auth/logged-out'],
    sent: 'http://localhost/auth/callback',
    origin: 'http://localhost',
  },
  {
    baseUrl: 'http://LOCALHOST:18080/',
    registered: ['http://localhost/auth/callback', 'http://localhost/auth/logged-out'],
    sent: 'http://localhost:18080/auth/callback',
    origin: 'http://localhost:18080',
  },
  {
    baseUrl: 'https://203.0.113.5',
    registered: ['https://203.0.113.5/auth/callback', 'https://203.0.113.5/auth/logged-out'],
    sent: 'https://203.0.113.5/auth/callback',
    origin: 'https://203.0.113.5',
  },
];

/** Invalid base URLs with the reason the module gives (research 2.2, FR-B-103). */
const INVALID: readonly (readonly [baseUrl: string, reason: RedirectUriFailure])[] = [
  ['', 'not_a_url'],
  ['panel', 'not_a_url'],
  [' https://panel.example.org', 'not_a_url'],
  ['https://panel.example.org ', 'not_a_url'],
  ['https://panel.example.org\n', 'not_a_url'],
  // A backslash is read as a slash by a URL parser; the module refuses it instead of guessing.
  ['http:\\\\localhost:9090', 'not_a_url'],
  ['https://panel.example.org\\app', 'not_a_url'],
  ['localhost:9300', 'scheme_not_allowed'],
  ['ftp://panel.example.org', 'scheme_not_allowed'],
  ['javascript:alert(1)', 'scheme_not_allowed'],
  // Learn: only `localhost` may use http; `127.0.0.1` and `[::1]` are not registrable here.
  ['http://127.0.0.1:9300', 'host_not_allowed'],
  ['http://[::1]:9300', 'host_not_allowed'],
  ['http://0.0.0.0:9300', 'host_not_allowed'],
  ['http://panel.example.org', 'host_not_allowed'],
  ['http://localhost.', 'host_not_allowed'],
  ['http://localhost.example.org', 'host_not_allowed'],
  ['http://sub.localhost', 'host_not_allowed'],
  ['https://user@panel.example.org', 'credentials'],
  ['https://user:secret@panel.example.org', 'credentials'],
  ['https://panel.example.org/app', 'path'],
  ['https://panel.example.org/Auth/Callback', 'path'],
  ['https://panel.example.org//', 'path'],
  ['https://panel.example.org?x=1', 'query'],
  ['https://panel.example.org/?', 'query'],
  ['https://panel.example.org#top', 'fragment'],
  ['https://panel.example.org/#', 'fragment'],
  ['https://*.example.org', 'wildcard'],
  ['https://panel.example.org:*', 'wildcard'],
  ['https://pa!nel.example.org', 'forbidden_character'],
  ['https://pa$nel.example.org', 'forbidden_character'],
  ["https://pa'nel.example.org", 'forbidden_character'],
  ['https://pa(nel.example.org', 'forbidden_character'],
  ['https://pa)nel.example.org', 'forbidden_character'],
  ['https://pa,nel.example.org', 'forbidden_character'],
  ['https://pa;nel.example.org', 'forbidden_character'],
  ['https://pånel.example.org', 'internationalised_host'],
  ['https://xn--pnel-ira.example.org', 'internationalised_host'],
  ['https://panel.xn--example-4ya.org', 'internationalised_host'],
  [
    `https://${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(60)}.org`,
    'too_long',
  ],
];

interface RedirectApi {
  readonly parse: (raw: string) => { readonly ok: boolean; readonly reason?: string };
  readonly registered: (baseUrl: string) => readonly string[];
  readonly sent: (baseUrl: string) => string;
}

const REAL: RedirectApi = {
  parse: (raw) => parsePublicBaseUrl(raw),
  registered: (baseUrl) => {
    const uris = redirectUris(baseUrl);
    return [uris.callback, uris.loggedOut];
  },
  sent: authorizeRedirectUri,
};

/** Throws unless `api` agrees with the research table on every row. */
function assertRedirectTable(api: RedirectApi): void {
  const problems: string[] = [];
  for (const row of VALID) {
    const parsed = api.parse(row.baseUrl);
    if (!parsed.ok) problems.push(`${row.baseUrl} was refused (${String(parsed.reason)})`);
    else {
      const registered = api.registered(row.baseUrl);
      if (registered.join(' ') !== row.registered.join(' ')) {
        problems.push(
          `${row.baseUrl} registers ${registered.join(' ')}, expected ${row.registered.join(' ')}`,
        );
      }
      const sent = api.sent(row.baseUrl);
      if (sent !== row.sent) problems.push(`${row.baseUrl} sends ${sent}, expected ${row.sent}`);
    }
  }
  for (const [baseUrl, reason] of INVALID) {
    const parsed = api.parse(baseUrl);
    if (parsed.ok) problems.push(`${JSON.stringify(baseUrl)} was accepted, expected ${reason}`);
    else if (parsed.reason !== reason) {
      problems.push(
        `${JSON.stringify(baseUrl)} failed as ${String(parsed.reason)}, expected ${reason}`,
      );
    }
  }
  if (problems.length > 0) throw new Error(`redirect table differs: ${problems.join('; ')}`);
}

describe('redirect URIs (FR-B-103, research 2.2)', () => {
  it('agrees with the table on every valid and every invalid base URL', () => {
    expect(() => {
      assertRedirectTable(REAL);
    }).not.toThrow();
  });

  it.each(VALID.map((row) => [row.baseUrl, row] as const))(
    '%s: registered and sent URIs, and the origin',
    (_baseUrl, row) => {
      const uris = redirectUris(row.baseUrl);
      expect([uris.callback, uris.loggedOut]).toEqual(row.registered);
      expect(authorizeRedirectUri(row.baseUrl)).toBe(row.sent);
      const parsed = parsePublicBaseUrl(row.baseUrl);
      expect(parsed.ok && parsed.origin).toBe(row.origin);
    },
  );

  it('https: registered and sent are the same string (BC-03)', () => {
    for (const row of VALID.filter((candidate) =>
      candidate.baseUrl.toLowerCase().startsWith('https'),
    )) {
      expect(authorizeRedirectUri(row.baseUrl)).toBe(redirectUris(row.baseUrl).callback);
    }
  });

  it('http://localhost: only the sent URI carries the port', () => {
    expect(redirectUris('http://localhost:9300').callback).not.toMatch(/:\d/);
    expect(authorizeRedirectUri('http://localhost:9300')).toBe(
      'http://localhost:9300/auth/callback',
    );
  });

  it('the post-logout URI is the logged-out URI in the same form as the sent callback', () => {
    expect(postLogoutRedirectUri('https://panel.example.org')).toBe(
      'https://panel.example.org/auth/logged-out',
    );
    expect(postLogoutRedirectUri('http://localhost:9300')).toBe(
      'http://localhost:9300/auth/logged-out',
    );
  });

  it('the paths are lower case, explicit and the two never coincide (callback and post-logout differ by path)', () => {
    expect(CALLBACK_PATH).toBe('/auth/callback');
    expect(LOGGED_OUT_PATH).toBe('/auth/logged-out');
    expect(CALLBACK_PATH).toBe(CALLBACK_PATH.toLowerCase());
    for (const row of VALID) {
      const uris = redirectUris(row.baseUrl);
      expect(uris.callback).not.toBe(uris.loggedOut);
    }
  });

  it('every registered URI stays within the 256 characters Learn allows', () => {
    for (const row of VALID) {
      const uris = redirectUris(row.baseUrl);
      expect(uris.callback.length).toBeLessThanOrEqual(256);
      expect(uris.loggedOut.length).toBeLessThanOrEqual(256);
    }
  });

  it.each(INVALID.map(([baseUrl, reason]) => [baseUrl, reason] as const))(
    '%j is refused as %s, and the builders throw a typed error that does not echo the value',
    (baseUrl, reason) => {
      expect(parsePublicBaseUrl(baseUrl)).toEqual({ ok: false, reason });
      for (const build of [redirectUris, authorizeRedirectUri, postLogoutRedirectUri]) {
        let thrown: unknown;
        try {
          build(baseUrl);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(RedirectUriError);
        if (thrown instanceof RedirectUriError) {
          expect(thrown.reason).toBe(reason);
          if (baseUrl.length > 3) expect(thrown.message).not.toContain(baseUrl);
        }
      }
    },
  );

  it('never says anything about a value it refuses beyond the reason code', () => {
    const result = parsePublicBaseUrl('https://user:hunter2-canary@panel.example.org');
    expect(JSON.stringify(result)).not.toContain('hunter2-canary');
  });
});

describe('the redirect table guard (negative fixtures)', () => {
  it('fails when the port of http://localhost is registered', () => {
    const keepsPort: RedirectApi = {
      ...REAL,
      registered: (baseUrl) => [
        REAL.sent(baseUrl),
        REAL.sent(baseUrl).replace('callback', 'logged-out'),
      ],
    };
    expectGuardFails(assertRedirectTable, keepsPort, {
      name: 'redirect table',
      reason: 'http://localhost:9300 registers http://localhost:9300/auth/callback',
    });
  });

  it('fails when 127.0.0.1 is accepted', () => {
    const acceptsLoopback: RedirectApi = {
      ...REAL,
      parse: (raw) => (raw.includes('127.0.0.1') ? { ok: true } : REAL.parse(raw)),
    };
    expectGuardFails(assertRedirectTable, acceptsLoopback, {
      name: 'redirect table',
      reason: 'was accepted, expected host_not_allowed',
    });
  });

  it('fails when plain http is accepted for another host', () => {
    const acceptsHttp: RedirectApi = {
      ...REAL,
      parse: (raw) => (raw === 'http://panel.example.org' ? { ok: true } : REAL.parse(raw)),
    };
    expectGuardFails(assertRedirectTable, acceptsHttp, {
      name: 'redirect table',
      reason: '"http://panel.example.org" was accepted',
    });
  });

  it('fails when a forbidden character, a wildcard or an internationalised host is accepted', () => {
    for (const fragment of ['pa!nel', '*.example', 'pånel']) {
      const lax: RedirectApi = {
        ...REAL,
        parse: (raw) => (raw.includes(fragment) ? { ok: true } : REAL.parse(raw)),
      };
      expectGuardFails(assertRedirectTable, lax, {
        name: 'redirect table',
        reason: 'was accepted',
      });
    }
  });

  it('fails when the sent URI of https differs from the registered one', () => {
    const differs: RedirectApi = { ...REAL, sent: (baseUrl) => `${REAL.sent(baseUrl)}/` };
    expectGuardFails(assertRedirectTable, differs, { name: 'redirect table', reason: 'sends ' });
  });

  it('fails when a valid base URL is refused', () => {
    const strict: RedirectApi = {
      ...REAL,
      parse: (raw) =>
        raw === 'https://panel.example.org:8443' ? { ok: false, reason: 'path' } : REAL.parse(raw),
    };
    expectGuardFails(assertRedirectTable, strict, {
      name: 'redirect table',
      reason: 'https://panel.example.org:8443 was refused (path)',
    });
  });
});

// T-A-026, FR-A-046, E-15: TRUST_PROXY decides whether `X-Forwarded-For` and `X-Forwarded-Proto`
// are believed. A header from a peer that is not trusted is a forgery, and believing it lets any
// client pick its own rate-limit bucket and its own scheme, so the spoofing cases are the test.
//
// Negative fixtures: `assertSpoofingRules` runs a whole matrix against a resolver factory. The real
// factory passes it; a factory that believes headers from any peer, that takes the leftmost entry,
// or that reads `X-Forwarded-Proto` under `none` must fail it on purpose.
import { expectGuardFails } from '@m365portal/shared/testing';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { loadConfig, type TrustProxySetting } from '../src/config/index.js';
import { clientKeyOf, normalizeIp } from '../src/http/client-key.js';
import { requestContext, type AppEnv } from '../src/http/request-context.js';
import {
  createForwardingResolver,
  effectiveScheme,
  requestHost,
  type Forwarding,
  type ForwardingInput,
} from '../src/http/trust-proxy.js';
import { createTestApp } from './helpers/test-app.js';

function settingOf(value: string): TrustProxySetting {
  const result = loadConfig({ TRUST_PROXY: value });
  if (!result.ok) throw new Error(`TRUST_PROXY=${value} was refused`);
  return result.config.trustProxy;
}

type ResolverFactory = (setting: TrustProxySetting) => (input: ForwardingInput) => Forwarding;

function resolve(
  setting: string,
  peer: string | undefined,
  headers: { forwardedFor?: string | null; forwardedProto?: string | null } = {},
  factory: ResolverFactory = createForwardingResolver,
): Forwarding {
  return factory(settingOf(setting))({
    peer,
    forwardedFor: headers.forwardedFor ?? null,
    forwardedProto: headers.forwardedProto ?? null,
  });
}

// ---------------------------------------------------------------------------------------------
// The matrix as a guard
// ---------------------------------------------------------------------------------------------

interface Case {
  readonly name: string;
  readonly setting: string;
  readonly peer: string | undefined;
  readonly forwardedFor?: string;
  readonly forwardedProto?: string;
  readonly address: string | undefined;
  readonly scheme: 'http' | 'https' | undefined;
}

const PEER = '203.0.113.9';
const TRUSTED = '10.0.0.1';
const CLIENT = '198.51.100.7';

const CASES: readonly Case[] = [
  // none: the socket peer, whatever the headers say
  {
    name: 'none ignores X-Forwarded-For and X-Forwarded-Proto',
    setting: 'none',
    peer: PEER,
    forwardedFor: '1.2.3.4',
    forwardedProto: 'https',
    address: PEER,
    scheme: undefined,
  },
  {
    name: 'none without headers uses the peer',
    setting: 'none',
    peer: PEER,
    address: PEER,
    scheme: undefined,
  },
  // hop count N: entry N from the right
  {
    name: 'one hop takes the last entry',
    setting: '1',
    peer: TRUSTED,
    forwardedFor: `1.1.1.1, ${CLIENT}`,
    address: CLIENT,
    scheme: undefined,
  },
  {
    name: 'two hops take the second entry from the right',
    setting: '2',
    peer: TRUSTED,
    forwardedFor: `1.1.1.1, ${CLIENT}, 10.0.0.9`,
    address: CLIENT,
    scheme: undefined,
  },
  {
    name: 'a forged leftmost entry is not the client',
    setting: '1',
    peer: TRUSTED,
    forwardedFor: `9.9.9.9, ${CLIENT}`,
    address: CLIENT,
    scheme: undefined,
  },
  {
    name: 'fewer entries than hops falls back to the peer',
    setting: '3',
    peer: TRUSTED,
    forwardedFor: `1.1.1.1, ${CLIENT}`,
    address: TRUSTED,
    scheme: undefined,
  },
  {
    name: 'a hop count without X-Forwarded-For uses the peer',
    setting: '1',
    peer: TRUSTED,
    address: TRUSTED,
    scheme: undefined,
  },
  {
    name: 'an invalid entry falls back to the peer',
    setting: '1',
    peer: TRUSTED,
    forwardedFor: `${CLIENT}, not-an-address`,
    address: TRUSTED,
    scheme: undefined,
  },
  {
    name: 'an empty entry falls back to the peer',
    setting: '1',
    peer: TRUSTED,
    forwardedFor: `${CLIENT},`,
    address: TRUSTED,
    scheme: undefined,
  },
  {
    name: 'a hop count honours the last X-Forwarded-Proto',
    setting: '1',
    peer: TRUSTED,
    forwardedFor: CLIENT,
    forwardedProto: 'http, https',
    address: CLIENT,
    scheme: 'https',
  },
  {
    name: 'a hop count reads the last X-Forwarded-Proto: http',
    setting: '1',
    peer: TRUSTED,
    forwardedFor: CLIENT,
    forwardedProto: 'https, http',
    address: CLIENT,
    scheme: 'http',
  },
  {
    name: 'X-Forwarded-Proto is case-insensitive',
    setting: '1',
    peer: TRUSTED,
    forwardedFor: CLIENT,
    forwardedProto: ' HTTPS ',
    address: CLIENT,
    scheme: 'https',
  },
  {
    name: 'an unknown X-Forwarded-Proto is no scheme',
    setting: '1',
    peer: TRUSTED,
    forwardedFor: CLIENT,
    forwardedProto: 'gopher',
    address: CLIENT,
    scheme: undefined,
  },
  // list: only peers inside the list are believed
  {
    name: 'a list ignores headers from an untrusted peer',
    setting: '10.0.0.0/8,192.168.0.0/16',
    peer: PEER,
    forwardedFor: '10.0.0.5',
    forwardedProto: 'https',
    address: PEER,
    scheme: undefined,
  },
  {
    name: 'a list believes a trusted peer',
    setting: '10.0.0.0/8,192.168.0.0/16',
    peer: TRUSTED,
    forwardedFor: CLIENT,
    forwardedProto: 'https',
    address: CLIENT,
    scheme: 'https',
  },
  {
    name: 'a list skips trusted hops from the right',
    setting: '10.0.0.0/8,192.168.0.0/16',
    peer: TRUSTED,
    forwardedFor: `${CLIENT}, 192.168.4.4, 10.0.0.2`,
    address: CLIENT,
    scheme: undefined,
  },
  {
    name: 'a list stops at the first untrusted entry from the right, not at a forged one on the left',
    setting: '10.0.0.0/8',
    peer: TRUSTED,
    forwardedFor: `203.0.113.50, ${CLIENT}, 10.0.0.2`,
    address: CLIENT,
    scheme: undefined,
  },
  {
    name: 'a list whose entries are all trusted gives the leftmost entry',
    setting: '10.0.0.0/8',
    peer: TRUSTED,
    forwardedFor: '10.0.0.7, 10.0.0.2',
    address: '10.0.0.7',
    scheme: undefined,
  },
  {
    name: 'a list with an invalid entry falls back to the peer',
    setting: '10.0.0.0/8',
    peer: TRUSTED,
    forwardedFor: `${CLIENT}, garbage, 10.0.0.2`,
    address: TRUSTED,
    scheme: undefined,
  },
  {
    name: 'a list without X-Forwarded-For uses the peer',
    setting: '10.0.0.0/8',
    peer: TRUSTED,
    address: TRUSTED,
    scheme: undefined,
  },
  {
    name: 'an exact address in the list is trusted',
    setting: '10.0.0.1',
    peer: TRUSTED,
    forwardedFor: CLIENT,
    address: CLIENT,
    scheme: undefined,
  },
  {
    name: 'a neighbour of an exact address is not trusted',
    setting: '10.0.0.1',
    peer: '10.0.0.2',
    forwardedFor: CLIENT,
    address: '10.0.0.2',
    scheme: undefined,
  },
  {
    name: 'the address after the end of a range is not trusted',
    setting: '10.0.0.0/30',
    peer: '10.0.0.4',
    forwardedFor: CLIENT,
    address: '10.0.0.4',
    scheme: undefined,
  },
  {
    name: 'the last address inside a range is trusted',
    setting: '10.0.0.0/30',
    peer: '10.0.0.3',
    forwardedFor: CLIENT,
    address: CLIENT,
    scheme: undefined,
  },
  // IPv6 and IPv4-mapped IPv6
  {
    name: 'an IPv4-mapped IPv6 peer is the IPv4 address',
    setting: '10.0.0.0/8',
    peer: '::ffff:10.0.0.1',
    forwardedFor: CLIENT,
    address: CLIENT,
    scheme: undefined,
  },
  {
    name: 'an IPv4-mapped IPv6 client is unwrapped',
    setting: '1',
    peer: '::ffff:10.0.0.1',
    forwardedFor: '::ffff:198.51.100.7',
    address: CLIENT,
    scheme: undefined,
  },
  {
    name: 'an IPv4-mapped IPv6 peer is unwrapped under none',
    setting: 'none',
    peer: '::ffff:203.0.113.9',
    address: PEER,
    scheme: undefined,
  },
  {
    name: 'an IPv6 range in the list is matched',
    setting: 'fd00::/8',
    peer: 'fd12:3456::1',
    forwardedFor: '2001:db8:aaaa:bbbb:1:2:3:4',
    address: '2001:db8:aaaa:bbbb:1:2:3:4',
    scheme: undefined,
  },
  {
    name: 'an IPv6 peer outside the list is not believed',
    setting: 'fd00::/8',
    peer: '2001:db8::1',
    forwardedFor: '2001:db8:aaaa:bbbb:1:2:3:4',
    address: '2001:db8::1',
    scheme: undefined,
  },
  {
    name: 'a mapped IPv6 range stands for the IPv4 range it maps (::ffff:10.0.0.0/104 is 10.0.0.0/8)',
    setting: '::ffff:10.0.0.0/104',
    peer: TRUSTED,
    forwardedFor: CLIENT,
    forwardedProto: 'https',
    address: CLIENT,
    scheme: 'https',
  },
  {
    name: 'a mapped IPv6 range does not trust the IPv4 addresses outside it',
    setting: '::ffff:10.0.0.0/104',
    peer: '11.0.0.1',
    forwardedFor: CLIENT,
    forwardedProto: 'https',
    address: '11.0.0.1',
    scheme: undefined,
  },
  {
    name: 'a mapped IPv6 range keeps its prefix length (/105 is 10.0.0.0/9)',
    setting: '::ffff:10.0.0.0/105',
    peer: '10.128.0.1',
    forwardedFor: CLIENT,
    address: '10.128.0.1',
    scheme: undefined,
  },
  {
    name: 'the whole mapped space (::ffff:0:0/96) is every IPv4 address',
    setting: '::ffff:0:0/96',
    peer: PEER,
    forwardedFor: CLIENT,
    address: CLIENT,
    scheme: undefined,
  },
  {
    name: 'an IPv6 range that only ends like a mapped one is still an IPv6 range',
    setting: '2001:db8::/112',
    peer: '10.0.0.1',
    forwardedFor: CLIENT,
    address: '10.0.0.1',
    scheme: undefined,
  },
  {
    name: 'an IPv4 range does not match an IPv6 peer',
    setting: '0.0.0.0/0',
    peer: '2001:db8::1',
    forwardedFor: CLIENT,
    address: '2001:db8::1',
    scheme: undefined,
  },
  {
    name: 'a scope id on the peer is dropped',
    setting: 'none',
    peer: 'fe80::1%eth0',
    address: 'fe80::1',
    scheme: undefined,
  },
  {
    name: 'an unknown peer is never trusted in a list',
    setting: '10.0.0.0/8',
    peer: undefined,
    forwardedFor: CLIENT,
    forwardedProto: 'https',
    address: undefined,
    scheme: undefined,
  },
  {
    name: 'a peer that is not an address is not trusted either',
    setting: '0.0.0.0/0',
    peer: 'unix-socket',
    forwardedFor: CLIENT,
    address: undefined,
    scheme: undefined,
  },
];

/** Throws on the first case a resolver factory gets wrong. */
function assertSpoofingRules(factory: ResolverFactory): void {
  for (const testCase of CASES) {
    const headers = {
      ...(testCase.forwardedFor === undefined ? {} : { forwardedFor: testCase.forwardedFor }),
      ...(testCase.forwardedProto === undefined ? {} : { forwardedProto: testCase.forwardedProto }),
    };
    const actual = resolve(testCase.setting, testCase.peer, headers, factory);
    if (actual.address !== testCase.address || actual.scheme !== testCase.scheme) {
      throw new Error(
        `${testCase.name}: expected ${String(testCase.address)} / ${String(testCase.scheme)}, got ${String(actual.address)} / ${String(actual.scheme)}`,
      );
    }
  }
}

describe('createForwardingResolver (FR-A-046)', () => {
  it.each(CASES.map((testCase) => [testCase.name, testCase] as const))('%s', (_name, testCase) => {
    const actual = resolve(testCase.setting, testCase.peer, {
      forwardedFor: testCase.forwardedFor ?? null,
      forwardedProto: testCase.forwardedProto ?? null,
    });
    expect(actual).toEqual({ address: testCase.address, scheme: testCase.scheme });
  });

  it('passes the whole matrix', () => {
    expect(() => {
      assertSpoofingRules(createForwardingResolver);
    }).not.toThrow();
  });

  it('answers the same for the same input (no hidden state between requests)', () => {
    const resolver = createForwardingResolver(settingOf('1'));
    const input = { peer: TRUSTED, forwardedFor: CLIENT, forwardedProto: 'https' };
    expect(resolver(input)).toEqual(resolver(input));
    expect(resolver({ ...input, forwardedFor: '9.9.9.9' }).address).toBe('9.9.9.9');
    expect(resolver(input).address).toBe(CLIENT);
  });

  describe('negative fixtures: broken resolvers fail the matrix', () => {
    const believesEveryone: ResolverFactory = (setting) => {
      const real = createForwardingResolver(setting);
      return (input) => {
        const headers: ForwardingInput = {
          ...input,
          peer: setting.mode === 'list' ? TRUSTED : input.peer,
        };
        return real(headers);
      };
    };

    const takesLeftmost: ResolverFactory = (setting) => {
      const real = createForwardingResolver(setting);
      return (input) => {
        const first = input.forwardedFor?.split(',')[0]?.trim();
        const result = real(input);
        return setting.mode === 'none' || first === undefined || first === ''
          ? result
          : { ...result, address: first };
      };
    };

    const readsProtoUnderNone: ResolverFactory = (setting) => {
      const real = createForwardingResolver(setting);
      return (input) => {
        const result = real(input);
        if (setting.mode !== 'none') return result;
        const proto = input.forwardedProto?.trim().toLowerCase();
        return proto === 'https' ? { ...result, scheme: 'https' } : result;
      };
    };

    const believesInvalidEntries: ResolverFactory = (setting) => {
      const real = createForwardingResolver(setting);
      return (input) => {
        const last = input.forwardedFor?.split(',').at(-1)?.trim();
        return setting.mode === 'hops' && last !== undefined && last !== ''
          ? { ...real(input), address: last }
          : real(input);
      };
    };

    it.each([
      ['believes headers from any peer', believesEveryone],
      ['takes the leftmost X-Forwarded-For entry', takesLeftmost],
      ['reads X-Forwarded-Proto under none', readsProtoUnderNone],
      ['believes an entry that is not an address', believesInvalidEntries],
    ])('%s', (_name, factory) => {
      expectGuardFails(assertSpoofingRules, factory, { reason: /expected/ });
    });
  });
});

// ---------------------------------------------------------------------------------------------
// The effective scheme
// ---------------------------------------------------------------------------------------------

describe('effectiveScheme', () => {
  it('is https when PUBLIC_BASE_URL is https, whatever the proxy says', () => {
    expect(effectiveScheme({ publicIsHttps: true, forwardedScheme: undefined })).toBe('https');
    expect(effectiveScheme({ publicIsHttps: true, forwardedScheme: 'http' })).toBe('https');
  });

  it('is https for an http base URL only when a trusted proxy says https', () => {
    expect(effectiveScheme({ publicIsHttps: false, forwardedScheme: 'https' })).toBe('https');
    expect(effectiveScheme({ publicIsHttps: false, forwardedScheme: 'http' })).toBe('http');
    expect(effectiveScheme({ publicIsHttps: false, forwardedScheme: undefined })).toBe('http');
  });
});

// ---------------------------------------------------------------------------------------------
// Client addresses and the client key
// ---------------------------------------------------------------------------------------------

describe('normalizeIp', () => {
  it.each([
    ['203.0.113.9', '203.0.113.9'],
    ['::ffff:203.0.113.9', '203.0.113.9'],
    ['::FFFF:203.0.113.9', '203.0.113.9'],
    ['::ffff:cb00:7109', '203.0.113.9'],
    ['0:0:0:0:0:ffff:203.0.113.9', '203.0.113.9'],
    ['2001:DB8:0:0:0:0:0:1', '2001:db8::1'],
    ['2001:db8::1', '2001:db8::1'],
    ['2001:db8:0:0:1:0:0:1', '2001:db8::1:0:0:1'],
    // RFC 5952: `::` never stands for a single group of zeros, and the first longest run wins.
    ['2001:db8:0:1:1:1:1:1', '2001:db8:0:1:1:1:1:1'],
    ['1:0:1:1:1:1:1:1', '1:0:1:1:1:1:1:1'],
    ['1:0:0:2:0:0:0:3', '1:0:0:2::3'],
    ['1:0:0:2:3:0:0:4', '1::2:3:0:0:4'],
    // Only the 80 zero bits and 0xffff of the mapped form are unwrapped; each group is checked.
    ['1::ffff:203.0.113.9', '1::ffff:cb00:7109'],
    ['0:1::ffff:203.0.113.9', '0:1::ffff:cb00:7109'],
    ['0:0:1::ffff:203.0.113.9', '::1:0:0:ffff:cb00:7109'],
    ['0:0:0:1::ffff:203.0.113.9', '::1:0:ffff:cb00:7109'],
    ['0:0:0:0:1:ffff:203.0.113.9', '::1:ffff:cb00:7109'],
    ['::fffe:203.0.113.9', '::fffe:cb00:7109'],
    ['::1', '::1'],
    ['::', '::'],
    ['fe80::1%eth0', 'fe80::1'],
    ['1:2:3:4:5:6:7:8', '1:2:3:4:5:6:7:8'],
  ])('writes %s as %s', (value, expected) => {
    expect(normalizeIp(value)).toBe(expected);
  });

  it.each([
    '',
    ' ',
    'localhost',
    '1.2.3',
    '1.2.3.4.5',
    '256.1.1.1',
    '1.2.3.4:80',
    '::g',
    '1::2::3',
  ])('refuses %j', (value) => {
    expect(normalizeIp(value)).toBeUndefined();
  });
});

describe('clientKeyOf', () => {
  it('is the address for IPv4', () => {
    expect(clientKeyOf('203.0.113.9')).toBe('203.0.113.9');
    expect(clientKeyOf('::ffff:203.0.113.9')).toBe('203.0.113.9');
  });

  it('is the /64 prefix for IPv6, so one network shares one bucket', () => {
    const key = clientKeyOf('2001:db8:1:2:3:4:5:6');
    expect(key).toBe('2001:db8:1:2::/64');
    expect(clientKeyOf('2001:db8:1:2:ffff:ffff:ffff:ffff')).toBe(key);
    expect(clientKeyOf('2001:DB8:1:2::1')).toBe(key);
    expect(clientKeyOf('2001:0db8:0001:0002:0000:0000:0000:0001')).toBe(key);
    expect(clientKeyOf('2001:db8:1:3::1')).not.toBe(key);
    expect(clientKeyOf('2001:db8:2:2::1')).not.toBe(key);
  });

  it('keeps the address family apart', () => {
    expect(clientKeyOf('::1')).toBe('0:0:0:0::/64');
    expect(clientKeyOf('127.0.0.1')).toBe('127.0.0.1');
  });

  it('is one fixed key for an unknown or invalid address', () => {
    expect(clientKeyOf(undefined)).toBe('unknown');
    expect(clientKeyOf('')).toBe('unknown');
    expect(clientKeyOf('not-an-address')).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------------------------
// requestHost: the one host normaliser of the HSTS rule and the preview rule
// ---------------------------------------------------------------------------------------------

function requestWithHost(host: string | null): Request {
  const headers = new Headers();
  if (host !== null) headers.set('host', host);
  return new Request('http://placeholder.invalid/x', { headers });
}

describe('requestHost', () => {
  it.each([
    ['localhost', 'localhost'],
    ['LOCALHOST:9300', 'localhost'],
    ['Panel.Example.COM', 'panel.example.com'],
    ['panel.example.com.', 'panel.example.com'],
    ['panel.example.com.:8443', 'panel.example.com'],
    ['[::1]:9300', '[::1]'],
    ['[::1]', '[::1]'],
    ['127.0.0.1:80', '127.0.0.1'],
  ])('reads Host %j as %j', (host, expected) => {
    expect(requestHost(requestWithHost(host))).toBe(expected);
  });

  it('drops exactly one trailing dot', () => {
    expect(requestHost(requestWithHost('panel.example.com..'))).toBeUndefined();
  });

  it.each([null, '', ' ', ':9300', 'a b', 'a/b', 'user@host', 'host:port', '::1', 'a..b', 'café'])(
    'returns nothing for Host %j',
    (host) => {
      expect(requestHost(requestWithHost(host))).toBeUndefined();
    },
  );
});

// ---------------------------------------------------------------------------------------------
// The request context middleware reads the peer from the socket
// ---------------------------------------------------------------------------------------------

function contextApp(env: Record<string, string>) {
  const result = loadConfig(env);
  if (!result.ok) throw new Error('configuration refused');
  const { config } = result;
  const app = new Hono<AppEnv>();
  app.use(requestContext({ config }));
  app.get('/who', (c) =>
    c.json({
      address: c.get('client').address ?? null,
      key: c.get('client').key,
      scheme: c.get('scheme'),
    }),
  );
  return app;
}

async function whoAmI(
  env: Record<string, string>,
  options: { peer?: string; headers?: Record<string, string> },
): Promise<{ address: string | null; key: string; scheme: string }> {
  const harness = await createTestApp({ buildApp: () => contextApp(env) });
  const client = harness.clientFor({
    ...(options.peer === undefined ? {} : { peer: options.peer }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
  });
  const response = await client.get('/who');
  expect(response.status).toBe(200);
  return (await response.json()) as { address: string | null; key: string; scheme: string };
}

describe('requestContext: client and scheme', () => {
  it('uses the socket peer under the default mode and ignores forwarding headers', async () => {
    const who = await whoAmI(
      {},
      { peer: PEER, headers: { 'x-forwarded-for': '1.2.3.4', 'x-forwarded-proto': 'https' } },
    );
    expect(who).toEqual({ address: PEER, key: PEER, scheme: 'http' });
  });

  it('believes a trusted proxy', async () => {
    const who = await whoAmI(
      { TRUST_PROXY: '10.0.0.0/8' },
      { peer: TRUSTED, headers: { 'x-forwarded-for': CLIENT, 'x-forwarded-proto': 'https' } },
    );
    expect(who).toEqual({ address: CLIENT, key: CLIENT, scheme: 'https' });
  });

  it('does not believe the same headers from a peer outside the list', async () => {
    const who = await whoAmI(
      { TRUST_PROXY: '10.0.0.0/8' },
      { peer: PEER, headers: { 'x-forwarded-for': CLIENT, 'x-forwarded-proto': 'https' } },
    );
    expect(who).toEqual({ address: PEER, key: PEER, scheme: 'http' });
  });

  it('is https through PUBLIC_BASE_URL without any header', async () => {
    const who = await whoAmI({ PUBLIC_BASE_URL: 'https://panel.example.com' }, { peer: PEER });
    expect(who.scheme).toBe('https');
  });

  it('gives an IPv6 client the key of its /64', async () => {
    const who = await whoAmI({}, { peer: '2001:db8:1:2:3:4:5:6' });
    expect(who).toEqual({
      address: '2001:db8:1:2:3:4:5:6',
      key: '2001:db8:1:2::/64',
      scheme: 'http',
    });
  });

  it('survives a request with no socket at all (an in-process call)', async () => {
    const app = contextApp({});
    const response = await app.request('/who');
    expect(await response.json()).toEqual({ address: null, key: 'unknown', scheme: 'http' });
  });

  it('reads the peer from a real socket', async () => {
    const harness = await createTestApp({ buildApp: () => contextApp({}) });
    const running = await harness.listen();
    const response = await running.client.get('/who');
    const who = (await response.json()) as { address: string; key: string };
    expect(['127.0.0.1', '::1']).toContain(who.address);
    expect(who.key).toBe(clientKeyOf(who.address));
  });
});

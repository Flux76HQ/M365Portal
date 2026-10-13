// T-A-025, FR-A-010, FR-A-016, FR-A-035, E-17, A-30, A-63: the configuration is the environment
// variables of FR-A-010, parsed by one Zod schema. An invalid value stops the process before it
// listens, and the report names the variable and never the value.
//
// Negative fixtures (tasks.md section 0.3): `assertPortRule` and `assertTrustProxyRule` are guards
// that run a reader over the whole matrix; the real reader passes them, and a reader that accepts
// port 0 (the scaffold's bug), accepts a low port or echoes the value must fail them on purpose.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { inspect } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parsePublicBaseUrl } from '@m365portal/shared/auth/redirect-uri';
import { DEFAULT_PORT, LIMITS } from '@m365portal/shared/limits';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import {
  ENV_VARIABLE_NAMES,
  ENV_VARIABLES,
  EnvSchema,
  formatConfigIssues,
  isLoopbackHost,
  loadConfig,
  loadConfigOrThrow,
  normalizeHost,
  readPosture,
  removedVariablesIn,
  CROSS_MESSAGES,
  ENV_MESSAGES,
  EXCHANGE_KEY_HANDOVER_VALUES,
  REMOVED_VARIABLE_NAMES,
  SecretText,
  type AppConfig,
  type ConfigIssue,
} from '../src/config/index.js';
import { CERTIFICATE_MODES } from '../src/integrations/exchange/pwsh/key-handover.js';

type Env = Readonly<Record<string, string | undefined>>;

const serverDirectory = fileURLToPath(new URL('..', import.meta.url));
const specPath = fileURLToPath(new URL('../../../specs/001-m365portal/spec.md', import.meta.url));
const specBPath = fileURLToPath(new URL('../../../specs/002-phase-b/spec.md', import.meta.url));

function configOf(env: Env): AppConfig {
  const result = loadConfig(env);
  if (!result.ok) {
    throw new Error(`configuration refused: ${formatConfigIssues(result.issues)}`);
  }
  return result.config;
}

function issuesOf(env: Env): readonly ConfigIssue[] {
  const result = loadConfig(env);
  if (result.ok) throw new Error('configuration was accepted');
  return result.issues;
}

function variablesOf(env: Env): string[] {
  return issuesOf(env).map((issue) => issue.variable);
}

// ---------------------------------------------------------------------------------------------
// The variable list equals the spec (FR-A-010)
// ---------------------------------------------------------------------------------------------

/** The `NAME (default)` pairs of the "Phase A variables" sentence of the FR-A-010 row. */
function specVariables(): { name: string; defaultText: string }[] {
  const row = readFileSync(specPath, 'utf8')
    .split('\n')
    .find((line) => line.startsWith('| FR-A-010 |'));
  if (row === undefined) throw new Error('spec.md has no FR-A-010 row');
  const sentence = row.slice(row.indexOf('Phase A variables:'));
  const found = [...sentence.matchAll(/`([A-Z][A-Z0-9_]+)` \(([^)]*)\)/g)].map((match) => ({
    name: match[1] ?? '',
    defaultText:
      (match[2] ?? '')
        .replace(/^default /, '')
        .split(',')[0]
        ?.replaceAll('`', '')
        .trim() ?? '',
  }));
  if (found.length === 0) throw new Error('could not read the variables of the FR-A-010 row');
  return found;
}

/**
 * The rows of table 6.9.1 of the Phase B spec: `NAME` and the default as `ENV_VARIABLES` writes it
 * (`unset` for a variable without a default).
 */
function specBVariables(): { name: string; defaultText: string }[] {
  const spec = readFileSync(specBPath, 'utf8');
  const start = spec.indexOf('#### 6.9.1 Environment variables');
  const end = spec.indexOf('Changed by Phase B.', start);
  if (start < 0 || end < 0) throw new Error('could not find table 6.9.1 in the Phase B spec');
  const rows = [...spec.slice(start, end).matchAll(/^\| `([A-Z][A-Z0-9_]+)` \| ([^|]*) \|/gm)];
  const found = rows.map((match) => {
    const cell = (match[2] ?? '').replaceAll('`', '').trim();
    return { name: match[1] ?? '', defaultText: cell.startsWith('unset') ? 'unset' : cell };
  });
  if (found.length === 0) throw new Error('could not read the rows of table 6.9.1');
  return found;
}

/** The variables Phase B removed (FR-B-102). */
const REMOVED = ['PREVIEW_MODE', 'PREVIEW_MODE_ALLOW_REMOTE'];

describe('the variable list (FR-A-010, spec 6.9.1)', () => {
  it('keeps the variables and defaults of the FR-A-010 row that Phase B did not remove, in that order', () => {
    const fromSpec = specVariables();
    expect(fromSpec.map((variable) => variable.name)).toHaveLength(12);
    const kept = fromSpec.filter((variable) => !REMOVED.includes(variable.name));
    expect(kept).toHaveLength(10);
    const phaseA = ENV_VARIABLES.slice(0, kept.length);
    expect(phaseA.map(({ name, defaultText }) => ({ name, defaultText }))).toEqual(kept);
  });

  it('adds the 14 variables of table 6.9.1 with their defaults, in the order of the table', () => {
    const fromSpec = specBVariables();
    expect(fromSpec).toHaveLength(14);
    const phaseB = ENV_VARIABLES.slice(10, 24);
    expect(phaseB.map(({ name, defaultText }) => ({ name, defaultText }))).toEqual(fromSpec);
    expect(ENV_VARIABLES).toHaveLength(25);
    // Phase D adds one: the way the Exchange certificate reaches the worker (T-D-114).
    expect(ENV_VARIABLES.slice(24)).toEqual([
      { name: 'EXCHANGE_KEY_HANDOVER', defaultText: 'memory' },
    ]);
  });

  it('marks the secret variables, and only those', () => {
    expect(ENV_VARIABLES.filter((variable) => variable.secret === true).map((v) => v.name)).toEqual(
      ['APP_KEY', 'APP_KEY_PREVIOUS', 'SETUP_TOKEN', 'BREAK_GLASS_PASSWORD_HASH'],
    );
  });

  it('does not list the removed variables (FR-B-102)', () => {
    for (const name of REMOVED) expect(ENV_VARIABLE_NAMES as readonly string[]).not.toContain(name);
    expect([...REMOVED_VARIABLE_NAMES]).toEqual(REMOVED);
  });

  it('exports the names once and builds the schema from the same list', () => {
    expect([...ENV_VARIABLE_NAMES]).toEqual(ENV_VARIABLES.map((variable) => variable.name));
    expect(Object.keys(EnvSchema.in.shape)).toEqual([...ENV_VARIABLE_NAMES]);
  });

  it('does not read HOST_PORT: it is a Compose-only variable (FR-A-016)', () => {
    expect(ENV_VARIABLE_NAMES).not.toContain('HOST_PORT');
    const base = configOf({});
    expect(configOf({ HOST_PORT: 'not-a-port' })).toEqual(base);
    expect(configOf({ HOST_PORT: '9090' })).toEqual(base);
  });

  it('ignores every variable it does not know', () => {
    expect(configOf({ PATH: '/usr/bin', NODE_ENV: 'production', HOME: '/root' })).toEqual(
      configOf({}),
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------------------------

describe('defaults', () => {
  it('gives every variable its default (FR-A-010, spec 6.9.1)', () => {
    const config = configOf({});
    expect(config).toEqual({
      port: DEFAULT_PORT,
      host: '0.0.0.0',
      dataDir: '/data',
      publicOrigin: `http://localhost:${String(DEFAULT_PORT)}`,
      publicHost: 'localhost',
      publicIsHttps: false,
      trustProxy: { mode: 'none' },
      showcase: false,
      logLevel: 'info',
      hsts: { maxAgeSeconds: 31_536_000, includeSubDomains: false, preload: false },
      redirectUris: {
        callback: 'http://localhost/auth/callback',
        loggedOut: 'http://localhost/auth/logged-out',
      },
      authorizeRedirectUri: `http://localhost:${String(DEFAULT_PORT)}/auth/callback`,
      postLogoutRedirectUri: `http://localhost:${String(DEFAULT_PORT)}/auth/logged-out`,
      appKey: { source: 'none' },
      appKeyPrevious: { source: 'none' },
      setupToken: undefined,
      bootstrapClientId: '14d82eec-204b-4c2f-b7e8-296a70dab67e',
      setup: { propagationTimeoutMs: 900_000 },
      session: { idleTimeoutMs: 1_800_000, absoluteTimeoutMs: 28_800_000 },
      rbac: { groupCacheTtlMs: 300_000 },
      auth: { requireMfa: true, mfaAmrValues: ['mfa', 'multipleauthn'] },
      breakGlass: undefined,
      exchangeKeyHandover: 'memory',
    } satisfies AppConfig);
    expect(config.hsts.maxAgeSeconds).toBe(LIMITS.hstsMaxAgeSeconds);
  });

  it('has no preview field at all: the preview variables are gone (FR-B-102)', () => {
    expect(Object.keys(configOf({}))).not.toContain('previewMode');
    expect(Object.keys(configOf({}))).not.toContain('previewModeAllowRemote');
  });

  it('is frozen, so one consumer cannot change what another reads', () => {
    const config = configOf({});
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.hsts)).toBe(true);
    expect(Object.isFrozen(config.trustProxy)).toBe(true);
  });

  it('derives the default PUBLIC_BASE_URL from PORT (A-63: PORT is the in-container port)', () => {
    expect(configOf({ PORT: '18080' }).publicOrigin).toBe('http://localhost:18080');
    expect(configOf({ PORT: '18080', PUBLIC_BASE_URL: 'http://localhost:9090' }).publicOrigin).toBe(
      'http://localhost:9090',
    );
  });
});

// ---------------------------------------------------------------------------------------------
// PORT (FR-A-016)
// ---------------------------------------------------------------------------------------------

const PORT_MESSAGE = 'PORT must be an integer between 1024 and 65535';
const PORT_ACCEPTED = ['1024', '1025', '9300', '18080', '49152', '65535'];
const PORT_REJECTED = [
  '0',
  '80',
  '443',
  '1023',
  '65536',
  '100000',
  '',
  ' ',
  'abc',
  '-1',
  '80.5',
  '0x1F90',
  '1e4',
  ' 9300',
  '9300 ',
  '08080',
  '+9300',
  '8_080',
  '８０８０',
];

/**
 * The PORT matrix as a guard: it throws when `readPort` accepts a value FR-A-016 forbids, rejects
 * one it allows, or lets the offending value into its message.
 */
function assertPortRule(readPort: (value: string | undefined) => number): void {
  for (const value of PORT_ACCEPTED) {
    if (readPort(value) !== Number(value)) throw new Error(`PORT=${value} must be accepted`);
  }
  if (readPort(undefined) !== DEFAULT_PORT) throw new Error('an unset PORT is the default');
  for (const value of PORT_REJECTED) {
    let message: string | undefined;
    try {
      readPort(value);
    } catch (failure) {
      message = failure instanceof Error ? failure.message : String(failure);
    }
    if (message === undefined) throw new Error(`PORT=${JSON.stringify(value)} must be rejected`);
    if (!message.includes('PORT')) throw new Error(`the message names no variable: ${message}`);
    if (value.trim() !== '' && message.includes(value)) {
      throw new Error(`the message echoes the value: ${message}`);
    }
  }
}

function readPortFromConfig(value: string | undefined): number {
  return loadConfigOrThrow(value === undefined ? {} : { PORT: value }).port;
}

describe('PORT (FR-A-016)', () => {
  it('accepts 1024 to 65535 and rejects 0, a low port, a high one, empty and non-numeric input', () => {
    expect(() => {
      assertPortRule(readPortFromConfig);
    }).not.toThrow();
  });

  it.each(PORT_ACCEPTED)('accepts PORT=%s', (value) => {
    expect(configOf({ PORT: value }).port).toBe(Number(value));
  });

  it.each(PORT_REJECTED)('rejects PORT=%j with a message that names PORT', (value) => {
    const issues = issuesOf({ PORT: value });
    expect(issues).toEqual([{ variable: 'PORT', message: PORT_MESSAGE }]);
  });

  it('treats an unset PORT as the default but an empty one as an error', () => {
    expect(configOf({ PORT: undefined }).port).toBe(DEFAULT_PORT);
    expect(variablesOf({ PORT: '' })).toEqual(['PORT']);
  });

  it('is not weakened by the default of PUBLIC_BASE_URL: a bad PORT is the only issue', () => {
    expect(variablesOf({ PORT: '0' })).toEqual(['PORT']);
  });

  // The negative fixtures: readers that break one rule each must fail the matrix.
  it('fails the matrix for a reader that accepts port 0 (the scaffold behaviour)', () => {
    const accepts = (value: string | undefined): number => {
      if (value === '0') return 0;
      return readPortFromConfig(value);
    };
    expectGuardFails(assertPortRule, accepts, { reason: 'PORT="0" must be rejected' });
  });

  it('fails the matrix for a reader that treats an empty PORT as the default', () => {
    const emptyIsDefault = (value: string | undefined): number =>
      readPortFromConfig(value === '' ? undefined : value);
    expectGuardFails(assertPortRule, emptyIsDefault, { reason: 'PORT="" must be rejected' });
  });

  it('fails the matrix for a reader that allows a low port', () => {
    const allowsLow = (value: string | undefined): number => {
      if (value === '80') return 80;
      return readPortFromConfig(value);
    };
    expectGuardFails(assertPortRule, allowsLow, { reason: 'PORT="80" must be rejected' });
  });

  it('fails the matrix for a reader that trims whitespace', () => {
    const trims = (value: string | undefined): number =>
      readPortFromConfig(value === undefined ? undefined : value.trim());
    expectGuardFails(assertPortRule, trims, { reason: 'must be rejected' });
  });

  it('fails the matrix for a reader whose message echoes the value', () => {
    const echoes = (value: string | undefined): number => {
      try {
        return readPortFromConfig(value);
      } catch {
        throw new Error(`PORT=${value ?? ''} is wrong`);
      }
    };
    expectGuardFails(assertPortRule, echoes, { reason: 'echoes the value' });
  });
});

// ---------------------------------------------------------------------------------------------
// HOST, DATA_DIR, LOG_LEVEL, booleans
// ---------------------------------------------------------------------------------------------

describe('HOST', () => {
  it.each(['0.0.0.0', '127.0.0.1', '::', '::1', 'localhost', 'panel.internal', 'a'])(
    'accepts %j',
    (value) => {
      expect(configOf({ HOST: value }).host).toBe(value);
    },
  );

  it.each([
    '',
    ' ',
    'a b',
    'host:80',
    'http://localhost',
    'a/b',
    '-bad',
    'bad-',
    'a..b',
    '[::1]',
    'x'.repeat(254),
    'café',
  ])('rejects %j and names HOST', (value) => {
    expect(issuesOf({ HOST: value })).toEqual([
      { variable: 'HOST', message: 'HOST must be a host name or an IP address' },
    ]);
  });
});

describe('DATA_DIR', () => {
  it.each(['/data', '/var/lib/m365portal', '/a/b/c', '/'])('accepts %j', (value) => {
    expect(configOf({ DATA_DIR: value }).dataDir).toBe(value);
  });

  it.each(['', ' ', 'data', './data', '../data', 'data/', '~/data', '/data\0/x'])(
    'rejects %j and names DATA_DIR',
    (value) => {
      expect(issuesOf({ DATA_DIR: value })).toEqual([
        { variable: 'DATA_DIR', message: 'DATA_DIR must be an absolute path' },
      ]);
    },
  );
});

describe('LOG_LEVEL', () => {
  it.each(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])('accepts %s', (value) => {
    expect(configOf({ LOG_LEVEL: value }).logLevel).toBe(value);
  });

  it.each(['', 'INFO', 'Info', 'verbose', 'silly', ' info', 'info '])('rejects %j', (value) => {
    expect(variablesOf({ LOG_LEVEL: value })).toEqual(['LOG_LEVEL']);
  });
});

describe('booleans are true or false, in lower case, and nothing else', () => {
  const NAMES = [
    ['SHOWCASE', 'showcase'],
    ['HSTS_INCLUDE_SUBDOMAINS', 'hsts'],
    ['AUTH_REQUIRE_MFA', 'auth'],
  ] as const;

  for (const [name] of NAMES) {
    it.each(['', 'TRUE', 'True', 'FALSE', '1', '0', 'yes', 'no', 'on', 'off', ' true', 'true '])(
      `${name} rejects %j`,
      (value) => {
        expect(issuesOf({ [name]: value })).toEqual([
          { variable: name, message: `${name} must be true or false` },
        ]);
      },
    );
  }

  it('reads true and false for every boolean variable', () => {
    expect(configOf({ SHOWCASE: 'true' }).showcase).toBe(true);
    expect(configOf({ SHOWCASE: 'false' }).showcase).toBe(false);
    expect(configOf({ HSTS_INCLUDE_SUBDOMAINS: 'true' }).hsts.includeSubDomains).toBe(true);
    expect(configOf({ AUTH_REQUIRE_MFA: 'false' }).auth.requireMfa).toBe(false);
    expect(configOf({ AUTH_REQUIRE_MFA: 'true' }).auth.requireMfa).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// PUBLIC_BASE_URL
// ---------------------------------------------------------------------------------------------

describe('PUBLIC_BASE_URL', () => {
  it.each([
    ['http://localhost:9090', 'http://localhost:9090', 'localhost'],
    ['http://localhost:9090/', 'http://localhost:9090', 'localhost'],
    ['HTTPS://Panel.Example.COM/', 'https://panel.example.com', 'panel.example.com'],
    ['https://panel.example.com:443', 'https://panel.example.com', 'panel.example.com'],
    ['http://localhost:80/', 'http://localhost', 'localhost'],
    ['http://LOCALHOST:18080', 'http://localhost:18080', 'localhost'],
    ['https://panel.example.com:8443', 'https://panel.example.com:8443', 'panel.example.com'],
    ['https://203.0.113.5:9000', 'https://203.0.113.5:9000', '203.0.113.5'],
    ['https://panel.example.com.', 'https://panel.example.com.', 'panel.example.com'],
  ])('normalises %s to the serialised origin %s (host %s)', (value, origin, host) => {
    const config = configOf({ PUBLIC_BASE_URL: value });
    expect(config.publicOrigin).toBe(origin);
    expect(config.publicHost).toBe(host);
    expect(config.publicIsHttps).toBe(origin.startsWith('https:'));
  });

  const REJECTED = [
    '',
    ' ',
    'localhost:9090',
    'ftp://localhost',
    'ws://localhost',
    '//localhost',
    'localhost',
    'http://',
    'http://localhost:9090/panel',
    'http://localhost:9090//',
    'http://localhost:9090/?x=1',
    'http://localhost:9090?x=1',
    'http://localhost:9090/#top',
    'http://localhost:9090#top',
    'http://user@localhost:9090',
    'http://user:secret@localhost:9090',
    'http://localhost:99999',
    ' http://localhost:9090',
    'http://localhost:9090 ',
    'http:\\\\localhost:9090',
    'http://local host:9090',
    'javascript:alert(1)',
    // Phase B (FR-B-103): http is for `localhost` only; every other http host cannot be registered.
    'http://127.0.0.1:9090',
    'http://127.0.0.2:9090',
    'http://[::1]:9000',
    'http://192.168.1.10:9000',
    'http://panel.example.com:80/',
    'http://panel.example.com',
    'http://0.0.0.0:9090',
    'http://localhost.:9090',
    'http://localhost.example.org',
    'https://*.example.com',
    'https://pa!nel.example.com',
    'https://pa(nel).example.com',
    'https://p\u00e5nel.example.com',
    'https://xn--pnel-ira.example.com',
  ];

  it.each(REJECTED)('rejects %j and names PUBLIC_BASE_URL', (value) => {
    expect(issuesOf({ PUBLIC_BASE_URL: value })).toEqual([
      { variable: 'PUBLIC_BASE_URL', message: ENV_MESSAGES.PUBLIC_BASE_URL },
    ]);
  });

  it('agrees with the shared redirect-URI module on every row of its table (round trip, T-B-007)', () => {
    const accepted = [
      'https://panel.example.org',
      'https://panel.example.org/',
      'https://panel.example.org:8443',
      'HTTPS://Panel.Example.ORG',
      'https://443.example.org:443',
      'http://localhost:9300',
      'http://localhost',
      'http://localhost:80',
      'http://LOCALHOST:18080/',
      'https://203.0.113.5',
    ];
    for (const value of [...accepted, ...REJECTED]) {
      expect(loadConfig({ PUBLIC_BASE_URL: value }).ok, JSON.stringify(value)).toBe(
        parsePublicBaseUrl(value).ok,
      );
    }
    for (const value of accepted) expect(parsePublicBaseUrl(value).ok, value).toBe(true);
  });

  it('derives the redirect URIs only through the shared module (FR-B-103)', () => {
    const local = configOf({ PUBLIC_BASE_URL: 'http://localhost:9090' });
    expect(local.redirectUris).toEqual({
      callback: 'http://localhost/auth/callback',
      loggedOut: 'http://localhost/auth/logged-out',
    });
    expect(local.authorizeRedirectUri).toBe('http://localhost:9090/auth/callback');
    expect(local.postLogoutRedirectUri).toBe('http://localhost:9090/auth/logged-out');
    const secure = configOf({ PUBLIC_BASE_URL: 'https://panel.example.com:8443/' });
    expect(secure.redirectUris).toEqual({
      callback: 'https://panel.example.com:8443/auth/callback',
      loggedOut: 'https://panel.example.com:8443/auth/logged-out',
    });
    expect(secure.authorizeRedirectUri).toBe(secure.redirectUris.callback);
    // The default base URL follows PORT.
    expect(configOf({ PORT: '18080' }).authorizeRedirectUri).toBe(
      'http://localhost:18080/auth/callback',
    );
  });

  it('never repeats credentials in the report', () => {
    const [issue] = issuesOf({ PUBLIC_BASE_URL: 'http://admin:hunter2@localhost:9090' });
    expect(JSON.stringify(issue)).not.toContain('hunter2');
    expect(JSON.stringify(issue)).not.toContain('admin');
  });
});

// ---------------------------------------------------------------------------------------------
// TRUST_PROXY
// ---------------------------------------------------------------------------------------------

describe('TRUST_PROXY', () => {
  it('is none by default', () => {
    expect(configOf({}).trustProxy).toEqual({ mode: 'none' });
    expect(configOf({ TRUST_PROXY: 'none' }).trustProxy).toEqual({ mode: 'none' });
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('accepts the hop count %i', (hops) => {
    expect(configOf({ TRUST_PROXY: String(hops) }).trustProxy).toEqual({ mode: 'hops', hops });
  });

  it('reads a list of IPv4 and IPv6 addresses and ranges', () => {
    expect(
      configOf({ TRUST_PROXY: '10.0.0.0/8,192.168.1.5,fd00::/8, ::1 ,2001:db8::/32' }).trustProxy,
    ).toEqual({
      mode: 'list',
      networks: [
        { family: 4, address: '10.0.0.0', prefix: 8 },
        { family: 4, address: '192.168.1.5', prefix: 32 },
        { family: 6, address: 'fd00::', prefix: 8 },
        { family: 6, address: '::1', prefix: 128 },
        { family: 6, address: '2001:db8::', prefix: 32 },
      ],
    });
  });

  it('accepts up to 32 entries and refuses the 33rd', () => {
    const entries = (count: number): string =>
      Array.from({ length: count }, (_, index) => `10.0.${String(index)}.1`).join(',');
    const accepted = configOf({ TRUST_PROXY: entries(32) }).trustProxy;
    expect(accepted.mode === 'list' && accepted.networks.length).toBe(32);
    expect(variablesOf({ TRUST_PROXY: entries(33) })).toEqual(['TRUST_PROXY']);
  });

  it.each([
    '',
    ' ',
    'None',
    'NONE',
    'none ',
    ' none',
    '0',
    '9',
    '08',
    '1.5',
    '-1',
    '10',
    'true',
    'localhost',
    '10.0.0.256',
    '10.0.0.0/33',
    '10.0.0.0/',
    '10.0.0.0/08',
    '10.0.0.0/-1',
    '10.0.0.0/8/8',
    'fd00::/129',
    'fe80::1%eth0',
    '10.0.0.1,',
    ',10.0.0.1',
    '10.0.0.1,,10.0.0.2',
    'none,10.0.0.1',
    '1,2',
    '10.0.0.1;10.0.0.2',
  ])('rejects %j and names TRUST_PROXY', (value) => {
    expect(issuesOf({ TRUST_PROXY: value })).toEqual([
      {
        variable: 'TRUST_PROXY',
        message:
          'TRUST_PROXY must be none, a number of proxies from 1 to 8, or a comma-separated list of at most 32 IP addresses or CIDR ranges',
      },
    ]);
  });
});

/** The TRUST_PROXY rule as a guard, so that a reader that is too lenient fails on purpose. */
function assertTrustProxyRule(accepts: (value: string) => boolean): void {
  for (const value of ['none', '1', '8', '10.0.0.0/8', '::1', 'fd00::/8,10.0.0.1']) {
    if (!accepts(value)) throw new Error(`TRUST_PROXY=${value} must be accepted`);
  }
  for (const value of ['', '0', '9', 'NONE', '10.0.0.0/33', '10.0.0.1,', 'localhost']) {
    if (accepts(value)) throw new Error(`TRUST_PROXY=${JSON.stringify(value)} must be rejected`);
  }
}

describe('TRUST_PROXY guard', () => {
  const real = (value: string): boolean => loadConfig({ TRUST_PROXY: value }).ok;

  it('passes for the real reader', () => {
    expect(() => {
      assertTrustProxyRule(real);
    }).not.toThrow();
  });

  it('fails for a reader that accepts any integer as a hop count', () => {
    const lenient = (value: string): boolean => /^\d+$/.test(value) || real(value);
    expectGuardFails(assertTrustProxyRule, lenient, { reason: 'must be rejected' });
  });

  it('fails for a reader that accepts a trailing comma', () => {
    const lenient = (value: string): boolean => real(value.replace(/,$/, ''));
    expectGuardFails(assertTrustProxyRule, lenient, { reason: 'must be rejected' });
  });

  it('fails for a reader that accepts any host name', () => {
    const lenient = (value: string): boolean => value === 'localhost' || real(value);
    expectGuardFails(assertTrustProxyRule, lenient, { reason: 'must be rejected' });
  });
});

// ---------------------------------------------------------------------------------------------
// HSTS
// ---------------------------------------------------------------------------------------------

describe('HSTS variables', () => {
  it.each(['0', '1', '86400', '31536000', '63072000'])('accepts HSTS_MAX_AGE=%s', (value) => {
    expect(configOf({ HSTS_MAX_AGE: value }).hsts.maxAgeSeconds).toBe(Number(value));
  });

  it.each(['', '-1', '63072001', '1.5', '1e7', ' 5', '5 ', '0x10', '00', '007', 'forever'])(
    'rejects HSTS_MAX_AGE=%j',
    (value) => {
      expect(issuesOf({ HSTS_MAX_AGE: value })).toEqual([
        {
          variable: 'HSTS_MAX_AGE',
          message: 'HSTS_MAX_AGE must be an integer between 0 and 63072000',
        },
      ]);
    },
  );

  it('accepts HSTS_PRELOAD=true only with HSTS_INCLUDE_SUBDOMAINS=true and a year of max-age', () => {
    expect(configOf({ HSTS_PRELOAD: 'true', HSTS_INCLUDE_SUBDOMAINS: 'true' }).hsts).toEqual({
      maxAgeSeconds: 31_536_000,
      includeSubDomains: true,
      preload: true,
    });
    expect(
      configOf({
        HSTS_PRELOAD: 'true',
        HSTS_INCLUDE_SUBDOMAINS: 'true',
        HSTS_MAX_AGE: '63072000',
      }).hsts.preload,
    ).toBe(true);
  });

  const PRELOAD_MESSAGE =
    'HSTS_PRELOAD=true requires HSTS_INCLUDE_SUBDOMAINS=true and HSTS_MAX_AGE of at least 31536000';

  it('refuses HSTS_PRELOAD=true without HSTS_INCLUDE_SUBDOMAINS=true (baseline section 13)', () => {
    expect(issuesOf({ HSTS_PRELOAD: 'true' })).toEqual([
      { variable: 'HSTS_PRELOAD', message: PRELOAD_MESSAGE },
    ]);
    expect(variablesOf({ HSTS_PRELOAD: 'true', HSTS_INCLUDE_SUBDOMAINS: 'false' })).toEqual([
      'HSTS_PRELOAD',
    ]);
  });

  it('refuses HSTS_PRELOAD=true with a max-age below 31,536,000', () => {
    for (const maxAge of ['0', '86400', '31535999']) {
      expect(
        variablesOf({
          HSTS_PRELOAD: 'true',
          HSTS_INCLUDE_SUBDOMAINS: 'true',
          HSTS_MAX_AGE: maxAge,
        }),
      ).toEqual(['HSTS_PRELOAD']);
    }
  });

  it('accepts a short max-age or none of the flags when preload is off', () => {
    expect(configOf({ HSTS_MAX_AGE: '0' }).hsts.maxAgeSeconds).toBe(0);
    expect(configOf({ HSTS_INCLUDE_SUBDOMAINS: 'true', HSTS_MAX_AGE: '60' }).hsts).toEqual({
      maxAgeSeconds: 60,
      includeSubDomains: true,
      preload: false,
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Preview mode (FR-A-035, E-17)
// ---------------------------------------------------------------------------------------------

describe('isLoopbackHost', () => {
  it.each(['localhost', 'LOCALHOST', '127.0.0.1', '127.0.0.2', '127.255.255.254', '[::1]', '::1'])(
    '%s is loopback',
    (host) => {
      expect(isLoopbackHost(host)).toBe(true);
    },
  );

  it.each([
    '',
    'localhost.',
    'localhost.attacker.example',
    'attacker-localhost',
    '127.0.0.1.nip.io',
    '127.0.0',
    '127.0.0.256',
    '127.1',
    '128.0.0.1',
    '126.255.255.255',
    '0.0.0.0',
    '10.0.0.1',
    '192.168.1.10',
    '[::2]',
    '::',
    '[::ffff:127.0.0.1]',
    '[0:0:0:0:0:0:0:1]',
    'panel.example.com',
    'localhost:9300',
  ])('%j is not loopback', (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});

describe('normalizeHost, the one host normaliser', () => {
  it.each([
    ['localhost', 'localhost'],
    ['LocalHost:9090', 'localhost'],
    ['panel.example.com.', 'panel.example.com'],
    ['Panel.Example.COM.:8443', 'panel.example.com'],
    ['[::1]:9300', '[::1]'],
    ['[::1]', '[::1]'],
    ['[2001:DB8::1]:443', '[2001:db8::1]'],
    ['127.0.0.1:80', '127.0.0.1'],
    ['a', 'a'],
  ])('normalises %j to %j', (value, host) => {
    expect(normalizeHost(value)).toBe(host);
  });

  it.each([
    '',
    ' ',
    ':9300',
    'host:',
    'host:port',
    'host:123456',
    'host:80:80',
    'a b',
    'a/b',
    'a@b',
    'a?b',
    'a#b',
    'a\\b',
    'a..b',
    'panel.example.com..',
    '.',
    '-a',
    '[::1',
    '::1]',
    '::1',
    '[::1]x',
    '[zz]',
    '[]',
    'café',
    'host\r\nX-Injected: 1',
    // A zone id names an interface of one machine: never a host a request is addressed to.
    '[fe80::1%eth0]',
    '[fe80::1%25eth0]',
  ])('refuses %j', (value) => {
    expect(normalizeHost(value)).toBeUndefined();
  });

  it('accepts a label of 63 characters and a name of 253, and refuses one more of either', () => {
    const label = (length: number): string => 'a'.repeat(length);
    expect(normalizeHost(label(63))).toBe(label(63));
    expect(normalizeHost(label(64))).toBeUndefined();
    // Three labels of 63 characters, one of 61 and three dots make 253 characters, the longest name.
    const longest = [label(63), label(63), label(63), label(61)].join('.');
    expect(longest).toHaveLength(253);
    expect(normalizeHost(longest)).toBe(longest);
    expect(normalizeHost(`${longest}a`)).toBeUndefined();
    expect(normalizeHost(`${longest}.`)).toBe(longest);
  });
});

describe('the removed preview variables (FR-B-102)', () => {
  it('names them, and only when the environment sets them', () => {
    expect(removedVariablesIn({})).toEqual([]);
    expect(removedVariablesIn({ PREVIEW_MODE: 'true' })).toEqual(['PREVIEW_MODE']);
    expect(removedVariablesIn({ PREVIEW_MODE_ALLOW_REMOTE: 'false' })).toEqual([
      'PREVIEW_MODE_ALLOW_REMOTE',
    ]);
    expect(removedVariablesIn({ PREVIEW_MODE_ALLOW_REMOTE: 'x', PREVIEW_MODE: 'y' })).toEqual([
      'PREVIEW_MODE',
      'PREVIEW_MODE_ALLOW_REMOTE',
    ]);
    expect(removedVariablesIn({ SHOWCASE: 'true' })).toEqual([]);
  });

  it.each([
    [{ PREVIEW_MODE: 'true' }],
    [{ PREVIEW_MODE: 'true', PREVIEW_MODE_ALLOW_REMOTE: 'true' }],
    [{ PREVIEW_MODE: 'banana' }],
    [{ PREVIEW_MODE: '' }],
    [{ PREVIEW_MODE: 'true', PUBLIC_BASE_URL: 'https://panel.example.com' }],
  ])('has no effect: %j gives the configuration of the same environment without them', (env) => {
    const without = Object.fromEntries(
      Object.entries(env).filter(([name]) => !REMOVED.includes(name)),
    );
    expect(configOf(env)).toEqual(configOf(without));
    expect(readPosture(configOf(env))).toEqual(readPosture(configOf(without)));
  });

  it('does not let them cause an issue, even with a value the old schema refused', () => {
    expect(loadConfig({ PREVIEW_MODE: 'TRUE', PREVIEW_MODE_ALLOW_REMOTE: '1' }).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// The variables of Phase B (spec 6.9.1, FR-B-101)
// ---------------------------------------------------------------------------------------------

const KEY_HEX = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const KEY_BASE64 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const KEY_BASE64URL = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const KEY_OTHER_HEX = '1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100';
const SCRYPT_LINE = `scrypt:131072:8:1:${Buffer.alloc(16, 7).toString('base64url')}:${Buffer.alloc(32, 9).toString('base64url')}`;

/** What the report says for `name` when `value` is refused: its fixed message, and nothing else. */
function refusal(name: keyof typeof ENV_MESSAGES, value: string): readonly ConfigIssue[] {
  return issuesOf({ [name]: value });
}

describe('APP_KEY and APP_KEY_FILE (FR-B-104)', () => {
  it.each([KEY_HEX, KEY_BASE64, KEY_BASE64URL, KEY_HEX.toUpperCase()])('accepts %s', (value) => {
    const config = configOf({ APP_KEY: value });
    expect(config.appKey.source).toBe('env');
    if (config.appKey.source === 'env') expect(config.appKey.value.reveal()).toBe(value);
  });

  it.each([
    '',
    ' ',
    'short',
    KEY_HEX.slice(1),
    `${KEY_HEX}0`,
    `${KEY_BASE64URL}A`,
    `${KEY_BASE64URL.slice(0, 42)}B`,
    `${KEY_BASE64URL.slice(0, 40)}+_x`,
    '00'.repeat(32),
    Buffer.from(Array.from({ length: 32 }, (_, i) => i % 15)).toString('hex'),
    `${KEY_BASE64URL}\n`,
    `"${KEY_BASE64URL}"`,
  ])('rejects %j and names APP_KEY', (value) => {
    expect(refusal('APP_KEY', value)).toEqual([
      { variable: 'APP_KEY', message: ENV_MESSAGES.APP_KEY },
    ]);
  });

  it('reads the source: nothing, the variable, or a file read at start', () => {
    expect(configOf({}).appKey).toEqual({ source: 'none' });
    expect(configOf({ APP_KEY_FILE: '/run/secrets/app_key' }).appKey).toEqual({
      source: 'file',
      path: '/run/secrets/app_key',
    });
  });

  it.each(['', ' ', 'app_key', './app_key', '../app_key', '/a\0b'])(
    'rejects APP_KEY_FILE=%j and names APP_KEY_FILE',
    (value) => {
      expect(refusal('APP_KEY_FILE', value)).toEqual([
        { variable: 'APP_KEY_FILE', message: ENV_MESSAGES.APP_KEY_FILE },
      ]);
    },
  );

  it('does not open the file while the configuration is read (that is the start, T-B-019)', () => {
    expect(loadConfig({ APP_KEY_FILE: '/nonexistent/app-key' }).ok).toBe(true);
  });

  it('refuses both at once, naming APP_KEY, and accepts each alone or neither (neither: before setup)', () => {
    expect(issuesOf({ APP_KEY: KEY_HEX, APP_KEY_FILE: '/run/secrets/app_key' })).toEqual([
      { variable: 'APP_KEY', message: CROSS_MESSAGES.appKeyExclusive },
    ]);
    expect(loadConfig({ APP_KEY: KEY_HEX }).ok).toBe(true);
    expect(loadConfig({ APP_KEY_FILE: '/run/secrets/app_key' }).ok).toBe(true);
    expect(loadConfig({}).ok).toBe(true);
  });
});

describe('APP_KEY_PREVIOUS and APP_KEY_PREVIOUS_FILE (FR-B-109)', () => {
  it('reads the same formats as APP_KEY', () => {
    const config = configOf({ APP_KEY: KEY_HEX, APP_KEY_PREVIOUS: KEY_OTHER_HEX });
    expect(config.appKeyPrevious.source).toBe('env');
    expect(configOf({ APP_KEY_PREVIOUS_FILE: '/run/secrets/previous' }).appKeyPrevious).toEqual({
      source: 'file',
      path: '/run/secrets/previous',
    });
  });

  it.each(['', 'short', '00'.repeat(32), `${KEY_HEX}0`])('rejects %j', (value) => {
    expect(refusal('APP_KEY_PREVIOUS', value)).toEqual([
      { variable: 'APP_KEY_PREVIOUS', message: ENV_MESSAGES.APP_KEY_PREVIOUS },
    ]);
  });

  it.each(['', 'relative'])('rejects APP_KEY_PREVIOUS_FILE=%j', (value) => {
    expect(refusal('APP_KEY_PREVIOUS_FILE', value)).toEqual([
      { variable: 'APP_KEY_PREVIOUS_FILE', message: ENV_MESSAGES.APP_KEY_PREVIOUS_FILE },
    ]);
  });

  it('refuses both at once and accepts each alone', () => {
    expect(
      issuesOf({ APP_KEY_PREVIOUS: KEY_OTHER_HEX, APP_KEY_PREVIOUS_FILE: '/run/secrets/previous' }),
    ).toEqual([{ variable: 'APP_KEY_PREVIOUS', message: CROSS_MESSAGES.appKeyPreviousExclusive }]);
    expect(loadConfig({ APP_KEY_PREVIOUS: KEY_OTHER_HEX }).ok).toBe(true);
  });

  it('lets the current and the previous key use different sources', () => {
    expect(
      loadConfig({ APP_KEY: KEY_HEX, APP_KEY_PREVIOUS_FILE: '/run/secrets/previous' }).ok,
    ).toBe(true);
    expect(
      loadConfig({ APP_KEY_FILE: '/run/secrets/app_key', APP_KEY_PREVIOUS: KEY_OTHER_HEX }).ok,
    ).toBe(true);
  });
});

describe('SETUP_TOKEN (FR-B-203)', () => {
  const distinct12 = 'abcdefghijkl';

  it.each([
    distinct12.repeat(2),
    `${distinct12}-_.~${distinct12}`,
    'A1b2C3d4E5f6G7h8I9j0K1l2M3n4'.repeat(4),
    'a'.repeat(116) + distinct12,
    distinct12 + 'a'.repeat(12),
  ])('accepts a token of %#', (value) => {
    const config = configOf({ SETUP_TOKEN: value });
    expect(config.setupToken?.reveal()).toBe(value);
  });

  it.each([
    ['empty', ''],
    ['23 characters', `${distinct12}${distinct12}`.slice(0, 23)],
    ['129 characters', `${distinct12}${'a'.repeat(117)}`],
    ['11 distinct characters', 'abcdefghijk'.repeat(3)],
    ['a space', `${distinct12.slice(0, 11)} ${distinct12}`],
    ['a slash', `${distinct12.slice(0, 11)}/${distinct12}`],
    ['a plus sign', `${distinct12.slice(0, 11)}+${distinct12}`],
    ['padding', `${distinct12}${distinct12.slice(0, 11)}=`],
    ['a non-ASCII letter', `${distinct12}${distinct12.slice(0, 11)}é`],
    ['a trailing newline', `${distinct12}${distinct12}\n`],
  ])('rejects a token with %s', (_label, value) => {
    expect(refusal('SETUP_TOKEN', value)).toEqual([
      { variable: 'SETUP_TOKEN', message: ENV_MESSAGES.SETUP_TOKEN },
    ]);
  });

  it('is unset by default (the token file is used)', () => {
    expect(configOf({}).setupToken).toBeUndefined();
  });
});

describe('BOOTSTRAP_CLIENT_ID (FR-B-214)', () => {
  it('is the default public client, in lower case', () => {
    expect(configOf({}).bootstrapClientId).toBe('14d82eec-204b-4c2f-b7e8-296a70dab67e');
  });

  it('is case-insensitive and stored lower-case', () => {
    expect(
      configOf({ BOOTSTRAP_CLIENT_ID: '14D82EEC-204B-4C2F-B7E8-296A70DAB67E' }).bootstrapClientId,
    ).toBe('14d82eec-204b-4c2f-b7e8-296a70dab67e');
  });

  it.each([
    '',
    ' ',
    '{14d82eec-204b-4c2f-b7e8-296a70dab67e}',
    '14d82eec204b4c2fb7e8296a70dab67e',
    '14d82eec-204b-4c2f-b7e8-296a70dab67',
    '14d82eec-204b-4c2f-b7e8-296a70dab67ee',
    'g4d82eec-204b-4c2f-b7e8-296a70dab67e',
    'urn:uuid:14d82eec-204b-4c2f-b7e8-296a70dab67e',
    ' 14d82eec-204b-4c2f-b7e8-296a70dab67e',
  ])('rejects %j', (value) => {
    expect(refusal('BOOTSTRAP_CLIENT_ID', value)).toEqual([
      { variable: 'BOOTSTRAP_CLIENT_ID', message: ENV_MESSAGES.BOOTSTRAP_CLIENT_ID },
    ]);
  });
});

describe('the integer settings: range tables (spec 6.9.1)', () => {
  const TABLE = [
    ['SETUP_PROPAGATION_TIMEOUT_SECONDS', LIMITS.setup.propagationTimeoutSeconds],
    ['SESSION_IDLE_TIMEOUT_MINUTES', LIMITS.session.idleTimeoutMinutes],
    ['SESSION_ABSOLUTE_TIMEOUT_HOURS', LIMITS.session.absoluteTimeoutHours],
    ['GROUP_CACHE_TTL_SECONDS', LIMITS.rbac.groupCacheTtlSeconds],
  ] as const;

  const BAD_FORM = ['', ' ', 'abc', '-5', '+5', '5.0', '1e2', '0x10', '05', ' 5', '5 ', '５'];

  for (const [name, range] of TABLE) {
    describe(name, () => {
      it(`has the default ${String(range.default)} and the range ${String(range.min)} to ${String(range.max)}`, () => {
        expect(ENV_MESSAGES[name]).toBe(
          `${name} must be an integer between ${String(range.min)} and ${String(range.max)}`,
        );
        expect(loadConfig({}).ok).toBe(true);
      });

      it.each([range.min, Math.floor((range.min + range.max) / 2), range.max])(
        'accepts %i',
        (value) => {
          // The pair rule needs the other session setting to stay in order.
          const extra =
            name === 'SESSION_IDLE_TIMEOUT_MINUTES'
              ? { SESSION_ABSOLUTE_TIMEOUT_HOURS: '24' }
              : name === 'SESSION_ABSOLUTE_TIMEOUT_HOURS'
                ? { SESSION_IDLE_TIMEOUT_MINUTES: '5' }
                : {};
          expect(loadConfig({ [name]: String(value), ...extra }).ok).toBe(true);
        },
      );

      it.each([String(range.min - 1), String(range.max + 1), '0', '100000000', ...BAD_FORM])(
        'rejects %j and names %s',
        (value) => {
          expect(refusal(name, value)).toEqual([{ variable: name, message: ENV_MESSAGES[name] }]);
        },
      );
    });
  }

  it('converts every duration to milliseconds once, in derived.ts', () => {
    const config = configOf({
      SETUP_PROPAGATION_TIMEOUT_SECONDS: '120',
      SESSION_IDLE_TIMEOUT_MINUTES: '45',
      SESSION_ABSOLUTE_TIMEOUT_HOURS: '10',
      GROUP_CACHE_TTL_SECONDS: '90',
    });
    expect(config.setup.propagationTimeoutMs).toBe(120_000);
    expect(config.session.idleTimeoutMs).toBe(45 * 60_000);
    expect(config.session.absoluteTimeoutMs).toBe(10 * 3_600_000);
    expect(config.rbac.groupCacheTtlMs).toBe(90_000);
  });

  it('requires the absolute lifetime to exceed the idle one: hours x 60 greater than minutes', () => {
    const message = CROSS_MESSAGES.sessionOrder;
    // 1 hour is 60 minutes: not greater than 60.
    expect(
      issuesOf({ SESSION_ABSOLUTE_TIMEOUT_HOURS: '1', SESSION_IDLE_TIMEOUT_MINUTES: '60' }),
    ).toEqual([{ variable: 'SESSION_ABSOLUTE_TIMEOUT_HOURS', message }]);
    expect(
      loadConfig({ SESSION_ABSOLUTE_TIMEOUT_HOURS: '1', SESSION_IDLE_TIMEOUT_MINUTES: '59' }).ok,
    ).toBe(true);
    // The defaults: 8 hours is 480 minutes, and the idle maximum is 480: equal is refused too.
    expect(issuesOf({ SESSION_IDLE_TIMEOUT_MINUTES: '480' })).toEqual([
      { variable: 'SESSION_ABSOLUTE_TIMEOUT_HOURS', message },
    ]);
    expect(loadConfig({ SESSION_IDLE_TIMEOUT_MINUTES: '479' }).ok).toBe(true);
    expect(
      loadConfig({ SESSION_IDLE_TIMEOUT_MINUTES: '480', SESSION_ABSOLUTE_TIMEOUT_HOURS: '9' }).ok,
    ).toBe(true);
    expect(loadConfig({ SESSION_ABSOLUTE_TIMEOUT_HOURS: '1' }).ok).toBe(true);
  });
});

describe('AUTH_MFA_AMR_VALUES (FR-B-405)', () => {
  it('is mfa and multipleauthn by default', () => {
    expect(configOf({}).auth.mfaAmrValues).toEqual(['mfa', 'multipleauthn']);
  });

  it.each([
    ['mfa', ['mfa']],
    ['mfa,multipleauthn', ['mfa', 'multipleauthn']],
    ['otp,fido,hwk,ngcmfa', ['otp', 'fido', 'hwk', 'ngcmfa']],
    ['a1', ['a1']],
    ['z'.repeat(32), ['z'.repeat(32)]],
    ['aa,bb,cc,dd,ee,ff,gg,hh', ['aa', 'bb', 'cc', 'dd', 'ee', 'ff', 'gg', 'hh']],
  ])('accepts %s', (value, expected) => {
    expect(configOf({ AUTH_MFA_AMR_VALUES: value }).auth.mfaAmrValues).toEqual(expected);
  });

  it.each([
    ['empty', ''],
    ['pwd', 'pwd'],
    ['wia', 'wia'],
    ['x509', 'x509'],
    ['a single-factor method in a list', 'mfa,pwd'],
    ['one character', 'a'],
    ['33 characters', 'z'.repeat(33)],
    ['9 values', 'aa,bb,cc,dd,ee,ff,gg,hh,ii'],
    ['a duplicate', 'mfa,mfa'],
    ['upper case', 'MFA'],
    ['a space', 'mfa, otp'],
    ['a trailing comma', 'mfa,'],
    ['an empty element', 'mfa,,otp'],
    ['an underscore', 'a_b'],
    ['a hyphen', 'a-b'],
  ])('rejects %s', (_label, value) => {
    expect(refusal('AUTH_MFA_AMR_VALUES', value)).toEqual([
      { variable: 'AUTH_MFA_AMR_VALUES', message: ENV_MESSAGES.AUTH_MFA_AMR_VALUES },
    ]);
  });
});

describe('BREAK_GLASS_USERNAME and BREAK_GLASS_PASSWORD_HASH (FR-B-521)', () => {
  it('is off by default', () => {
    expect(configOf({}).breakGlass).toBeUndefined();
  });

  it('reads the account when both are set', () => {
    const config = configOf({
      BREAK_GLASS_USERNAME: 'recovery.admin',
      BREAK_GLASS_PASSWORD_HASH: SCRYPT_LINE,
    });
    expect(config.breakGlass?.username).toBe('recovery.admin');
    expect(config.breakGlass?.passwordHash.reveal()).toBe(SCRYPT_LINE);
  });

  it.each(['abc', 'A.b_c-1', 'a'.repeat(64), 'Recovery-Admin_01'])(
    'accepts the username %j',
    (user) => {
      expect(
        loadConfig({ BREAK_GLASS_USERNAME: user, BREAK_GLASS_PASSWORD_HASH: SCRYPT_LINE }).ok,
      ).toBe(true);
    },
  );

  it.each(['', 'ab', 'a'.repeat(65), 'a b', 'ab@c', 'useré', 'a/b', 'a\nb'])(
    'rejects the username %j',
    (user) => {
      expect(
        issuesOf({ BREAK_GLASS_USERNAME: user, BREAK_GLASS_PASSWORD_HASH: SCRYPT_LINE }),
      ).toEqual([{ variable: 'BREAK_GLASS_USERNAME', message: ENV_MESSAGES.BREAK_GLASS_USERNAME }]);
    },
  );

  it.each([
    ['empty', ''],
    ['plain text', 'correct horse battery staple'],
    ['a weaker N', SCRYPT_LINE.replace(':131072:', ':8192:')],
    ['a heavier N', SCRYPT_LINE.replace(':131072:', ':1048576:')],
    ['over the memory cap', SCRYPT_LINE.replace(':131072:8:', ':131072:16:')],
    [
      'a short salt',
      `scrypt:131072:8:1:${Buffer.alloc(8, 7).toString('base64url')}:${Buffer.alloc(32, 9).toString('base64url')}`,
    ],
    ['the $ format', '$scrypt$ln=17,r=8,p=1$c2FsdA$aGFzaA'],
    ['padding', `${SCRYPT_LINE}=`],
  ])('rejects the hash: %s', (_label, hash) => {
    expect(
      issuesOf({ BREAK_GLASS_USERNAME: 'recovery.admin', BREAK_GLASS_PASSWORD_HASH: hash }),
    ).toEqual([
      { variable: 'BREAK_GLASS_PASSWORD_HASH', message: ENV_MESSAGES.BREAK_GLASS_PASSWORD_HASH },
    ]);
  });

  it('needs both or neither: naming the one that is missing', () => {
    expect(issuesOf({ BREAK_GLASS_USERNAME: 'recovery.admin' })).toEqual([
      { variable: 'BREAK_GLASS_PASSWORD_HASH', message: CROSS_MESSAGES.breakGlassPair },
    ]);
    expect(issuesOf({ BREAK_GLASS_PASSWORD_HASH: SCRYPT_LINE })).toEqual([
      { variable: 'BREAK_GLASS_USERNAME', message: CROSS_MESSAGES.breakGlassPair },
    ]);
  });
});

describe('secrets in the configuration never leave it (AGENTS.md section 4, FR-B-104)', () => {
  const ALL_SECRETS = {
    APP_KEY: KEY_HEX,
    APP_KEY_PREVIOUS: KEY_OTHER_HEX,
    SETUP_TOKEN: 'Zq9XvB3nLm7TdR2sKw8YcP4h',
    BREAK_GLASS_USERNAME: 'recovery.admin',
    BREAK_GLASS_PASSWORD_HASH: SCRYPT_LINE,
  };

  it('prints, serialises and inspects as [redacted]', () => {
    const config = configOf(ALL_SECRETS);
    const text = `${JSON.stringify(config)} ${inspect(config, { depth: 8 })} ${String(config.setupToken)}`;
    for (const secret of [KEY_HEX, KEY_OTHER_HEX, 'Zq9XvB3nLm7TdR2sKw8YcP4h', SCRYPT_LINE]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain('[redacted]');
    expect(config.setupToken?.reveal()).toBe('Zq9XvB3nLm7TdR2sKw8YcP4h');
  });

  it('SecretText gives its value only through reveal()', () => {
    const secret = new SecretText('canary-1234');
    expect(secret.reveal()).toBe('canary-1234');
    expect(String(secret)).toBe('[redacted]');
    expect(String(secret)).not.toContain('canary');
    expect(JSON.stringify({ secret })).toBe('{"secret":"[redacted]"}');
    expect(inspect(secret)).toBe('[redacted]');
    expect(Object.keys(secret)).toEqual([]);
  });

  it('is frozen with the rest of the configuration', () => {
    const config = configOf(ALL_SECRETS);
    expect(Object.isFrozen(config.auth)).toBe(true);
    expect(Object.isFrozen(config.session)).toBe(true);
    expect(Object.isFrozen(config.breakGlass)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Reporting: names, never values (FR-A-010)
// ---------------------------------------------------------------------------------------------

describe('reporting an invalid configuration', () => {
  const CANARY = 'CANARY-7c1e9a52-secret';

  it('reports every invalid variable at once, by name', () => {
    const env = {
      PORT: `${CANARY}-port`,
      HOST: `${CANARY} host`,
      DATA_DIR: `${CANARY}/relative`,
      PUBLIC_BASE_URL: `http://${CANARY}:pw@localhost`,
      TRUST_PROXY: `${CANARY}-proxy`,
      SHOWCASE: `${CANARY}-showcase`,
      LOG_LEVEL: `${CANARY}-level`,
      HSTS_MAX_AGE: `${CANARY}-age`,
      HSTS_INCLUDE_SUBDOMAINS: `${CANARY}-include`,
      HSTS_PRELOAD: `${CANARY}-preload`,
      // Phase B: the secret variables are the likeliest to carry a real value.
      APP_KEY: `${CANARY}-app-key`,
      APP_KEY_FILE: `${CANARY}-key-file`,
      APP_KEY_PREVIOUS: `${CANARY}-previous`,
      APP_KEY_PREVIOUS_FILE: `${CANARY}-previous-file`,
      SETUP_TOKEN: `${CANARY}-token with spaces`,
      BOOTSTRAP_CLIENT_ID: `${CANARY}-client`,
      SETUP_PROPAGATION_TIMEOUT_SECONDS: `${CANARY}-propagation`,
      SESSION_IDLE_TIMEOUT_MINUTES: `${CANARY}-idle`,
      SESSION_ABSOLUTE_TIMEOUT_HOURS: `${CANARY}-absolute`,
      GROUP_CACHE_TTL_SECONDS: `${CANARY}-ttl`,
      AUTH_REQUIRE_MFA: `${CANARY}-mfa`,
      AUTH_MFA_AMR_VALUES: `${CANARY}-amr`,
      BREAK_GLASS_USERNAME: `${CANARY} user`,
      BREAK_GLASS_PASSWORD_HASH: `${CANARY}-hash`,
      // Phase D.
      EXCHANGE_KEY_HANDOVER: `${CANARY}-handover`,
    };
    const issues = issuesOf(env);
    expect(issues.map((issue) => issue.variable).sort()).toEqual([...ENV_VARIABLE_NAMES].sort());
    expect(JSON.stringify(issues)).not.toContain('CANARY');
    expect(formatConfigIssues(issues)).not.toContain('CANARY');
    for (const issue of issues) expect(issue.message).toContain(issue.variable);
  });

  it('puts the code config_invalid and every variable name in the text, and no value', () => {
    const text = formatConfigIssues(issuesOf({ PORT: CANARY, HSTS_MAX_AGE: CANARY }));
    expect(text).toContain('config_invalid');
    expect(text).toContain('PORT');
    expect(text).toContain('HSTS_MAX_AGE');
    expect(text).not.toContain(CANARY);
    expect(text.endsWith('\n')).toBe(true);
  });

  it('throws an error that carries the issues and no value', () => {
    let failure: unknown;
    try {
      loadConfigOrThrow({ PORT: CANARY });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('PORT');
    expect((failure as Error).message).not.toContain(CANARY);
    expect(String((failure as Error).stack)).not.toContain(CANARY);
  });

  it('replaces a message of a library, so that no text but ours reaches the report', () => {
    // A value of the wrong type (not possible from `process.env`, possible from a caller) makes Zod
    // write a message of its own. It is not one of ours, so it is not passed on.
    const issues = issuesOf({ PORT: 9300 as unknown as string });
    expect(issues).toEqual([{ variable: 'PORT', message: 'PORT is invalid' }]);
  });

  it('does not run the cross-field rules on a variable that is already invalid', () => {
    expect(variablesOf({ APP_KEY_FILE: '/x', APP_KEY: 'nope' })).toEqual(['APP_KEY']);
    expect(variablesOf({ BREAK_GLASS_USERNAME: 'ab' })).toEqual(['BREAK_GLASS_USERNAME']);
    expect(
      variablesOf({ SESSION_IDLE_TIMEOUT_MINUTES: '4', SESSION_ABSOLUTE_TIMEOUT_HOURS: '1' }),
    ).toEqual(['SESSION_IDLE_TIMEOUT_MINUTES']);
  });

  it('reports every cross-field rule that fails, each once, by variable name', () => {
    const issues = issuesOf({
      APP_KEY: KEY_HEX,
      APP_KEY_FILE: '/k',
      APP_KEY_PREVIOUS: KEY_OTHER_HEX,
      APP_KEY_PREVIOUS_FILE: '/p',
      BREAK_GLASS_USERNAME: 'recovery.admin',
      SESSION_IDLE_TIMEOUT_MINUTES: '480',
      HSTS_PRELOAD: 'true',
    });
    expect(issues.map((issue) => issue.variable).sort()).toEqual([
      'APP_KEY',
      'APP_KEY_PREVIOUS',
      'BREAK_GLASS_PASSWORD_HASH',
      'HSTS_PRELOAD',
      'SESSION_ABSOLUTE_TIMEOUT_HOURS',
    ]);
    expect(JSON.stringify(issues)).not.toContain(KEY_HEX);
  });

  it('refuses to start in a process of its own, before it listens, with names and no values', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: serverDirectory,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        PORT: `${CANARY}-spawn-port`,
        HSTS_MAX_AGE: `${CANARY}-spawn-age`,
        DATA_DIR: '/nonexistent/m365portal-config-test',
      },
      encoding: 'utf8',
      timeout: 60_000,
    });
    // A server that had started listening would still be running when the timeout ends.
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('config_invalid');
    expect(result.stderr).toContain('PORT must be an integer between 1024 and 65535');
    expect(result.stderr).toContain('HSTS_MAX_AGE');
    expect(`${result.stdout}${result.stderr}`).not.toContain('CANARY');
    expect(result.stdout).not.toContain('listening');
  }, 90_000);
});

// ---------------------------------------------------------------------------------------------
// The posture (FR-A-015)
// ---------------------------------------------------------------------------------------------

describe('readPosture', () => {
  it('describes the defaults without values or addresses', () => {
    expect(readPosture(configOf({}))).toEqual({
      trustProxy: 'none',
      hsts: 'off',
      showcase: false,
      breakGlass: 'off',
      mfa: 'on',
    });
  });

  it('has no preview field any more (FR-B-102)', () => {
    expect(Object.keys(readPosture(configOf({})))).not.toContain('preview');
    expect(Object.keys(readPosture(configOf({})))).not.toContain('previewBoundary');
  });

  it('reports whether the break-glass account exists and whether MFA is required, as flags', () => {
    expect(
      readPosture(
        configOf({
          BREAK_GLASS_USERNAME: 'recovery.admin',
          BREAK_GLASS_PASSWORD_HASH: SCRYPT_LINE,
        }),
      ).breakGlass,
    ).toBe('on');
    expect(readPosture(configOf({ AUTH_REQUIRE_MFA: 'false' })).mfa).toBe('off');
    expect(readPosture(configOf({ AUTH_REQUIRE_MFA: 'true' })).mfa).toBe('on');
  });

  it('names the trust-proxy mode, never a count or an address', () => {
    expect(readPosture(configOf({ TRUST_PROXY: '2' })).trustProxy).toBe('hops');
    expect(readPosture(configOf({ TRUST_PROXY: '10.0.0.0/8' })).trustProxy).toBe('list');
  });

  it('names the HSTS opt-in level, and off when https can never be seen', () => {
    const https = { PUBLIC_BASE_URL: 'https://panel.example.com' };
    expect(readPosture(configOf(https)).hsts).toBe('plain');
    expect(readPosture(configOf({ ...https, HSTS_INCLUDE_SUBDOMAINS: 'true' })).hsts).toBe(
      'include-subdomains',
    );
    expect(
      readPosture(configOf({ ...https, HSTS_INCLUDE_SUBDOMAINS: 'true', HSTS_PRELOAD: 'true' }))
        .hsts,
    ).toBe('preload');
    // An http base URL with a trusted proxy can still see https through X-Forwarded-Proto.
    expect(readPosture(configOf({ TRUST_PROXY: '1' })).hsts).toBe('plain');
    expect(readPosture(configOf({ SHOWCASE: 'true' })).showcase).toBe(true);
  });

  it('holds nothing but modes and flags: no address, port, path or origin', () => {
    const posture = readPosture(
      configOf({
        PUBLIC_BASE_URL: 'https://panel.example.com',
        TRUST_PROXY: '10.1.2.3',
        DATA_DIR: '/srv/m365-secret-dir',
        BREAK_GLASS_USERNAME: 'recovery.admin',
        BREAK_GLASS_PASSWORD_HASH: SCRYPT_LINE,
        SETUP_TOKEN: 'Zq9XvB3nLm7TdR2sKw8YcP4h',
      }),
    );
    const text = JSON.stringify(posture);
    for (const forbidden of [
      '10.1.2.3',
      'panel.example.com',
      'm365-secret-dir',
      '/srv',
      'recovery.admin',
      'Zq9XvB3nLm7TdR2sKw8YcP4h',
      'scrypt',
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });
});

describe('EXCHANGE_KEY_HANDOVER (T-D-114, FR-D-103)', () => {
  it('is memory when unset and accepts memory and tmpfs', () => {
    expect(configOf({}).exchangeKeyHandover).toBe('memory');
    expect(configOf({ EXCHANGE_KEY_HANDOVER: 'memory' }).exchangeKeyHandover).toBe('memory');
    expect(configOf({ EXCHANGE_KEY_HANDOVER: 'tmpfs' }).exchangeKeyHandover).toBe('tmpfs');
  });

  it('refuses anything else with the fixed message and no value in it', () => {
    for (const bad of ['file', 'TMPFS', 'Memory', ' tmpfs', 'disk', 'true']) {
      const issues = issuesOf({ EXCHANGE_KEY_HANDOVER: bad });
      expect(
        issues.map((issue) => issue.variable),
        bad,
      ).toEqual(['EXCHANGE_KEY_HANDOVER']);
      expect(formatConfigIssues(issues), bad).toContain(ENV_MESSAGES.EXCHANGE_KEY_HANDOVER);
      expect(formatConfigIssues(issues), bad).not.toContain(`'${bad}'`);
      expect(ENV_MESSAGES.EXCHANGE_KEY_HANDOVER).toBe(
        'EXCHANGE_KEY_HANDOVER must be memory or tmpfs',
      );
    }
  });

  it('lists the same two values as the key hand-over of the worker', () => {
    expect([...EXCHANGE_KEY_HANDOVER_VALUES]).toEqual([...CERTIFICATE_MODES]);
  });
});

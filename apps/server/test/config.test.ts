// T-A-025, FR-A-010, FR-A-016, FR-A-035, E-17, A-30, A-63: the configuration is the environment
// variables of FR-A-010, parsed by one Zod schema. An invalid value stops the process before it
// listens, and the report names the variable and never the value.
//
// Negative fixtures (tasks.md section 0.3): `assertPortRule` and `assertTrustProxyRule` are guards
// that run a reader over the whole matrix; the real reader passes them, and a reader that accepts
// port 0 (the scaffold's bug), accepts a low port or echoes the value must fail them on purpose.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
  type AppConfig,
  type ConfigIssue,
} from '../src/config/index.js';

type Env = Readonly<Record<string, string | undefined>>;

const serverDirectory = fileURLToPath(new URL('..', import.meta.url));
const specPath = fileURLToPath(new URL('../../../specs/001-m365portal/spec.md', import.meta.url));

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

describe('the variable list (FR-A-010)', () => {
  it('has exactly the variables and defaults of the FR-A-010 row of the spec, in that order', () => {
    const fromSpec = specVariables();
    expect(fromSpec.map((variable) => variable.name)).toHaveLength(12);
    expect(ENV_VARIABLES.map(({ name, defaultText }) => ({ name, defaultText }))).toEqual(fromSpec);
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
  it('gives every variable of FR-A-010 its default', () => {
    const config = configOf({});
    expect(config).toEqual({
      port: DEFAULT_PORT,
      host: '0.0.0.0',
      dataDir: '/data',
      publicOrigin: `http://localhost:${String(DEFAULT_PORT)}`,
      publicHost: 'localhost',
      publicIsHttps: false,
      trustProxy: { mode: 'none' },
      previewMode: false,
      previewModeAllowRemote: false,
      showcase: false,
      logLevel: 'info',
      hsts: { maxAgeSeconds: 31_536_000, includeSubDomains: false, preload: false },
    } satisfies AppConfig);
    expect(config.hsts.maxAgeSeconds).toBe(LIMITS.hstsMaxAgeSeconds);
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
const PORT_ACCEPTED = ['1024', '1025', '8080', '18080', '49152', '65535'];
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
  ' 8080',
  '8080 ',
  '08080',
  '+8080',
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
    ['PREVIEW_MODE_ALLOW_REMOTE', 'previewModeAllowRemote'],
    ['SHOWCASE', 'showcase'],
    ['HSTS_INCLUDE_SUBDOMAINS', 'hsts'],
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
    expect(configOf({ PREVIEW_MODE: 'true' }).previewMode).toBe(true);
    expect(configOf({ PREVIEW_MODE: 'false' }).previewMode).toBe(false);
    expect(configOf({ PREVIEW_MODE_ALLOW_REMOTE: 'true' }).previewModeAllowRemote).toBe(true);
    expect(configOf({ HSTS_INCLUDE_SUBDOMAINS: 'true' }).hsts.includeSubDomains).toBe(true);
  });

  it('names PREVIEW_MODE for a bad PREVIEW_MODE', () => {
    expect(issuesOf({ PREVIEW_MODE: 'TRUE' })).toEqual([
      { variable: 'PREVIEW_MODE', message: 'PREVIEW_MODE must be true or false' },
    ]);
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
    ['http://panel.example.com:80/', 'http://panel.example.com', 'panel.example.com'],
    ['https://panel.example.com:8443', 'https://panel.example.com:8443', 'panel.example.com'],
    ['http://[::1]:9000', 'http://[::1]:9000', '[::1]'],
    ['http://192.168.1.10:9000', 'http://192.168.1.10:9000', '192.168.1.10'],
    ['https://panel.example.com.', 'https://panel.example.com.', 'panel.example.com'],
    ['http://localhost.:9090', 'http://localhost.:9090', 'localhost'],
  ])('normalises %s to the serialised origin %s (host %s)', (value, origin, host) => {
    const config = configOf({ PUBLIC_BASE_URL: value });
    expect(config.publicOrigin).toBe(origin);
    expect(config.publicHost).toBe(host);
    expect(config.publicIsHttps).toBe(origin.startsWith('https:'));
  });

  it.each([
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
  ])('rejects %j and names PUBLIC_BASE_URL', (value) => {
    expect(variablesOf({ PUBLIC_BASE_URL: value })).toEqual(['PUBLIC_BASE_URL']);
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
    'localhost:8080',
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
    ['[::1]:8080', '[::1]'],
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
    ':8080',
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
  ])('refuses %j', (value) => {
    expect(normalizeHost(value)).toBeUndefined();
  });
});

describe('PREVIEW_MODE with a non-loopback host (FR-A-035, E-17, A-30)', () => {
  it('is allowed on the default loopback URL', () => {
    expect(configOf({ PREVIEW_MODE: 'true' }).previewMode).toBe(true);
  });

  it.each([
    'http://localhost:9090',
    'http://127.0.0.2:9090',
    'http://[::1]:9090',
    'http://localhost.:9090',
    'http://LOCALHOST:9090',
  ])('is allowed on %s', (url) => {
    expect(configOf({ PREVIEW_MODE: 'true', PUBLIC_BASE_URL: url }).previewMode).toBe(true);
  });

  const REMOTE_MESSAGE =
    'PREVIEW_MODE=true requires a loopback PUBLIC_BASE_URL (localhost, 127.0.0.0/8 or ::1) unless PREVIEW_MODE_ALLOW_REMOTE=true';

  it.each([
    'http://192.168.1.10:9090',
    'https://panel.example.com',
    'http://localhost.attacker.example',
    'http://127.0.0.1.nip.io',
    'http://0.0.0.0:9090',
    'http://[::2]:9090',
  ])('fails on %s unless PREVIEW_MODE_ALLOW_REMOTE=true', (url) => {
    expect(issuesOf({ PREVIEW_MODE: 'true', PUBLIC_BASE_URL: url })).toEqual([
      { variable: 'PREVIEW_MODE', message: REMOTE_MESSAGE },
    ]);
    const lifted = configOf({
      PREVIEW_MODE: 'true',
      PREVIEW_MODE_ALLOW_REMOTE: 'true',
      PUBLIC_BASE_URL: url,
    });
    expect(lifted.previewMode).toBe(true);
    expect(lifted.previewModeAllowRemote).toBe(true);
  });

  it('does not touch a remote URL when preview mode is off', () => {
    expect(
      configOf({ PREVIEW_MODE: 'false', PUBLIC_BASE_URL: 'https://panel.example.com' }).previewMode,
    ).toBe(false);
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
      PREVIEW_MODE: `${CANARY}-preview`,
      PREVIEW_MODE_ALLOW_REMOTE: `${CANARY}-remote`,
      SHOWCASE: `${CANARY}-showcase`,
      LOG_LEVEL: `${CANARY}-level`,
      HSTS_MAX_AGE: `${CANARY}-age`,
      HSTS_INCLUDE_SUBDOMAINS: `${CANARY}-include`,
      HSTS_PRELOAD: `${CANARY}-preload`,
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

  it('does not run the cross-field rules on a variable that is already invalid', () => {
    expect(variablesOf({ PREVIEW_MODE: 'true', PUBLIC_BASE_URL: 'nope' })).toEqual([
      'PUBLIC_BASE_URL',
    ]);
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
      preview: 'off',
      trustProxy: 'none',
      hsts: 'off',
      showcase: false,
    });
  });

  it('says that preview mode refuses requests for other hosts, unless the override lifts it', () => {
    expect(readPosture(configOf({ PREVIEW_MODE: 'true' })).preview).toBe('loopback-only');
    expect(
      readPosture(
        configOf({
          PREVIEW_MODE: 'true',
          PREVIEW_MODE_ALLOW_REMOTE: 'true',
          PUBLIC_BASE_URL: 'http://192.168.1.10:9090',
        }),
      ).preview,
    ).toBe('any-host');
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
        PREVIEW_MODE: 'false',
      }),
    );
    const text = JSON.stringify(posture);
    for (const forbidden of ['10.1.2.3', 'panel.example.com', 'm365-secret-dir', '/srv']) {
      expect(text).not.toContain(forbidden);
    }
  });
});

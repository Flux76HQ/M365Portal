// T-A-033: FR-A-032 (preview mode: a warning on the log and on stderr at start, the actor id
// `preview`, nothing reachable without `PREVIEW_MODE=true`), FR-A-035 (the guard at configuration
// time, tested in `config.test.ts`) and FR-A-036 (the request-level rule).
//
// FR-A-036. The default `PUBLIC_BASE_URL` (`http://localhost:<PORT>`) is loopback even when the port
// is published to a network or a proxy forwards to it, so the configured name proves nothing about
// a request. Unless `PREVIEW_MODE_ALLOW_REMOTE=true` the preview actor is for a request whose `Host`
// is loopback and that carries no `Forwarded`, `X-Forwarded-*` or `X-Real-IP` header; every other
// request is anonymous. The rule can only downgrade an actor, never upgrade one. It is not a
// security boundary (a non-browser client can forge `Host`); publishing the port on loopback only is.
//
// Negative fixtures (tasks.md section 0.3): `assertHostMatrix` is run on resolvers that are wrong in
// each way one can be wrong, among them one that ignores `Host`, and must fail on every one.
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import { isLoopbackHost, loadConfigOrThrow } from '../src/config/index.js';
import { requestHost } from '../src/http/trust-proxy.js';
import {
  ANONYMOUS_ACTOR,
  PREVIEW_ACTOR,
  announcePreviewMode,
  carriesForwardingHeader,
  createActorResolver,
  resolveActor,
  type Actor,
  type ActorConfig,
} from '../src/policy/index.js';
import { createLogCapture } from './helpers/log-capture.js';
import { createLogger } from '../src/logging/logger.js';

const OFF: ActorConfig = { previewMode: false, previewModeAllowRemote: false };
const ON: ActorConfig = { previewMode: true, previewModeAllowRemote: false };
const ON_REMOTE: ActorConfig = { previewMode: true, previewModeAllowRemote: true };
const OFF_BUT_REMOTE: ActorConfig = { previewMode: false, previewModeAllowRemote: true };

function requestWith(
  host: string | null,
  headers: Record<string, string> = {},
  path = '/api/v1/me',
): Request {
  const all = new Headers(headers);
  if (host !== null) all.set('host', host);
  return new Request(`http://localhost${path}`, { headers: all });
}

const LOOPBACK_HOSTS = [
  'localhost',
  'localhost:8080',
  'LOCALHOST:8080',
  'Localhost',
  'localhost.',
  'localhost.:9090',
  '127.0.0.1',
  '127.0.0.1:8080',
  '127.0.0.2:8080',
  '127.255.255.254',
  '127.1.2.3:4000',
  '[::1]',
  '[::1]:8080',
  '[::1]:80',
] as const;

const OTHER_HOSTS = [
  '192.168.1.10:8080',
  '192.168.1.10',
  '10.0.0.5',
  '172.16.0.1:8080',
  '8.8.8.8',
  'panel.example.com',
  'panel.example.com:8080',
  'example.com',
  'localhost.attacker.example',
  'localhost.attacker.example:8080',
  'localhost-evil.example',
  'xlocalhost',
  'notlocalhost',
  '127.0.0.1.nip.io',
  '127.0.0.1.example.com',
  'sub.localhost.example.com',
  '0.0.0.0',
  '0.0.0.0:8080',
  '[::]',
  '[::]:8080',
  '[::2]',
  '[2001:db8::1]:8080',
  '[::ffff:127.0.0.1]',
  '[::ffff:7f00:1]',
  '127.1',
  '2130706433',
  '0x7f.0.0.1',
  '0177.0.0.1',
  '128.0.0.1',
  '126.255.255.255',
  '1.127.0.0.1',
  'localhost@evil.example',
  'evil.example#localhost',
  'evil.example/localhost',
  'localhost:8080@evil.example',
  'localhost:80:80',
  'localhost%00',
  'local host',
  '',
] as const;

const FORWARDING_HEADERS: readonly (readonly [string, string])[] = [
  ['X-Forwarded-For', '203.0.113.5'],
  ['x-forwarded-for', '127.0.0.1'],
  ['X-FORWARDED-FOR', ''],
  ['X-Forwarded-Host', 'localhost'],
  ['X-Forwarded-Proto', 'http'],
  ['X-Forwarded-Port', '8080'],
  ['X-Forwarded-Prefix', '/'],
  ['X-Forwarded-Server', 'proxy'],
  ['X-Forwarded-Anything-Else', '1'],
  ['Forwarded', 'for=203.0.113.5;proto=https'],
  ['FORWARDED', ''],
  ['X-Real-IP', '203.0.113.5'],
  ['x-real-ip', '127.0.0.1'],
];

describe('resolveActor: preview mode on, a loopback Host, no forwarding header (FR-A-036)', () => {
  it.each(LOOPBACK_HOSTS)('gives the preview actor for Host: %s', (host) => {
    expect(resolveActor(ON, requestWith(host))).toBe(PREVIEW_ACTOR);
  });

  it('has the actor id "preview" (FR-A-032), which is what the audit entries name', () => {
    const actor = resolveActor(ON, requestWith('localhost:8080'));
    expect(actor.id).toBe('preview');
    expect(actor.kind).toBe('preview');
  });

  it('does not care what else the request says: only the downgrade rule can change the answer', () => {
    for (const path of [
      '/',
      '/api/v1/me',
      '/api/v1/branding?actor=anonymous',
      '/x?preview=false',
    ]) {
      expect(resolveActor(ON, requestWith('localhost:8080', {}, path))).toBe(PREVIEW_ACTOR);
    }
    const noise = {
      'x-actor': 'anonymous',
      'x-preview': 'false',
      authorization: 'Bearer anonymous',
      cookie: 'actor=anonymous; preview=off',
      origin: 'https://evil.example',
      'sec-fetch-site': 'cross-site',
      'user-agent': 'curl/8',
      accept: 'text/html',
      'content-type': 'application/json',
      'x-csrf-token': 'v1.1.2.3.4',
    };
    expect(resolveActor(ON, requestWith('localhost:8080', noise))).toBe(PREVIEW_ACTOR);
  });
});

describe('resolveActor: every other request is anonymous (FR-A-036)', () => {
  it.each(OTHER_HOSTS)('gives the anonymous actor for Host: %j', (host) => {
    expect(resolveActor(ON, requestWith(host))).toBe(ANONYMOUS_ACTOR);
  });

  it('gives the anonymous actor when there is no Host header at all', () => {
    expect(resolveActor(ON, requestWith(null))).toBe(ANONYMOUS_ACTOR);
  });

  it.each(FORWARDING_HEADERS)(
    'gives the anonymous actor for a loopback Host with %s: %j (the request came through a proxy)',
    (name, value) => {
      expect(resolveActor(ON, requestWith('localhost:8080', { [name]: value }))).toBe(
        ANONYMOUS_ACTOR,
      );
      expect(resolveActor(ON, requestWith('[::1]:8080', { [name]: value }))).toBe(ANONYMOUS_ACTOR);
    },
  );

  it('gives the anonymous actor when several forwarding headers come together', () => {
    const all = Object.fromEntries(
      FORWARDING_HEADERS.map(([name, value], i) => [`${name}-${String(i)}`, value]),
    );
    const headers = {
      'X-Forwarded-For': '1.2.3.4',
      Forwarded: 'for=1.2.3.4',
      'X-Real-IP': '1.2.3.4',
      ...all,
    };
    expect(resolveActor(ON, requestWith('localhost:8080', headers))).toBe(ANONYMOUS_ACTOR);
  });

  it('does not take a header that only resembles a forwarding header for one', () => {
    for (const name of [
      'x-forward',
      'x-forwarded',
      'forwarded-for',
      'x-real',
      'x-real-ip-x',
      'via',
      'x-original-host',
    ]) {
      expect(resolveActor(ON, requestWith('localhost:8080', { [name]: '1' })), name).toBe(
        PREVIEW_ACTOR,
      );
    }
  });
});

describe('carriesForwardingHeader', () => {
  it.each(FORWARDING_HEADERS)('is true for %s', (name, value) => {
    expect(carriesForwardingHeader(new Headers({ [name]: value }))).toBe(true);
  });

  it('is false for headers that are not forwarding headers, and for none', () => {
    expect(carriesForwardingHeader(new Headers())).toBe(false);
    expect(carriesForwardingHeader(new Headers({ host: 'localhost', accept: '*/*' }))).toBe(false);
  });
});

describe('PREVIEW_MODE_ALLOW_REMOTE=true lifts the rule (FR-A-036)', () => {
  it.each([...LOOPBACK_HOSTS, ...OTHER_HOSTS])('gives the preview actor for Host: %j', (host) => {
    expect(resolveActor(ON_REMOTE, requestWith(host))).toBe(PREVIEW_ACTOR);
  });

  it('gives the preview actor with no Host and with forwarding headers', () => {
    expect(resolveActor(ON_REMOTE, requestWith(null))).toBe(PREVIEW_ACTOR);
    for (const [name, value] of FORWARDING_HEADERS) {
      expect(resolveActor(ON_REMOTE, requestWith('panel.example.com', { [name]: value }))).toBe(
        PREVIEW_ACTOR,
      );
    }
  });
});

describe('without PREVIEW_MODE=true nothing is reachable (FR-A-032, FR-A-036: never an upgrade)', () => {
  const requests: Request[] = [
    ...[...LOOPBACK_HOSTS, ...OTHER_HOSTS].map((host) => requestWith(host)),
    requestWith(null),
    ...FORWARDING_HEADERS.map(([name, value]) => requestWith('localhost:8080', { [name]: value })),
    requestWith('localhost:8080', {
      'x-actor': 'preview',
      'x-preview': 'true',
      'x-preview-mode': '1',
      authorization: 'Bearer preview',
      cookie: 'actor=preview; preview=1',
    }),
    requestWith('localhost:8080', {}, '/api/v1/me?actor=preview&preview=true&kind=preview'),
  ];

  it.each([
    ['off', OFF],
    ['off with the remote override alone', OFF_BUT_REMOTE],
  ])('gives the anonymous actor to %s, whatever the request is', (_name, config) => {
    for (const request of requests) {
      expect(resolveActor(config, request)).toBe(ANONYMOUS_ACTOR);
    }
  });

  it('is the anonymous configuration: Host is ignored, never read as an upgrade', () => {
    expect(resolveActor(OFF, requestWith('localhost:8080'))).toBe(ANONYMOUS_ACTOR);
    expect(resolveActor(OFF, requestWith('127.0.0.1'))).toBe(ANONYMOUS_ACTOR);
  });

  it('gives an actor with no permission at all', () => {
    const actor = resolveActor(OFF, requestWith('localhost:8080'));
    expect(actor.permissions.size).toBe(0);
  });
});

describe('nothing in a request chooses or upgrades the actor (FR-A-032)', () => {
  it('returns one of the two actors, by identity, for every request in this file', () => {
    const everything: Request[] = [
      ...[...LOOPBACK_HOSTS, ...OTHER_HOSTS].map((host) => requestWith(host)),
      ...FORWARDING_HEADERS.map(([name, value]) =>
        requestWith('localhost:8080', { [name]: value }),
      ),
    ];
    for (const config of [OFF, ON, ON_REMOTE, OFF_BUT_REMOTE]) {
      for (const request of everything) {
        const actor = resolveActor(config, request);
        expect([ANONYMOUS_ACTOR, PREVIEW_ACTOR]).toContain(actor);
      }
    }
  });

  it('can only lower what the configuration would give: a request never gets more than preview mode allows', () => {
    // With the override, the configuration hands out the preview actor to everyone; with the rule it
    // hands it to loopback requests only. Every request of the second kind is also one of the first.
    const all = [...LOOPBACK_HOSTS, ...OTHER_HOSTS].map((host) => requestWith(host));
    for (const request of all) {
      const withRule = resolveActor(ON, request);
      const withOverride = resolveActor(ON_REMOTE, request);
      if (withRule === PREVIEW_ACTOR) expect(withOverride).toBe(PREVIEW_ACTOR);
    }
  });

  it('is a function of the request alone: the same request gets the same actor every time', () => {
    const request = requestWith('localhost:8080');
    expect(resolveActor(ON, request)).toBe(resolveActor(ON, request));
  });

  it('is built once from the configuration by createActorResolver', () => {
    const resolve = createActorResolver(ON);
    expect(resolve(requestWith('localhost:8080'))).toBe(PREVIEW_ACTOR);
    expect(resolve(requestWith('192.168.1.10'))).toBe(ANONYMOUS_ACTOR);
    expect(createActorResolver(OFF)(requestWith('localhost:8080'))).toBe(ANONYMOUS_ACTOR);
  });

  it('works on the real configuration object too', () => {
    const config = loadConfigOrThrow({ PREVIEW_MODE: 'true' });
    expect(resolveActor(config, requestWith('localhost:8080'))).toBe(PREVIEW_ACTOR);
    expect(resolveActor(config, requestWith('192.168.1.10:8080'))).toBe(ANONYMOUS_ACTOR);
  });
});

// ---------------------------------------------------------------------------------------------
// The warning at start (FR-A-032)
// ---------------------------------------------------------------------------------------------

function announce(config: ActorConfig): {
  stderr: string;
  lines: Record<string, unknown>[];
  raw: string;
} {
  const capture = createLogCapture();
  const log = createLogger({ level: 'info', destination: capture });
  let stderr = '';
  announcePreviewMode(config, {
    log,
    stderr: {
      write: (text: string) => {
        stderr += text;
        return true;
      },
    },
  });
  return { stderr, lines: capture.lines(), raw: capture.text() };
}

describe('announcePreviewMode: a warning on the log and on stderr at start (FR-A-032)', () => {
  it('writes one warning to the log and one to stderr when preview mode is on', () => {
    const { stderr, lines } = announce(ON);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'warn', event: 'preview_mode', mode: 'loopback-only' });
    expect(stderr.endsWith('\n')).toBe(true);
    expect(stderr.trim().split('\n')).toHaveLength(1);
  });

  it('says on both that a non-loopback Host or a forwarding header makes a request anonymous', () => {
    const { stderr, lines } = announce(ON);
    const logged = String(lines[0]?.msg);

    for (const text of [stderr, logged]) {
      expect(text).toMatch(/PREVIEW_MODE/);
      expect(text).toMatch(/loopback/i);
      expect(text).toMatch(/Forwarded/);
      expect(text).toMatch(/X-Forwarded-\*/);
      expect(text).toMatch(/X-Real-IP/);
      expect(text).toMatch(/anonymous/i);
      expect(text).toMatch(/not a security boundary/i);
      expect(text).toMatch(/127\.0\.0\.1/);
    }
  });

  it('says so with the same words on stderr as in the log, so one cannot be read without the other', () => {
    const { stderr, lines } = announce(ON);
    expect(stderr.trim()).toContain(String(lines[0]?.msg));
  });

  it('says that every request is an administrator when the override is on', () => {
    const { stderr, lines } = announce(ON_REMOTE);

    expect(lines[0]).toMatchObject({ level: 'warn', event: 'preview_mode', mode: 'any-host' });
    expect(stderr).toMatch(/PREVIEW_MODE_ALLOW_REMOTE/);
    expect(stderr).toMatch(/every request/i);
    expect(stderr).not.toMatch(/treated as anonymous/i);
  });

  it('writes nothing at all when preview mode is off, with or without the override', () => {
    for (const config of [OFF, OFF_BUT_REMOTE]) {
      const { stderr, lines, raw } = announce(config);
      expect(stderr).toBe('');
      expect(lines).toEqual([]);
      expect(raw).toBe('');
    }
  });

  it('holds no value of the configuration: no address, no port, no host name', () => {
    const { stderr, raw } = announce(loadConfigOrThrow({ PREVIEW_MODE: 'true', PORT: '12345' }));
    expect(stderr).not.toContain('12345');
    expect(raw).not.toContain('12345');
  });

  it('does not fail when stderr cannot be written', () => {
    const log = createLogger({ level: 'info', destination: createLogCapture() });
    expect(() => {
      announcePreviewMode(ON, {
        log,
        stderr: {
          write: () => {
            throw new Error('closed');
          },
        },
      });
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
// The guard, and the resolvers that must fail it
// ---------------------------------------------------------------------------------------------

type Resolver = (config: ActorConfig, request: Request) => Actor;

/** Throws unless `resolve` gives the answers FR-A-036 lists, in both directions. */
function assertHostMatrix(resolve: Resolver): void {
  const fail = (message: string): never => {
    throw new Error(message);
  };
  for (const host of ['localhost:8080', '127.0.0.2:8080', '[::1]:8080']) {
    if (resolve(ON, requestWith(host)) !== PREVIEW_ACTOR)
      fail(`a loopback Host is refused: ${host}`);
  }
  for (const host of [
    '192.168.1.10:8080',
    'panel.example.com',
    'localhost.attacker.example',
    '127.0.0.1.nip.io',
  ]) {
    if (resolve(ON, requestWith(host)) !== ANONYMOUS_ACTOR)
      fail(`a non-loopback Host is let in: ${host}`);
  }
  if (resolve(ON, requestWith(null)) !== ANONYMOUS_ACTOR) fail('a request with no Host is let in');
  for (const [name, value] of [
    ['X-Forwarded-For', '203.0.113.5'],
    ['X-Forwarded-Host', 'localhost'],
    ['X-Forwarded-Proto', 'https'],
    ['Forwarded', 'for=203.0.113.5'],
    ['X-Real-IP', '203.0.113.5'],
  ] as const) {
    if (resolve(ON, requestWith('localhost:8080', { [name]: value })) !== ANONYMOUS_ACTOR) {
      fail(`a forwarded request is let in: ${name}`);
    }
  }
  if (resolve(ON_REMOTE, requestWith('192.168.1.10:8080')) !== PREVIEW_ACTOR)
    fail('the override does not lift the rule');
  if (resolve(OFF, requestWith('localhost:8080')) !== ANONYMOUS_ACTOR)
    fail('preview is reachable with preview mode off');
  if (resolve(OFF_BUT_REMOTE, requestWith('192.168.1.10')) !== ANONYMOUS_ACTOR) {
    fail('the override alone enables preview mode');
  }
  if (resolve(OFF, requestWith('localhost:8080', { 'x-actor': 'preview' })) !== ANONYMOUS_ACTOR) {
    fail('a header selects the actor');
  }
}

describe('the Host matrix guard', () => {
  it('passes for the real resolver', () => {
    expect(() => {
      assertHostMatrix(resolveActor);
    }).not.toThrow();
  });

  it('fails for a resolver that ignores Host', () => {
    const ignoresHost: Resolver = (config) =>
      config.previewMode ? PREVIEW_ACTOR : ANONYMOUS_ACTOR;
    expectGuardFails(assertHostMatrix, ignoresHost, { reason: 'non-loopback Host is let in' });
  });

  it('fails for a resolver that ignores the forwarding headers', () => {
    const ignoresForwarding: Resolver = (config, request) =>
      config.previewMode &&
      (config.previewModeAllowRemote || isLoopbackHost(requestHost(request) ?? ''))
        ? PREVIEW_ACTOR
        : ANONYMOUS_ACTOR;
    expectGuardFails(assertHostMatrix, ignoresForwarding, {
      reason: 'forwarded request is let in',
    });
  });

  it('fails for a resolver that matches the start of the host name instead of the whole of it', () => {
    const prefix: Resolver = (config, request) =>
      config.previewMode && /^(localhost|127\.|\[::1\])/i.test(request.headers.get('host') ?? '')
        ? PREVIEW_ACTOR
        : ANONYMOUS_ACTOR;
    expectGuardFails(assertHostMatrix, prefix, { reason: 'non-loopback Host is let in' });
  });

  it('fails for a resolver that lets a header choose the actor', () => {
    const header: Resolver = (config, request) =>
      request.headers.get('x-actor') === 'preview' ||
      (config.previewMode && request.headers.get('host') === 'localhost:8080')
        ? PREVIEW_ACTOR
        : ANONYMOUS_ACTOR;
    expectGuardFails(assertHostMatrix, header, {});
  });

  it('fails for a resolver that never gives the preview actor', () => {
    expectGuardFails(assertHostMatrix, () => ANONYMOUS_ACTOR, {
      reason: 'loopback Host is refused',
    });
  });

  it('fails for a resolver that lets the override alone enable preview mode', () => {
    const overrideAlone: Resolver = (config, request) =>
      config.previewModeAllowRemote ||
      (config.previewMode && (request.headers.get('host') ?? '').startsWith('localhost'))
        ? PREVIEW_ACTOR
        : ANONYMOUS_ACTOR;
    expectGuardFails(assertHostMatrix, overrideAlone, {});
  });

  it('fails for a resolver that does not lift the rule for the override', () => {
    const neverLifts: Resolver = (config, request) =>
      config.previewMode &&
      isLoopbackHost(requestHost(request) ?? '') &&
      !carriesForwardingHeader(request.headers)
        ? PREVIEW_ACTOR
        : ANONYMOUS_ACTOR;
    expectGuardFails(assertHostMatrix, neverLifts, { reason: 'override does not lift the rule' });
  });
});

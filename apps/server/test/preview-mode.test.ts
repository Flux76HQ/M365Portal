// T-A-033, rewritten by T-B-240 (FR-B-102, FR-B-413): preview mode is gone. Phase A promised it
// (FR-A-032, FR-A-035, FR-A-036): an actor with every permission for a request on a loopback `Host`
// without a proxy header, switched on by `PREVIEW_MODE=true`. Phase B removes the variables and the
// actor; this file keeps the Phase A cases as their Phase B counterparts:
//
//   - the Host matrix and the proxy-header list: every request, whatever its `Host` and headers, is
//     anonymous, and the reusable half of the rule, `carriesForwardingHeader`, now lives in
//     `http/trust-proxy.ts` for the setup loopback guard (FR-B-206);
//   - a server started with `PREVIEW_MODE=true` (and with `PREVIEW_MODE_ALLOW_REMOTE=true`) reaches the
//     same state as one started without them: anonymous, the same answers to the same requests;
//   - a leftover variable is named once in the log and on stderr, with no value (`announceRemovedVariables`).
//
// Negative fixtures (tasks.md section 0.3): `assertNoRequestUpgrades` is run on resolvers that bring
// the old behaviour back in each way it could come back, and must fail on every one.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import { defineRoute } from '../src/http/route.js';
import { carriesForwardingHeader } from '../src/http/trust-proxy.js';
import type { AppModuleFactory } from '../src/module.js';
import { createLogger } from '../src/logging/logger.js';
import { PERMISSIONS } from '@m365portal/shared/permissions';
import type { Grant } from '@m365portal/shared/rbac/effective';
import {
  ANONYMOUS_ACTOR,
  frozenSetOf,
  type Actor,
  type ActorResolver,
} from '../src/policy/index.js';
import { startServer, announceRemovedVariables } from '../src/start.js';
import { freePort } from './helpers/built-server.js';
import { createLogCapture } from './helpers/log-capture.js';
import { createPolicyHarness } from './helpers/policy-harness.js';
import { createTempDataDir } from './helpers/temp-data-dir.js';

const GRANTS: readonly Grant[] = Object.freeze(
  PERMISSIONS.map(
    (permission) => Object.freeze({ permission, qualifier: 'full', scope: 'all' }) as Grant,
  ),
);

/** A stand-in for the removed preview actor: the negative fixtures below say what a guard must refuse. */
const LEGACY_PREVIEW_ACTOR: Actor = Object.freeze({
  kind: 'preview',
  id: 'preview',
  label: 'Preview mode',
  permissions: frozenSetOf(PERMISSIONS),
  grants: GRANTS,
  csrfBinding: '',
  credential: 'valid',
  session: null,
  setupSession: null,
  stepUpFresh: false,
}) as unknown as Actor;

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
  'localhost:9300',
  'LOCALHOST:9300',
  'Localhost',
  'localhost.',
  'localhost.:9090',
  '127.0.0.1',
  '127.0.0.1:9300',
  '127.0.0.2:9300',
  '127.255.255.254',
  '127.1.2.3:4000',
  '[::1]',
  '[::1]:9300',
  '[::1]:80',
] as const;

const OTHER_HOSTS = [
  '192.168.1.10:9300',
  '192.168.1.10',
  '10.0.0.5',
  '172.16.0.1:9300',
  '8.8.8.8',
  'panel.example.com',
  'panel.example.com:9300',
  'example.com',
  'localhost.attacker.example',
  'localhost.attacker.example:9300',
  'localhost-evil.example',
  'xlocalhost',
  'notlocalhost',
  '127.0.0.1.nip.io',
  '127.0.0.1.example.com',
  'sub.localhost.example.com',
  '0.0.0.0',
  '0.0.0.0:9300',
  '[::]',
  '[::]:9300',
  '[::2]',
  '[2001:db8::1]:9300',
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
  'localhost:9300@evil.example',
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
  ['X-Forwarded-Port', '9300'],
  ['X-Forwarded-Prefix', '/'],
  ['X-Forwarded-Server', 'proxy'],
  ['X-Forwarded-Anything-Else', '1'],
  ['Forwarded', 'for=203.0.113.5;proto=https'],
  ['FORWARDED', ''],
  ['X-Real-IP', '203.0.113.5'],
  ['x-real-ip', '127.0.0.1'],
  // The wider list of the security review: other ways a proxy or CDN says "this came from elsewhere".
  ['Via', '1.1 proxy'],
  ['CF-Connecting-IP', '203.0.113.5'],
  ['True-Client-IP', '203.0.113.5'],
  ['X-Client-IP', '203.0.113.5'],
  ['X-Envoy-External-Address', '203.0.113.5'],
  ['Fastly-Client-IP', '203.0.113.5'],
  ['X-Original-Forwarded-For', '203.0.113.5'],
  ['X-Forwarded', 'for=203.0.113.5'],
  ['x-forwarded', '1'],
];

describe('every request is anonymous, whatever its Host and headers (FR-B-102, was FR-A-036)', () => {
  it.each([...LOOPBACK_HOSTS, ...OTHER_HOSTS])('Host: %j', async (host) => {
    const harness = await createPolicyHarness();
    expect(harness.resolve(requestWith(host))).toBe(ANONYMOUS_ACTOR);
  });

  it.each(FORWARDING_HEADERS)('a loopback Host with %s', async (name, value) => {
    const harness = await createPolicyHarness();
    expect(harness.resolve(requestWith('localhost:9300', { [name]: value }))).toBe(ANONYMOUS_ACTOR);
  });

  it('gives the anonymous actor when there is no Host header at all', async () => {
    const harness = await createPolicyHarness();
    expect(harness.resolve(requestWith(null))).toBe(ANONYMOUS_ACTOR);
  });

  it('holds no permission at all', async () => {
    const harness = await createPolicyHarness();
    const actor = harness.resolve(requestWith('localhost:9300'));
    expect(actor.permissions.size).toBe(0);
    expect(actor.grants).toEqual([]);
  });

  it('is a function of the request alone: the same request gets the same actor every time', async () => {
    const harness = await createPolicyHarness();
    const request = requestWith('localhost:9300');
    expect(harness.resolve(request)).toBe(harness.resolve(request));
  });
});

describe('carriesForwardingHeader (moved to http/trust-proxy.ts for the setup loopback guard)', () => {
  it.each(FORWARDING_HEADERS)('is true for %s', (name, value) => {
    expect(carriesForwardingHeader(new Headers({ [name]: value }))).toBe(true);
  });

  it('is false for headers that are not forwarding headers, and for none', () => {
    expect(carriesForwardingHeader(new Headers())).toBe(false);
    expect(carriesForwardingHeader(new Headers({ host: 'localhost', accept: '*/*' }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// FR-B-102: the variables are gone; a leftover one is named once and changes nothing
// ---------------------------------------------------------------------------------------------

describe('announceRemovedVariables: one warning for a leftover PREVIEW_MODE* (FR-B-102)', () => {
  function removed(env: Record<string, string | undefined>): {
    stderr: string;
    lines: Record<string, unknown>[];
    raw: string;
  } {
    const capture = createLogCapture();
    const log = createLogger({ level: 'info', destination: capture });
    let stderr = '';
    announceRemovedVariables(env, {
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

  it.each([
    [{ PREVIEW_MODE: 'true' }, ['PREVIEW_MODE']],
    [{ PREVIEW_MODE: 'false' }, ['PREVIEW_MODE']],
    [{ PREVIEW_MODE_ALLOW_REMOTE: 'true' }, ['PREVIEW_MODE_ALLOW_REMOTE']],
    [
      { PREVIEW_MODE: 'true', PREVIEW_MODE_ALLOW_REMOTE: 'true' },
      ['PREVIEW_MODE', 'PREVIEW_MODE_ALLOW_REMOTE'],
    ],
    [{ PREVIEW_MODE: '' }, ['PREVIEW_MODE']],
  ])('%j: exactly one warning, preview_mode_removed, naming %j', (env, names) => {
    const { stderr, lines } = removed(env);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'warn',
      event: 'preview_mode_removed',
      msg: 'preview_mode_removed',
      variables: names,
    });
    expect(stderr.trim().split('\n')).toHaveLength(1);
    expect(stderr.startsWith('preview_mode_removed: ')).toBe(true);
    for (const name of names) expect(stderr).toContain(name);
  });

  it('says nothing when neither variable is set', () => {
    for (const env of [{}, { SHOWCASE: 'true' }, { PREVIEW: 'true' }]) {
      const { stderr, lines, raw } = removed(env);
      expect(stderr).toBe('');
      expect(lines).toEqual([]);
      expect(raw).toBe('');
    }
  });

  it('never repeats a value', () => {
    const { stderr, raw } = removed({
      PREVIEW_MODE: 'canary-7f3a',
      PREVIEW_MODE_ALLOW_REMOTE: 'canary-9b1c',
    });
    expect(stderr).not.toContain('canary');
    expect(raw).not.toContain('canary');
  });

  it('does not fail when stderr cannot be written, and the log line is kept', () => {
    const capture = createLogCapture();
    const log = createLogger({ level: 'info', destination: capture });
    expect(() => {
      announceRemovedVariables(
        { PREVIEW_MODE: 'true' },
        {
          log,
          stderr: {
            write: () => {
              throw new Error('closed');
            },
          },
        },
      );
    }).not.toThrow();
    expect(capture.lines()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// A server started with the old variables (FR-B-102)
// ---------------------------------------------------------------------------------------------

const SERVER_ROOT = fileURLToPath(new URL('../', import.meta.url));
const WEB = join(SERVER_ROOT, 'test', 'fixtures', 'web-dist');
const MIGRATIONS = join(SERVER_ROOT, 'drizzle');

/** A module with one permissioned write and one permissioned read, to ask a started server about. */
const probeModule: AppModuleFactory = () => ({
  id: 'probe',
  routes: () => [
    defineRoute({
      id: 'probe.write',
      method: 'POST',
      path: '/api/v1/probe/write',
      access: { permission: 'settings:branding' },
      rateLimit: 'write',
      responses: { 200: { description: 'ok' } },
      handler: (c) => c.json({ ok: true }, 200),
    }),
    defineRoute({
      id: 'probe.read',
      method: 'GET',
      path: '/api/v1/probe/read',
      access: { permission: 'audit:read' },
      rateLimit: 'read',
      responses: { 200: { description: 'ok' } },
      handler: (c) => c.json({ ok: true }, 200),
    }),
  ],
});

interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

describe('a server started with PREVIEW_MODE=true is the same as one started without it (FR-B-102)', () => {
  async function answers(env: Record<string, string>): Promise<{
    me: Answer;
    write: Answer;
    secret: Answer;
    logs: ReturnType<typeof createLogCapture>;
  }> {
    const dataDir = (await createTempDataDir()).path;
    const port = await freePort();
    const logs = createLogCapture();
    const running = await startServer({
      env: {
        PORT: String(port),
        HOST: '127.0.0.1',
        DATA_DIR: dataDir,
        PUBLIC_BASE_URL: `http://localhost:${String(port)}`,
        ...env,
      },
      stderr: createLogCapture(),
      logDestination: logs,
      modules: [probeModule],
      paths: { webRoot: WEB, migrationsFolder: MIGRATIONS },
      umask: () => undefined,
    });
    try {
      const base = `http://localhost:${String(port)}`;
      const read = async (path: string, init?: RequestInit): Promise<Answer> => {
        const response = await fetch(`${base}${path}`, init);
        const body = (await response.json()) as Record<string, unknown>;
        return { status: response.status, body };
      };
      const csrf = (await (await fetch(`${base}/api/v1/csrf`)).json()) as { token: string };
      // The request id and the port (the server picks a free one) differ between two starts.
      const stable = (answer: Answer): Answer => ({
        status: answer.status,
        body: { ...answer.body, requestId: '-', publicOrigin: '-', expectedOrigin: '-' },
      });
      return {
        me: stable(await read('/api/v1/me')),
        write: stable(
          await read('/api/v1/probe/write', {
            method: 'POST',
            headers: {
              origin: base,
              'x-csrf-token': csrf.token,
              'content-type': 'application/json',
            },
            body: '{}',
          }),
        ),
        secret: stable(await read('/api/v1/probe/read')),
        logs,
      };
    } finally {
      await running.stop();
    }
  }

  it.each([
    ['PREVIEW_MODE=true', { PREVIEW_MODE: 'true' }],
    [
      'PREVIEW_MODE=true and PREVIEW_MODE_ALLOW_REMOTE=true',
      { PREVIEW_MODE: 'true', PREVIEW_MODE_ALLOW_REMOTE: 'true' },
    ],
  ])('%s: the same answers as without, and no preview anywhere', async (_name, env) => {
    const without = await answers({});
    const withVariables = await answers(env);
    expect(withVariables.me).toEqual(without.me);
    expect(withVariables.write).toEqual(without.write);
    expect(withVariables.secret).toEqual(without.secret);
    expect(withVariables.me.body).toMatchObject({ actor: { kind: 'anonymous' }, permissions: [] });
    expect(withVariables.me.body.features).toEqual({ showcase: false, breakGlass: false });
    expect(JSON.stringify(withVariables.me.body)).not.toContain('preview');
    expect(withVariables.write.status).toBeGreaterThanOrEqual(401);
    expect(withVariables.write.status).toBeLessThanOrEqual(403);
  });

  it('logs preview_mode_removed once, naming the variable and no value', async () => {
    const { logs } = await answers({
      PREVIEW_MODE: 'true',
      PREVIEW_MODE_ALLOW_REMOTE: 'canary-5c1e',
    });
    const lines = logs.lines().filter((line) => line.event === 'preview_mode_removed');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.variables).toEqual(['PREVIEW_MODE', 'PREVIEW_MODE_ALLOW_REMOTE']);
    expect(logs.text()).not.toContain('canary-5c1e');
  });

  it('writes no preview_mode_removed when the variables are absent', async () => {
    const { logs } = await answers({});
    expect(logs.lines().some((line) => line.event === 'preview_mode_removed')).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// The guard, and the resolvers that must fail it
// ---------------------------------------------------------------------------------------------

/** Throws unless the resolver gives the anonymous actor to every request of the old matrix. */
function assertNoRequestUpgrades(resolve: ActorResolver): void {
  const fail = (message: string): never => {
    throw new Error(message);
  };
  for (const host of [...LOOPBACK_HOSTS, ...OTHER_HOSTS]) {
    const actor: Actor = resolve(requestWith(host));
    if (actor.permissions.size > 0 || actor.kind !== 'anonymous') {
      fail(`Host ${JSON.stringify(host)} was given an actor with permissions`);
    }
  }
  for (const [name, value] of FORWARDING_HEADERS) {
    if (resolve(requestWith('localhost:9300', { [name]: value })).kind !== 'anonymous') {
      fail(`the header ${name} changed the actor`);
    }
  }
  if (
    resolve(requestWith('localhost:9300', { 'x-actor': 'preview', authorization: 'Bearer x' }))
      .kind !== 'anonymous'
  ) {
    fail('a header chose the actor');
  }
}

describe('the matrix guard', () => {
  it('passes for the real resolver', async () => {
    const harness = await createPolicyHarness();
    expect(() => {
      assertNoRequestUpgrades(harness.resolve);
    }).not.toThrow();
  });

  it('fails for a resolver that brings preview mode back for a loopback Host', () => {
    const loopbackIsRoot: ActorResolver = (request) =>
      (request.headers.get('host') ?? '').startsWith('localhost')
        ? LEGACY_PREVIEW_ACTOR
        : ANONYMOUS_ACTOR;
    expectGuardFails(assertNoRequestUpgrades, loopbackIsRoot, { reason: 'was given an actor' });
  });

  it('fails for a resolver that brings it back for every Host', () => {
    expectGuardFails(assertNoRequestUpgrades, () => LEGACY_PREVIEW_ACTOR, {
      reason: 'was given an actor',
    });
  });

  it('fails for a resolver that lets a header choose the actor', () => {
    const headerChooses: ActorResolver = (request) =>
      request.headers.has('x-actor') ? LEGACY_PREVIEW_ACTOR : ANONYMOUS_ACTOR;
    expectGuardFails(assertNoRequestUpgrades, headerChooses, {
      reason: 'a header chose the actor',
    });
  });

  it('fails for a resolver that lets a forwarding header change the actor', () => {
    const proxyIsRoot: ActorResolver = (request) =>
      carriesForwardingHeader(request.headers) ? LEGACY_PREVIEW_ACTOR : ANONYMOUS_ACTOR;
    expectGuardFails(assertNoRequestUpgrades, proxyIsRoot, { reason: 'changed the actor' });
  });
});

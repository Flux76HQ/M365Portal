// T-B-192: FR-B-521, EB-25, SC-B-010, OV-17 prerequisite, CD-08, CD-11 (+ negative). Break-glass: the hash
// verification (scrypt with the memory limit set from the parsed parameters, `timingSafeEqual`, the
// same work for an unknown username), the one-slot queue, the lock after 5 failures per client in 15
// minutes or 20 in an hour, the audit of failures inside the bound, and the route with its gate.
// Every password is generated for the run; the username and the password never reach a log or an audit row.
import { EventEmitter } from 'node:events';
import { scrypt as nodeScrypt } from 'node:crypto';
import { formatScryptHash, parseScryptHash } from '@m365portal/shared/auth/scrypt-hash';
import { LIMITS } from '@m365portal/shared/limits';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import {
  createBoundedQueue,
  createBreakGlassVerifier,
  passwordBytes,
  type ScryptFunction,
} from '../../src/auth/password-hash.js';
import { runCommand } from '../../src/cli.js';
import { loadConfig } from '../../src/config/index.js';
import { readJson } from '../helpers/http-client.js';
import { startSignInScene, type SignInScene } from './support/signin-scene.js';

const MINUTE = 60_000;
const USERNAME = 'bg-operator-canary-7f3a';
const PASSWORD = 'correct horse battery staple 4242';
const SALT = Buffer.from('0123456789abcdef');

/** A hash of the floor parameters (N = 16,384): fast enough to use in many tests. */
function quickHash(password = PASSWORD, n = 16_384, r = 8, p = 1): Promise<string> {
  return new Promise((resolve, reject) => {
    nodeScrypt(
      Buffer.from(password, 'utf8'),
      SALT,
      32,
      { N: n, r, p, maxmem: 2 * 128 * n * r + 128 * r * p + (1 << 20) },
      (error, derived) => {
        if (error !== null) reject(error);
        else resolve(formatScryptHash({ n, r, p, salt: SALT, hash: new Uint8Array(derived) }));
      },
    );
  });
}

const envFor = (hash: string): Record<string, string> => ({
  BREAK_GLASS_USERNAME: USERNAME,
  BREAK_GLASS_PASSWORD_HASH: hash,
});

describe('the verification', () => {
  it('accepts the right pair and refuses a wrong password, a wrong username and both wrong', async () => {
    const verifier = createBreakGlassVerifier({
      username: USERNAME,
      passwordHash: await quickHash(),
    });
    expect(await verifier.verify(USERNAME, PASSWORD)).toBe(true);
    expect(await verifier.verify(USERNAME, `${PASSWORD}x`)).toBe(false);
    expect(await verifier.verify('someone-else', PASSWORD)).toBe(false);
    expect(await verifier.verify('someone-else', 'nope')).toBe(false);
    expect(await verifier.verify(USERNAME.toUpperCase(), PASSWORD)).toBe(false);
  });

  it('does the same work for an unknown username: one scrypt of the configured parameters', async () => {
    const calls: {
      saltLength: number;
      keylen: number;
      n: number;
      r: number;
      p: number;
      maxmem: number;
    }[] = [];
    const spy: ScryptFunction = (password, salt, keylen, options, callback) => {
      calls.push({
        saltLength: salt.length,
        keylen,
        n: options.N,
        r: options.r,
        p: options.p,
        maxmem: options.maxmem,
      });
      nodeScrypt(password, salt, keylen, options, callback);
    };
    const verifier = createBreakGlassVerifier({
      username: USERNAME,
      passwordHash: await quickHash(),
      scrypt: spy,
    });
    await verifier.verify(USERNAME, PASSWORD);
    await verifier.verify('unknown-user', PASSWORD);
    await verifier.verify('unknown-user', 'x');
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((call) => JSON.stringify(call))).size).toBe(1);
  });

  it('sets the memory limit from the parsed parameters, at most 128 MiB plus the buffers of scrypt', async () => {
    const seen: number[] = [];
    const spy: ScryptFunction = (password, salt, keylen, options, callback) => {
      seen.push(options.maxmem);
      nodeScrypt(password, salt, keylen, options, callback);
    };
    for (const [n, r, p] of [
      [16_384, 8, 1],
      [32_768, 16, 2],
      [131_072, 8, 1],
    ] as const) {
      const verifier = createBreakGlassVerifier({
        username: USERNAME,
        passwordHash: await quickHash(PASSWORD, n, r, p),
        scrypt: spy,
      });
      expect(await verifier.verify(USERNAME, PASSWORD)).toBe(true);
    }
    // 128 * r * (N + p + 2): the two buffers scrypt needs, from the parsed parameters.
    expect(seen).toEqual([
      128 * 8 * (16_384 + 1 + 2),
      128 * 16 * (32_768 + 2 + 2),
      128 * 8 * (131_072 + 1 + 2),
    ]);
    expect(Math.max(...seen)).toBeLessThanOrEqual(LIMITS.breakGlass.scrypt.maxMemoryBytes + 4096);
    // Six scrypt runs, three of them at 16 to 128 MiB: seconds of CPU, more when the suite runs in parallel.
  }, 90_000);

  it('refuses a hash below the floors or above the memory limit at creation', () => {
    expect(() =>
      createBreakGlassVerifier({
        username: USERNAME,
        passwordHash:
          'scrypt:8192:8:1:AAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      }),
    ).toThrow();
    expect(() =>
      createBreakGlassVerifier({ username: USERNAME, passwordHash: 'not a hash' }),
    ).toThrow();
  });

  it('hashes the password like the hash-password command: UTF-8 bytes minus one trailing newline', async () => {
    const stdin = new EventEmitter() as EventEmitter & {
      isTTY: boolean;
      resume(): void;
      pause(): void;
    };
    stdin.isTTY = false;
    stdin.resume = () => undefined;
    stdin.pause = () => undefined;
    let out = '';
    const password = 'pässwörd-Ünicode-1234 ✓';
    const running = runCommand(['hash-password'], {
      env: {},
      stdout: { write: (text: string) => (out += text) },
      stderr: { write: () => undefined },
      stdin,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    stdin.emit('data', Buffer.from(`${password}\n`));
    stdin.emit('end');
    expect(await running).toBe(0);
    const line = out.trim();
    expect(parseScryptHash(line).ok).toBe(true);
    const verifier = createBreakGlassVerifier({ username: USERNAME, passwordHash: line });
    expect(await verifier.verify(USERNAME, password)).toBe(true);
    // A submitted password with one trailing newline is the same password, as the command reads it.
    expect(await verifier.verify(USERNAME, `${password}\n`)).toBe(true);
    expect(await verifier.verify(USERNAME, `${password}\r\n`)).toBe(true);
    expect(await verifier.verify(USERNAME, `${password}\n\n`)).toBe(false);
    expect(passwordBytes(`${password}\n`).equals(Buffer.from(password, 'utf8'))).toBe(true);
  }, 60_000);

  it('uses a bounded amount of memory: the peak stays within 128 MiB plus the process baseline noise', async () => {
    const verifier = createBreakGlassVerifier({
      username: USERNAME,
      passwordHash: await quickHash(PASSWORD, 131_072, 8, 1),
    });
    global.gc?.();
    const baseline = process.memoryUsage().rss;
    let peak = baseline;
    const timer = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 2);
    try {
      expect(await verifier.verify(USERNAME, PASSWORD)).toBe(true);
    } finally {
      clearInterval(timer);
    }
    expect(peak - baseline).toBeLessThanOrEqual(
      LIMITS.breakGlass.scrypt.maxMemoryBytes + 32 * 1024 * 1024,
    );
  }, 60_000);
});

describe('the one-slot queue', () => {
  it('runs one at a time, queues two, refuses the fourth', async () => {
    const queue = createBoundedQueue({ running: 1, waiting: 2 });
    const order: string[] = [];
    const gates = [0, 1, 2].map(() => {
      let resolve: () => void = () => undefined;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    });
    const tasks = gates.map((gate, index) =>
      queue.run(async () => {
        order.push(`start ${String(index)}`);
        await gate.promise;
        order.push(`end ${String(index)}`);
      }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(order).toEqual(['start 0']);
    const refused = await queue
      .run(() => Promise.resolve())
      .then(
        () => 'ran',
        () => 'refused',
      );
    expect(refused).toBe('refused');
    for (const gate of gates) gate.resolve();
    await Promise.all(tasks);
    expect(order).toEqual(['start 0', 'end 0', 'start 1', 'end 1', 'start 2', 'end 2']);
    // Free again afterwards.
    await expect(queue.run(() => Promise.resolve('again'))).resolves.toBe('again');
  });
});

describe('POST /api/v1/auth/break-glass', () => {
  async function scene(
    options: { env?: Record<string, string>; hash?: string } = {},
  ): Promise<SignInScene> {
    return await startSignInScene({
      env: { TRUST_PROXY: '1', ...envFor(options.hash ?? (await quickHash())), ...options.env },
    });
  }
  const attempt = async (
    server: SignInScene,
    body: unknown,
    forwardedFor = '198.51.100.1',
  ): Promise<Response> =>
    await server
      .client({ 'x-forwarded-for': forwardedFor })
      .post('/api/v1/auth/break-glass', { json: body });
  const code = async (response: Response): Promise<string> =>
    (await readJson<{ code: string }>(response)).code;

  it('success: 200 with the settings redirect and a session of kind break_glass', async () => {
    const server = await scene();
    const response = await attempt(server, { username: USERNAME, password: PASSWORD });
    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ redirect: '/settings/restore-access' });
    const cookie = response.headers.getSetCookie().join('\n');
    expect(cookie).toMatch(/^m365portal_session=[A-Za-z0-9_-]{43};/);
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).not.toMatch(/Max-Age|Expires/i);
    const rows = server.query<{ kind: string; oid: string; mfa: number; tid: string }>(
      'SELECT kind, oid, mfa, tid FROM session',
    );
    expect(rows).toEqual([{ kind: 'break_glass', oid: '', mfa: 0, tid: server.world.tenantId }]);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('is loud and clean: a warn line without the username, an audit entry without it either', async () => {
    const server = await scene();
    await attempt(server, { username: USERNAME, password: PASSWORD });
    await attempt(server, { username: USERNAME, password: 'wrong-password-value' });
    const warn = server.logs.lines().filter((line) => line.event === 'break_glass_signin');
    expect(warn).toHaveLength(1);
    expect(warn[0]?.level).toBe('warn');
    const everything = `${server.logs.text()}\n${JSON.stringify(server.auditRows())}`;
    expect(everything).not.toContain(USERNAME);
    expect(everything).not.toContain(PASSWORD);
    expect(everything).not.toContain('wrong-password-value');
    const rows = server.auditRows().filter((row) => row.action === 'breakglass.signin');
    expect(rows.map((row) => [row.actor_kind, row.outcome])).toEqual([
      ['break_glass', 'success'],
      ['anonymous', 'denied'],
    ]);
    expect(JSON.parse(rows[1]?.detail ?? '{}')).toEqual({ reason: 'invalid_credentials' });
  });

  it('a wrong password and an unknown username are indistinguishable: 401 unauthenticated', async () => {
    const server = await scene();
    const wrongPassword = await attempt(server, {
      username: USERNAME,
      password: 'not-the-password',
    });
    const unknownUser = await attempt(server, { username: 'nobody', password: PASSWORD });
    for (const response of [wrongPassword, unknownUser]) {
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe('Cookie realm="m365portal"');
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(await code(response.clone())).toBe('unauthenticated');
    }
    const strip = async (response: Response): Promise<unknown> => {
      const body = await readJson<Record<string, unknown>>(response);
      return Object.fromEntries(Object.entries(body).filter(([name]) => name !== 'requestId'));
    };
    expect(await strip(wrongPassword)).toEqual(await strip(unknownUser));
    expect(server.sessionCount()).toBe(0);
  });

  it('5 failures per client in 15 minutes lock the route: 429 with an integer Retry-After, not audited', async () => {
    const server = await scene();
    for (let index = 0; index < 5; index += 1) {
      const response = await attempt(server, {
        username: USERNAME,
        password: `wrong-${String(index)}`,
      });
      expect(response.status).toBe(401);
    }
    expect(server.auditRows().filter((row) => row.action === 'breakglass.signin')).toHaveLength(5);
    // Even the right password is refused while locked.
    const locked = await attempt(server, { username: USERNAME, password: PASSWORD });
    expect(locked.status).toBe(429);
    expect(await code(locked)).toBe('break_glass_locked');
    expect(locked.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(Number(locked.headers.get('retry-after'))).toBeLessThanOrEqual(15 * 60);
    expect(server.auditRows().filter((row) => row.action === 'breakglass.signin')).toHaveLength(5);
    expect(server.sessionCount()).toBe(0);
    // Another client is not locked by this one.
    const other = await attempt(server, { username: USERNAME, password: PASSWORD }, '198.51.100.2');
    expect(other.status).toBe(200);
  });

  it('the lock ends when the oldest failure leaves the 15-minute window', async () => {
    const server = await scene();
    for (let index = 0; index < 5; index += 1) {
      server.advance(30_000);
      await attempt(server, { username: USERNAME, password: `wrong-${String(index)}` });
    }
    const locked = await attempt(server, { username: USERNAME, password: PASSWORD });
    expect(locked.status).toBe(429);
    const wait = Number(locked.headers.get('retry-after'));
    // The failures are at 30, 60, ..., 150 s; at 150 s the first is 120 s old and leaves the window
    // in 15 minutes minus 120 s.
    expect(wait).toBe(15 * 60 - 120);
    server.advance((wait - 1) * 1000);
    expect((await attempt(server, { username: USERNAME, password: PASSWORD })).status).toBe(429);
    server.advance(2_000);
    expect((await attempt(server, { username: USERNAME, password: PASSWORD })).status).toBe(200);
  });

  it('20 failures in an hour lock the route for every client', async () => {
    const server = await scene();
    for (let index = 0; index < 20; index += 1) {
      const response = await attempt(
        server,
        { username: USERNAME, password: `wrong-${String(index)}` },
        `198.51.100.${String(10 + index)}`,
      );
      expect(response.status).toBe(401);
    }
    const locked = await attempt(
      server,
      { username: USERNAME, password: PASSWORD },
      '203.0.113.99',
    );
    expect(locked.status).toBe(429);
    expect(await code(locked)).toBe('break_glass_locked');
    expect(Number(locked.headers.get('retry-after'))).toBeLessThanOrEqual(60 * 60);
    server.advance(60 * MINUTE + 1_000);
    expect(
      (await attempt(server, { username: USERNAME, password: PASSWORD }, '203.0.113.99')).status,
    ).toBe(200);
  });

  it('a full queue (1 running, 2 waiting) answers 429 break_glass_locked', async () => {
    const server = await scene({ hash: await quickHash(PASSWORD, 131_072, 8, 1) });
    const responses = await Promise.all(
      Array.from({ length: 5 }, (_value, index) =>
        attempt(
          server,
          { username: USERNAME, password: 'wrong-password-value' },
          `198.51.100.${String(100 + index)}`,
        ),
      ),
    );
    const statuses = responses.map((response) => response.status).sort();
    expect(statuses.filter((status) => status === 429).length).toBeGreaterThanOrEqual(1);
    expect(statuses.filter((status) => status === 401).length).toBeGreaterThanOrEqual(3);
    for (const response of responses.filter((candidate) => candidate.status === 429)) {
      expect(response.headers.get('retry-after')).toMatch(/^\d+$/);
      expect(await code(response)).toBe('break_glass_locked');
    }
  }, 60_000);

  it('answers the standard 404 when it is not configured, and the variables come in a pair', async () => {
    const server = await startSignInScene();
    const response = await server.client().post('/api/v1/auth/break-glass', {
      json: { username: USERNAME, password: PASSWORD },
    });
    expect(response.status).toBe(404);
    expect(await code(response)).toBe('not_found');
    for (const half of [
      { BREAK_GLASS_USERNAME: USERNAME },
      { BREAK_GLASS_PASSWORD_HASH: await quickHash() },
    ]) {
      expect(loadConfig({ PUBLIC_BASE_URL: 'http://localhost:9300', ...half }).ok).toBe(false);
    }
    const me = await readJson<{ features: { breakGlass: boolean } }>(
      await server.client().get('/api/v1/me'),
    );
    expect(me.features.breakGlass).toBe(false);
  });

  it('needs a pinned tenant: 409 setup_required before', async () => {
    const server = await startSignInScene({
      state: 'in_progress',
      pinned: false,
      env: envFor(await quickHash()),
    });
    const response = await server.client().post('/api/v1/auth/break-glass', {
      json: { username: USERNAME, password: PASSWORD },
    });
    expect(response.status).toBe(409);
    expect(await code(response)).toBe('setup_required');
  });

  it('needs Origin and an anonymous CSRF token, takes 4,096 bytes at most and a strict body', async () => {
    const server = await scene();
    const client = server.client({ 'x-forwarded-for': '198.51.100.7' });
    const body = { username: USERNAME, password: PASSWORD };
    expect(
      (await client.post('/api/v1/auth/break-glass', { json: body, origin: null })).status,
    ).toBe(403);
    const noCsrf = await client.post('/api/v1/auth/break-glass', { json: body, csrf: 'none' });
    expect(noCsrf.status).toBe(403);
    expect(await code(noCsrf)).toBe('csrf_invalid');
    expect(
      (await client.post('/api/v1/auth/break-glass', { json: { ...body, extra: 1 } })).status,
    ).toBe(422);
    expect(
      (await client.post('/api/v1/auth/break-glass', { json: { username: '', password: 'x' } }))
        .status,
    ).toBe(422);
    expect(
      (
        await client.post('/api/v1/auth/break-glass', {
          json: { username: 'u', password: 'p'.repeat(5_000) },
        })
      ).status,
    ).toBe(413);
    expect(server.sessionCount()).toBe(0);
    expect(server.auditRows().filter((row) => row.action === 'breakglass.signin')).toEqual([]);
  });
});

describe('negative control', () => {
  it('a verifier that skips the work for an unknown username fails the same-work rule', async () => {
    const hash = await quickHash();
    async function assertSameWork(
      make: (spy: ScryptFunction) => { verify(u: string, p: string): Promise<boolean> },
    ): Promise<void> {
      let calls = 0;
      const spy: ScryptFunction = (password, salt, keylen, options, callback) => {
        calls += 1;
        nodeScrypt(password, salt, keylen, options, callback);
      };
      const verifier = make(spy);
      await verifier.verify('unknown-user', PASSWORD);
      if (calls !== 1) throw new Error('no work was done for an unknown username');
    }
    await assertSameWork((spy) =>
      createBreakGlassVerifier({ username: USERNAME, passwordHash: hash, scrypt: spy }),
    );
    const shortcut = (spy: ScryptFunction): { verify(u: string, p: string): Promise<boolean> } => {
      const inner = createBreakGlassVerifier({
        username: USERNAME,
        passwordHash: hash,
        scrypt: spy,
      });
      return { verify: async (u, p) => (u === USERNAME ? await inner.verify(u, p) : false) };
    };
    await expectGuardFails(assertSameWork, shortcut, {
      name: 'same work',
      reason: 'no work was done',
    });
  });
});

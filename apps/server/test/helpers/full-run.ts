// One full life of the panel on the real server, for the two regression controls that need to look at
// everything a run produced: `no-leak.test.ts` (canaries) and `logging-events.test.ts` (log events).
// T-B-390, FR-B-715, FR-B-107, FR-B-203, FR-B-215, FR-B-418, SC-B-013.
//
//   1. the server starts with a known `APP_KEY`, the break-glass variables and the setup token file
//   2. five wrong setup tokens lock the client (the lock event); the clock passes the lock
//   3. unlock, environment, the three steps of the wizard against the fake tenant, finish
//   4. the designated Owner signs in through the scripted browser (the setup completes), a second
//      person without a role is turned away, the break-glass account fails once and then signs in
//   5. a reader's account is disabled and their sessions end (session_revoked); Graph fails for the
//      Owner's refresh (membership_refresh_failed)
//   6. the application key is rotated with the CLI
//   7. the server stops and starts again over the same data with `SETUP_TOKEN` set after completion
//      (setup_token_after_complete), and once more with the retired preview variable
//
// Every value that must stay secret is a canary the run knows: it is generated here, or read from the
// place it is born (the setup token file, the certificate factory, the fake Microsoft's answers). The
// run returns what was produced; the tests decide what may appear where. Test support: nothing under
// `src/` imports it. The caller fakes the timers (`useWizardTimers`).
import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { appendFileSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { cookieNames } from '@m365portal/shared/auth/cookies';
import { vi } from 'vitest';
import { runRotateAppKey } from '../../src/cli/commands/rotate-app-key.js';
import { lazyCertificateFactory } from '../../src/secrets/certificate-factory.js';
import { FakeBrowser } from '../auth/support/fake-browser.js';
import { assign } from './rbac-db.js';
import { fake } from '../support/msw.js';
import { startWizardServer, type WizardServer } from '../setup/support/server-scene.js';
import { createHttpClient, type HttpClient } from './http-client.js';
import { createLogCapture } from './log-capture.js';

/** One response, as a browser or a script would have received it. */
export interface Exchange {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly requestBody: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: string;
}

/** A value that must not appear, in every spelling the run could have produced. */
export interface AuditRow {
  readonly seq: number;
  readonly actor_kind: string;
  readonly actor_id: string;
  readonly action: string;
  readonly target_type: string | null;
  readonly outcome: string;
  readonly reason_code: string | null;
  readonly detail: string;
}

export interface Canary {
  readonly name: string;
  readonly values: readonly string[];
  /** Born in a response by design: the `Set-Cookie` header that issues a session id. */
  readonly allowedInSetCookie?: boolean;
  /** Born in a redirect by design: the `Location` of `/auth/login` carries `state` and the challenge. */
  readonly allowedInLoginLocation?: boolean;
}

export interface FullRun {
  readonly server: WizardServer;
  readonly exchanges: readonly Exchange[];
  readonly canaries: readonly Canary[];
  /** The log lines of every server process of the run, as written. */
  readonly logText: string;
  /** Every audit row, as JSON text. */
  readonly auditText: string;
  readonly dataDir: string;
  /** Every audit row at the end of the run, including the rotation written by the CLI. */
  readonly auditRows: readonly AuditRow[];
  /** Every file of the data directory at the end of the run (it is removed with the test). */
  readonly files: readonly { readonly path: string; readonly text: string }[];
  /** What the rotation printed on standard output and error. */
  readonly commandOutput: string;
  readonly facts: {
    readonly completed: boolean;
    readonly ownerSignedIn: boolean;
    readonly breakGlassSignedIn: boolean;
    readonly noRoleTurnedAway: boolean;
    readonly rows: number;
    readonly previewLines: number;
    readonly rotated: boolean;
  };
  readonly oid: string;
  readonly upn: string;
  readonly displayName: string;
  readonly tenantId: string;
}

const BREAK_GLASS_USERNAME = 'canary-operator';

function trace(step: string): void {
  if (process.env.FULLRUN_TRACE !== undefined)
    appendFileSync(process.env.FULLRUN_TRACE, `${new Date().toISOString()} ${step}\n`);
}

/** Every spelling a key or token can reach a log in: as given, base64url, hex, and the raw bytes. */
export function spellings(value: string | Uint8Array): string[] {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
  const forms = new Set<string>([
    bytes.toString('base64'),
    bytes.toString('base64url'),
    bytes.toString('hex'),
  ]);
  if (typeof value === 'string') forms.add(value);
  return [...forms].filter((form) => form.length >= 16);
}

/** Slices of key bytes, in base64 and hex, so that a partial copy is found too. */
function sliceForms(bytes: Uint8Array): string[] {
  const buffer = Buffer.from(bytes);
  const forms: string[] = [];
  for (const [from, to] of [
    [64, 88],
    [160, 184],
    [300, 324],
  ] as const) {
    if (buffer.length >= to) {
      const part = buffer.subarray(from, to);
      forms.push(part.toString('hex'), part.toString('base64').replace(/=+$/, ''));
    }
  }
  return forms;
}

function walk(directory: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files;
}

/** Every file below the directory as latin1 text, so that binary content can be searched too. */
export function dataFiles(directory: string): { path: string; text: string }[] {
  return walk(directory).map((path) => ({ path, text: readFileSync(path, 'latin1') }));
}

/** Harvests the secrets in the answers of the fake Microsoft: tokens, assertions, device codes. */
function harvestMicrosoft(target: Set<string>): () => void {
  const original = fake.fetch.bind(fake);
  const patched = async (request: Request): Promise<Response> => {
    const response = await original(request);
    try {
      const text = await response.clone().text();
      const found = JSON.parse(text) as Record<string, unknown>;
      for (const key of ['access_token', 'id_token', 'refresh_token', 'device_code']) {
        const value = found[key];
        if (typeof value === 'string' && value.length >= 16) target.add(value);
      }
    } catch {
      // Not JSON (a redirect, a key set): nothing to harvest.
    }
    return response;
  };
  (fake as { fetch: typeof fake.fetch }).fetch = patched;
  return () => {
    (fake as { fetch: typeof fake.fetch }).fetch = original;
  };
}

/**
 * Lets the fake time pass while a request is in flight: a Graph retry waits on the server's scheduler,
 * and nothing in a test sleeps. One second at a time, at most `maxSeconds`.
 */
async function pumped<T>(server: WizardServer, work: Promise<T>, maxSeconds = 60): Promise<T> {
  let finished = false;
  const isDone = (): boolean => finished;
  const tracked = work.finally(() => {
    finished = true;
  });
  for (let seconds = 0; !isDone() && seconds < maxSeconds;) {
    for (let round = 0; round < 6 && !isDone(); round += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (!isDone()) {
      await server.advance(1000);
      seconds += 1;
    }
  }
  return await tracked;
}

function scryptLine(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, { N: 16_384, r: 8, p: 1 });
  return `scrypt:16384:8:1:${salt.toString('base64url')}:${hash.toString('base64url')}`;
}

function recorder(
  server: WizardServer,
  exchanges: Exchange[],
): (headers?: Record<string, string>) => HttpClient {
  return (headers = {}) =>
    createHttpClient({
      fetch: async (request) => {
        const requestBody = request.method === 'GET' ? '' : await request.clone().text();
        const response = await fetch(request);
        const copy = response.clone();
        exchanges.push({
          method: request.method,
          path: new URL(request.url).pathname + new URL(request.url).search,
          status: response.status,
          requestBody,
          headers: [...response.headers.entries()],
          body: await copy.text(),
        });
        return response;
      },
      baseUrl: server.socket,
      origin: server.origin,
      headers,
    });
}

function sessionIdIn(setCookie: readonly string[], name: string): string | undefined {
  for (const line of setCookie) {
    const match = new RegExp(`^${name}=([^;]+)`).exec(line);
    if (match?.[1] !== undefined && match[1] !== '') return match[1];
  }
  return undefined;
}

export async function runFullLifecycle(): Promise<FullRun> {
  const exchanges: Exchange[] = [];
  const logs: string[] = [];
  const microsoftSecrets = new Set<string>();
  const stopHarvest = harvestMicrosoft(microsoftSecrets);

  // The key of the certificate is born in the factory: keep a copy of its bytes for the scan.
  const pkcs8: Buffer[] = [];
  const generate = lazyCertificateFactory.generate.bind(lazyCertificateFactory);
  const spy = vi.spyOn(lazyCertificateFactory, 'generate').mockImplementation(async (request) => {
    const result = await generate(request);
    pkcs8.push(Buffer.from(result.pkcs8Der));
    return result;
  });

  const appKey = randomBytes(32);
  const nextKey = randomBytes(32);
  const breakGlassPassword = `Canary-${randomBytes(12).toString('base64url')}-pw`;
  const wrongBreakGlassPassword = `Wrong-${randomBytes(12).toString('base64url')}-pw`;
  const wrongSetupToken = `WRONG-${randomBytes(18).toString('base64url')}`;

  try {
    const server = await startWizardServer({
      keepRunningAfterTest: true,
      env: {
        APP_KEY: appKey.toString('base64'),
        BREAK_GLASS_USERNAME,
        // Sign-in routes have small buckets per client; each person below is their own client.
        TRUST_PROXY: '1',
        BREAK_GLASS_PASSWORD_HASH: scryptLine(breakGlassPassword),
      },
    });
    const dataDir = server.dataDir;
    const client = recorder(server, exchanges);
    const anonymous = client();
    const from = (address: string, headers: Record<string, string> = {}): HttpClient =>
      client({ 'x-forwarded-for': address, ...headers });
    const browserAt = (address: string): FakeBrowser =>
      new FakeBrowser({
        origin: server.origin,
        socket: server.socket,
        headers: { 'x-forwarded-for': address },
      });

    trace('lock');
    // 2. The lock: five wrong tokens, the sixth attempt is refused, the clock passes the lock.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await anonymous.post('/api/v1/setup/unlock', { json: { token: wrongSetupToken } });
    }
    await server.advance(16 * 60 * 1000);

    trace('wizard');
    // 3. The wizard.
    const setupToken = server.token() ?? '';
    const unlocked = await anonymous.post('/api/v1/setup/unlock', { json: { token: setupToken } });
    const setupCookie =
      sessionIdIn(unlocked.headers.getSetCookie(), cookieNames(server.origin).setup) ?? '';
    const setupClient = client({ cookie: `${cookieNames(server.origin).setup}=${setupCookie}` });
    await setupClient.post('/api/v1/setup/environment', { json: {} });
    await setupClient.get('/api/v1/setup/certificate.cer');
    await setupClient.post('/api/v1/connection/runs', {
      json: { steps: ['connect', 'configure', 'verify'], mode: 'continue' },
    });
    trace('drive');
    await server.drive();
    await setupClient.get('/api/v1/connection');
    await setupClient.get('/api/v1/connection/log?after=0&limit=200');
    await setupClient.post('/api/v1/connection/verify', { json: {} });
    const state = (await (await setupClient.get('/api/v1/setup/state')).json()) as {
      designatedOwner: { oid: string; upnLabel: string | null; nameLabel: string | null };
    };
    const oid = state.designatedOwner.oid;
    await setupClient.post('/api/v1/setup/finish', {
      json: { confirmOwnerOid: oid, language: 'nl' },
    });
    const admin = server.world.admin;

    trace('signins');
    // 4. Sign-ins.
    const sessionCookie = cookieNames(server.origin).session;
    const browser = browserAt('10.0.0.3');
    server.world.entra.control.nextSignIn({ user: admin.id });
    // The navigation follows the panel's 303 to Microsoft and Microsoft's 302 back, and stops before
    // the panel: its last `Location` is the callback URL with the authorization code and `state`.
    const login = await browser.navigate('/auth/login', { stopBeforePanel: true });
    exchanges.push({
      method: 'GET',
      path: '/auth/login',
      status: 303,
      requestBody: '',
      headers: [['location', login.chain[0]?.location ?? '']],
      body: '',
    });
    const callbackUrl = new URL(login.headers.get('location') ?? '');
    const callback = await browser.request(callbackUrl, { from: 'microsoft' });
    exchanges.push({
      method: 'GET',
      path: '/auth/callback',
      status: callback.status,
      requestBody: '',
      headers: [...callback.headers.entries()],
      body: callback.text,
    });
    const code = callbackUrl.searchParams.get('code') ?? '';
    const state2 = callbackUrl.searchParams.get('state') ?? '';
    const sessionId = browser.cookie(sessionCookie) ?? '';
    const ownerSignedIn = callback.status === 200 && sessionId !== '';
    const sessionClient = from('10.0.0.3', { cookie: `${sessionCookie}=${sessionId}` });
    await sessionClient.get('/api/v1/me');
    await sessionClient.get('/api/v1/me/access');
    await sessionClient.get('/api/v1/rbac/roles');
    await sessionClient.get('/api/v1/connection');
    // The proof again, as a person (the entry `connection.verify` is written for users only).
    // It needs a step-up: the first call is refused (a denied entry), the person re-authenticates with
    // `prompt=login` (an `auth.stepup` entry) and the second call succeeds.
    await pumped(server, sessionClient.post('/api/v1/connection/verify', { json: {} }));
    server.world.entra.control.nextSignIn({ user: admin.id });
    const stepUp = await browser.navigate('/auth/login?purpose=stepup&prompt=login&returnTo=%2F', {
      stopBeforePanel: true,
    });
    const stepUpCallback = await browser.request(new URL(stepUp.headers.get('location') ?? ''), {
      from: 'microsoft',
    });
    exchanges.push({
      method: 'GET',
      path: '/auth/callback',
      status: stepUpCallback.status,
      requestBody: '',
      headers: [...stepUpCallback.headers.entries()],
      body: stepUpCallback.text,
    });
    const steppedUpId = browser.cookie(sessionCookie) ?? sessionId;
    const steppedUpClient = from('10.0.0.3', { cookie: `${sessionCookie}=${steppedUpId}` });
    await pumped(server, steppedUpClient.post('/api/v1/connection/verify', { json: {} }));

    trace('stranger');
    // A second person with no role is turned away at /no-access.
    const stranger = server.world.graph.directory.addUser({
      userPrincipalName: 'stranger@contoso-fake.example',
    });
    server.world.entra.control.nextSignIn({ user: stranger.id });
    const browser2 = browserAt('10.0.0.4');
    const login2 = await browser2.navigate('/auth/login', { stopBeforePanel: true });
    const denied = await browser2.request(new URL(login2.headers.get('location') ?? ''), {
      from: 'microsoft',
    });
    const noRoleTurnedAway = (denied.headers.get('location') ?? denied.url).includes('/no-access');

    trace('breakglass');
    // The break-glass account: wrong password once, then the right one.
    const breakGlassClient = from('10.0.0.6');
    await breakGlassClient.post('/api/v1/auth/break-glass', {
      json: { username: BREAK_GLASS_USERNAME, password: wrongBreakGlassPassword },
    });
    const bg = await breakGlassClient.post('/api/v1/auth/break-glass', {
      json: { username: BREAK_GLASS_USERNAME, password: breakGlassPassword },
    });
    const bgSession = sessionIdIn(bg.headers.getSetCookie(), sessionCookie) ?? '';
    const breakGlassSignedIn = bg.status === 200 && bgSession !== '';
    if (bgSession !== '') {
      await from('10.0.0.6', { cookie: `${sessionCookie}=${bgSession}` }).get('/api/v1/me');
    }

    trace('pages');
    // Pages and the document, as a browser fetches them.
    const pages: string[] = [];
    for (const path of ['/', '/signin', '/no-access', '/settings/connection']) {
      const page = await server.client().get(path, { headers: { accept: 'text/html' } });
      pages.push(await page.text());
    }
    await anonymous.get('/api/v1/openapi.json');

    trace('disabled-and-graph-failing');
    // 5. A second person with the reader role signs in; their account is disabled and the next
    // request ends their sessions (session_revoked). Then Graph fails for the Owner's refresh
    // (membership_refresh_failed): the user call fails, the request goes on with direct grants.
    const ttlMs = 301 * 1000;
    const reader = server.world.graph.directory.addUser({
      userPrincipalName: 'reader@contoso-fake.example',
    });
    assign(server.database(), { role: 'reader', principalId: reader.id });
    server.world.entra.control.nextSignIn({ user: reader.id });
    const browser3 = browserAt('10.0.0.5');
    const login3 = await browser3.navigate('/auth/login', { stopBeforePanel: true });
    await browser3.request(new URL(login3.headers.get('location') ?? ''), { from: 'microsoft' });
    const readerSession = browser3.cookie(sessionCookie) ?? '';
    const readerClient = from('10.0.0.5', { cookie: `${sessionCookie}=${readerSession}` });
    await readerClient.get('/api/v1/me');
    const readerUser = server.world.graph.directory.users.get(reader.id);
    if (readerUser !== undefined) readerUser.accountEnabled = false;
    await server.advance(ttlMs);
    await pumped(server, readerClient.get('/api/v1/me'));

    server.world.graph.control.failWith({ times: 99, status: 503, match: /\/users\// });
    await server.advance(ttlMs);
    await pumped(server, steppedUpClient.get('/api/v1/me'));

    // The Owner signs out; so does the break-glass session.
    await steppedUpClient.post('/api/v1/auth/logout', { json: {} });
    if (bgSession !== '') {
      await from('10.0.0.6', { cookie: `${sessionCookie}=${bgSession}` }).post(
        '/api/v1/auth/logout',
        {
          json: {},
        },
      );
    }

    const completed =
      server.query<{ state: string }>('SELECT state FROM setup_state')[0]?.state === 'completed';
    const rows = server.auditRows().length;
    const auditText = JSON.stringify(server.auditRows());

    trace('rotation');
    // 6. Rotation with the CLI.
    await server.running.stop();
    logs.push(server.logs.text());
    const stdout = createLogCapture();
    const stderr = createLogCapture();
    const rotationStatus = await runRotateAppKey([], {
      env: {
        DATA_DIR: dataDir,
        PUBLIC_BASE_URL: server.origin,
        APP_KEY: nextKey.toString('base64'),
        APP_KEY_PREVIOUS: appKey.toString('base64'),
      },
      stdout,
      stderr,
    });
    const commandOutput = `${stdout.text()}${stderr.text()}`;
    const auditRows = server.query<AuditRow>(
      'SELECT seq, actor_kind, actor_id, action, target_type, outcome, reason_code, detail FROM audit_log ORDER BY seq',
    );

    trace('restart');
    // 7. The same data again: the token variable after completion, then the retired preview variable.
    const again = await startWizardServer({
      keepRunningAfterTest: true,
      dataDir,
      env: { APP_KEY: nextKey.toString('base64'), SETUP_TOKEN: setupToken },
    });
    await again.running.stop();
    logs.push(again.logs.text());
    const retired = await startWizardServer({
      keepRunningAfterTest: true,
      dataDir,
      env: { APP_KEY: nextKey.toString('base64'), PREVIEW_MODE: 'true' },
    });
    await retired.running.stop();
    logs.push(retired.logs.text());
    const previewLines = retired.logs
      .lines()
      .filter((line) => line.event === 'preview_mode_removed').length;

    const harvested = [...microsoftSecrets];
    const canaries: Canary[] = [
      { name: 'APP_KEY (first)', values: spellings(appKey) },
      { name: 'APP_KEY (rotated to)', values: spellings(nextKey) },
      { name: 'setup token', values: spellings(setupToken) },
      { name: 'wrong setup token', values: spellings(wrongSetupToken) },
      {
        name: 'certificate private key',
        values: [...pkcs8.flatMap((der) => [...spellings(der), ...sliceForms(der)]), 'PRIVATE KEY'],
      },
      { name: 'Microsoft tokens and device codes', values: harvested },
      { name: 'authorization code', values: code === '' ? [] : [code] },
      { name: 'state', values: state2 === '' ? [] : [state2], allowedInLoginLocation: true },
      {
        name: 'session id (owner)',
        values: sessionId === '' ? [] : [sessionId],
        allowedInSetCookie: true,
      },
      {
        name: 'session id (owner, after the step-up)',
        values: steppedUpId === '' || steppedUpId === sessionId ? [] : [steppedUpId],
        allowedInSetCookie: true,
      },
      {
        name: 'session id (break-glass)',
        values: bgSession === '' ? [] : [bgSession],
        allowedInSetCookie: true,
      },
      {
        name: 'setup session id',
        values: setupCookie === '' ? [] : [setupCookie],
        allowedInSetCookie: true,
      },
      { name: 'break-glass password', values: [breakGlassPassword, wrongBreakGlassPassword] },
    ];

    exchanges.push(
      ...pages.map((body) => ({
        method: 'GET',
        path: '(shell html)',
        status: 200,
        requestBody: '',
        headers: [] as [string, string][],
        body,
      })),
    );

    return {
      server,
      exchanges,
      canaries,
      logText: logs.join('\n'),
      auditText,
      dataDir,
      auditRows,
      files: dataFiles(dataDir),
      commandOutput,
      facts: {
        completed,
        ownerSignedIn,
        breakGlassSignedIn,
        noRoleTurnedAway,
        rows,
        previewLines,
        rotated: rotationStatus === 0,
      },
      oid,
      upn: admin.userPrincipalName,
      displayName: state.designatedOwner.nameLabel ?? '',
      tenantId: server.world.tenantId,
    };
  } finally {
    stopHarvest();
    spy.mockRestore();
  }
}

/** The SHA-256 of a text, for failure messages that must name a canary without printing it. */
export function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

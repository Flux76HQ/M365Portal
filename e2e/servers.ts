// The three processes of the e2e topology and the helpers that stop, start and restart them
// (FR-B-708, CB17, plan 14.3). Phase A had two instances (`preview`, `anonymous`); Phase B replaces
// them:
//
//   fake tenant  E2E_PORT + 2  the fake Entra, Graph and Exchange over local HTTP (`fake-tenant-server.ts`)
//   instance A   E2E_PORT      configured by global-setup through the real wizard; SHOWCASE=true,
//                              break-glass variables, long idle and absolute timeouts
//   instance B   E2E_PORT + 1  an empty data directory: the setup specs drive the wizard here
//
// The servers run the PRODUCTION build as `node --import e2e/support/server-preload.mjs
// apps/server/dist/index.js`; the preload puts the no-egress guard and an MSW forwarder in front of
// the three Microsoft hosts. `global-setup.ts` creates the run directory and records everything in a
// state file (path in E2E_STATE_FILE); the helpers below run in the test workers and keep it current.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, scryptSync } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fakeOrigin,
  INSTANCE_NAMES,
  originOf,
  portOf,
  type InstanceName,
  type PortName,
} from './support/ports.js';

export { INSTANCE_NAMES, originOf, portOf };
export type { InstanceName };

export const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const PRELOAD = join(repoRoot, 'e2e/support/server-preload.mjs');
const FAKE_SERVER = join(repoRoot, 'e2e/support/fake-tenant-server.ts');
const PWSH_SHIM = join(repoRoot, 'e2e/support/pwsh-shim/pwsh');

/**
 * The directory that is FIRST on the PATH of instance A: a link `pwsh` to the shim of
 * `e2e/support/pwsh-shim` (the fake Exchange worker), a link `node` to the Node that runs the server
 * (the product starts the worker WITHOUT a PATH, so the shim cannot look `node` up) and, once a spec
 * has chosen data, `seed.json` (`support/exchange-seed.ts`). One per run, inside the run directory.
 */
export function pwshShimDirectory(runDir: string): string {
  return join(runDir, 'pwsh');
}

/** Makes the shim directory of a run (global-setup, before the servers start). */
export function makePwshShimDirectory(runDir: string): string {
  const directory = pwshShimDirectory(runDir);
  mkdirSync(directory, { recursive: true });
  symlinkSync(PWSH_SHIM, join(directory, 'pwsh'));
  symlinkSync(process.execPath, join(directory, 'node'));
  return directory;
}

export interface InstanceState {
  readonly port: number;
  readonly dataDir: string;
  pid: number;
}

/** The values generated once per run: throwaway, in the run directory only, never in an artefact. */
export interface RunSecrets {
  readonly appKey: Record<InstanceName, string>;
  readonly setupToken: Record<InstanceName, string>;
  readonly breakGlass: {
    readonly username: string;
    readonly password: string;
    readonly hash: string;
  };
}

export interface ServersState {
  readonly runDir: string;
  /** The throwaway certificate of the fake tenant's TLS listener (made by global-setup with openssl). */
  readonly tls: { readonly keyFile: string; readonly certFile: string };
  readonly secrets: RunSecrets;
  readonly instances: Record<InstanceName, InstanceState>;
  fakePid: number;
}

// ---- the run directory and its state file ------------------------------------------------------

function stateFile(): string {
  const file = process.env.E2E_STATE_FILE;
  if (file === undefined || file === '') {
    throw new Error('E2E_STATE_FILE is not set: the servers are started by global-setup.ts');
  }
  return file;
}

export function readState(): ServersState {
  return JSON.parse(readFileSync(stateFile(), 'utf8')) as ServersState;
}

export function writeState(state: ServersState): void {
  writeFileSync(stateFile(), JSON.stringify(state));
}

/** Where the storage states of the principals live (written by global-setup). */
export function statesDir(): string {
  return join(dirname(stateFile()), 'states');
}

/**
 * A throwaway self-signed certificate for the three Microsoft host names, made with `openssl` into the
 * run directory (the key never exists anywhere else and is removed with the run). Chromium accepts it
 * through `ignoreHTTPSErrors`.
 */
export function makeTlsMaterial(runDir: string): { keyFile: string; certFile: string } {
  const keyFile = join(runDir, 'fake-tls.key');
  const certFile = join(runDir, 'fake-tls.crt');
  const names = ['login.microsoftonline.com', 'graph.microsoft.com', 'outlook.office365.com'];
  const result = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '2',
      '-subj',
      '/CN=m365portal-e2e-fake-tenant',
      '-addext',
      `subjectAltName=${names.map((name) => `DNS:${name}`).join(',')}`,
      '-keyout',
      keyFile,
      '-out',
      certFile,
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`openssl could not make the fake tenant's certificate: ${result.stderr}`);
  }
  return { keyFile, certFile };
}

export function makeRunDirectory(): string {
  const runDir = mkdtempSync(join(tmpdir(), 'm365portal-e2e-'));
  process.env.E2E_STATE_FILE = join(runDir, 'state.json');
  mkdirSync(join(runDir, 'states'));
  return runDir;
}

// ---- secrets of the run ---------------------------------------------------------------------------

function scryptLine(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, { N: 16_384, r: 8, p: 1 });
  return `scrypt:16384:8:1:${salt.toString('base64url')}:${hash.toString('base64url')}`;
}

export function generateRunSecrets(): RunSecrets {
  const password = `Run-${randomBytes(12).toString('base64url')}-pw`;
  return {
    appKey: {
      a: randomBytes(32).toString('base64'),
      b: randomBytes(32).toString('base64'),
    },
    setupToken: {
      a: `e2e-${randomBytes(24).toString('base64url')}`,
      b: `e2e-${randomBytes(24).toString('base64url')}`,
    },
    breakGlass: { username: 'e2e-breakglass', password, hash: scryptLine(password) },
  };
}

// ---- processes ---------------------------------------------------------------------------------

/** The environment of one instance. `extra` wins (a spec that restarts it with another setting). */
export function instanceEnv(
  name: InstanceName,
  dataDir: string,
  secrets: RunSecrets,
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {
    PORT: String(portOf(name)),
    HOST: '127.0.0.1',
    PUBLIC_BASE_URL: originOf(name),
    DATA_DIR: dataDir,
    APP_KEY: secrets.appKey[name],
    SETUP_TOKEN: secrets.setupToken[name],
    // The server's own Microsoft calls go to the fake through the preload (see spawn below).
    E2E_FAKE_ORIGIN: fakeOrigin(),
    E2E_FAKE_TENANT: name,
  };
  if (name === 'a') {
    env.SHOWCASE = 'true';
    // One proxy hop is trusted so that every browser context can be a client of its own
    // (support/client-address.ts); B trusts none.
    env.TRUST_PROXY = '1';
    env.BREAK_GLASS_USERNAME = secrets.breakGlass.username;
    env.BREAK_GLASS_PASSWORD_HASH = secrets.breakGlass.hash;
    // Relaxed so that the storage states of a long run stay valid (idle: 8 h, absolute: 24 h).
    env.SESSION_IDLE_TIMEOUT_MINUTES = '480';
    env.SESSION_ABSOLUTE_TIMEOUT_HOURS = '24';
  } else {
    // The shortest propagation window the product allows: the wizard specs wait it out for real.
    env.SETUP_PROPAGATION_TIMEOUT_SECONDS = '60';
  }
  return { ...env, ...extra };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function answersAt(origin: string, path = '/healthz'): Promise<boolean> {
  try {
    const response = await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(1000) });
    // /readyz can answer 503 on purpose (degraded secrets); /healthz is the liveness probe.
    return response.status < 500 || path !== '/healthz';
  } catch {
    return false;
  }
}

/** Whether a port of the topology answers its health endpoint right now. */
export function isRunning(name: PortName): Promise<boolean> {
  return name === 'fake'
    ? answersAt(fakeOrigin())
    : answersAt(`http://127.0.0.1:${String(portOf(name))}`);
}

function childEnvironment(env: Record<string, string>): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...process.env, ...env };
  // Everything here talks to loopback: never through the sandbox's outbound proxy.
  delete merged.NODE_USE_ENV_PROXY;
  merged.NO_PROXY = '127.0.0.1,localhost';
  merged.no_proxy = '127.0.0.1,localhost';
  return merged;
}

async function waitForHealth(
  port: number,
  pid: number,
  what: string,
  logDir: string,
): Promise<void> {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    if (await answersAt(`http://127.0.0.1:${String(port)}`)) return;
    if (!alive(pid)) throw new Error(`the ${what} exited early (see ${logDir})`);
    await sleep(100);
  }
  throw new Error(`the ${what} did not answer /healthz within 40 s (see ${logDir})`);
}

/** Starts the fake tenant. Returns its pid. */
export async function spawnFakeTenant(
  logDir: string,
  tls: { keyFile: string; certFile: string },
): Promise<number> {
  mkdirSync(logDir, { recursive: true });
  const log = openSync(join(logDir, 'fake-tenant.log'), 'a');
  const child = spawn(process.execPath, ['--import', 'tsx', FAKE_SERVER], {
    cwd: repoRoot,
    env: childEnvironment({
      E2E_PORT: String(portOf('a')),
      E2E_TLS_KEY_FILE: tls.keyFile,
      E2E_TLS_CERT_FILE: tls.certFile,
    }),
    stdio: ['ignore', log, log],
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error('the fake tenant did not start');
  child.unref();
  await waitForHealth(portOf('fake'), pid, 'fake tenant', logDir);
  return pid;
}

/**
 * Starts one instance of the production build behind the preload and waits for /healthz. `port`
 * overrides the port (the spare instance of the specs that need a second one beside A).
 */
export async function spawnInstance(
  name: InstanceName,
  dataDir: string,
  logDir: string,
  extra: Record<string, string> = {},
  secrets: RunSecrets = readState().secrets,
): Promise<number> {
  const entry = join(repoRoot, 'apps/server/dist/index.js');
  mkdirSync(logDir, { recursive: true });
  const log = openSync(join(logDir, `server-${name}.log`), 'a');
  // Instance A finds the fake `pwsh` first (the Exchange worker of lists and contacts); the product has
  // no hook for it, it is only a file on a PATH. B talks to Exchange only through the wizard's REST probe.
  const shim: Record<string, string> =
    name === 'a'
      ? { PATH: `${pwshShimDirectory(dirname(dataDir))}:${process.env.PATH ?? ''}` }
      : {};
  const child = spawn(process.execPath, ['--import', PRELOAD, entry], {
    cwd: repoRoot,
    env: childEnvironment({ ...shim, ...instanceEnv(name, dataDir, secrets, extra) }),
    stdio: ['ignore', log, log],
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error(`instance ${name} did not start`);
  child.unref();
  await waitForHealth(portOf(name), pid, `instance ${name}`, logDir);
  return pid;
}

/** Stops a process (SIGTERM, then SIGKILL after 15 s) and waits until it is gone. */
export async function stopProcess(pid: number): Promise<void> {
  if (!alive(pid)) return;
  process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (!alive(pid)) return;
    await sleep(50);
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // already gone
  }
  while (alive(pid)) await sleep(50);
}

function logDirectory(): string {
  return join(dirname(stateFile()), 'logs');
}

// Instance B answers a browser's page load with a call to the setup routes, whose rate class holds 10
// tokens and earns one every 5 s (`rateLimit.setup`), and B trusts no proxy, so every context is the
// same client. A spec run that opens many pages on B restarts it (the buckets are in memory) before the
// budget is gone, instead of waiting for tokens or failing with 429. `takeSetupBudget` is called by
// `app.goto` for instance B; any start of B resets the count.
const SETUP_PAGE_LOADS_PER_START = 6;
let setupLoadsSinceStart = 0;

export async function takeSetupBudget(): Promise<void> {
  if (setupLoadsSinceStart >= SETUP_PAGE_LOADS_PER_START) await restartServer('b');
  setupLoadsSinceStart += 1;
}

/** Stops the instance; its DATA_DIR stays. Resolves when the port no longer answers. */
export async function stopServer(name: InstanceName): Promise<void> {
  const state = readState();
  await stopProcess(state.instances[name].pid);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!(await isRunning(name))) return;
    await sleep(50);
  }
  throw new Error(`instance ${name} still answers after it was stopped`);
}

/**
 * Starts the instance again on the same DATA_DIR (a no-op when it already answers). `env` overrides
 * variables of the instance for this start only: a restart without it returns to the default.
 */
export async function startServer(
  name: InstanceName,
  env: Record<string, string> = {},
): Promise<void> {
  const state = readState();
  if (await isRunning(name)) return;
  state.instances[name].pid = await spawnInstance(
    name,
    state.instances[name].dataDir,
    logDirectory(),
    env,
    state.secrets,
  );
  writeState(state);
  if (name === 'b') setupLoadsSinceStart = 0;
}

/** Stop, then start, on the same DATA_DIR. */
export async function restartServer(
  name: InstanceName,
  env: Record<string, string> = {},
): Promise<void> {
  await stopServer(name);
  await startServer(name, env);
}

/**
 * Puts instance B back to "empty": stops it, removes its data directory, resets its tenant in the fake
 * and starts it again. Every wizard spec begins with this.
 */
export async function resetEmptyInstance(): Promise<void> {
  await stopServer('b');
  const state = readState();
  const { dataDir } = state.instances.b;
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir);
  await fetch(`${fakeOrigin()}/control/b`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'reset' }),
  });
  await startServer('b');
}

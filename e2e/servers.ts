// The two instances of the production build (FR-A-157, contract C14) and the helper that stops,
// starts and restarts one of them on the same DATA_DIR (offline tests stop the server; they never
// use `context.setOffline`, plan V-16).
//
//   preview    PREVIEW_MODE=true, SHOWCASE=true, port E2E_PORT (default 4173)
//   anonymous  neither, port E2E_PORT + 1
//
// `global-setup.ts` creates both with a fresh temporary DATA_DIR each and records them in a state
// file (path in E2E_STATE_FILE); `global-teardown.ts` stops them and removes the directories. The
// helpers below run in the test workers and keep the state file current.
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type InstanceName = 'preview' | 'anonymous';
export const INSTANCE_NAMES: readonly InstanceName[] = ['preview', 'anonymous'];

export const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/** E2E_PORT (1024-65535, default 4173). Throws on anything else (FR-A-016). */
export function previewPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.E2E_PORT ?? '4173';
  const port = Number(raw);
  if (!/^\d{1,5}$/.test(raw) || port < 1024 || port > 65534) {
    throw new Error(
      'E2E_PORT must be an integer between 1024 and 65534 (E2E_PORT + 1 is used too)',
    );
  }
  return port;
}

export function portOf(name: InstanceName, env: NodeJS.ProcessEnv = process.env): number {
  return previewPort(env) + (name === 'anonymous' ? 1 : 0);
}

/**
 * The origin the browser uses. `localhost` and not 127.0.0.1: PUBLIC_BASE_URL must equal it (writes
 * are only accepted from that origin, A-31) and preview mode needs a loopback Host.
 */
export function originOf(name: InstanceName, env: NodeJS.ProcessEnv = process.env): string {
  return `http://localhost:${String(portOf(name, env))}`;
}

export interface InstanceState {
  readonly port: number;
  readonly dataDir: string;
  pid: number;
}
export type ServersState = Record<InstanceName, InstanceState>;

/** The environment variables of one instance. */
export function instanceEnv(name: InstanceName, dataDir: string): Record<string, string> {
  const env: Record<string, string> = {
    PORT: String(portOf(name)),
    HOST: '127.0.0.1',
    PUBLIC_BASE_URL: originOf(name),
    DATA_DIR: dataDir,
  };
  if (name === 'preview') {
    env.SHOWCASE = 'true';
    env.PREVIEW_MODE = 'true';
  }
  return env;
}

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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function answers(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/healthz`, {
      signal: AbortSignal.timeout(1000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Starts one instance on its DATA_DIR and waits for /healthz. Returns the new pid. */
export async function spawnInstance(
  name: InstanceName,
  dataDir: string,
  logDir: string,
): Promise<number> {
  const entry = join(repoRoot, 'apps/server/dist/index.js');
  mkdirSync(logDir, { recursive: true });
  const log = openSync(join(logDir, `server-${name}.log`), 'a');
  const child = spawn(process.execPath, [entry], {
    cwd: repoRoot,
    env: { ...process.env, ...instanceEnv(name, dataDir) },
    stdio: ['ignore', log, log],
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error(`the ${name} server did not start`);
  child.unref();
  const port = portOf(name);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await answers(port)) return pid;
    if (!alive(pid)) throw new Error(`the ${name} server exited early (see ${logDir})`);
    await sleep(100);
  }
  throw new Error(`the ${name} server did not answer /healthz within 30 s`);
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

/** Whether the instance answers /healthz right now. */
export function isRunning(name: InstanceName): Promise<boolean> {
  return answers(portOf(name));
}

/** Stops the instance; its DATA_DIR stays. Resolves when the port no longer answers. */
export async function stopServer(name: InstanceName): Promise<void> {
  const state = readState();
  await stopProcess(state[name].pid);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!(await answers(state[name].port))) return;
    await sleep(50);
  }
  throw new Error(`the ${name} server still answers after it was stopped`);
}

/** Starts the instance again on the same DATA_DIR (a no-op when it already answers). */
export async function startServer(name: InstanceName): Promise<void> {
  const state = readState();
  if (await answers(state[name].port)) return;
  state[name].pid = await spawnInstance(
    name,
    state[name].dataDir,
    join(dirname(stateFile()), 'logs'),
  );
  writeState(state);
}

/** Stop, then start, on the same DATA_DIR. */
export async function restartServer(name: InstanceName): Promise<void> {
  await stopServer(name);
  await startServer(name);
}

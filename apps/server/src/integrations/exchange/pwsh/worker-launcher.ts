// The process boundary of the Exchange worker (Phase D, T-D-112, FR-D-102, FR-D-103, FR-D-107): what
// is spawned, with which command line and environment, and how the pipes are read. The session
// (session.ts) talks to a `WorkerProcess` and never to Node's child process; the tests give it a
// stand-in that speaks the same protocol in memory, and one real child process (the Node program
// test/fakes/fake-tenant/exchange/standin-process.mjs) through this launcher.
//
// Rules this file keeps:
//   - no shell: `spawn` with an argument list, `shell: false`;
//   - an environment of a short list of names and nothing of the parent but the proxy and the
//     certificate-bundle variables (a secret of the server, such as `APP_KEY`, never reaches the worker);
//   - the command line holds the script path, the certificate mode and, for the fallback, the scratch
//     directory: never the certificate, a password or a tenant name;
//   - stdout is read as UTF-8 (a multi-byte character may arrive in two chunks), stdin is written
//     line by line, and STDERR NEVER LEAVES THIS FILE: a PowerShell error text can hold a name or an
//     address. The last 2 KB are read once, when the process has ended, into ONE word of a closed list
//     (exit-classification.ts) that the session may log; the text itself is dropped.
import { mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { posix } from 'node:path';
import {
  STDERR_TAIL_CHARS,
  classifySpawnError,
  classifyStderr,
  safeSignal,
  type WorkerExit,
} from './exit-classification.js';
import type { CertificateMode } from './key-handover.js';

export type { WorkerExit } from './exit-classification.js';

export interface WorkerLaunchOptions {
  readonly certificateMode: CertificateMode;
  /** The private directory of this worker (fallback mode only). */
  readonly scratchDir?: string;
}

/** One running worker, as the session sees it. */
export interface WorkerProcess {
  /** Writes one complete line (with its newline). */
  write(line: string): void;
  /** Called with each chunk of stdout, as text. */
  onData(listener: (chunk: string) => void): void;
  /** Called once when the process has ended, however it ended (also at once if it already had), with how it ended. */
  onExit(listener: (exit: WorkerExit) => void): void;
  /** Closes stdin: the worker finishes what it reads and leaves. */
  end(): void;
  /** Ends the process at once and for good. Idempotent. */
  kill(): void;
}

export interface WorkerLauncher {
  /** Starts a worker. Throws when it cannot. */
  launch(options: WorkerLaunchOptions): WorkerProcess;
}

/** The names that are copied from the parent environment when they are set. */
export const WORKER_ENV_ALLOW = Object.freeze([
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'DOTNET_SYSTEM_GLOBALIZATION_INVARIANT',
] as const);

/** The names the launcher sets itself. */
export const WORKER_FIXED_ENV = Object.freeze([
  'HOME',
  'TMPDIR',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_CONFIG_HOME',
  'DOTNET_CLI_TELEMETRY_OPTOUT',
  'DOTNET_NOLOGO',
  'POWERSHELL_TELEMETRY_OPTOUT',
  'POWERSHELL_UPDATECHECK',
  'NO_COLOR',
  'TERM',
  'LANG',
] as const);

/** The environment of the worker: the fixed names with `homeDir` as home, and the allowed names of the parent. */
export function buildWorkerEnvironment(
  parent: Readonly<Record<string, string | undefined>>,
  options: { readonly homeDir: string },
): Record<string, string> {
  const env: Record<string, string> = {
    HOME: options.homeDir,
    TMPDIR: options.homeDir,
    XDG_CACHE_HOME: posix.join(options.homeDir, '.cache'),
    XDG_DATA_HOME: posix.join(options.homeDir, '.local', 'share'),
    XDG_CONFIG_HOME: posix.join(options.homeDir, '.config'),
    DOTNET_CLI_TELEMETRY_OPTOUT: '1',
    DOTNET_NOLOGO: '1',
    POWERSHELL_TELEMETRY_OPTOUT: '1',
    POWERSHELL_UPDATECHECK: 'Off',
    NO_COLOR: '1',
    TERM: 'dumb',
    LANG: 'C.UTF-8',
  };
  for (const name of WORKER_ENV_ALLOW) {
    const value = parent[name];
    if (typeof value === 'string' && value.length > 0) env[name] = value;
  }
  return env;
}

/** A path on the command line: absolute, and made of characters no shell and no PowerShell parameter parser treats specially. */
const SAFE_PATH = /^\/[A-Za-z0-9_.\-/]{1,400}$/;

function safePath(value: string, what: string): string {
  if (!SAFE_PATH.test(value) || value.includes('..'))
    throw new RangeError(`${what} is not a safe path`);
  return value;
}

/** The arguments of `pwsh` for the worker script (T-D-114: the mode and the scratch directory, never a secret). */
export function buildWorkerArguments(options: {
  readonly scriptPath: string;
  readonly certificateMode: CertificateMode;
  readonly scratchDir?: string;
}): string[] {
  const args = [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-File',
    safePath(options.scriptPath, 'the script path'),
    '-CertificateMode',
    options.certificateMode,
  ];
  if (options.certificateMode === 'tmpfs') {
    if (options.scratchDir === undefined)
      throw new RangeError('the fallback needs a scratch directory');
    args.push('-ScratchDirectory', safePath(options.scratchDir, 'the scratch directory'));
  }
  return args;
}

export interface NodeWorkerLauncherOptions {
  /** `pwsh` (an absolute path in the image). */
  readonly command: string;
  readonly scriptPath: string;
  /** The home directory of the worker: a path on a writable file system (a tmpfs under a read-only root). */
  readonly homeDir: string;
  /** The environment the allowed names are copied from. */
  readonly parentEnv: Readonly<Record<string, string | undefined>>;
  /** For tests: other arguments than `buildWorkerArguments` (a Node program is not `pwsh`). */
  readonly argumentsFor?: (options: WorkerLaunchOptions) => string[];
  /** For tests: environment variables added to the fixed ones (the real runtime passes none). */
  readonly extraEnv?: Readonly<Record<string, string>>;
}

/** The launcher over Node's `spawn`. */
export function createNodeWorkerLauncher(options: NodeWorkerLauncherOptions): WorkerLauncher {
  return {
    launch(launch) {
      mkdirSync(options.homeDir, { recursive: true, mode: 0o700 });
      const args =
        options.argumentsFor?.(launch) ??
        buildWorkerArguments({
          scriptPath: options.scriptPath,
          certificateMode: launch.certificateMode,
          ...(launch.scratchDir === undefined ? {} : { scratchDir: launch.scratchDir }),
        });
      const child = spawn(options.command, args, {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...buildWorkerEnvironment(options.parentEnv, { homeDir: options.homeDir }),
          ...options.extraEnv,
        },
        cwd: options.homeDir,
        windowsHide: true,
      });
      child.stdout.setEncoding('utf8');
      // A write to a worker that is gone is an error event on the pipe; the exit handler reports it.
      child.stdin.on('error', () => undefined);
      child.stdout.on('error', () => undefined);

      // stderr is drained (a full pipe would stop the worker) but only its tail is kept, and only to be classified.
      let stderrTail = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
      });
      child.stderr.on('error', () => undefined);

      let exited = false;
      let ended = false;
      let result: WorkerExit | undefined;
      const exitListeners: ((exit: WorkerExit) => void)[] = [];
      const finish = (exit: WorkerExit): void => {
        if (ended) return;
        ended = true;
        result = exit;
        stderrTail = '';
        for (const listener of exitListeners.splice(0)) listener(exit);
      };
      let exitCode: number | null = null;
      let signal: string | null = null;
      // 'exit' comes before the pipes are drained: the record is made at 'close', when all of stderr is read.
      // (A call that waits for a worker that never closes its pipes is still ended by its own deadline.)
      const done = (): void => {
        finish({ exitCode, signal, stderrClass: classifyStderr(stderrTail) });
      };
      child.on('exit', (code, sig) => {
        exited = true;
        exitCode = code;
        signal = safeSignal(sig);
      });
      child.on('close', (code, sig) => {
        exited = true;
        exitCode ??= code;
        signal ??= safeSignal(sig);
        done();
      });
      child.on('error', (error: NodeJS.ErrnoException) => {
        exited = true;
        finish({ exitCode: null, signal: null, stderrClass: classifySpawnError(error.code) });
      });

      return {
        write(line) {
          if (!child.stdin.destroyed && child.stdin.writable) child.stdin.write(line);
        },
        onData(listener) {
          child.stdout.on('data', (chunk: string) => {
            listener(chunk);
          });
        },
        onExit(listener) {
          if (result !== undefined) listener(result);
          else exitListeners.push(listener);
        },
        end() {
          if (!child.stdin.destroyed) child.stdin.end();
        },
        kill() {
          if (!exited) child.kill('SIGKILL');
        },
      };
    },
  };
}

// The worker stand-in (T-D-112, T-D-114, T-D-115, plan 6): a `WorkerLauncher` whose processes are
// objects in memory that speak the line protocol of `@m365portal/shared/exchange/protocol` like
// `worker-script.ps1` does, over the fake Exchange state. `ExchangeWorkerSession` and
// `PwshExchangeClient` therefore run for real in the unit tests, up to the process boundary.
//
// What it does like the script: reads request lines with the shared parser (a line that is not the
// protocol, or a call outside the allow-list, is `invalid_argument`); a call before the connect is
// `not_connected`; the connect and the ping answer the hashes of the allow-list and of the
// projections; a call is run by `runCmdlet` (cmdlets.ts); it never puts text of a request into an
// answer; `shutdown` answers and exits; closing stdin ends it.
//
// What a test can script: the connect (`connect(...)`), each call (`script(fn)` returns an action by
// the index of the call: hang, exit, apply and exit, hold, an error, extra or replaced lines, answers
// in pieces), a launch that fails (`failLaunch`), a process that dies (`crash`, `killAll`). In the
// fallback mode the stand-in plays the script's part in the key hand-over: it writes the certificate to
// a file in the scratch directory during the connect and removes it afterwards (or leaves it, to prove
// that the guard sees a file left behind).
import { createHash } from 'node:crypto';
import {
  encodeLine,
  parseRequestLine,
  type ExchangeErrorCode,
} from '@m365portal/shared/exchange/protocol';
import {
  ALLOW_LIST_MANIFEST_SHA256,
  PROJECTION_MANIFEST_SHA256,
} from '../../../../src/integrations/exchange/pwsh/generated-allow-list.js';
import type {
  WorkerLauncher,
  WorkerLaunchOptions,
  WorkerProcess,
} from '../../../../src/integrations/exchange/pwsh/worker-launcher.js';
import { runCmdlet } from './cmdlets.js';
import type { FakeExchangeState } from './state.js';

export type StandInAction =
  | 'hang'
  | 'exit'
  | 'hold'
  | 'ignore'
  | 'apply-then-exit'
  | { readonly error: ExchangeErrorCode; readonly retryAfterMs?: number }
  | {
      readonly before?: readonly string[];
      readonly replace?: readonly string[];
      readonly chunk?: number;
    }
  | undefined;

export interface StandInCall {
  /** 0-based position among the `call` lines of all processes. `-1` for other types. */
  readonly index: number;
  readonly type: 'call' | 'ping' | 'connect' | 'shutdown';
  readonly cmdlet?: string;
}

export type StandInConnect =
  | 'ok'
  | 'hang'
  | 'exit'
  | 'exit-with-file'
  | 'hang-with-file'
  | { readonly error: ExchangeErrorCode; readonly retryAfterMs?: number }
  | { readonly wrongHashes: true };

/** Where the stand-in plays the script's file in the fallback mode. */
export interface StandInFiles {
  write(path: string, bytes: Uint8Array): void;
  remove(path: string): void;
}

export interface StandInProcess extends WorkerProcess {
  readonly received: string[];
  killed: boolean;
  stdinClosed: boolean;
  exited: boolean;
  /** What the connect carried, without the secrets: the format, the data as received and a hash of the password. */
  certificateSeen: { format: string; data: string; passwordHash: string } | undefined;
  filesWritten: number;
  /** The process dies by itself. */
  crash(): void;
}

export interface StandInLauncher extends WorkerLauncher {
  launches: number;
  readonly processes: StandInProcess[];
  readonly launchOptions: WorkerLaunchOptions[];
  /** Decides what each call does; `undefined` means the normal answer. */
  script(fn: (call: StandInCall) => StandInAction): void;
  connect(mode: StandInConnect): void;
  failLaunch(times: number): void;
  /** The number of `call` lines received so far, over all processes. */
  calls(): number;
  /** Answers the calls that were held. */
  release(): void;
  /** In the fallback mode: leave the file where it is after the connect. */
  leaveKeyFile(on: boolean): void;
  killAll(): void;
}

export function createStandInLauncher(
  state: FakeExchangeState,
  options: { readonly files?: StandInFiles } = {},
): StandInLauncher {
  let scriptFn: (call: StandInCall) => StandInAction = () => undefined;
  let connectMode: StandInConnect = 'ok';
  let failures = 0;
  let callCounter = 0;
  let leaveFile = false;
  const held: (() => void)[] = [];

  const launcher: StandInLauncher = {
    launches: 0,
    processes: [],
    launchOptions: [],
    script(fn) {
      scriptFn = fn;
    },
    connect(mode) {
      connectMode = mode;
    },
    failLaunch(times) {
      failures = times;
    },
    calls: () => callCounter,
    release() {
      for (const resume of held.splice(0)) resume();
    },
    leaveKeyFile(on) {
      leaveFile = on;
    },
    killAll() {
      for (const process of launcher.processes) process.kill();
    },
    launch(launchOptions) {
      if (failures > 0) {
        failures -= 1;
        throw new Error('the stand-in cannot start');
      }
      launcher.launches += 1;
      launcher.launchOptions.push(launchOptions);
      const process = createProcess(launchOptions);
      launcher.processes.push(process);
      return process;
    },
  };

  function createProcess(launchOptions: WorkerLaunchOptions): StandInProcess {
    const dataListeners: ((chunk: string) => void)[] = [];
    const exitListeners: (() => void)[] = [];
    let connected = false;
    let ignoreShutdown = false;
    let keyPath: string | undefined;

    const process: StandInProcess = {
      received: [],
      killed: false,
      stdinClosed: false,
      exited: false,
      certificateSeen: undefined,
      filesWritten: 0,
      write(line) {
        if (process.exited || process.stdinClosed) return;
        process.received.push(line);
        handle(line.replace(/\n$/, ''));
      },
      onData(listener) {
        dataListeners.push(listener);
      },
      onExit(listener) {
        if (process.exited) listener();
        else exitListeners.push(listener);
      },
      end() {
        process.stdinClosed = true;
        if (!ignoreShutdown) exit();
      },
      kill() {
        if (process.exited) return;
        process.killed = true;
        exit();
      },
      crash() {
        exit();
      },
    };

    function exit(): void {
      if (process.exited) return;
      process.exited = true;
      for (const listener of exitListeners.splice(0)) listener();
    }

    /** Output reaches the reader a moment later, as a pipe does. */
    function emit(text: string, chunk?: number): void {
      queueMicrotask(() => {
        if (process.killed) return;
        if (chunk === undefined) {
          for (const listener of dataListeners) listener(text);
          return;
        }
        for (let at = 0; at < text.length; at += chunk) {
          const piece = text.slice(at, at + chunk);
          for (const listener of dataListeners) listener(piece);
        }
      });
    }

    const hello = (wrongHashes = false): Record<string, unknown> => ({
      allowListSha256: wrongHashes ? '0'.repeat(64) : ALLOW_LIST_MANIFEST_SHA256,
      projectionSha256: PROJECTION_MANIFEST_SHA256,
      moduleVersion: '3.10.1',
      psVersion: '7.6.6',
      mode: launchOptions.certificateMode,
      connected,
    });
    const ok = (id: string, data: unknown, chunk?: number): void => {
      emit(encodeLine({ v: 1, id, ok: true, data }), chunk);
    };
    const fail = (id: string, code: ExchangeErrorCode, retryAfterMs?: number): void => {
      emit(
        encodeLine({
          v: 1,
          id,
          ok: false,
          error: { code, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) },
        }),
      );
    };

    function handle(line: string): void {
      const parsed = parseRequestLine(line);
      if (!parsed.ok) {
        fail('invalid-request', 'invalid_argument');
        return;
      }
      const request = parsed.value;
      switch (request.type) {
        case 'ping':
          ok(request.id, hello());
          return;
        case 'connect':
          handleConnect(request.id, request.certificate);
          return;
        case 'shutdown': {
          const action = scriptFn({ index: -1, type: 'shutdown' });
          if (action === 'ignore') {
            ignoreShutdown = true;
            return;
          }
          ok(request.id, { done: true });
          exit();
          return;
        }
        case 'call':
          handleCall(request.id, request.cmdlet, request.args);
      }
    }

    function handleConnect(
      id: string,
      certificate: { format: string; data: string; password: string },
    ): void {
      process.certificateSeen = {
        format: certificate.format,
        data: certificate.data,
        passwordHash: createHash('sha256').update(certificate.password).digest('hex'),
      };
      const mode = connectMode;
      // The fallback: the script writes the key to a file in its scratch directory for the connect.
      if (launchOptions.certificateMode === 'tmpfs' && launchOptions.scratchDir !== undefined) {
        keyPath = `${launchOptions.scratchDir}/k${String(process.filesWritten)}.pfx`;
        options.files?.write(keyPath, Buffer.from(certificate.data, 'base64'));
        process.filesWritten += 1;
      }
      const clean = (): void => {
        if (keyPath !== undefined && !leaveFile) options.files?.remove(keyPath);
      };
      if (mode === 'hang' || mode === 'hang-with-file') return;
      if (mode === 'exit' || mode === 'exit-with-file') {
        if (mode === 'exit') clean();
        exit();
        return;
      }
      clean();
      if (typeof mode === 'object' && 'error' in mode) {
        fail(id, mode.error, mode.retryAfterMs);
        return;
      }
      connected = true;
      ok(id, hello(typeof mode === 'object' && 'wrongHashes' in mode));
    }

    function handleCall(id: string, cmdlet: string, args: Record<string, unknown>): void {
      const index = callCounter;
      callCounter += 1;
      const action = scriptFn({ index, type: 'call', cmdlet });
      const normal = (chunk?: number): void => {
        if (!connected) {
          fail(id, 'not_connected');
          return;
        }
        const outcome = runCmdlet(state, cmdlet, args);
        if (outcome.ok) ok(id, outcome.data, chunk);
        else fail(id, outcome.error, outcome.retryAfterMs);
      };
      if (action === undefined || action === 'ignore') {
        normal();
        return;
      }
      if (action === 'hang') return;
      if (action === 'exit') {
        exit();
        return;
      }
      if (action === 'apply-then-exit') {
        if (connected) runCmdlet(state, cmdlet, args);
        exit();
        return;
      }
      if (action === 'hold') {
        held.push(() => {
          normal();
        });
        return;
      }
      if ('error' in action) {
        fail(id, action.error, action.retryAfterMs);
        return;
      }
      for (const extra of action.before ?? []) emit(`${extra}\n`);
      if (action.replace !== undefined) {
        for (const replacement of action.replace) emit(`${replacement}\n`);
        return;
      }
      normal(action.chunk);
    }

    return process;
  }

  return launcher;
}

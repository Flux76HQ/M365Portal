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
// fallback mode the stand-in plays the script's part in the key hand-over: it writes the two PEMs and the
// derived PKCS#12 to files in the scratch directory during the connect and removes them afterwards (or leaves it, to prove
// that the guard sees a file left behind).
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
  WorkerExit,
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
  | {
      readonly error: ExchangeErrorCode;
      readonly retryAfterMs?: number;
      /** What the real worker puts in `error.detail` (type, errorId, hints, and in the diagnostic mode text, textLength). */
      readonly detail?: StandInErrorDetail;
    }
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

export interface StandInErrorDetail {
  readonly type?: string;
  readonly errorId?: string;
  readonly hints?: readonly string[];
  readonly text?: string;
  readonly textLength?: number;
}

export type StandInConnect =
  | 'ok'
  | 'hang'
  | 'exit'
  | 'exit-with-file'
  | 'hang-with-file'
  | {
      readonly error: ExchangeErrorCode;
      readonly retryAfterMs?: number;
      readonly aadsts?: number;
      readonly detail?: StandInErrorDetail;
    }
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
  /** What the connect carried, as received (test canaries only; a real log never holds it). */
  certificateSeen: { format: string; certificate: string; privateKey: string } | undefined;
  filesWritten: number;
  /** The process dies by itself (with this exit record; default code 1 and an unknown stderr class). */
  crash(exit?: Partial<WorkerExit>): void;
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
    const exitListeners: ((exit: WorkerExit) => void)[] = [];
    let exitRecord: WorkerExit | undefined;
    let connected = false;
    let ignoreShutdown = false;
    let keyPaths: string[] = [];

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
        if (exitRecord !== undefined) listener(exitRecord);
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
      crash(record) {
        exit({ exitCode: 1, signal: null, stderrClass: 'unknown', ...record });
      },
    };

    function exit(
      record: WorkerExit = process.killed
        ? { exitCode: null, signal: 'SIGKILL', stderrClass: 'none' }
        : { exitCode: 0, signal: null, stderrClass: 'none' },
    ): void {
      if (process.exited) return;
      process.exited = true;
      exitRecord = record;
      for (const listener of exitListeners.splice(0)) listener(record);
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
    const fail = (
      id: string,
      code: ExchangeErrorCode,
      retryAfterMs?: number,
      aadsts?: number,
      detail?: StandInErrorDetail,
    ): void => {
      emit(
        encodeLine({
          v: 1,
          id,
          ok: false,
          error: {
            code,
            ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
            ...(aadsts === undefined ? {} : { aadsts }),
            ...(detail === undefined ? {} : { detail }),
          },
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
      certificate: { format: string; certificate: string; privateKey: string },
    ): void {
      process.certificateSeen = {
        format: certificate.format,
        certificate: certificate.certificate,
        privateKey: certificate.privateKey,
      };
      const mode = connectMode;
      // The fallback: the script writes the key to a file in its scratch directory for the connect.
      if (launchOptions.certificateMode === 'tmpfs' && launchOptions.scratchDir !== undefined) {
        const stem = `${launchOptions.scratchDir}/${String(process.filesWritten)}`;
        // The script writes the PEMs and derives the PKCS#12 from them (here: the bytes of the key stand in for it).
        const written: [string, string][] = [
          [`${stem}-c.pem`, certificate.certificate],
          [`${stem}-k.pem`, certificate.privateKey],
          [`${stem}-p.pfx`, certificate.privateKey],
        ];
        keyPaths = written.map(([path]) => path);
        for (const [path, text] of written) options.files?.write(path, Buffer.from(text, 'utf8'));
        process.filesWritten += 1;
      }
      const clean = (): void => {
        if (!leaveFile) for (const path of keyPaths) options.files?.remove(path);
      };
      if (mode === 'hang' || mode === 'hang-with-file') return;
      if (mode === 'exit' || mode === 'exit-with-file') {
        if (mode === 'exit') clean();
        exit();
        return;
      }
      clean();
      if (typeof mode === 'object' && 'error' in mode) {
        fail(id, mode.error, mode.retryAfterMs, mode.aadsts, mode.detail);
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
        fail(id, action.error, action.retryAfterMs, undefined, action.detail);
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

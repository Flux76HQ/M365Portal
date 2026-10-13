// The session with the Exchange worker (Phase D, T-D-112, T-D-114; FR-D-102 to FR-D-104, FR-D-107;
// plan 5.1). It owns one `pwsh` process at a time, started at the first request:
//
//   request -> validate against the allow-list (nothing is written, the worker is not even started,
//              for a call that breaks it) -> queue (requests are serial) -> start or recycle the
//              worker -> write one line -> wait for the answer with the same id -> resolve.
//
// Starting a worker: the credential source is read, the process is launched, the first line is the
// `connect` message (the certificate travels in it, in memory: key-handover.ts), and the worker must
// answer with the hashes of the allow-list and of the projections that this server was built with
// (generated-allow-list.ts): a worker that runs a script made from another table is stopped.
//
// A worker lives until it has served `workerMaxCalls` calls or is `workerMaxAgeSeconds` old (R-D-03:
// repeated connect and disconnect can leak memory); the next call after that starts a new one, the
// old one is sent `shutdown` and, if it does not leave within five seconds, killed. A call that is
// not answered by its deadline kills the worker (the cmdlet cannot be cancelled inside it) and fails;
// a crash fails the call in flight; both leave the session ready to start a new worker. What the
// session throws carries a fixed `reason`, never text of the worker or of a request (FR-D-107):
//   ExchangeUnsupportedError  `not_allowed`: the call breaks the allow-list, or its deadline is out of range
//   ExchangeUnavailableError  `worker_start_failed`, `worker_timeout`, `worker_crashed`,
//                             `worker_protocol`, `worker_closed`, `role_pending`
//   ExchangeCommandError      the connect was refused (`permission_denied`, `throttled` ...)
// A command error of a CALL is data: the answer with `ok: false` is returned, and the client decides.
import { validateCall } from '@m365portal/shared/exchange/allow-list';
import {
  createLineDecoder,
  encodeLine,
  parseResponseLine,
  type ExchangeResponse,
} from '@m365portal/shared/exchange/protocol';
import { LIMITS } from '@m365portal/shared/limits';
import type { Clock, RandomSource, Scheduler } from '../../../ports/clock.js';
import {
  ExchangeCommandError,
  ExchangeUnavailableError,
  ExchangeUnsupportedError,
} from '../../../ports/errors.js';
import { ALLOW_LIST_MANIFEST_SHA256, PROJECTION_MANIFEST_SHA256 } from './generated-allow-list.js';
import {
  DEFAULT_HANDOVER,
  DEFAULT_TMPFS_ROOT,
  buildConnectLine,
  createScratchManager,
  nodeScratchFileSystem,
  type ExchangeCredentialSource,
  type HandoverConfig,
  type ScratchFileSystem,
  type ScratchManager,
} from './key-handover.js';
import type { WorkerLauncher, WorkerProcess } from './worker-launcher.js';

/** What the Exchange code logs: fixed fields only, no name, no address, no argument (FR-D-107). */
export interface ExchangeLog {
  debug(fields: Readonly<Record<string, unknown>>, message: string): void;
  warn(fields: Readonly<Record<string, unknown>>, message: string): void;
}

export interface SessionRequest {
  readonly cmdlet: string;
  readonly args: Record<string, unknown>;
  /** 1 s to `callDeadlineSeconds`; default the limit. */
  readonly deadlineMs?: number;
}

export interface SessionAnswer {
  readonly id: string;
  readonly response: ExchangeResponse;
}

/** What the client needs of a session; `ExchangeWorkerSession` is the real one. */
export interface ExchangeSession {
  request(call: SessionRequest): Promise<SessionAnswer>;
  ping(): Promise<boolean>;
  /** Ends the worker at once; the next request starts a new one (a lost connection, a stuck state). */
  reset(): Promise<void>;
  close(): Promise<void>;
}

export interface SessionLimits {
  readonly maxCalls?: number;
  readonly maxAgeSeconds?: number;
}

export interface SessionDeps {
  readonly launcher: WorkerLauncher;
  readonly credentials: ExchangeCredentialSource;
  readonly clock: Clock;
  readonly scheduler: Scheduler;
  readonly random: RandomSource;
  readonly log?: ExchangeLog;
  /** `memory` (default) or the tmpfs fallback. */
  readonly handover?: HandoverConfig;
  /** The file system of the fallback; default the real one. */
  readonly scratchFs?: ScratchFileSystem;
  readonly limits?: SessionLimits;
  /** The hashes a worker must report; default the ones this build was generated with. */
  readonly expectedHashes?: { readonly allowList: string; readonly projection: string };
}

/** After `shutdown` a worker has this long to leave before it is killed. */
const SHUTDOWN_GRACE_MS = 5_000;
const DEADLINE_MIN_MS = 1_000;
const DEADLINE_MAX_MS = LIMITS.exchange.callDeadlineSeconds * 1000;

interface Pending {
  readonly id: string;
  readonly resolve: (response: ExchangeResponse) => void;
  readonly reject: (error: Error) => void;
  timer: unknown;
}

interface Worker {
  readonly process: WorkerProcess;
  readonly startedAt: number;
  readonly scratchDir: string | undefined;
  calls: number;
  alive: boolean;
  /** Set when the session itself asked the worker to leave (`shutdown`): its exit is not a crash. */
  stopping: boolean;
  pending: Pending | undefined;
}

function unavailable(reason: string, id?: string): ExchangeUnavailableError {
  return new ExchangeUnavailableError({
    reason,
    ...(id === undefined ? {} : { clientRequestId: id }),
  });
}

export class ExchangeWorkerSession implements ExchangeSession {
  readonly #deps: SessionDeps;
  readonly #handover: HandoverConfig;
  readonly #scratch: ScratchManager | undefined;
  readonly #maxCalls: number;
  readonly #maxAgeMs: number;
  readonly #hashes: { allowList: string; projection: string };
  readonly #prefix: string;
  #counter = 0;
  #launches = 0;
  #worker: Worker | undefined;
  #tail: Promise<unknown> = Promise.resolve();
  /** Set when `close()` is called: later requests are refused, those already queued are served. */
  #closing = false;

  constructor(deps: SessionDeps) {
    this.#deps = deps;
    this.#handover = deps.handover ?? DEFAULT_HANDOVER;
    this.#maxCalls = deps.limits?.maxCalls ?? LIMITS.exchange.workerMaxCalls;
    this.#maxAgeMs = (deps.limits?.maxAgeSeconds ?? LIMITS.exchange.workerMaxAgeSeconds) * 1000;
    this.#hashes = deps.expectedHashes ?? {
      allowList: ALLOW_LIST_MANIFEST_SHA256,
      projection: PROJECTION_MANIFEST_SHA256,
    };
    this.#prefix = Array.from(deps.random.bytes(4), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    this.#scratch =
      this.#handover.mode === 'tmpfs'
        ? createScratchManager({
            fs: deps.scratchFs ?? nodeScratchFileSystem,
            root: this.#handover.tmpfsRoot ?? DEFAULT_TMPFS_ROOT,
            random: deps.random,
          })
        : undefined;
  }

  request(call: SessionRequest): Promise<SessionAnswer> {
    const id = this.#nextId();
    const started = this.#deps.clock.now();
    if (this.#closing) return Promise.reject(unavailable('worker_closed', id));
    // The allow-list first, and synchronously: a refused call never waits in the queue and never starts a worker.
    const checked = validateCall(call.cmdlet, call.args);
    const deadlineMs = call.deadlineMs ?? DEADLINE_MAX_MS;
    if (
      !checked.ok ||
      !Number.isInteger(deadlineMs) ||
      deadlineMs < DEADLINE_MIN_MS ||
      deadlineMs > DEADLINE_MAX_MS
    ) {
      this.#deps.log?.warn(
        { event: 'exchange_call', requestId: id, outcome: 'refused', durationMs: 0 },
        'exchange call refused',
      );
      return Promise.reject(new ExchangeUnsupportedError({ reason: 'not_allowed' }));
    }
    const cmdlet = checked.cmdlet;
    // The copy the allow-list validated is what is written: the caller may change its object afterwards.
    const args = checked.args;
    return this.#enqueue(async () => {
      const worker = await this.#ready(id);
      const message = encodeLine({ v: 1, type: 'call', id, cmdlet, args, deadlineMs });
      try {
        const response = await this.#exchange(worker, id, message, deadlineMs);
        worker.calls += 1;
        this.#deps.log?.debug(
          {
            event: 'exchange_call',
            requestId: id,
            cmdlet,
            outcome: outcomeOf(response),
            durationMs: this.#deps.clock.now() - started,
          },
          'exchange call',
        );
        return { id, response };
      } catch (failure) {
        this.#deps.log?.warn(
          {
            event: 'exchange_call',
            requestId: id,
            cmdlet,
            outcome:
              failure instanceof ExchangeUnavailableError
                ? outcomeOfReason(failure.reason)
                : 'protocol',
            durationMs: this.#deps.clock.now() - started,
          },
          'exchange call failed',
        );
        throw failure;
      }
    });
  }

  ping(): Promise<boolean> {
    const id = this.#nextId();
    if (this.#closing) return Promise.reject(unavailable('worker_closed', id));
    return this.#enqueue(async () => {
      const worker = await this.#ready(id);
      const response = await this.#exchange(
        worker,
        id,
        encodeLine({ v: 1, type: 'ping', id }),
        DEADLINE_MAX_MS,
      );
      return response.ok;
    });
  }

  reset(): Promise<void> {
    return this.#enqueue(() => {
      const worker = this.#worker;
      if (worker !== undefined) this.#kill(worker);
      return Promise.resolve();
    });
  }

  /** Sends `shutdown` to the worker, waits for it to leave (or kills it), and refuses every later request. */
  close(): Promise<void> {
    this.#closing = true;
    return this.#enqueue(async () => {
      const worker = this.#worker;
      if (worker !== undefined) await this.#stop(worker, 'closed');
    });
  }

  // ---- the queue ---------------------------------------------------------------------------

  #nextId(): string {
    this.#counter += 1;
    return `${this.#prefix}-${String(this.#counter).padStart(8, '0')}`;
  }

  #enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(job);
    this.#tail = run.catch(() => undefined);
    return run;
  }

  // ---- starting, recycling, stopping --------------------------------------------------------

  async #ready(id: string): Promise<Worker> {
    const current = this.#worker;
    if (current !== undefined) {
      const due =
        current.calls >= this.#maxCalls ||
        this.#deps.clock.now() - current.startedAt >= this.#maxAgeMs;
      if (current.alive && !due) return current;
      if (current.alive) await this.#stop(current, 'recycled');
      this.#worker = undefined;
    }
    return this.#start(id);
  }

  async #start(id: string): Promise<Worker> {
    let scratchDir: string | undefined;
    if (this.#scratch !== undefined) {
      try {
        this.#scratch.prepare();
      } catch {
        throw unavailable('worker_start_failed', id);
      }
    }
    let connectLine: string;
    try {
      const credential = await this.#deps.credentials.load();
      connectLine = buildConnectLine(`${id}-c`, credential);
    } catch {
      // The reason is a fixed word: the failure of the credential store can hold a path.
      throw unavailable('worker_start_failed', id);
    }
    let process: WorkerProcess;
    try {
      if (this.#scratch !== undefined) scratchDir = this.#scratch.create();
      process = this.#deps.launcher.launch({
        certificateMode: this.#handover.mode,
        ...(scratchDir === undefined ? {} : { scratchDir }),
      });
    } catch {
      if (scratchDir !== undefined) this.#scratch?.remove(scratchDir);
      throw unavailable('worker_start_failed', id);
    }
    this.#launches += 1;
    const worker: Worker = {
      process,
      startedAt: this.#deps.clock.now(),
      scratchDir,
      calls: 0,
      alive: true,
      stopping: false,
      pending: undefined,
    };
    this.#worker = worker;
    this.#wire(worker);
    this.#deps.log?.debug(
      { event: 'exchange_worker', outcome: 'ok', launches: this.#launches },
      'exchange worker started',
    );

    let hello: ExchangeResponse;
    try {
      hello = await this.#exchange(worker, `${id}-c`, connectLine, DEADLINE_MAX_MS);
    } catch (failure) {
      this.#kill(worker);
      throw failure;
    }
    if (!hello.ok) {
      this.#kill(worker);
      // A code of the closed list and, for a refusal of the sign-in service, the number of its AADSTS code
      // (digits only): enough to tell a missing consent or role from another fault, and no text (FR-D-107).
      this.#deps.log?.warn(
        {
          event: 'exchange_worker',
          reason: 'connect_refused',
          code: hello.error.code,
          aadsts: hello.error.aadsts ?? null,
          errorType: hello.error.detail?.type ?? null,
          errorId: hello.error.detail?.errorId ?? null,
        },
        'exchange worker connect refused',
      );
      throw connectError(hello.error.code, hello.error.retryAfterMs);
    }
    const data = hello.data;
    const hashes =
      typeof data === 'object' && data !== null && !Array.isArray(data) ? data : undefined;
    if (
      hashes?.allowListSha256 !== this.#hashes.allowList ||
      hashes.projectionSha256 !== this.#hashes.projection
    ) {
      // A script made from another table: stop it, whatever else it says (PD-02).
      this.#kill(worker);
      throw unavailable('worker_protocol', id);
    }
    return worker;
  }

  /** Reads stdout line by line; an answer for the pending request resolves it, anything unreadable ends the worker. */
  #wire(worker: Worker): void {
    const decoder = createLineDecoder();
    const onItems = (items: ReturnType<typeof decoder.push>): void => {
      for (const item of items) {
        if (!worker.alive) return;
        if (item.kind === 'overflow') {
          this.#protocolViolation(worker);
          return;
        }
        if (item.kind !== 'line') continue;
        const parsed = parseResponseLine(item.text);
        // A banner or a warning on stdout is not the protocol and not an attack: skip it.
        if (!parsed.ok && parsed.reason === 'not_json') continue;
        if (!parsed.ok) {
          this.#protocolViolation(worker);
          return;
        }
        const pending = worker.pending;
        if (pending?.id === parsed.value.id) {
          this.#settle(worker, pending);
          pending.resolve(parsed.value);
        }
        // An answer for another id belongs to nobody: ignored.
      }
    };
    worker.process.onData((chunk) => {
      onItems(decoder.push(chunk));
    });
    worker.process.onExit((exit) => {
      onItems(decoder.flush());
      // Once per worker: how the process ended, as numbers and a word of a closed list, never its text.
      // A crash (nobody asked it to end) is a warning; a stop or a kill by this session is a debug line.
      const expected = !worker.alive || worker.stopping;
      if (expected) {
        this.#deps.log?.debug(
          {
            event: 'exchange_worker',
            reason: 'exited',
            exitCode: exit.exitCode,
            signal: exit.signal,
            stderrClass: exit.stderrClass,
          },
          'exchange worker exited',
        );
      } else {
        this.#deps.log?.warn(
          {
            event: 'exchange_worker',
            reason: 'exited',
            exitCode: exit.exitCode,
            signal: exit.signal,
            stderrClass: exit.stderrClass,
          },
          'exchange worker crashed',
        );
      }
      worker.alive = false;
      if (worker.scratchDir !== undefined) this.#scratch?.remove(worker.scratchDir);
      const pending = worker.pending;
      if (pending !== undefined) {
        this.#settle(worker, pending);
        pending.reject(unavailable('worker_crashed', pending.id));
      }
    });
  }

  #settle(worker: Worker, pending: Pending): void {
    this.#deps.scheduler.clearTimeout(pending.timer);
    if (worker.pending === pending) worker.pending = undefined;
  }

  #protocolViolation(worker: Worker): void {
    const pending = worker.pending;
    // Settled before the kill: the exit handler must not find it and call it a crash.
    if (pending !== undefined) this.#settle(worker, pending);
    this.#kill(worker);
    pending?.reject(unavailable('worker_protocol', pending.id));
  }

  /** One line out, one answer in, with a deadline that kills the worker. */
  #exchange(
    worker: Worker,
    id: string,
    line: string,
    deadlineMs: number,
  ): Promise<ExchangeResponse> {
    return new Promise<ExchangeResponse>((resolve, reject) => {
      if (!worker.alive) {
        reject(unavailable('worker_crashed', id));
        return;
      }
      const pending: Pending = {
        id,
        resolve,
        reject,
        timer: this.#deps.scheduler.setTimeout(() => {
          this.#settle(worker, pending);
          this.#kill(worker);
          reject(unavailable('worker_timeout', id));
        }, deadlineMs),
      };
      worker.pending = pending;
      worker.process.write(line);
    });
  }

  #kill(worker: Worker): void {
    worker.alive = false;
    worker.process.kill();
    if (worker.scratchDir !== undefined) this.#scratch?.remove(worker.scratchDir);
    if (this.#worker === worker) this.#worker = undefined;
  }

  /** `shutdown`, close stdin, wait for the exit; kill after the grace period. */
  async #stop(worker: Worker, reason: 'recycled' | 'closed'): Promise<void> {
    if (worker.alive) {
      worker.stopping = true;
      const exited = new Promise<void>((resolve) => {
        worker.process.onExit(() => {
          resolve();
        });
      });
      const grace = new Promise<void>((resolve) => {
        const timer = this.#deps.scheduler.setTimeout(() => {
          this.#kill(worker);
          resolve();
        }, SHUTDOWN_GRACE_MS);
        void exited.then(() => {
          this.#deps.scheduler.clearTimeout(timer);
          resolve();
        });
      });
      worker.process.write(encodeLine({ v: 1, type: 'shutdown', id: this.#nextId() }));
      worker.process.end();
      await grace;
    }
    worker.alive = false;
    if (worker.scratchDir !== undefined) this.#scratch?.remove(worker.scratchDir);
    if (this.#worker === worker) this.#worker = undefined;
    this.#deps.log?.debug(
      { event: 'exchange_worker', reason, launches: this.#launches },
      'exchange worker stopped',
    );
  }
}

function connectError(code: string, retryAfterMs: number | undefined): Error {
  if (code === 'role_pending') return unavailable('role_pending');
  if (code === 'permission_denied' || code === 'throttled' || code === 'timeout') {
    return new ExchangeCommandError(
      code,
      retryAfterMs === undefined ? undefined : { retryAfterMs },
    );
  }
  return unavailable('worker_start_failed');
}

function outcomeOf(response: ExchangeResponse): string {
  if (response.ok) return 'ok';
  if (response.error.code === 'throttled') return 'throttled';
  if (response.error.code === 'timeout') return 'timeout';
  return 'command_error';
}

function outcomeOfReason(reason: string): string {
  if (reason === 'worker_timeout') return 'timeout';
  if (reason === 'worker_crashed') return 'crashed';
  if (reason === 'worker_protocol') return 'protocol';
  return 'refused';
}

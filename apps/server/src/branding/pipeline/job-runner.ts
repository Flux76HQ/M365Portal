// The image job runner (T-A-083; FR-A-097, FR-A-088 time budget; PD-08, V-19; E-28, H-39). The main
// process never decodes, rasterises or encodes an image: it hands the bytes to a child process, one
// fresh child per job, and gets PNG bytes back. A worker thread would not do: `worker.terminate()`
// does not stop a native libvips or librsvg call that is already running, so a hostile input would
// keep a core busy and pile up in the shared libuv pool (plan V-19); a child that is killed is gone.
//
// What the runner guarantees:
//   - at most `maxRunning` children run (2) and `maxQueued` jobs wait (4); the next job is refused
//     at once with 429 `image_processing_busy` and a Retry-After hint. The decision is made in the
//     call itself, before any waiting, so a burst of simultaneous jobs cannot slip past it;
//   - a job gets `timeBudgetMs` (10 s) from the start of its child. Over it the child is killed with
//     SIGKILL and the job fails with 422 `image_processing_timeout`. The job settles only after the
//     child has exited, so the answer means "the process is gone", and a slot is never given away
//     while its child is still burning a core;
//   - a child is started with an empty environment, the three standard streams on /dev/null and the
//     IPC channel as its only channel, a heap cap, and the permission model of Node: it may read the
//     directory of its own bundle and the `node_modules` it needs, and nothing else; it may not write
//     a file, start a process or a thread. (Node 22 has no switch for the network: the worker has
//     none of its own code that could use it, which `job-runner.test.ts` checks on its import closure.)
//   - everything the child answers is checked against the wire format before it is used
//     (`job-protocol.ts`); a child that crashes, stalls or lies is a worker fault (500), never a
//     client error, and never leaves a process behind;
//   - `shutdown()` kills every running child, fails the waiting jobs and refuses new ones with 503
//     `shutting_down`.
//
// The main process does not import any image code from here: this module and the protocol hold no
// reference to sharp, so the main process holds no libvips (the test checks the import closure).
import { fork, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LIMITS } from '@m365portal/shared/limits';
import type { AssetSlot, UploadWarning } from '@m365portal/shared/schemas/assets';
import { ProblemError } from '../../http/problem.js';
import {
  ICON_KINDS,
  ICON_SIZES,
  PROTOCOL_VERSION,
  decodeBytes,
  encodeBytes,
  parseJobReply,
  readPngSize,
  type IconKind,
  type IconPlate,
  type IconSource,
  type JobKind,
  type JobRequest,
  type UploadJobSuccess,
  type VariantsJobSuccess,
} from './job-protocol.js';

/** The `Retry-After` of a refused job, in seconds: a job is usually done within a second or two. */
export const BUSY_RETRY_AFTER_SECONDS = 5;

/** The heap cap of a child, in megabytes (plan PD-08). */
export const DEFAULT_MAX_OLD_SPACE_MB = 128;

// ---------------------------------------------------------------------------------------------
// Starting a child
// ---------------------------------------------------------------------------------------------

export interface WorkerLaunch {
  /** The absolute path of the child's script. */
  readonly entry: string;
  /** Arguments after the script. */
  readonly args?: readonly string[];
  /** More Node flags before the script (a loader, in development). */
  readonly execArgv?: readonly string[];
  /**
   * The permission model: the child may read these directories and nothing else, may not write, may
   * not start a process or a thread. Left out, the model is not used (development from source, where
   * the TypeScript loader needs a thread of its own).
   */
  readonly readRoots?: readonly string[];
}

export interface WorkerForkOptions {
  readonly execArgv: string[];
  readonly env: Record<string, string>;
  readonly stdio: ['ignore', 'ignore', 'ignore', 'ipc'];
  readonly serialization: 'json';
  readonly windowsHide: true;
}

function assertAbsolute(path: string, what: string): void {
  if (typeof path !== 'string' || path === '' || !isAbsolute(path)) {
    throw new RangeError(`${what} must be an absolute path`);
  }
}

/**
 * How a child is started, as data. Nothing of the parent's environment goes along (`env` is empty, so
 * no secret, no `DATA_DIR`, no proxy setting reaches a process that parses hostile files), the
 * standard streams are closed to /dev/null and the IPC channel is the only way in or out, messages
 * are JSON (see `job-protocol.ts`), and the heap is capped.
 */
export function workerForkOptions(
  launch: WorkerLaunch,
  options: { readonly maxOldSpaceMb?: number } = {},
): WorkerForkOptions {
  assertAbsolute(launch.entry, 'the worker entry');
  const heap = options.maxOldSpaceMb ?? DEFAULT_MAX_OLD_SPACE_MB;
  if (!Number.isInteger(heap) || heap < 16 || heap > 4096) {
    throw new RangeError('the heap limit of the worker is not usable');
  }
  const execArgv = [`--max-old-space-size=${String(heap)}`, ...(launch.execArgv ?? [])];
  if (launch.readRoots !== undefined) {
    for (const root of launch.readRoots) {
      assertAbsolute(root, 'a read root');
      // `--allow-fs-read` takes a comma-separated list; a comma in a path would split it in two.
      if (root.includes(',')) throw new RangeError('a read root must not contain a comma');
    }
    // `--allow-addons` is needed because sharp is a native addon. No `--allow-child-process`, no
    // `--allow-worker`, no `--allow-fs-write`: those stay refused.
    execArgv.push(
      '--permission',
      '--allow-addons',
      ...launch.readRoots.map((root) => `--allow-fs-read=${root}`),
    );
  }
  return {
    execArgv,
    env: {},
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    serialization: 'json',
    windowsHide: true,
  };
}

/** Start a child: a new process running `launch.entry`, with the options above. */
export function forkImageWorker(
  launch: WorkerLaunch,
  options: { readonly maxOldSpaceMb?: number } = {},
): ChildProcess {
  return fork(launch.entry, [...(launch.args ?? [])], workerForkOptions(launch, options));
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The directories a built worker has to read: the one its bundle sits in, every `node_modules` next to
 * it or above it (as the module loader looks them up, and as they really are when they are links),
 * and the `node_modules` that holds sharp (which a package manager may keep somewhere else than the
 * link says). Never a parent of these, never a data directory.
 */
export function defaultReadRoots(entry: string): string[] {
  assertAbsolute(entry, 'the worker entry');
  const roots = new Set<string>();
  const add = (path: string): void => {
    roots.add(path);
    try {
      roots.add(realpathSync(path));
    } catch {
      // A path that does not exist (yet) stays as it is written.
    }
  };
  add(dirname(entry));
  for (let directory = dirname(entry); ; directory = dirname(directory)) {
    const modules = join(directory, 'node_modules');
    if (isDirectory(modules)) add(modules);
    if (dirname(directory) === directory) break;
  }
  try {
    const resolved = realpathSync(createRequire(entry).resolve('sharp'));
    const marker = `${sep}node_modules${sep}`;
    const at = resolved.indexOf(marker);
    if (at >= 0) add(resolved.slice(0, at + marker.length - 1));
  } catch {
    // No sharp to find: the worker will say so when it starts.
  }
  return [...roots];
}

/** A built worker under the permission model with the roots it needs. */
export function hardenedLaunch(entry: string): WorkerLaunch {
  return { entry, readRoots: defaultReadRoots(entry) };
}

/**
 * Where the worker is. Built (`dist/image-worker.js` next to the bundle, TA-09): under the permission
 * model. From source (development and tests): the TypeScript file through the tsx loader, without
 * it, because the loader runs a thread of its own.
 */
export function defaultLaunch(): WorkerLaunch {
  const built = fileURLToPath(new URL('./image-worker.js', import.meta.url));
  if (existsSync(built)) return hardenedLaunch(built);
  const source = fileURLToPath(new URL('../image-worker.ts', import.meta.url));
  const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href;
  return { entry: source, execArgv: ['--import', loader] };
}

// ---------------------------------------------------------------------------------------------
// What a job gives back
// ---------------------------------------------------------------------------------------------

/** A processed upload: always PNG, always bounded, nothing of the input left in it. */
export interface ProcessedImage {
  readonly png: Buffer;
  readonly width: number;
  readonly height: number;
  /** The alpha-weighted mean relative luminance of the visible pixels, 0 to 1, or null. */
  readonly luminance: number | null;
  readonly warnings: readonly UploadWarning[];
}

export interface StoredImage {
  readonly png: Buffer;
  /** SHA-256 of `png`, lower-case hex, computed here, never taken from the child. */
  readonly hash: string;
  readonly width: number;
  readonly height: number;
}

export interface DerivedImage extends StoredImage {
  readonly luminance: number | null;
}

export interface VariantsInput {
  readonly orgName: string;
  readonly accent: string;
  readonly light: Uint8Array | null;
  readonly dark: Uint8Array | null;
  readonly compact: Uint8Array | null;
}

export interface VariantsResult {
  readonly compact: DerivedImage | null;
  readonly compactDerived: boolean;
  readonly source: IconSource;
  readonly plate: IconPlate;
  readonly icons: Readonly<Record<IconKind, StoredImage>>;
}

// ---------------------------------------------------------------------------------------------
// Faults of the worker itself
// ---------------------------------------------------------------------------------------------

export type ImageWorkerFault = 'spawn' | 'send' | 'exited' | 'protocol' | 'internal';

/**
 * The worker failed in a way that is not the input's fault: it could not be started, it died, it said
 * something the protocol does not allow, or it reported an internal failure. The message is generic;
 * the exit code and signal are for the log. Maps to 500 `internal_error`.
 */
export class ImageWorkerError extends Error {
  readonly reason: ImageWorkerFault;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;

  constructor(
    reason: ImageWorkerFault,
    details: { readonly exitCode?: number | null; readonly signal?: NodeJS.Signals | null } = {},
  ) {
    super(`the image worker failed (${reason})`);
    this.name = 'ImageWorkerError';
    this.reason = reason;
    this.exitCode = details.exitCode ?? null;
    this.signal = details.signal ?? null;
  }
}

// ---------------------------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------------------------

/** Told about what the runner does; for the log and for tests. Never throws into the runner. */
export interface JobObserver {
  /** A child was started for a job (`job` counts from 1). */
  spawned?(pid: number, job: number): void;
  /** A job ended, after its child was gone. `outcome` is `ok`, a problem code, or `worker_fault:<reason>`. */
  settled?(info: {
    readonly job: number;
    readonly pid: number;
    readonly outcome: string;
    readonly durationMs: number;
  }): void;
}

export interface ImageJobRunnerOptions {
  /** Where the child is, as a value or computed for each job. Default: `defaultLaunch()`. */
  readonly launch?: WorkerLaunch | (() => WorkerLaunch);
  /** Time budget of one job in milliseconds. Default `LIMITS.image.jobTimeBudgetMs`. */
  readonly timeBudgetMs?: number;
  /** Jobs that run at once. Default `LIMITS.image.concurrentJobs`. */
  readonly maxRunning?: number;
  /** Jobs that wait. Default `LIMITS.image.queuedJobs`. */
  readonly maxQueued?: number;
  /** Heap cap of a child in megabytes. Default 128. */
  readonly maxOldSpaceMb?: number;
  readonly observer?: JobObserver;
}

export interface RunnerStats {
  readonly running: number;
  readonly queued: number;
  /** Children started since the runner was made. */
  readonly started: number;
  /** The most children that ran at the same time. */
  readonly peakRunning: number;
}

export interface ImageJobRunner {
  /** Sniff, sanitise, rasterise and re-encode an upload. */
  process(input: { readonly bytes: Uint8Array; readonly slot: AssetSlot }): Promise<ProcessedImage>;
  /** Derive the compact variant and the icons of a branding. */
  deriveVariants(input: VariantsInput): Promise<VariantsResult>;
  /** Kill every child, fail the waiting jobs, refuse new ones. Safe to call again. */
  shutdown(): Promise<void>;
  stats(): RunnerStats;
}

type SuccessReply = UploadJobSuccess | VariantsJobSuccess;
type Outcome =
  { readonly reply: SuccessReply } | { readonly error: unknown; readonly label: string };

interface Job {
  readonly id: number;
  readonly request: JobRequest;
  readonly kind: JobKind;
  readonly resolve: (reply: SuccessReply) => void;
  readonly reject: (error: unknown) => void;
}

interface Running {
  readonly job: Job;
  readonly child: ChildProcess;
  readonly startedAt: number;
  readonly done: Promise<void>;
  readonly finishDone: () => void;
  outcome: Outcome | undefined;
  exited: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timer: NodeJS.Timeout | undefined;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function describeOutcome(outcome: Outcome): string {
  if ('reply' in outcome) return 'ok';
  return outcome.label;
}

export function createImageJobRunner(options: ImageJobRunnerOptions = {}): ImageJobRunner {
  const budgetMs = options.timeBudgetMs ?? LIMITS.image.jobTimeBudgetMs;
  const maxRunning = options.maxRunning ?? LIMITS.image.concurrentJobs;
  const maxQueued = options.maxQueued ?? LIMITS.image.queuedJobs;
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
    throw new RangeError('the time budget of an image job must be a positive number');
  }
  if (
    !Number.isInteger(maxRunning) ||
    maxRunning < 1 ||
    !Number.isInteger(maxQueued) ||
    maxQueued < 0
  ) {
    throw new RangeError('the limits of the job runner are not usable');
  }

  let launchOption = options.launch;
  const resolveLaunch = (): WorkerLaunch => {
    if (typeof launchOption === 'function') return launchOption();
    launchOption ??= defaultLaunch();
    return launchOption;
  };

  const running = new Set<Running>();
  const queue: Job[] = [];
  let closing = false;
  let nextId = 1;
  let started = 0;
  let peakRunning = 0;

  const notify = (call: () => void): void => {
    try {
      call();
    } catch {
      // An observer that fails must not fail a job.
    }
  };

  /** The slot is free again: give it to the oldest waiting job. */
  const drain = (): void => {
    while (!closing && running.size < maxRunning) {
      const next = queue.shift();
      if (next === undefined) return;
      start(next);
    }
  };

  /** Everything after the child is gone: free the slot, answer the job, start the next one. */
  const settle = (state: Running): void => {
    if (!running.delete(state) || state.outcome === undefined) return;
    if (state.timer !== undefined) clearTimeout(state.timer);
    const { outcome, job } = state;
    notify(() => {
      options.observer?.settled?.({
        job: job.id,
        pid: state.child.pid ?? -1,
        outcome: describeOutcome(outcome),
        durationMs: Date.now() - state.startedAt,
      });
    });
    if ('reply' in outcome) job.resolve(outcome.reply);
    else job.reject(outcome.error);
    state.finishDone();
    drain();
  };

  /**
   * Record how a job ended, once. The child is killed if it is still there, and the job settles when it
   * has exited: so an answer always means that the process is gone.
   */
  const conclude = (state: Running, outcome: Outcome): void => {
    if (state.outcome !== undefined) return;
    state.outcome = outcome;
    if (state.timer !== undefined) clearTimeout(state.timer);
    if (state.exited) {
      settle(state);
      return;
    }
    if (state.child.pid === undefined) {
      // The process never started: there is nothing to wait for.
      state.exited = true;
      settle(state);
      return;
    }
    state.child.kill('SIGKILL');
  };

  const start = (job: Job): void => {
    let child: ChildProcess;
    try {
      child = forkImageWorker(
        resolveLaunch(),
        options.maxOldSpaceMb === undefined ? {} : { maxOldSpaceMb: options.maxOldSpaceMb },
      );
    } catch {
      job.reject(new ImageWorkerError('spawn'));
      return;
    }
    let finishDone: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      finishDone = resolve;
    });
    const state: Running = {
      job,
      child,
      startedAt: Date.now(),
      done,
      finishDone,
      outcome: undefined,
      exited: false,
      exitCode: null,
      signal: null,
      timer: undefined,
    };
    running.add(state);
    started += 1;
    peakRunning = Math.max(peakRunning, running.size);
    notify(() => {
      options.observer?.spawned?.(child.pid ?? -1, job.id);
    });

    state.timer = setTimeout(() => {
      conclude(state, {
        error: new ProblemError('image_processing_timeout'),
        label: 'image_processing_timeout',
      });
    }, budgetMs);

    /** The process has exited and its channel is closed: nothing more can arrive. */
    const closed = (): void => {
      if (!state.exited || child.connected) return;
      conclude(state, {
        error: new ImageWorkerError('exited', { exitCode: state.exitCode, signal: state.signal }),
        label: 'worker_fault:exited',
      });
    };

    child.on('message', (raw: unknown) => {
      if (state.outcome !== undefined) return;
      try {
        const reply = parseJobReply(raw, job.kind);
        if (reply.ok) conclude(state, { reply });
        else if (reply.failure === 'problem') {
          conclude(state, { error: new ProblemError(reply.code), label: reply.code });
        } else {
          conclude(state, {
            error: new ImageWorkerError('internal'),
            label: 'worker_fault:internal',
          });
        }
      } catch {
        conclude(state, {
          error: new ImageWorkerError('protocol'),
          label: 'worker_fault:protocol',
        });
      }
    });
    child.on('error', () => {
      conclude(state, { error: new ImageWorkerError('spawn'), label: 'worker_fault:spawn' });
    });
    child.on('disconnect', closed);
    child.on('exit', (code, signal) => {
      state.exited = true;
      state.exitCode = code;
      state.signal = signal;
      if (state.outcome !== undefined) {
        settle(state);
        return;
      }
      // A reply sent just before the exit may still be on its way: the channel closing says it is not.
      closed();
    });

    child.send(job.request, (failure) => {
      if (failure !== null) {
        conclude(state, { error: new ImageWorkerError('send'), label: 'worker_fault:send' });
      }
    });
  };

  const submit = (request: JobRequest): Promise<SuccessReply> =>
    new Promise<SuccessReply>((resolve, reject) => {
      // The decision is made here, synchronously, so that a burst of calls is counted one by one.
      if (closing) {
        reject(new ProblemError('shutting_down'));
        return;
      }
      const job: Job = { id: nextId, request, kind: request.kind, resolve, reject };
      if (running.size < maxRunning) {
        nextId += 1;
        start(job);
      } else if (queue.length < maxQueued) {
        nextId += 1;
        queue.push(job);
      } else {
        reject(
          new ProblemError('image_processing_busy', {
            retryAfterSeconds: BUSY_RETRY_AFTER_SECONDS,
          }),
        );
      }
    });

  const stored = (png: Buffer, width: number, height: number): StoredImage => ({
    png,
    hash: sha256Hex(png),
    width,
    height,
  });

  return {
    async process(input) {
      if (input.bytes.length > LIMITS.body.logoFileBytes) {
        throw new ProblemError('payload_too_large');
      }
      const reply = await submit({
        v: PROTOCOL_VERSION,
        kind: 'upload',
        slot: input.slot,
        bytes: encodeBytes(input.bytes),
      });
      if (reply.kind !== 'upload') throw new ImageWorkerError('protocol');
      return {
        png: decodeBytes(reply.png, LIMITS.body.logoFileBytes),
        width: reply.width,
        height: reply.height,
        luminance: reply.luminance,
        warnings: reply.warnings,
      };
    },

    async deriveVariants(input) {
      const encode = (bytes: Uint8Array | null): string | null =>
        bytes === null ? null : encodeBytes(bytes);
      const reply = await submit({
        v: PROTOCOL_VERSION,
        kind: 'variants',
        orgName: input.orgName,
        accent: input.accent,
        light: encode(input.light),
        dark: encode(input.dark),
        compact: encode(input.compact),
      });
      if (reply.kind !== 'variants') throw new ImageWorkerError('protocol');
      const image = (text: string): { png: Buffer; width: number; height: number } => {
        const png = decodeBytes(text, LIMITS.body.logoFileBytes);
        const size = readPngSize(png);
        if (size === null) throw new ImageWorkerError('protocol');
        return { png, ...size };
      };
      const icons = {} as Record<IconKind, StoredImage>;
      for (const kind of ICON_KINDS) {
        const { png } = image(reply.icons[kind]);
        icons[kind] = stored(png, ICON_SIZES[kind], ICON_SIZES[kind]);
      }
      let compact: DerivedImage | null = null;
      if (reply.compact !== null) {
        const { png, width, height } = image(reply.compact.png);
        compact = { ...stored(png, width, height), luminance: reply.compact.luminance };
      }
      return {
        compact,
        compactDerived: reply.compactDerived,
        source: reply.source,
        plate: reply.plate,
        icons,
      };
    },

    async shutdown() {
      closing = true;
      for (const job of queue.splice(0)) job.reject(new ProblemError('shutting_down'));
      const waiting = [...running];
      for (const state of waiting) {
        conclude(state, { error: new ProblemError('shutting_down'), label: 'shutting_down' });
      }
      await Promise.all(waiting.map((state) => state.done));
    },

    stats: () => ({ running: running.size, queued: queue.length, started, peakRunning }),
  };
}

// ---------------------------------------------------------------------------------------------
// The shape the hostile-corpus runner drives
// ---------------------------------------------------------------------------------------------

/** What `hostile-harness.ts` calls a pipeline: bytes in, PNG and warnings out, or an error with a code. */
export interface PipelineSubjectLike {
  process(input: { readonly bytes: Uint8Array; readonly slot: AssetSlot }): Promise<{
    readonly png: Uint8Array;
    readonly warnings: readonly UploadWarning[];
  }>;
  /** The most jobs that ran at once so far. */
  maxRunning(): number;
  close(): Promise<void>;
}

/**
 * The whole pipeline from bytes to PNG as the corpus runner drives it: the job runner over the child
 * process. This is what `viaPipeline` of `server/branding/hostile-uploads.test.ts` loads.
 */
export function createPipelineSubject(options: ImageJobRunnerOptions = {}): PipelineSubjectLike {
  const runner = createImageJobRunner(options);
  return {
    process: async (input) => {
      const result = await runner.process(input);
      return { png: result.png, warnings: result.warnings };
    },
    maxRunning: () => runner.stats().peakRunning,
    close: () => runner.shutdown(),
  };
}

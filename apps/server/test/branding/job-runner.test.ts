// The image job runner and its child-process worker (T-A-083; FR-A-097, FR-A-088 time budget; PD-08,
// V-19; E-28, H-39). Image work runs in one fresh child process per job, never in a worker thread: a
// terminated worker thread leaves a native libvips or librsvg call running (plan V-19), a killed child
// is gone.
//
// What is proven here, and how:
//   - how a child is started: an empty environment, standard streams on /dev/null and the IPC channel
//     the only open channel, a heap cap, and the permission model of Node with no file, process or
//     worker access beyond what loading the worker needs. Read from a real child that reports what it
//     can see and do, not from the option list alone;
//   - the runner against fixture children (answers, never answers, crashes, sends rubbish): at most 2
//     jobs run and 4 wait, the rest are refused with a Retry-After hint; a job over its budget is
//     killed and its pid is gone before the answer; the main process keeps its event loop; a shutdown
//     kills the children and the waiting jobs get `shutting_down`;
//   - the real worker, built the way the S1 build bundles it (TA-09), through that runner: the same
//     bytes as the in-process code, 20 simultaneous valid jobs (H-39), a child that exits by itself
//     when its parent goes away, and an import closure with nothing that opens a file, a socket or a
//     process.
// No test sleeps for a fixed time: every wait is for an event or for a condition with a deadline.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { dirname, join, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { relativeLuminance } from '@m365portal/shared/branding/contrast';
import { PROBLEM_CODES } from '@m365portal/shared/problem';
import { expectGuardFails } from '@m365portal/shared/testing';
import { build, type Metafile } from 'esbuild';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deriveVariants } from '../../src/branding/pipeline/icons.js';
import { handleJob, type UploadProcessor } from '../../src/branding/pipeline/job-handler.js';
import {
  ICON_KINDS,
  ICON_SIZES,
  JobProtocolError,
  PROTOCOL_VERSION,
  WORKER_FAILURE_CODES,
  decodeBytes,
  encodeBytes,
  parseJobReply,
  parseJobRequest,
} from '../../src/branding/pipeline/job-protocol.js';
import {
  BUSY_RETRY_AFTER_SECONDS,
  ImageWorkerError,
  createImageJobRunner,
  createPipelineSubject,
  defaultReadRoots,
  forkImageWorker,
  hardenedLaunch,
  workerForkOptions,
  type ImageJobRunner,
  type JobObserver,
  type WorkerLaunch,
} from '../../src/branding/pipeline/job-runner.js';
import { describeProblem } from '../../src/http/problem.js';
import { OUTPUT_CHUNK_TYPES, solidPng, walkPng } from '../fixtures/png-chunks.js';
import { startLocalListener } from '../helpers/local-listener.js';

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const serverRoot = fileURLToPath(new URL('../../', import.meta.url));
const childrenScript = fileURLToPath(new URL('./job-children.mjs', import.meta.url));
const blockingScript = fileURLToPath(new URL('../fixtures/blocking-child.mjs', import.meta.url));

/** A launch of a fixture child: it may read only its own file (the permission model is on). */
function fixtureLaunch(mode: string, entry = childrenScript): WorkerLaunch {
  return { entry, args: [`--mode=${mode}`], readRoots: [dirname(entry)] };
}

const uploadJob = (bytes: Uint8Array = solidPng(1, 1, [9, 8, 7])) =>
  ({ bytes, slot: 'logoLight' }) as const;

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Wait for a condition that depends on another process, with a deadline (no fixed sleep). */
async function until(
  condition: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** True while the process exists and is not a zombie that nobody has reaped. */
async function isAlive(pid: number): Promise<boolean> {
  try {
    const stat = await readFile(`/proc/${String(pid)}/stat`, 'utf8');
    // "pid (name) S ...": the state is the first field after the closing parenthesis.
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
  } catch {
    return false;
  }
}

const onLinux = process.platform === 'linux';

/** SIGUSR2 is signal 12: bit 11 of the caught-signal mask in /proc/<pid>/status. */
const SIGUSR2_BIT = 1n << 11n;

/** True once the process has a handler for SIGUSR2 (so that the signal does not end it). */
async function catchesSigusr2(pid: number): Promise<boolean> {
  try {
    const status = await readFile(`/proc/${String(pid)}/status`, 'utf8');
    const caught = /^SigCgt:\s*([0-9a-f]+)$/m.exec(status)?.[1];
    return caught !== undefined && (BigInt(`0x${caught}`) & SIGUSR2_BIT) !== 0n;
  } catch {
    return false;
  }
}

/** Let a `hold` child finish its job: wait until it can receive the signal, then send it. */
async function release(pid: number): Promise<void> {
  await until(() => catchesSigusr2(pid), `process ${String(pid)} to install its signal handler`);
  process.kill(pid, 'SIGUSR2');
}

/** The result of a job that is expected to fail, reduced to what the caller can act on. */
async function failureOf(job: Promise<unknown>): Promise<unknown> {
  return job.then(
    () => {
      throw new Error('the job should have failed');
    },
    (failure: unknown) => failure,
  );
}

class Spawns implements JobObserver {
  readonly pids: number[] = [];
  readonly jobs: number[] = [];
  private readonly waiters: { count: number; done: Deferred<void> }[] = [];

  spawned(pid: number, job: number): void {
    this.pids.push(pid);
    this.jobs.push(job);
    for (const waiter of this.waiters) {
      if (this.pids.length >= waiter.count) waiter.done.resolve();
    }
  }

  /** Resolves when this many children have been started. */
  reached(count: number): Promise<void> {
    if (this.pids.length >= count) return Promise.resolve();
    const done = deferred<undefined>();
    this.waiters.push({ count, done });
    return done.promise;
  }
}

/** The worst gap between two ticks of a 10 ms timer: how long the event loop was held. */
function watchEventLoop(): { stop(): number } {
  let last = performance.now();
  let worst = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last - 10);
    last = now;
  }, 10);
  return {
    stop: () => {
      clearInterval(timer);
      return worst;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The wire format
// ---------------------------------------------------------------------------------------------

const PNG_BYTES = solidPng(1, 1, [9, 8, 7]);
const PNG_BASE64 = encodeBytes(PNG_BYTES);

/** One valid icon per kind, each at the size of its kind. */
function sizedIcons(): Record<(typeof ICON_KINDS)[number], string> {
  return Object.fromEntries(
    ICON_KINDS.map((kind) => [
      kind,
      encodeBytes(solidPng(ICON_SIZES[kind], ICON_SIZES[kind], [1, 2, 3])),
    ]),
  ) as Record<(typeof ICON_KINDS)[number], string>;
}

const uploadReply = {
  v: 1,
  ok: true,
  kind: 'upload',
  png: PNG_BASE64,
  width: 1,
  height: 1,
  luminance: 0.25,
  warnings: [
    { code: 'svg_content_removed', categories: ['script'] },
    { code: 'animation_flattened' },
  ],
};

describe('the wire format', () => {
  it('knows the codes a worker may report and the icons it returns', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect([...WORKER_FAILURE_CODES].sort()).toEqual(
      [
        'image_corrupt',
        'image_empty',
        'image_pixels_exceeded',
        'image_type_unsupported',
        'svg_doctype_forbidden',
        'svg_not_wellformed',
        'svg_text_unsupported',
        'svg_too_complex',
      ].sort(),
    );
    // Every one of them is a code of the registry and a client error (never the runner's own).
    for (const code of WORKER_FAILURE_CODES)
      expect(PROBLEM_CODES[code].status).toBeGreaterThanOrEqual(400);
    expect([...ICON_KINDS]).toEqual([
      'favicon32',
      'appleTouch180',
      'pwa192',
      'pwa512',
      'maskable512',
    ]);
    expect(ICON_SIZES).toEqual({
      favicon32: 32,
      appleTouch180: 180,
      pwa192: 192,
      pwa512: 512,
      maskable512: 512,
    });
  });

  it('carries bytes as canonical base64 and refuses anything else', () => {
    const bytes = Uint8Array.from([0, 1, 2, 250, 251, 252, 253]);
    expect(decodeBytes(encodeBytes(bytes), 100)).toEqual(Buffer.from(bytes));
    for (const bad of ['!!!', 'AAA', 'AA==\n', ' AAAA', 'AAAA AAAA', 'AB==', 'A===', '=AAA']) {
      expectGuardFails((text: string) => decodeBytes(text, 100), bad, { reason: 'base64' });
    }
    expectGuardFails((text: string) => decodeBytes(text, 3), encodeBytes(bytes), {
      reason: 'too long',
    });
    expect(decodeBytes('', 100)).toHaveLength(0);
  });

  it('parses a valid request of each kind and refuses every malformation', () => {
    const upload = { v: 1, kind: 'upload', slot: 'compact', bytes: PNG_BASE64 };
    expect(parseJobRequest(upload)).toEqual({ ...upload, bytes: PNG_BASE64 });
    const variants = {
      v: 1,
      kind: 'variants',
      orgName: 'Acme Corp',
      accent: '#0078d4',
      light: PNG_BASE64,
      dark: null,
      compact: null,
    };
    expect(parseJobRequest(variants)).toEqual(variants);

    const bad: readonly unknown[] = [
      null,
      'upload',
      [],
      {},
      { ...upload, v: 2 },
      { ...upload, v: '1' },
      { ...upload, kind: 'resize' },
      { ...upload, slot: 'logoMiddle' },
      { ...upload, slot: undefined },
      { ...upload, bytes: 5 },
      { ...upload, bytes: 'not base64!' },
      { ...upload, extra: 1 },
      { ...variants, orgName: 5 },
      { ...variants, orgName: 'x'.repeat(300) },
      { ...variants, accent: 5 },
      { ...variants, accent: '#0078d4'.repeat(10) },
      { ...variants, light: 5 },
      { ...variants, light: '?' },
      { ...variants, compact: undefined },
      { ...variants, dark: 'AAA' },
      { ...variants, extra: true },
      { ...variants, light: 'A'.repeat(4 * 800_000) },
    ];
    for (const raw of bad) {
      expectGuardFails(parseJobRequest, raw, { reason: 'job request' });
    }
    expect(() => parseJobRequest(null)).toThrow(JobProtocolError);
    expect(() => parseJobReply(null, 'upload')).toThrow(JobProtocolError);
  });

  it('parses a valid reply of each kind and refuses every malformation', () => {
    const parsedUpload = parseJobReply(uploadReply, 'upload');
    expect(parsedUpload).toMatchObject({ ok: true, kind: 'upload', width: 1, height: 1 });

    const icons = sizedIcons();
    const variants = {
      v: 1,
      ok: true,
      kind: 'variants',
      compact: { png: PNG_BASE64, luminance: null },
      compactDerived: true,
      source: 'light',
      plate: 'dark',
      icons,
    };
    expect(parseJobReply(variants, 'variants')).toMatchObject({ ok: true, kind: 'variants' });
    expect(
      parseJobReply({ ...variants, compact: null, compactDerived: false }, 'variants'),
    ).toMatchObject({ compact: null });
    expect(
      parseJobReply({ v: 1, ok: false, failure: 'problem', code: 'image_corrupt' }, 'upload'),
    ).toEqual({
      v: 1,
      ok: false,
      failure: 'problem',
      code: 'image_corrupt',
    });
    expect(parseJobReply({ v: 1, ok: false, failure: 'internal' }, 'variants')).toEqual({
      v: 1,
      ok: false,
      failure: 'internal',
    });

    const badUpload: readonly unknown[] = [
      null,
      'ok',
      [],
      { ...uploadReply, v: 2 },
      { ...uploadReply, ok: 'yes' },
      { ...uploadReply, kind: 'variants' },
      { ...uploadReply, png: 7 },
      { ...uploadReply, png: '!!' },
      { ...uploadReply, png: encodeBytes(Buffer.from('not a png at all, just text')) },
      { ...uploadReply, png: encodeBytes(PNG_BYTES.subarray(0, 20)) },
      { ...uploadReply, width: 2 },
      { ...uploadReply, height: 0 },
      { ...uploadReply, width: 1.5 },
      { ...uploadReply, luminance: 1.5 },
      { ...uploadReply, luminance: -0.1 },
      { ...uploadReply, luminance: '0.5' },
      { ...uploadReply, luminance: undefined },
      { ...uploadReply, warnings: 'none' },
      { ...uploadReply, warnings: [{ code: 'something_else' }] },
      { ...uploadReply, warnings: [{ code: 'svg_content_removed' }] },
      { ...uploadReply, warnings: [{ code: 'svg_content_removed', categories: [] }] },
      { ...uploadReply, warnings: [{ code: 'svg_content_removed', categories: ['nope'] }] },
      {
        ...uploadReply,
        warnings: [{ code: 'svg_content_removed', categories: ['script', 'script'] }],
      },
      { ...uploadReply, warnings: [{ code: 'animation_flattened', categories: ['script'] }] },
      {
        ...uploadReply,
        warnings: [
          { code: 'animation_flattened' },
          { code: 'animation_flattened' },
          { code: 'animation_flattened' },
        ],
      },
      { ...uploadReply, extra: 1 },
      { v: 1, ok: false, failure: 'problem', code: 'permission_denied' },
      { v: 1, ok: false, failure: 'problem', code: 'image_processing_busy' },
      { v: 1, ok: false, failure: 'problem' },
      { v: 1, ok: false, failure: 'whatever' },
      { v: 1, ok: false },
      { v: 1, ok: false, failure: 'internal', detail: 'the stack of the failure' },
    ];
    for (const raw of badUpload) {
      expectGuardFails((value: unknown) => parseJobReply(value, 'upload'), raw, {
        reason: 'job reply',
      });
    }
    const badVariants: readonly unknown[] = [
      { ...variants, icons: {} },
      { ...variants, icons: { ...icons, favicon32: undefined } },
      { ...variants, icons: { ...icons, extra: PNG_BASE64 } },
      // The size of every icon is fixed by its kind: a 1 by 1 PNG is not a 32 by 32 icon.
      { ...variants, icons: Object.fromEntries(ICON_KINDS.map((kind) => [kind, PNG_BASE64])) },
      { ...variants, icons: { ...icons, pwa512: sizedIcons().pwa192 } },
      // A compact is square and at most 128 pixels.
      {
        ...variants,
        compact: { png: encodeBytes(solidPng(129, 129, [1, 2, 3])), luminance: null },
      },
      { ...variants, compact: { png: encodeBytes(solidPng(4, 2, [1, 2, 3])), luminance: null } },
      { ...variants, source: 'sidebar' },
      { ...variants, plate: 'blue' },
      { ...variants, compactDerived: 'yes' },
      { ...variants, compact: { png: PNG_BASE64 } },
      { ...variants, compact: { png: PNG_BASE64, luminance: 2 } },
      { ...variants, kind: 'upload' },
    ];
    for (const raw of badVariants) {
      expectGuardFails((value: unknown) => parseJobReply(value, 'variants'), raw, {
        reason: 'job reply',
      });
    }
  });

  it('accepts icons only at the size of their kind', () => {
    const icons = sizedIcons();
    const reply = {
      v: 1,
      ok: true,
      kind: 'variants',
      compact: null,
      compactDerived: false,
      source: 'monogram',
      plate: 'accent',
      icons,
    };
    expect(parseJobReply(reply, 'variants')).toMatchObject({ ok: true });
    expectGuardFails(
      (value: unknown) => parseJobReply(value, 'variants'),
      { ...reply, icons: { ...icons, pwa512: encodeBytes(solidPng(256, 256, [1, 2, 3])) } },
      { reason: 'job reply' },
    );
  });
});

// ---------------------------------------------------------------------------------------------
// How a child is started
// ---------------------------------------------------------------------------------------------

interface ProbeReport {
  readonly pid: number;
  readonly env: readonly string[];
  readonly execArgv: readonly string[];
  readonly argv: readonly string[];
  readonly heapLimit: number;
  readonly permissionModel: boolean;
  readonly mayRead: boolean | null;
  readonly mayReadEntry: boolean | null;
  readonly mayWrite: boolean | null;
  readonly readCanary: string;
  readonly writeScratch: string;
  readonly listDirectory: string;
  readonly spawn: string;
  readonly worker: string;
}

async function listFds(pid: number): Promise<{ fd: number; target: string }[]> {
  const names = await readdir(`/proc/${String(pid)}/fd`);
  const entries = await Promise.all(
    names.map(async (name) => {
      try {
        return { fd: Number(name), target: await readlink(`/proc/${String(pid)}/fd/${name}`) };
      } catch {
        return null;
      }
    }),
  );
  return entries.filter((entry) => entry !== null).sort((a, b) => a.fd - b.fd);
}

/** Start a probe child, ask it for its report, and look at its file descriptors from outside. */
async function probeChild(
  launch: WorkerLaunch,
  paths: { canary: string; scratch: string; directory: string },
): Promise<{ report: ProbeReport; fds: { fd: number; target: string }[] }> {
  const child = forkImageWorker(launch);
  try {
    const report = await new Promise<ProbeReport>((resolve, reject) => {
      child.once('message', (message) => {
        resolve(message as ProbeReport);
      });
      child.once('error', reject);
      child.once('exit', (code) => {
        reject(new Error(`the probe child exited with ${String(code)}`));
      });
      child.send({ ask: 'report', ...paths });
    });
    const fds = child.pid === undefined || !onLinux ? [] : await listFds(child.pid);
    return { report, fds };
  } finally {
    child.kill('SIGKILL');
  }
}

describe('how a child is started', () => {
  let workDir = '';
  let canary = '';
  let scratch = '';
  let listener: Server | undefined;

  beforeAll(async () => {
    workDir = await mkdtemp(join(process.env.TMPDIR ?? '/tmp', 'm365portal-job-runner-'));
    canary = join(workDir, 'canary.txt');
    scratch = join(workDir, 'scratch.txt');
    await writeFile(canary, 'a file the child must not be able to read');
    process.env.M365_JOB_CANARY = 'canary-value-that-must-not-reach-the-child';
    // A listening socket in the parent: it must not be inherited by the child.
    listener = createServer();
    await new Promise<void>((resolve) => listener?.listen(0, '127.0.0.1', resolve));
  });

  afterAll(async () => {
    delete process.env.M365_JOB_CANARY;
    await new Promise<void>((resolve) => {
      if (listener === undefined) resolve();
      else
        listener.close(() => {
          resolve();
        });
    });
    await rm(workDir, { recursive: true, force: true });
  });

  it('builds the fork options: empty environment, only the IPC channel, a heap cap, JSON messages', () => {
    const options = workerForkOptions(fixtureLaunch('ok'));
    expect(options.env).toEqual({});
    expect(options.stdio).toEqual(['ignore', 'ignore', 'ignore', 'ipc']);
    expect(options.serialization).toBe('json');
    expect(options.execArgv).toContain('--max-old-space-size=128');
    // The permission model: no file access beyond the roots, no child process, no worker threads
    // (their flags are simply absent), and addons only because sharp is one.
    expect(options.execArgv).toContain('--permission');
    expect(options.execArgv).toContain('--allow-addons');
    expect(options.execArgv).toContain(`--allow-fs-read=${dirname(childrenScript)}`);
    expect(
      options.execArgv.some((flag) => /^--allow-(?:child-process|worker|fs-write|wasi)/.test(flag)),
    ).toBe(false);
    expect(options.execArgv.some((flag) => flag.startsWith('--inspect'))).toBe(false);

    const open = workerForkOptions(
      { entry: childrenScript, args: ['--mode=ok'] },
      { maxOldSpaceMb: 64 },
    );
    expect(open.execArgv).toEqual(['--max-old-space-size=64']);
    expect(open.env).toEqual({});
    expect(open.stdio).toEqual(['ignore', 'ignore', 'ignore', 'ipc']);

    expectGuardFails(
      () => workerForkOptions({ entry: childrenScript, readRoots: ['/a,/b'] }),
      undefined,
      { reason: 'read root' },
    );
    expectGuardFails(() => workerForkOptions({ entry: 'relative/image-worker.js' }), undefined, {
      reason: 'absolute',
    });
    expectGuardFails(
      () => workerForkOptions(fixtureLaunch('ok'), { maxOldSpaceMb: 0 }),
      undefined,
      {
        reason: 'heap',
      },
    );
  });

  it('derives the directories a built worker may read from where it sits and where sharp is', async () => {
    const app = await mkdtemp(join(workDir, 'app-'));
    await mkdir(join(app, 'dist'), { recursive: true });
    await mkdir(join(app, 'node_modules', 'sharp'), { recursive: true });
    await writeFile(
      join(app, 'node_modules', 'sharp', 'package.json'),
      '{"name":"sharp","main":"index.js"}',
    );
    await writeFile(join(app, 'node_modules', 'sharp', 'index.js'), 'module.exports = {};');
    await writeFile(join(app, 'dist', 'image-worker.js'), '');
    const roots = defaultReadRoots(join(app, 'dist', 'image-worker.js'));
    // The bundle's own directory and the node_modules next to it; nothing wider, nothing of /data.
    expect(roots).toContain(join(app, 'dist'));
    expect(roots).toContain(join(app, 'node_modules'));
    expect(roots).not.toContain('/');
    expect(roots).not.toContain(app);
    expect(roots.every((root) => !root.endsWith(sep) || root === sep)).toBe(true);
    expect(new Set(roots).size).toBe(roots.length);
  });

  it.skipIf(!onLinux)(
    'starts a child with nothing of the parent: no environment, no inherited descriptor, a heap cap',
    async () => {
      const { report, fds } = await probeChild(fixtureLaunch('probe'), {
        canary,
        scratch,
        directory: workDir,
      });
      // The parent has a canary variable; the child sees no variable at all.
      expect(process.env.M365_JOB_CANARY).toBeDefined();
      expect(report.env).toEqual([]);
      expect(report.argv).toEqual(['--mode=probe']);
      expect(report.execArgv).toContain('--max-old-space-size=128');
      expect(report.heapLimit).toBeLessThan(200 * 1024 * 1024);

      // The three standard streams are /dev/null; the only socket is the IPC channel; there is no
      // regular file and no second socket (the parent's listening socket and open files did not cross).
      expect(fds.filter((entry) => entry.fd <= 2).map((entry) => entry.target)).toEqual([
        '/dev/null',
        '/dev/null',
        '/dev/null',
      ]);
      const kinds = fds.map((entry) => entry.target);
      for (const target of kinds) {
        expect(target, `descriptor ${target}`).toMatch(
          /^(?:\/dev\/null|socket:\[\d+\]|pipe:\[\d+\]|anon_inode:\[\w+\])$/,
        );
      }
      expect(kinds.filter((target) => target.startsWith('socket:'))).toHaveLength(1);
    },
    30_000,
  );

  it.skipIf(!onLinux)(
    'a control: without the options the same child would have seen the canary',
    async () => {
      const child = spawn(process.execPath, [childrenScript, '--mode=probe'], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: process.env,
      });
      try {
        const report = await new Promise<ProbeReport>((resolve, reject) => {
          child.once('message', (message) => {
            resolve(message as ProbeReport);
          });
          child.once('error', reject);
          child.send({
            ask: 'report',
            canary,
            // Its own scratch file: this child is allowed to write, the others are not.
            scratch: join(workDir, 'control-scratch.txt'),
            directory: workDir,
          });
        });
        expect(report.env).toContain('M365_JOB_CANARY');
        expect(report.writeScratch).toBe('allowed');
        expect(report.permissionModel).toBe(false);
        expect(report.readCanary).toBe('allowed');
      } finally {
        child.kill('SIGKILL');
      }
    },
    30_000,
  );

  it('runs the child under the permission model: no file outside its roots, no write, no process, no thread', async () => {
    const { report } = await probeChild(fixtureLaunch('probe'), {
      canary,
      scratch,
      directory: workDir,
    });
    expect(report.permissionModel).toBe(true);
    expect(report.mayReadEntry).toBe(true);
    expect(report.mayRead).toBe(false);
    expect(report.mayWrite).toBe(false);
    expect(report.readCanary).toBe('ERR_ACCESS_DENIED');
    expect(report.listDirectory).toBe('ERR_ACCESS_DENIED');
    expect(report.writeScratch).toBe('ERR_ACCESS_DENIED');
    expect(report.spawn).toBe('ERR_ACCESS_DENIED');
    expect(report.worker).toBe('ERR_ACCESS_DENIED');
    await expect(readFile(scratch)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 30_000);

  it('opens up only the roots it is given', async () => {
    const { report } = await probeChild(
      { ...fixtureLaunch('probe'), readRoots: [dirname(childrenScript), workDir] },
      { canary, scratch, directory: workDir },
    );
    expect(report.mayRead).toBe(true);
    expect(report.readCanary).toBe('allowed');
    expect(report.listDirectory).toBe('allowed');
    // Reading is not writing, spawning or starting a thread.
    expect(report.writeScratch).toBe('ERR_ACCESS_DENIED');
    expect(report.spawn).toBe('ERR_ACCESS_DENIED');
    expect(report.worker).toBe('ERR_ACCESS_DENIED');
  }, 30_000);
});

// ---------------------------------------------------------------------------------------------
// The runner against fixture children
// ---------------------------------------------------------------------------------------------

function runnerFor(
  mode: string,
  options: Partial<Parameters<typeof createImageJobRunner>[0]> = {},
): { runner: ImageJobRunner; spawns: Spawns } {
  const spawns = new Spawns();
  const runner = createImageJobRunner({
    launch: fixtureLaunch(mode),
    observer: spawns,
    ...options,
  });
  return { runner, spawns };
}

describe('the runner', () => {
  it('starts a fresh child for every job, hands it the bytes, and has no child left afterwards', async () => {
    const { runner, spawns } = runnerFor('echo');
    const input = solidPng(1, 1, [9, 8, 7]);
    const outputs: Buffer[] = [];
    for (let job = 0; job < 3; job += 1) {
      const result = await runner.process({ bytes: input, slot: 'logoLight' });
      outputs.push(result.png);
      expect(result.width).toBe(1);
      expect(result.height).toBe(1);
      expect(result.luminance).toBe(0.5);
      expect(result.warnings).toEqual([]);
    }
    // The bytes went over the channel and came back unchanged.
    for (const output of outputs) expect(Buffer.compare(output, Buffer.from(input))).toBe(0);
    expect(new Set(spawns.pids).size).toBe(3);
    for (const pid of spawns.pids) expect(await isAlive(pid), `pid ${String(pid)}`).toBe(false);
    expect(runner.stats()).toMatchObject({ running: 0, queued: 0, started: 3 });
    await runner.shutdown();
  }, 30_000);

  it('runs at most 2 jobs, queues 4 and refuses the rest with a Retry-After hint', async () => {
    const { runner, spawns } = runnerFor('hold');
    const outcomes: Promise<'done' | { code: string }>[] = [];
    const submit = (): void => {
      outcomes.push(
        runner.process(uploadJob()).then(
          () => 'done' as const,
          (failure: unknown) => ({ code: (failure as { code: string }).code }),
        ),
      );
    };
    for (let job = 0; job < 6; job += 1) submit();
    await spawns.reached(2);
    expect(runner.stats()).toMatchObject({ running: 2, queued: 4 });

    // The seventh job finds the queue full: it is refused at once, with the hint.
    const seventh = await failureOf(runner.process(uploadJob()));
    expect(seventh).toMatchObject({ name: 'ProblemError', code: 'image_processing_busy' });
    const details = (seventh as { details: { retryAfterSeconds: number } }).details;
    expect(details.retryAfterSeconds).toBe(BUSY_RETRY_AFTER_SECONDS);
    expect(BUSY_RETRY_AFTER_SECONDS).toBeGreaterThanOrEqual(1);
    expect(describeProblem('image_processing_busy', 'req-1', details).headers['Retry-After']).toBe(
      String(BUSY_RETRY_AFTER_SECONDS),
    );
    expect(runner.stats()).toMatchObject({ running: 2, queued: 4 });

    // Release the jobs one at a time, oldest child first: the queue moves in order, and never more
    // than 2 run.
    let released = 0;
    while (released < 6) {
      await spawns.reached(Math.min(released + 2, 6));
      const pid = spawns.pids[released];
      if (pid === undefined) throw new Error('no child to release');
      expect(runner.stats().running).toBeLessThanOrEqual(2);
      await release(pid);
      released += 1;
      await until(
        () => runner.stats().started >= Math.min(released + 2, 6),
        'the next job to start',
      );
    }
    expect(await Promise.all(outcomes)).toEqual(Array<'done'>(6).fill('done'));
    expect(spawns.jobs).toEqual([1, 2, 3, 4, 5, 6]);
    expect(runner.stats()).toMatchObject({ running: 0, queued: 0, started: 6, peakRunning: 2 });
    for (const pid of spawns.pids) expect(await isAlive(pid)).toBe(false);
    await runner.shutdown();
  }, 60_000);

  it('can be told other limits', async () => {
    const { runner, spawns } = runnerFor('hold', { maxRunning: 1, maxQueued: 1 });
    const first = runner.process(uploadJob());
    const second = runner.process(uploadJob());
    await spawns.reached(1);
    const third = await failureOf(runner.process(uploadJob()));
    expect(third).toMatchObject({ code: 'image_processing_busy' });
    const pid = spawns.pids[0];
    if (pid === undefined) throw new Error('no child');
    await release(pid);
    await first;
    await spawns.reached(2);
    const next = spawns.pids[1];
    if (next === undefined) throw new Error('no second child');
    await release(next);
    await second;
    await runner.shutdown();
    expect(runner.stats().peakRunning).toBe(1);
  }, 30_000);

  it('kills a child over its budget: its pid is gone when the answer comes, and the main process kept running', async () => {
    const { runner, spawns } = runnerFor('block', {
      launch: fixtureLaunch('block', blockingScript),
      timeBudgetMs: 300,
    });
    const loop = watchEventLoop();
    const started = performance.now();
    const failure = await failureOf(runner.process(uploadJob()));
    const elapsed = performance.now() - started;
    const worst = loop.stop();
    expect(failure).toMatchObject({ name: 'ProblemError', code: 'image_processing_timeout' });
    expect(PROBLEM_CODES.image_processing_timeout.status).toBe(422);
    // Killed at the budget, not much later.
    expect(elapsed).toBeGreaterThanOrEqual(290);
    expect(elapsed).toBeLessThan(3_000);
    // The child is gone (not a zombie either): nothing burns a core any more.
    const pid = spawns.pids[0];
    if (pid === undefined) throw new Error('no child was started');
    expect(await isAlive(pid)).toBe(false);
    if (onLinux)
      await expect(readFile(`/proc/${String(pid)}/stat`)).rejects.toMatchObject({ code: 'ENOENT' });
    // The main process kept answering while the child spun: its timer was never held for long.
    expect(worst).toBeLessThan(250);
    // And the slot is free again: the next job runs.
    expect(runner.stats()).toMatchObject({ running: 0, queued: 0 });
    await runner.shutdown();
  }, 30_000);

  it('serves a job after another one timed out', async () => {
    let calls = 0;
    const spawns = new Spawns();
    const runner = createImageJobRunner({
      launch: () => {
        calls += 1;
        return calls === 1 ? fixtureLaunch('block', blockingScript) : fixtureLaunch('ok');
      },
      observer: spawns,
      timeBudgetMs: 200,
    });
    const first = failureOf(runner.process(uploadJob()));
    const second = runner.process(uploadJob());
    expect(await first).toMatchObject({ code: 'image_processing_timeout' });
    expect((await second).png.length).toBeGreaterThan(8);
    await runner.shutdown();
  }, 30_000);

  it('turns a failure the worker reports into the problem it names', async () => {
    const { runner } = runnerFor('problem');
    const failure = await failureOf(runner.process(uploadJob()));
    expect(failure).toMatchObject({ name: 'ProblemError', code: 'image_corrupt' });
    expect(PROBLEM_CODES.image_corrupt.status).toBe(422);
    await runner.shutdown();
  }, 30_000);

  it('reports anything else a child does wrong as a worker fault, and keeps serving', async () => {
    const cases: readonly (readonly [string, string])[] = [
      ['crash', 'exited'],
      ['silent-exit', 'exited'],
      ['garbage', 'protocol'],
      ['bad-code', 'protocol'],
      ['bad-png', 'protocol'],
      ['wrong-kind', 'protocol'],
      ['internal', 'internal'],
    ];
    for (const [mode, reason] of cases) {
      const { runner, spawns } = runnerFor(mode);
      const failure = await failureOf(runner.process(uploadJob()));
      expect(failure, mode).toBeInstanceOf(ImageWorkerError);
      expect(failure, mode).toMatchObject({ name: 'ImageWorkerError', reason });
      // Generic by construction: no byte of the input and no text of the child in the message.
      expect((failure as Error).message, mode).toBe(`the image worker failed (${reason})`);
      const pid = spawns.pids[0];
      if (pid === undefined) throw new Error('no child');
      expect(await isAlive(pid), mode).toBe(false);
      expect(runner.stats(), mode).toMatchObject({ running: 0, queued: 0 });
      await runner.shutdown();
    }
    // The exit code of a crash is kept for the log.
    const { runner } = runnerFor('crash');
    expect(await failureOf(runner.process(uploadJob()))).toMatchObject({ exitCode: 7 });
    await runner.shutdown();
  }, 60_000);

  it('reports a worker that cannot start', async () => {
    const runner = createImageJobRunner({
      launch: {
        entry: join(serverRoot, 'does-not-exist', 'image-worker.js'),
        readRoots: [serverRoot],
      },
    });
    const failure = await failureOf(runner.process(uploadJob()));
    expect(failure).toMatchObject({ name: 'ImageWorkerError', reason: 'exited' });
    await runner.shutdown();
  }, 30_000);

  it('shuts down: the running children are killed, the waiting jobs and later ones get shutting_down', async () => {
    const { runner, spawns } = runnerFor('hold');
    const jobs = [0, 1, 2].map(() => failureOf(runner.process(uploadJob())));
    await spawns.reached(2);
    expect(runner.stats()).toMatchObject({ running: 2, queued: 1 });

    await runner.shutdown();
    for (const failure of await Promise.all(jobs)) {
      expect(failure).toMatchObject({ name: 'ProblemError', code: 'shutting_down' });
    }
    expect(PROBLEM_CODES.shutting_down.status).toBe(503);
    expect(spawns.pids).toHaveLength(2);
    for (const pid of spawns.pids) expect(await isAlive(pid), `pid ${String(pid)}`).toBe(false);
    expect(runner.stats()).toMatchObject({ running: 0, queued: 0 });
    // After the shutdown nothing starts, and a second shutdown does no harm.
    expect(await failureOf(runner.process(uploadJob()))).toMatchObject({ code: 'shutting_down' });
    expect(spawns.pids).toHaveLength(2);
    await runner.shutdown();
  }, 30_000);

  it('hands the hostile-corpus runner the shape it needs', async () => {
    const spawns = new Spawns();
    const subject = createPipelineSubject({ launch: fixtureLaunch('problem'), observer: spawns });
    expect(subject.maxRunning()).toBe(0);
    const failure = await failureOf(
      subject.process({ bytes: solidPng(1, 1, [1, 1, 1]), slot: 'compact' }),
    );
    expect(failure).toMatchObject({ code: 'image_corrupt' });
    await subject.close();

    const ok = createPipelineSubject({ launch: fixtureLaunch('ok') });
    const result = await ok.process({ bytes: solidPng(1, 1, [1, 1, 1]), slot: 'logoLight' });
    expect(result.png.length).toBeGreaterThan(8);
    expect(result.warnings).toEqual([]);
    expect(ok.maxRunning()).toBe(1);
    await ok.close();
  }, 30_000);
});

// ---------------------------------------------------------------------------------------------
// What the child does with a job, in-process
// ---------------------------------------------------------------------------------------------

function uploadRequest(
  bytes: Uint8Array = PNG_BYTES,
  slot: 'logoLight' | 'logoDark' | 'compact' = 'logoLight',
) {
  return parseJobRequest({ v: 1, kind: 'upload', slot, bytes: encodeBytes(bytes) });
}

describe('the job handler', () => {
  const stub: UploadProcessor = ({ bytes, slot }) =>
    Promise.resolve({
      png: bytes,
      width: 1,
      height: 1,
      luminance: slot === 'compact' ? null : 0.25,
      warnings: [{ code: 'animation_flattened' }],
    });

  it('answers an upload with what the upload stages produced, in the shape of the protocol', async () => {
    const reply = await handleJob(uploadRequest(), { upload: stub });
    expect(reply).toEqual({
      v: 1,
      ok: true,
      kind: 'upload',
      png: PNG_BASE64,
      width: 1,
      height: 1,
      luminance: 0.25,
      warnings: [{ code: 'animation_flattened' }],
    });
    // What it answers is what the main process accepts.
    expect(parseJobReply(reply, 'upload')).toEqual(reply);
    expect(await handleJob(uploadRequest(PNG_BYTES, 'compact'), { upload: stub })).toMatchObject({
      luminance: null,
    });
  });

  it('answers a variants job with the same icons the code itself renders', async () => {
    const light = await sharp({
      create: {
        width: 30,
        height: 30,
        channels: 4,
        background: { r: 20, g: 120, b: 200, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    const request = parseJobRequest({
      v: 1,
      kind: 'variants',
      orgName: 'Acme Corp',
      accent: '#0078d4',
      light: encodeBytes(light),
      dark: null,
      compact: null,
    });
    const reply = await handleJob(request);
    expect(parseJobReply(reply, 'variants')).toEqual(reply);
    const expected = await deriveVariants({
      orgName: 'Acme Corp',
      accent: '#0078d4',
      light: { png: light },
      dark: null,
      compact: null,
    });
    if (!reply.ok || reply.kind !== 'variants') throw new Error('the job failed');
    expect(reply.source).toBe(expected.icons.source);
    expect(reply.compactDerived).toBe(true);
    for (const kind of ICON_KINDS) {
      expect(reply.icons[kind]).toBe(encodeBytes(expected.icons.icons[kind].png));
    }
  });

  it('reports a failure of the input by its code, and every other failure as internal, saying nothing more', async () => {
    const failing =
      (failure: unknown): UploadProcessor =>
      () => {
        throw failure;
      };
    for (const code of WORKER_FAILURE_CODES) {
      const reply = await handleJob(uploadRequest(), {
        upload: failing(
          Object.assign(new Error('the text of the failure, a path /etc/passwd'), { code }),
        ),
      });
      expect(reply).toEqual({ v: 1, ok: false, failure: 'problem', code });
    }
    const internal = { v: 1, ok: false, failure: 'internal' };
    for (const failure of [
      new Error('plain'),
      Object.assign(new Error('x'), { code: 'permission_denied' }),
      Object.assign(new Error('x'), { code: 'image_processing_timeout' }),
      Object.assign(new Error('x'), { code: 42 }),
      'a string',
      null,
      undefined,
    ]) {
      expect(await handleJob(uploadRequest(), { upload: failing(failure) })).toEqual(internal);
    }
    // No processor, a request whose bytes cannot be decoded, a damaged master: internal, never a throw.
    expect(await handleJob(uploadRequest())).toEqual(internal);
    expect(
      await handleJob(
        { v: 1, kind: 'upload', slot: 'logoLight', bytes: '!!not base64!!' },
        { upload: stub },
      ),
    ).toEqual(internal);
    expect(
      await handleJob({
        v: 1,
        kind: 'variants',
        orgName: 'Acme',
        accent: '#0078d4',
        light: encodeBytes(Buffer.from('not a png')),
        dark: null,
        compact: null,
      }),
    ).toEqual(internal);
    expect(
      await handleJob({
        v: 1,
        kind: 'variants',
        orgName: 'Acme',
        accent: 'not a colour',
        light: null,
        dark: null,
        compact: null,
      }),
    ).toEqual(internal);
  });
});

// ---------------------------------------------------------------------------------------------
// The real worker, built the way the S1 build bundles it
// ---------------------------------------------------------------------------------------------

interface BuiltWorker {
  readonly dir: string;
  readonly entry: string;
  readonly metafile: Metafile;
}

/**
 * Bundle `src/branding/image-worker.ts` as `image-worker.js` the way the server build does (TA-09:
 * workspace packages inlined, everything under "dependencies" external), into a directory below
 * `apps/server/node_modules/.cache`, where `sharp` resolves like it does for `dist`.
 */
async function buildWorker(): Promise<BuiltWorker> {
  const cache = join(serverRoot, 'node_modules', '.cache');
  await mkdir(cache, { recursive: true });
  const dir = await mkdtemp(join(cache, 'm365portal-image-worker-'));
  const manifest = JSON.parse(await readFile(join(serverRoot, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
  };
  const { metafile } = await build({
    absWorkingDir: serverRoot,
    entryPoints: { 'image-worker': 'src/branding/image-worker.ts' },
    outdir: join(dir, 'dist'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    external: Object.keys(manifest.dependencies),
    legalComments: 'none',
    metafile: true,
    logLevel: 'silent',
  });
  return { dir, entry: join(dir, 'dist', 'image-worker.js'), metafile };
}

/** What a bundle imports that it does not contain: Node's own modules and the packages left external. */
function externalImports(metafile: Metafile): string[] {
  const found = new Set<string>();
  for (const input of Object.values(metafile.inputs)) {
    for (const item of input.imports) {
      if (item.external === true) found.add(item.path);
    }
  }
  return [...found].sort();
}

/** The inputs of a bundle whose source matches a pattern (comments are not code, so they are skipped). */
function mentions(metafile: Metafile, pattern: RegExp): string[] {
  const hits: string[] = [];
  for (const path of Object.keys(metafile.inputs)) {
    const text = readFileSync(join(serverRoot, path), 'utf8');
    const code = text
      .split('\n')
      .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
      .join('\n');
    if (pattern.test(code)) hits.push(path);
  }
  return hits;
}

const DANGEROUS_MODULES =
  /^(?:node:)?(?:fs|fs\/promises|net|tls|http|https|http2|dgram|dns|dns\/promises|child_process|cluster|worker_threads|vm|inspector|repl|readline|module|wasi|v8|perf_hooks|async_hooks|diagnostics_channel)$/;
const SERVER_ONLY_PACKAGES = /^(?:better-sqlite3|drizzle-orm|hono|@hono\/|pino|libsodium)/;
const SERVER_ONLY_FOLDERS = /^apps\/server\/src\/(?:db|config|http|audit|logging|policy)\//;

/** Throws when what the worker bundles could open a file, a socket or a process, or reaches the server. */
function assertCannotReachOutside(metafile: Metafile): void {
  for (const path of externalImports(metafile)) {
    if (DANGEROUS_MODULES.test(path)) throw new Error(`the worker imports ${path}`);
    if (SERVER_ONLY_PACKAGES.test(path))
      throw new Error(`the worker imports the server package ${path}`);
  }
  for (const path of Object.keys(metafile.inputs)) {
    const relative = path.replaceAll('\\', '/').replace(/^(?:\.\.\/)+/, '');
    if (SERVER_ONLY_FOLDERS.test(relative)) throw new Error(`the worker bundles ${relative}`);
  }
}

describe('the real worker', () => {
  let built: BuiltWorker | undefined;

  const worker = (): BuiltWorker => {
    if (built === undefined) throw new Error('the worker was not built');
    return built;
  };

  beforeAll(async () => {
    built = await buildWorker();
  }, 60_000);

  afterAll(async () => {
    if (built !== undefined) await rm(built.dir, { recursive: true, force: true });
  });

  it('is picked up by the *-worker.ts rule of the build: one file, workspace code inlined, packages external', () => {
    const { metafile, entry } = worker();
    expect(Object.keys(metafile.outputs).map((path) => path.split('/').pop())).toEqual([
      'image-worker.js',
    ]);
    const inputs = Object.keys(metafile.inputs);
    // Only our own code and the workspace package are inlined; nothing of node_modules is.
    expect(inputs.some((path) => path.includes('node_modules/'))).toBe(false);
    expect(inputs.some((path) => path.endsWith('src/branding/image-worker.ts'))).toBe(true);
    expect(entry.endsWith(`${sep}dist${sep}image-worker.js`)).toBe(true);
    // It leaves external only sharp, saxes (the SVG parser) and zod (if a shared schema module is inlined).
    const packages = externalImports(metafile).filter((path) => !path.startsWith('node:'));
    expect(
      packages.filter((path) => path !== 'sharp' && path !== 'saxes' && path !== 'zod'),
    ).toEqual([]);
    expect(packages).toContain('sharp');
  });

  it('imports nothing that opens a file, a socket or a process, and nothing of the server', () => {
    const { metafile } = worker();
    expect(() => {
      assertCannotReachOutside(metafile);
    }).not.toThrow();
    // The worker never reads the environment: no file of its closure does.
    expect(mentions(metafile, /\bprocess\.env\b/)).toEqual([]);
  });

  it('fails the check on a bundle that could (negative fixtures)', () => {
    const bundle = (imports: readonly string[], inputs: readonly string[] = []): Metafile => ({
      inputs: Object.fromEntries<Metafile['inputs'][string]>([
        ...imports.map((path): [string, Metafile['inputs'][string]] => [
          `src/branding/x-${path.replace(/\W/g, '')}.ts`,
          { bytes: 1, imports: [{ path, kind: 'import-statement' as const, external: true }] },
        ]),
        ...inputs.map((path): [string, Metafile['inputs'][string]] => [
          path,
          { bytes: 1, imports: [] },
        ]),
      ]),
      outputs: {},
    });
    for (const path of [
      'node:fs',
      'fs/promises',
      'node:net',
      'node:http',
      'node:https',
      'node:child_process',
      'node:worker_threads',
      'node:dns',
      'node:tls',
      'node:dgram',
      'node:vm',
    ]) {
      expectGuardFails(assertCannotReachOutside, bundle([path]), { reason: 'the worker imports' });
    }
    for (const path of ['better-sqlite3', 'hono', 'pino', '@hono/node-server']) {
      expectGuardFails(assertCannotReachOutside, bundle([path]), { reason: 'server package' });
    }
    for (const path of [
      'apps/server/src/db/open.ts',
      'apps/server/src/config/load.ts',
      'apps/server/src/http/problem.ts',
    ]) {
      expectGuardFails(assertCannotReachOutside, bundle([], [path]), {
        reason: 'the worker bundles',
      });
    }
    expect(() => {
      assertCannotReachOutside(bundle(['sharp', 'node:crypto', 'zod']));
    }).not.toThrow();
  });

  it('derives the icons in a child that may read nothing but its own bundle, with the bytes the code itself gives', async () => {
    const { entry } = worker();
    const spawns = new Spawns();
    const runner = createImageJobRunner({ launch: hardenedLaunch(entry), observer: spawns });
    // A master as the pipeline stores it: a PNG with an alpha channel.
    const lightPng = await sharp({
      create: {
        width: 40,
        height: 20,
        channels: 4,
        background: { r: 200, g: 30, b: 30, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    const request = {
      orgName: 'Acme Corp',
      accent: '#0078d4',
      light: lightPng,
      dark: null,
      compact: null,
    };
    const expected = await deriveVariants({
      orgName: request.orgName,
      accent: request.accent,
      light: { png: request.light },
      dark: null,
      compact: null,
    });
    const actual = await runner.deriveVariants(request);

    expect(actual.compactDerived).toBe(expected.compactDerived);
    expect(actual.source).toBe(expected.icons.source);
    expect(actual.plate).toBe(expected.icons.plate);
    expect(actual.compact?.hash).toBe(expected.compact?.hash);
    expect(actual.compact?.luminance).toBe(expected.compact?.luminance);
    for (const kind of ICON_KINDS) {
      expect(actual.icons[kind].hash, kind).toBe(expected.icons.icons[kind].hash);
      expect(Buffer.compare(actual.icons[kind].png, expected.icons.icons[kind].png), kind).toBe(0);
      expect(actual.icons[kind].width).toBe(ICON_SIZES[kind]);
    }
    // One child, started for this job, and gone.
    expect(spawns.pids).toHaveLength(1);
    expect(await isAlive(spawns.pids[0] ?? 0)).toBe(false);
    await runner.shutdown();
  }, 60_000);

  it('processes an upload end to end in a child under the permission model: bounded, clean, measured', async () => {
    const runner = createImageJobRunner({ launch: hardenedLaunch(worker().entry) });
    const colour = [200, 30, 30] as const;
    const wide = await runner.process({ bytes: solidPng(600, 300, colour), slot: 'logoLight' });
    expect([wide.width, wide.height]).toEqual([512, 256]);
    expect(wide.warnings).toEqual([]);
    expect(wide.luminance).toBeCloseTo(relativeLuminance('#c81e1e'), 2);
    const walk = walkPng(wide.png);
    expect(walk.trailing).toHaveLength(0);
    for (const chunk of walk.chunks) expect(OUTPUT_CHUNK_TYPES).toContain(chunk.type);

    const compact = await runner.process({ bytes: solidPng(600, 300, colour), slot: 'compact' });
    expect([compact.width, compact.height]).toEqual([128, 64]);

    const jpeg = await sharp({
      create: { width: 300, height: 200, channels: 3, background: { r: 10, g: 200, b: 10 } },
    })
      .jpeg()
      .toBuffer();
    const fromJpeg = await runner.process({ bytes: jpeg, slot: 'logoDark' });
    // Never enlarged, always PNG.
    expect([fromJpeg.width, fromJpeg.height]).toEqual([300, 200]);
    expect(fromJpeg.png.subarray(1, 4).toString('latin1')).toBe('PNG');
    await runner.shutdown();
  }, 60_000);

  it('turns what is wrong with an upload into the problem that names it, in a child that goes away', async () => {
    const spawns = new Spawns();
    const runner = createImageJobRunner({
      launch: hardenedLaunch(worker().entry),
      observer: spawns,
    });
    const cases: readonly (readonly [string, Uint8Array, string])[] = [
      ['a GIF', Buffer.from('GIF89a\u0001\u0000\u0001\u0000'), 'image_type_unsupported'],
      ['one byte', Uint8Array.of(7), 'image_type_unsupported'],
      ['an empty body', new Uint8Array(0), 'image_empty'],
      ['a truncated PNG', solidPng(40, 40, [1, 2, 3]).subarray(0, 60), 'image_corrupt'],
    ];
    for (const [name, bytes, code] of cases) {
      expect(await failureOf(runner.process({ bytes, slot: 'logoLight' })), name).toMatchObject({
        name: 'ProblemError',
        code,
      });
    }
    expect(spawns.pids).toHaveLength(cases.length);
    for (const pid of spawns.pids) expect(await isAlive(pid)).toBe(false);
    await runner.shutdown();
  }, 60_000);

  it('makes no connection while it works (a listener on 127.0.0.1 sees none)', async () => {
    const listener = await startLocalListener();
    try {
      const runner = createImageJobRunner({ launch: hardenedLaunch(worker().entry) });
      await runner.deriveVariants({
        orgName: listener.origin,
        accent: '#0078d4',
        light: null,
        dark: null,
        compact: null,
      });
      await runner.shutdown();
      expect(listener.connections()).toBe(0);
    } finally {
      await listener.close();
    }
  }, 60_000);

  it('refuses a damaged master with a worker fault, not a crash of the main process', async () => {
    const runner = createImageJobRunner({ launch: hardenedLaunch(worker().entry) });
    const failure = await failureOf(
      runner.deriveVariants({
        orgName: 'Acme',
        accent: '#0078d4',
        light: Buffer.from('this is not a png'),
        dark: null,
        compact: null,
      }),
    );
    expect(failure).toMatchObject({ name: 'ImageWorkerError', reason: 'internal' });
    await runner.shutdown();
  }, 60_000);

  it('processes 20 simultaneous valid jobs with at most 2 at a time, a queue of 4 and the rest refused (H-39)', async () => {
    const spawns = new Spawns();
    const runner = createImageJobRunner({
      launch: hardenedLaunch(worker().entry),
      observer: spawns,
    });
    const job = () =>
      runner.deriveVariants({
        orgName: 'Acme Corp',
        accent: '#0078d4',
        light: null,
        dark: null,
        compact: null,
      });
    const results = await Promise.allSettled(Array.from({ length: 20 }, job));
    const done = results.filter((result) => result.status === 'fulfilled');
    const refused = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(done).toHaveLength(6);
    expect(refused).toHaveLength(14);
    for (const result of refused) {
      expect(result.reason).toMatchObject({ name: 'ProblemError', code: 'image_processing_busy' });
    }
    expect(runner.stats()).toMatchObject({ running: 0, queued: 0, started: 6, peakRunning: 2 });
    expect(spawns.pids).toHaveLength(6);
    for (const pid of spawns.pids) expect(await isAlive(pid), `pid ${String(pid)}`).toBe(false);
    await runner.shutdown();
  }, 120_000);

  it.skipIf(!onLinux)(
    'exits by itself when its parent disconnects',
    async () => {
      const child = forkImageWorker(hardenedLaunch(worker().entry));
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => {
          child.once('exit', (code, signal) => {
            resolve({ code, signal });
          });
        },
      );
      // Let it come up, then let go of it: no job, no signal, only the end of the channel.
      await new Promise<void>((resolve) => child.once('spawn', resolve));
      child.disconnect();
      const result = await exited;
      expect(result).toEqual({ code: 0, signal: null });
    },
    30_000,
  );

  it.skipIf(!onLinux)(
    'is not left behind when its parent is killed',
    async () => {
      // A parent that starts the worker and reports its pid, and is then killed without any chance
      // to clean up: the end of the IPC channel is all the worker gets.
      const parentScript = join(worker().dir, 'orphan-parent.mjs');
      await writeFile(
        parentScript,
        [
          "import { fork } from 'node:child_process';",
          `const child = fork(${JSON.stringify(worker().entry)}, [], { env: {}, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });`,
          "child.once('spawn', () => { process.stdout.write(String(child.pid) + '\\n'); });",
          'setInterval(() => undefined, 1000);',
        ].join('\n'),
      );
      const parent = spawn(process.execPath, [parentScript], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const pid = await new Promise<number>((resolve, reject) => {
        parent.stdout.once('data', (chunk: Buffer) => {
          resolve(Number(chunk.toString().trim()));
        });
        parent.once('error', reject);
      });
      expect(await isAlive(pid)).toBe(true);
      parent.kill('SIGKILL');
      await until(async () => !(await isAlive(pid)), 'the orphaned worker to go away', 15_000);
    },
    30_000,
  );
});

// ---------------------------------------------------------------------------------------------
// The module built the way the process is built
// ---------------------------------------------------------------------------------------------

describe('the runner module', () => {
  it('does not pull the image library into the main process', async () => {
    // The main process imports the runner; if that imported sharp (or the code that uses it), the main
    // process would hold libvips, which is what the child process is for (PD-08).
    const { metafile } = await build({
      absWorkingDir: serverRoot,
      entryPoints: ['src/branding/pipeline/job-runner.ts'],
      write: false,
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'esm',
      packages: 'external',
      metafile: true,
      logLevel: 'silent',
    });
    expect(externalImports(metafile)).not.toContain('sharp');
    const inputs = Object.keys(metafile.inputs).map((path) => path.replaceAll('\\', '/'));
    for (const heavy of [
      'icons.ts',
      'plate.ts',
      'monogram-render.ts',
      'job-handler.ts',
      'image-worker.ts',
    ]) {
      expect(
        inputs.some((path) => path.endsWith(`/${heavy}`)),
        heavy,
      ).toBe(false);
    }
  }, 60_000);
});

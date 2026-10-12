// CONTAINER SMOKE TEST (T-A-235; plan 12.1; FR-A-014, FR-A-016, FR-A-075, FR-A-092 image half,
// FR-A-161 to FR-A-165; SC-A-001, SC-A-008; E-10, E-25; PR-06, PR-15, PR-16).
//
//   pnpm image:smoke                       the image m365portal:local, full mode
//   SMOKE_IMAGE=name:tag pnpm image:smoke  another image
//   SMOKE_MODE=skeleton pnpm image:smoke   only the checks that need nothing but the image
//   SMOKE_NETWORK=host pnpm image:smoke    --network host (a sandbox without bridge networking)
//
// It runs the image the way docker-compose.yml documents it: `--read-only --tmpfs /tmp --cap-drop ALL
// --security-opt no-new-privileges`, a fresh named volume (it inherits the owner 65532 of the image's
// /data), a generated `APP_KEY` and a loopback URL. There is no preview mode any more (FR-B-102): the
// branding upload and apply run as the SETUP actor, after `setup-token` printed the token with
// `docker exec` and `POST /api/v1/setup/unlock` accepted it. With bridge networking the port is published on
// 127.0.0.1; with SMOKE_NETWORK=host the container binds the host port itself, so PORT is the host
// port: the image default (DEFAULT_PORT) for the first run, SMOKE_ALT_PORT (default 18080) for the third.
//
// Skeleton mode: image inspect (user, labels, health check), start, Docker health becomes `healthy`
// (the smoke runs use `--health-interval 2s --health-start-period 0s`; the command that runs is the
// image's own HEALTHCHECK), `/healthz` version equals VERSION equals the label, `/readyz` 200 within
// 10 s, the process runs as the expected user, `docker stop` exits 0 within 10 s.
// Full mode adds: Intl (PR-16), the SVG loader of the distroless libvips (R-06), the bundled image
// worker (PR-06), a CSRF-protected upload and apply, glyph pixels in the icon (no fonts in
// distroless), a safe SVG upload, `verify-audit`, a restart on the same volume (branding kept, no
// migration applied twice), a second run on a /data the user cannot write (`/readyz` 503
// `data_dir_not_writable`, `/healthz` 200), a third run with PORT=SMOKE_ALT_PORT, and idle and peak
// memory with two concurrent large uploads (PR-15).
// Phase B adds (T-B-353; FR-B-706, FR-B-110, FR-B-106, FR-B-710; SC-B-016; U34): the CLI commands
// `generate-app-key` and `hash-password` through the planned command line (the first form that passes
// is recorded as the verified form, U34), `setup-token` through `docker exec`, the unlock and the
// environment step, a certificate created INSIDE the image by the product and parsed with the host's
// `openssl x509` (RSA 2048, 360 days), persistence of state and certificate over a restart, a start
// without the key (`/readyz` 503 `app_key_missing`), the image size against the ceiling, and the memory
// of the 128 MiB scrypt of the break-glass hash. A break-glass sign-in itself needs a pinned tenant
// (409 `setup_required` before), so the verification cannot run in an unconfigured image: the memory
// is measured on the same parameters through the `hash-password` command in a memory-limited container.
//
// Environment: SMOKE_IMAGE, SMOKE_MODE (full|skeleton), SMOKE_NETWORK (host|bridge), SMOKE_EXPECT_USER
// (default 65532; a wrong value must make the run fail), SMOKE_PREFIX (name prefix of every container
// and volume this script creates, default m365portal-smoke), SMOKE_ALT_PORT, SMOKE_REPORT (a file to
// which the JSON report is written). Exit 0 when every check passed, 1 otherwise. Everything this
// script creates is removed again, by name, also when a check fails.
import { spawnSync } from 'node:child_process';
import { randomBytes, X509Certificate } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { DEFAULT_PORT, LIMITS } from '../packages/shared/src/limits.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const image = process.env.SMOKE_IMAGE ?? 'm365portal:local';
const mode = process.env.SMOKE_MODE ?? 'full';
const network = process.env.SMOKE_NETWORK === 'host' ? 'host' : 'bridge';
const expectUser = process.env.SMOKE_EXPECT_USER ?? '65532';
const prefix = process.env.SMOKE_PREFIX ?? 'm365portal-smoke';
const altPort = Number(process.env.SMOKE_ALT_PORT ?? '18080');
const READY_WITHIN_MS = 10_000;
const STOP_WITHIN_MS = 10_000;
const MAX_LOGO_BYTES = LIMITS.body.logoFileBytes;

if (mode !== 'full' && mode !== 'skeleton') {
  console.error(`SMOKE_MODE must be full or skeleton, got "${mode}"`);
  process.exit(2);
}

// Reporting -----------------------------------------------------------------------------------------

interface Result {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}
const results: Result[] = [];
const figures: Record<string, string | number> = {};

function record(name: string, ok: boolean, detail: string): boolean {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
  return ok;
}

/** Runs one check; an exception is a failure of that check, not of the script. */
async function check(name: string, body: () => Promise<string> | string): Promise<boolean> {
  try {
    return record(name, true, await body());
  } catch (failure) {
    return record(name, false, failure instanceof Error ? failure.message : String(failure));
  }
}

function expect(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// Docker --------------------------------------------------------------------------------------------

interface DockerResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function docker(args: readonly string[], input?: string): DockerResult {
  // `-e NAME` without a value (the sealing key) reads the environment of this process, so the key is
  // in no argument list.
  const done = spawnSync('docker', args, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
  if (done.error) throw new Error(`cannot run docker: ${done.error.message}`);
  return { status: done.status ?? 1, stdout: done.stdout, stderr: done.stderr };
}

interface CliForm {
  readonly name: string;
  readonly args: (command: readonly string[]) => string[];
}
const CLI_BASE = [
  'run',
  '--rm',
  '-i',
  '--network',
  'none',
  '--read-only',
  '--tmpfs',
  '/tmp',
  '--cap-drop',
  'ALL',
  '--security-opt',
  'no-new-privileges',
] as const;
/** The planned command lines of the CLI (U34), in order of preference. The first that passes is recorded. */
const CLI_FORMS: readonly CliForm[] = [
  {
    name: 'docker run --rm -i IMAGE dist/cli.js <command>',
    args: (command) => [...CLI_BASE, image, 'dist/cli.js', ...command],
  },
  {
    name: 'docker run --rm -i --entrypoint /nodejs/bin/node IMAGE dist/cli.js <command>',
    args: (command) => [
      ...CLI_BASE,
      '--entrypoint',
      '/nodejs/bin/node',
      image,
      'dist/cli.js',
      ...command,
    ],
  },
];
let cliForm: CliForm | undefined;

/** Runs a CLI command in a throwaway container. The first call settles which command line works. */
function cli(command: readonly string[], input?: string): DockerResult {
  if (cliForm !== undefined) return docker(cliForm.args(command), input);
  let last: DockerResult = { status: 1, stdout: '', stderr: 'no command line was tried' };
  for (const form of CLI_FORMS) {
    last = docker(form.args(command), input);
    if (last.status === 0) {
      cliForm = form;
      figures.cliForm = form.name;
      return last;
    }
  }
  return last;
}

function dockerOk(args: readonly string[]): string {
  const done = docker(args);
  if (done.status !== 0) {
    throw new Error(
      `docker ${args.slice(0, 2).join(' ')} failed: ${done.stderr.trim().split('\n')[0] ?? ''}`,
    );
  }
  return done.stdout.trim();
}

const containers: string[] = [];
const volumes: string[] = [];
const scratchDirectories: string[] = [];
let counter = 0;

function nameOf(kind: string): string {
  counter += 1;
  return `${prefix}-${String(process.pid)}-${kind}${String(counter)}`;
}

function cleanup(): void {
  for (const container of containers.splice(0)) docker(['rm', '-f', container]);
  for (const volume of volumes.splice(0)) docker(['volume', 'rm', '-f', volume]);
  for (const directory of scratchDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    cleanup();
    process.exit(130);
  });
}

// Ports and HTTP -------------------------------------------------------------------------------------

function portIsBusy(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      done(true);
    });
    socket.once('error', () => {
      done(false);
    });
  });
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address !== null && typeof address === 'object') done(address.port);
        else fail(new Error('no port'));
      });
    });
  });
}

/** The cookies of one client, the way a browser keeps them: name to value, a cleared cookie is dropped. */
class CookieJar {
  readonly #cookies = new Map<string, string>();
  header(): Record<string, string> {
    return this.#cookies.size === 0
      ? {}
      : { cookie: [...this.#cookies].map(([name, value]) => `${name}=${value}`).join('; ') };
  }
  absorb(headers: Headers): void {
    for (const line of headers.getSetCookie()) {
      const pair = line.split(';')[0] ?? '';
      const at = pair.indexOf('=');
      if (at <= 0) continue;
      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1).trim();
      if (value === '' || /;\s*max-age=0/i.test(line)) this.#cookies.delete(name);
      else this.#cookies.set(name, value);
    }
  }
}

interface Answer {
  readonly status: number;
  readonly headers: Headers;
  readonly bytes: Buffer;
  text(): string;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller names the shape it expects
  json<T>(): T;
}

async function http(
  origin: string,
  path: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: FormData | string;
    redirect?: 'manual' | 'follow';
    jar?: CookieJar;
  } = {},
): Promise<Answer> {
  const response = await fetch(origin.replace('//localhost:', '//127.0.0.1:') + path, {
    method: init.method ?? 'GET',
    headers: { origin, ...(init.jar?.header() ?? {}), ...(init.headers ?? {}) },
    ...(init.body === undefined ? {} : { body: init.body }),
    redirect: init.redirect ?? 'follow',
    signal: AbortSignal.timeout(30_000),
  });
  init.jar?.absorb(response.headers);
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    headers: response.headers,
    bytes,
    text: () => bytes.toString('utf8'),
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- see Answer.json
    json: <T>() => JSON.parse(bytes.toString('utf8')) as T,
  };
}

// A running container ---------------------------------------------------------------------------------

interface Running {
  readonly name: string;
  readonly origin: string;
  readonly port: number;
  readonly startedAt: number;
}

interface RunOptions {
  readonly kind: string;
  /** The container port (PORT). `undefined` leaves PORT to the image default. */
  readonly port?: number;
  readonly mount: string;
  /** More settings of the application, as the operator would put them in the environment. */
  readonly env?: Readonly<Record<string, string>>;
  /** Default true: the sealing key is passed (`-e APP_KEY`, read from this process, never an argument). */
  readonly appKey?: boolean;
}

/** The sealing key of this run, made by the image's own `generate-app-key` (see `main`). */
let sealingKey = '';

async function startContainer(options: RunOptions): Promise<Running> {
  const name = nameOf(options.kind);
  containers.push(name);
  const containerPort = options.port ?? DEFAULT_PORT;
  const hostPort = network === 'host' ? containerPort : await freePort();
  if (network === 'host' && (await portIsBusy(hostPort))) {
    throw new Error(
      `port ${String(hostPort)} is already in use on this host and --network host needs it. ` +
        'Stop what uses it, or run without SMOKE_NETWORK=host (bridge networking, published port).',
    );
  }
  // PUBLIC_BASE_URL must be https or http on the host localhost (FR-B-103), so the origin is
  // localhost; the requests of this script connect to 127.0.0.1 (see `http`).
  const origin = `http://localhost:${String(hostPort)}`;
  const args = [
    'run',
    '-d',
    '--name',
    name,
    '--read-only',
    '--tmpfs',
    '/tmp',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--health-interval',
    '2s',
    '--health-start-period',
    '0s',
    ...(network === 'host'
      ? ['--network', 'host']
      : ['-p', `127.0.0.1:${String(hostPort)}:${String(containerPort)}`]),
    ...(options.appKey === false ? [] : ['-e', 'APP_KEY']),
    '-e',
    `PUBLIC_BASE_URL=${origin}`,
    ...Object.entries(options.env ?? {}).flatMap(([name, value]) => ['-e', `${name}=${value}`]),
    ...(options.port === undefined ? [] : ['-e', `PORT=${String(options.port)}`]),
    '-v',
    `${options.mount}:/data`,
    image,
  ];
  process.env.APP_KEY = sealingKey;
  dockerOk(args);
  return { name, origin, port: hostPort, startedAt: startedAtOf(name) };
}

/**
 * When the container process started (`State.StartedAt`), not when `docker run` was typed: with the
 * vfs storage driver of a sandbox, creating the container copies the whole image, which is time
 * the application does not spend. The 10 s of /readyz are counted from the start of the process.
 */
function startedAtOf(name: string): number {
  return Date.parse(dockerOk(['inspect', '--format', '{{.State.StartedAt}}', name]));
}

function logsOf(name: string): string {
  const done = docker(['logs', name]);
  return done.stdout + done.stderr;
}

async function waitFor<T>(
  what: string,
  timeoutMs: number,
  probe: () => Promise<T | undefined> | T | undefined,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await probe();
    if (found !== undefined) return found;
    if (Date.now() > deadline)
      throw new Error(`timed out after ${String(timeoutMs)} ms waiting for ${what}`);
    await sleep(100);
  }
}

/** The first moment `/readyz` answers 200, in ms since the container was started. */
async function waitReady(running: Running, timeoutMs = 60_000): Promise<number> {
  return waitFor('/readyz 200', timeoutMs, async () => {
    const state = dockerOk(['inspect', '--format', '{{.State.Status}}', running.name]);
    if (state !== 'running')
      throw new Error(`the container is ${state}; logs:\n${logsOf(running.name).slice(-2000)}`);
    try {
      const answer = await http(running.origin, '/readyz');
      return answer.status === 200 ? Date.now() - running.startedAt : undefined;
    } catch {
      return undefined;
    }
  });
}

async function waitHealth(
  running: Running,
  wanted: 'healthy' | 'unhealthy',
  timeoutMs = 60_000,
): Promise<string> {
  return waitFor(`Docker health ${wanted}`, timeoutMs, () => {
    const status = dockerOk([
      'inspect',
      '--format',
      '{{if .State.Health}}{{.State.Health.Status}}{{end}}',
      running.name,
    ]);
    if (status === wanted) return status;
    if (wanted === 'healthy' && status === 'unhealthy') {
      throw new Error(
        `Docker health is unhealthy; last output: ${dockerOk(['inspect', '--format', '{{json .State.Health.Log}}', running.name]).slice(-600)}`,
      );
    }
    return undefined;
  });
}

/** `docker stop` must exit 0 (the process handled SIGTERM) and return within the drain time. */
function stopAndCheck(running: Running): string {
  const begin = Date.now();
  const stopped = docker(['stop', '--timeout', '15', running.name]);
  const elapsed = Date.now() - begin;
  expect(stopped.status === 0, `docker stop failed: ${stopped.stderr.trim()}`);
  const exitCode = dockerOk(['inspect', '--format', '{{.State.ExitCode}}', running.name]);
  expect(exitCode === '0', `the container exited with ${exitCode}, not 0`);
  expect(
    elapsed < STOP_WITHIN_MS,
    `docker stop took ${String(elapsed)} ms, the limit is ${String(STOP_WITHIN_MS)} ms`,
  );
  figures.stopMs = elapsed;
  return `exit code 0 after ${String(elapsed)} ms`;
}

function removeContainer(running: Running): void {
  docker(['rm', '-f', running.name]);
  containers.splice(containers.indexOf(running.name), 1);
}

function newVolume(): string {
  const name = nameOf('data');
  dockerOk(['volume', 'create', name]);
  volumes.push(name);
  return name;
}

// Fixtures ---------------------------------------------------------------------------------------------

const SAFE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">' +
  '<rect width="128" height="128" rx="16" fill="#0078d4"/><path d="M32 96V32h16l16 32 16-32h16v64h-14V60L64 92 46 60v36z" fill="#ffffff"/></svg>';

// A small PNG writer and reader, so that the script needs no image library: the fixtures are made
// here and the icon that comes back is judged here, while the code under test stays in the container.

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** An 8-bit RGB PNG whose rows come from `row(y)`; rows equal to the one above use filter Up (all zeros). */
function encodeRgb(width: number, height: number, row: (y: number) => Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const lines: Buffer[] = [];
  let previous: Buffer | undefined;
  for (let y = 0; y < height; y += 1) {
    const current = row(y);
    if (previous !== undefined && current.equals(previous)) {
      const same = Buffer.alloc(width * 3 + 1);
      same.writeUInt8(2, 0);
      lines.push(same);
    } else {
      lines.push(Buffer.concat([Buffer.from([0]), current]));
    }
    previous = current;
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(lines), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function logoPng(): Buffer {
  const blue = [0x00, 0x78, 0xd4];
  return encodeRgb(256, 256, (y) => {
    const line = Buffer.alloc(256 * 3);
    for (let x = 0; x < 256; x += 1) {
      const inside = y >= 64 && y < 192 && x >= 64 && x < 192;
      line.set(inside ? [255, 255, 255] : blue, x * 3);
    }
    return line;
  });
}

/** 4096 by 4096 (the pixel limit), blocks of 64 pixels of noise: the most work the file limit allows. */
function largestPng(): Buffer {
  let seed = 12345;
  const next = (): number => {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    return seed >> 16;
  };
  let block = Buffer.alloc(0);
  const png = encodeRgb(4096, 4096, (y) => {
    if (y % 64 === 0) {
      block = Buffer.alloc(4096 * 3);
      for (let x = 0; x < 4096; x += 64) {
        const colour = [next() & 255, next() & 255, next() & 255];
        for (let k = 0; k < 64; k += 1) block.set(colour, (x + k) * 3);
      }
    }
    return block;
  });
  if (png.length > MAX_LOGO_BYTES)
    throw new Error(`the largest fixture is ${String(png.length)} bytes, over the file limit`);
  return png;
}

interface Raster {
  readonly width: number;
  readonly height: number;
  /** One number per pixel: the colour, with alpha, packed. */
  readonly pixels: Uint32Array;
}

/** Reads an 8-bit PNG of colour type 0, 2, 3, 4 or 6 (not interlaced), which is what the server writes. */
function decodePng(png: Buffer): Raster {
  let at = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colourType = 0;
  let palette = Buffer.alloc(0);
  const parts: Buffer[] = [];
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data.readUInt8(8);
      colourType = data.readUInt8(9);
      expect(data.readUInt8(12) === 0, 'an interlaced PNG');
    } else if (type === 'PLTE') palette = Buffer.from(data);
    else if (type === 'IDAT') parts.push(Buffer.from(data));
    at += 12 + length;
  }
  expect(depth === 8, `a PNG of bit depth ${String(depth)}`);
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number | undefined>)[
    colourType
  ];
  expect(channels !== undefined, `a PNG of colour type ${String(colourType)}`);
  const raw = inflateSync(Buffer.concat(parts));
  const stride = width * channels;
  const rows = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw.readUInt8(y * (stride + 1));
    for (let x = 0; x < stride; x += 1) {
      const value = raw.readUInt8(y * (stride + 1) + 1 + x);
      const left = x >= channels ? rows.readUInt8(y * stride + x - channels) : 0;
      const up = y > 0 ? rows.readUInt8((y - 1) * stride + x) : 0;
      const upLeft = y > 0 && x >= channels ? rows.readUInt8((y - 1) * stride + x - channels) : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) {
        const estimate = left + up - upLeft;
        const dLeft = Math.abs(estimate - left);
        const dUp = Math.abs(estimate - up);
        const dUpLeft = Math.abs(estimate - upLeft);
        predictor = dLeft <= dUp && dLeft <= dUpLeft ? left : dUp <= dUpLeft ? up : upLeft;
      }
      rows.writeUInt8((value + predictor) & 255, y * stride + x);
    }
  }
  const pixels = new Uint32Array(width * height);
  for (let index = 0; index < width * height; index += 1) {
    const o = index * channels;
    let r: number;
    let g: number;
    let b: number;
    let a = 255;
    if (colourType === 3) {
      const entry = rows.readUInt8(o) * 3;
      r = palette.readUInt8(entry);
      g = palette.readUInt8(entry + 1);
      b = palette.readUInt8(entry + 2);
    } else if (colourType === 0 || colourType === 4) {
      r = g = b = rows.readUInt8(o);
      if (colourType === 4) a = rows.readUInt8(o + 1);
    } else {
      r = rows.readUInt8(o);
      g = rows.readUInt8(o + 1);
      b = rows.readUInt8(o + 2);
      if (colourType === 6) a = rows.readUInt8(o + 3);
    }
    pixels[index] = ((a << 24) | (r << 16) | (g << 8) | b) >>> 0;
  }
  return { width, height, pixels };
}

// The checks -----------------------------------------------------------------------------------------------

interface Branding {
  readonly revision: number;
  readonly orgName: string;
  readonly icons: { readonly pwa512: { readonly url: string } };
}
interface Upload {
  readonly asset: { readonly hash: string; readonly url: string };
  readonly warnings: readonly { readonly code: string }[];
}

async function csrfToken(origin: string, jar?: CookieJar): Promise<string> {
  return (await http(origin, '/api/v1/csrf', { ...(jar ? { jar } : {}) })).json<{ token: string }>()
    .token;
}

/**
 * The upload rate class (LIMITS.rateLimit.upload: a burst of 3, one token back every 10 s) is per
 * client, so a smoke test that uploads seven times has to wait for tokens or it is answered 429 and
 * proves nothing. This models the bucket of the server a little pessimistically.
 */
const UPLOAD_CAPACITY = LIMITS.rateLimit.upload.capacity;
const UPLOAD_REFILL_MS = LIMITS.rateLimit.upload.refillIntervalMs;
let uploadTokens: number = UPLOAD_CAPACITY;
let uploadTokensAt = Date.now();

async function acquireUploadTokens(count: number): Promise<void> {
  for (;;) {
    const now = Date.now();
    uploadTokens = Math.min(
      UPLOAD_CAPACITY,
      uploadTokens + (now - uploadTokensAt) / UPLOAD_REFILL_MS,
    );
    uploadTokensAt = now;
    if (uploadTokens >= count + 0.1) {
      uploadTokens -= count;
      return;
    }
    await sleep(Math.ceil((count + 0.1 - uploadTokens) * UPLOAD_REFILL_MS) + 200);
  }
}

async function upload(
  origin: string,
  token: string,
  slot: string,
  bytes: Buffer,
  filename: string,
  type: string,
  tokensAcquired = false,
  jar?: CookieJar,
): Promise<{ status: number; body: string; parsed?: Upload }> {
  if (!tokensAcquired) await acquireUploadTokens(1);
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)], { type }), filename);
  const answer = await http(origin, `/api/v1/branding/assets?slot=${slot}`, {
    method: 'POST',
    headers: { 'x-csrf-token': token },
    body: form,
    ...(jar ? { jar } : {}),
  });
  const ok = answer.status === 200 || answer.status === 201;
  return {
    status: answer.status,
    body: answer.text().slice(0, 400),
    ...(ok ? { parsed: answer.json<Upload>() } : {}),
  };
}

function memoryOf(name: string): { rssMb: number; peakMb: number } {
  const out = dockerOk([
    'exec',
    name,
    '/nodejs/bin/node',
    '-e',
    "const s=require('fs').readFileSync('/proc/1/status','utf8');const g=k=>Number(new RegExp(k+':\\\\s+(\\\\d+)').exec(s)[1]);console.log(JSON.stringify({rss:g('VmRSS'),peak:g('VmHWM')}))",
  ]);
  const parsed = JSON.parse(out) as { rss: number; peak: number };
  return { rssMb: Math.round(parsed.rss / 1024), peakMb: Math.round(parsed.peak / 1024) };
}

async function main(): Promise<void> {
  const version = readFileSync(join(root, 'VERSION'), 'utf8').trim();
  figures.image = image;
  figures.mode = mode;
  figures.network = network;

  // Image facts -------------------------------------------------------------------------------------------
  const imageExists = await check('image exists', () => {
    const inspected = docker(['image', 'inspect', image]);
    expect(
      inspected.status === 0,
      `docker image inspect ${image} failed: ${inspected.stderr.trim()}. Build it first: docker build --build-arg VERSION="$(cat VERSION)" -t ${image} .`,
    );
    return image;
  });
  if (!imageExists) return;

  const inspected = JSON.parse(dockerOk(['image', 'inspect', image])) as {
    Architecture: string;
    Config: { User: string; Labels: Record<string, string>; Healthcheck?: { Test: string[] } };
  }[];
  const config = inspected[0]?.Config;
  figures.architecture = inspected[0]?.Architecture ?? 'unknown';

  await check('image user', () => {
    const user = (config?.User ?? '').split(':')[0];
    expect(
      user === expectUser,
      `Config.User is "${config?.User ?? ''}", expected uid ${expectUser}`,
    );
    return `Config.User ${config?.User ?? ''}`;
  });
  await check('label version equals VERSION', () => {
    const label = config?.Labels['org.opencontainers.image.version'];
    expect(
      label === version,
      `label org.opencontainers.image.version is "${label ?? ''}", VERSION is "${version}" (build with --build-arg VERSION="$(cat VERSION)")`,
    );
    return version;
  });
  await check('image has a HEALTHCHECK', () => {
    const test = config?.Healthcheck?.Test;
    expect(
      Array.isArray(test) && test.join(' ').includes('dist/healthcheck.js'),
      `unexpected health check ${JSON.stringify(test)}`,
    );
    return JSON.stringify(test);
  });

  // The CLI of the image (FR-B-110; U34) -------------------------------------------------------------------
  const breakGlassPassword = randomBytes(18).toString('base64url');
  let breakGlassHash = '';
  await check(
    'generate-app-key prints one line: 32 random bytes as base64 (U34 form recorded)',
    () => {
      const done = cli(['generate-app-key']);
      expect(done.status === 0, `exit ${String(done.status)}: ${done.stderr.trim().slice(0, 200)}`);
      const lines = done.stdout.split('\n').filter((line) => line !== '');
      expect(lines.length === 1, `${String(lines.length)} lines on standard output, expected one`);
      const key = lines[0] ?? '';
      expect(Buffer.from(key, 'base64').length === 32, 'the line is not 32 bytes of base64');
      sealingKey = key;
      return `one line of ${String(key.length)} characters; verified form: ${cliForm?.name ?? '?'}`;
    },
  );
  if (sealingKey === '') return;
  await check(
    'hash-password reads standard input and prints only a scrypt hash line (FR-B-521)',
    () => {
      const refused = cli(['hash-password'], 'short\n');
      expect(
        refused.status === 1 && refused.stdout === '',
        `a short password gave exit ${String(refused.status)}`,
      );
      const done = cli(['hash-password'], `${breakGlassPassword}\n`);
      expect(done.status === 0, `exit ${String(done.status)}: ${done.stderr.trim().slice(0, 200)}`);
      const line = done.stdout.trim();
      expect(
        /^scrypt:\d+:\d+:\d+:[A-Za-z0-9+/_=-]+:[A-Za-z0-9+/_=-]+$/.test(line),
        'not a scrypt hash line',
      );
      expect(!line.includes('$'), 'the hash holds a dollar sign, which Compose would interpolate');
      expect(!done.stdout.includes(breakGlassPassword), 'the password is printed');
      breakGlassHash = line;
      return `scrypt hash of ${String(line.length)} characters, no dollar sign; a 5-character password is refused`;
    },
  );
  if (breakGlassHash === '') return;

  // Run 1: the default port --------------------------------------------------------------------------------
  const volume = newVolume();
  let first: Running | undefined;
  await check(
    'run 1 starts (default PORT, read-only, cap-drop ALL, no-new-privileges, APP_KEY, break-glass variables)',
    async () => {
      first = await startContainer({
        kind: 'main',
        mount: volume,
        env: {
          BREAK_GLASS_USERNAME: 'smoke-break-glass',
          BREAK_GLASS_PASSWORD_HASH: breakGlassHash,
        },
      });
      return `${first.name} on ${first.origin}`;
    },
  );
  if (first === undefined) return;
  const main1 = first;

  await check('/readyz is 200 within 10 s', async () => {
    const took = await waitReady(main1);
    figures.readyzMs = took;
    expect(
      took <= READY_WITHIN_MS,
      `/readyz answered 200 after ${String(took)} ms, the limit is ${String(READY_WITHIN_MS)} ms`,
    );
    return `${String(took)} ms after the container process started`;
  });
  await check(
    'Docker health becomes healthy (the image HEALTHCHECK, PORT default)',
    async () => `Docker health: ${await waitHealth(main1, 'healthy')}`,
  );
  await check('/healthz version equals VERSION', async () => {
    const answer = await http(main1.origin, '/healthz');
    expect(answer.status === 200, `/healthz answered ${String(answer.status)}`);
    const reported = answer.json<{ version: string }>().version;
    expect(reported === version, `/healthz says ${reported}, VERSION is ${version}`);
    return reported;
  });
  await check('the server process runs as the expected user', () => {
    const top = dockerOk(['top', main1.name, '-eo', 'uid,pid,args']);
    const lines = top
      .split('\n')
      .slice(1)
      .filter((line) => line.includes('dist/index.js'));
    expect(lines.length > 0, `no dist/index.js process in docker top:\n${top}`);
    const uid = (lines[0] ?? '').trim().split(/\s+/)[0];
    expect(uid === expectUser, `docker top shows uid ${uid ?? '?'}, expected ${expectUser}`);
    return `uid ${uid}`;
  });

  if (mode === 'skeleton') {
    await check('docker stop exits 0 within 10 s', () => stopAndCheck(main1));
    removeContainer(main1);
    return;
  }

  // Full mode ------------------------------------------------------------------------------------------------

  // The setup gate, in the image (FR-B-106, FR-B-110, FR-B-203, FR-B-706) -----------------------------------------
  const jar = new CookieJar();
  let setupToken = '';
  let certificateDer = Buffer.alloc(0);
  const printToken = (container: string): string => {
    const done = docker(['exec', container, '/nodejs/bin/node', 'dist/cli.js', 'setup-token']);
    expect(
      done.status === 0,
      `setup-token exited ${String(done.status)}: ${done.stderr.trim().slice(0, 200)}`,
    );
    return done.stdout.trim();
  };
  const unlockWith = async (origin: string, target: CookieJar, token: string): Promise<Answer> => {
    const anonymous = await csrfToken(origin);
    return http(origin, '/api/v1/setup/unlock', {
      method: 'POST',
      headers: { 'x-csrf-token': anonymous, 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
      jar: target,
    });
  };
  await check('setup-token prints the token with docker exec and the logs never hold it', () => {
    setupToken = printToken(main1.name);
    expect(
      setupToken.length >= 24 && setupToken.length <= 128,
      `a token of ${String(setupToken.length)} characters`,
    );
    expect(!logsOf(main1.name).includes(setupToken), 'the setup token is in the container logs');
    return `${String(setupToken.length)} characters, printed once, not in the logs`;
  });
  await check(
    'before the unlock the status asks for the token; a wrong token is refused (401)',
    async () => {
      const status = await http(main1.origin, '/api/v1/setup/status');
      expect(status.status === 200, `status answered ${String(status.status)}`);
      const body = status.json<{ state: string; tokenRequired: boolean }>();
      expect(
        body.state === 'unconfigured' && body.tokenRequired,
        `status ${status.text().slice(0, 120)}`,
      );
      const wrong = await unlockWith(main1.origin, new CookieJar(), 'x'.repeat(setupToken.length));
      expect(wrong.status === 401, `a wrong token answered ${String(wrong.status)}`);
      const state = await http(main1.origin, '/api/v1/setup/state');
      expect(
        state.status === 401,
        `the wizard state without a session answered ${String(state.status)}`,
      );
      return 'status unconfigured with tokenRequired, wrong token 401, state without a session 401';
    },
  );
  await check(
    'POST /api/v1/setup/unlock accepts the printed token and sets the setup cookie',
    async () => {
      const answer = await unlockWith(main1.origin, jar, setupToken);
      expect(
        answer.status === 200,
        `unlock answered ${String(answer.status)}: ${answer.text().slice(0, 200)}`,
      );
      expect(
        answer.json<{ state: string }>().state === 'in_progress',
        'the state is not in_progress',
      );
      expect(answer.headers.getSetCookie().length > 0, 'no cookie was set');
      expect(!answer.text().includes(setupToken), 'the token is echoed');
      return 'state in_progress, cookie set';
    },
  );
  await check(
    'POST /api/v1/setup/environment answers with the six checks of FR-B-213',
    async () => {
      const token = await csrfToken(main1.origin, jar);
      const answer = await http(main1.origin, '/api/v1/setup/environment', {
        method: 'POST',
        headers: { 'x-csrf-token': token, 'content-type': 'application/json' },
        body: '{}',
        jar,
      });
      expect(
        answer.status === 200,
        `environment answered ${String(answer.status)}: ${answer.text().slice(0, 200)}`,
      );
      const result = answer.json<{ checks: { key: string; status: string }[] }>();
      const byKey = new Map(result.checks.map((entry) => [entry.key, entry.status]));
      expect(
        [...byKey.keys()].sort().join() ===
          ['app_key', 'data_dir', 'network', 'node_version', 'public_base_url', 'time_skew'].join(),
        `checks: ${[...byKey.keys()].join(', ')}`,
      );
      for (const key of ['app_key', 'data_dir', 'public_base_url', 'node_version'])
        expect(byKey.get(key) === 'ok', `check ${key} is ${byKey.get(key) ?? 'missing'}`);
      return `app_key, data_dir, public_base_url and node_version ok; network ${byKey.get('network') ?? '?'}, time_skew ${byKey.get('time_skew') ?? '?'} (this host decides those two)`;
    },
  );
  await check(
    'a certificate is created inside the image and parses with the host openssl (RSA 2048, 360 days)',
    async () => {
      const answer = await http(main1.origin, '/api/v1/setup/certificate.cer', { jar });
      expect(
        answer.status === 200,
        `certificate.cer answered ${String(answer.status)}: ${answer.text().slice(0, 200)}`,
      );
      expect(
        (answer.headers.get('content-type') ?? '').startsWith('application/x-x509-ca-cert'),
        `content type ${answer.headers.get('content-type') ?? 'none'}`,
      );
      certificateDer = answer.bytes;
      expect(
        !certificateDer.toString('latin1').includes('PRIVATE'),
        'private material in the body',
      );
      const openssl = (args: readonly string[]): string => {
        const done = spawnSync('openssl', ['x509', '-inform', 'DER', '-noout', ...args], {
          input: certificateDer,
          encoding: 'utf8',
        });
        if (done.error) throw new Error(`cannot run openssl: ${done.error.message}`);
        expect(done.status === 0, `openssl x509 failed: ${done.stderr.trim().slice(0, 200)}`);
        return done.stdout;
      };
      const text = openssl(['-text']);
      expect(text.includes('Public-Key: (2048 bit)'), 'the key is not RSA 2048');
      expect(text.includes('rsaEncryption'), 'the key is not RSA');
      const dates = openssl(['-startdate', '-enddate']);
      const start = Date.parse(/notBefore=(.+)/.exec(dates)?.[1] ?? '');
      const end = Date.parse(/notAfter=(.+)/.exec(dates)?.[1] ?? '');
      const days = (end - start) / 86_400_000;
      expect(Math.abs(days - 360) < 1.01, `the validity is ${days.toFixed(2)} days, expected 360`);
      const fingerprint = new X509Certificate(certificateDer).fingerprint256;
      figures.certificateSha256 = fingerprint.replaceAll(':', '').slice(0, 16).toLowerCase();
      return `${String(certificateDer.length)} bytes DER, RSA 2048, ${days.toFixed(1)} days, SHA-256 ${figures.certificateSha256}...`;
    },
  );
  await check('Intl: grapheme segmenter and Dutch plural rules (PR-16)', () => {
    const code =
      "const g=[...new Intl.Segmenter('nl',{granularity:'grapheme'}).segment('e\\u0301\\u{1F1F3}\\u{1F1F1}\\u{1F468}\\u200D\\u{1F469}\\u200D\\u{1F467}')].length;" +
      "const p=new Intl.PluralRules('nl');console.log(JSON.stringify({g,one:p.select(1),other:p.select(2),node:process.version}))";
    const out = dockerOk([
      'run',
      '--rm',
      '--network',
      'none',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--entrypoint',
      '/nodejs/bin/node',
      image,
      '-e',
      code,
    ]);
    const parsed = JSON.parse(out) as { g: number; one: string; other: string; node: string };
    expect(parsed.g === 3, `Intl.Segmenter counts ${String(parsed.g)} graphemes, expected 3`);
    expect(
      parsed.one === 'one' && parsed.other === 'other',
      `PluralRules('nl') gave ${parsed.one}/${parsed.other}`,
    );
    return `node ${parsed.node}, 3 graphemes, plural one/other`;
  });
  await check(
    'SVG loader in the distroless libvips rasterises a safe SVG (R-06) and the image worker is bundled (PR-06)',
    () => {
      const code =
        "const fs=require('fs');const sharp=require('sharp');" +
        `const svg=Buffer.from(${JSON.stringify(SAFE_SVG)});` +
        "sharp(svg).png().toBuffer({resolveWithObject:true}).then(r=>console.log(JSON.stringify({w:r.info.width,h:r.info.height,svgInput:sharp.format.svg.input.buffer,libvips:sharp.versions.vips,rsvg:sharp.versions.rsvg,worker:fs.existsSync('/app/dist/image-worker.js')})))";
      const out = dockerOk([
        'run',
        '--rm',
        '--network',
        'none',
        '--read-only',
        '--cap-drop',
        'ALL',
        '--entrypoint',
        '/nodejs/bin/node',
        image,
        '-e',
        code,
      ]);
      const parsed = JSON.parse(out) as {
        w: number;
        h: number;
        svgInput: boolean;
        libvips: string;
        rsvg?: string;
        worker: boolean;
      };
      expect(
        parsed.svgInput && parsed.w === 128 && parsed.h === 128,
        `the SVG did not rasterise: ${out}`,
      );
      expect(parsed.worker, '/app/dist/image-worker.js is missing');
      figures.libvips = `${parsed.libvips} (librsvg ${parsed.rsvg ?? 'n/a'})`;
      return `128x128 PNG from SVG, libvips ${parsed.libvips}, librsvg ${parsed.rsvg ?? 'n/a'}; dist/image-worker.js present`;
    },
  );

  const memoryIdle = memoryOf(main1.name);
  figures.idleRssMb = memoryIdle.rssMb;

  let applied = false;
  await check(
    'CSRF-protected upload and apply work; the icon holds glyph pixels (no fonts in distroless)',
    async () => {
      const withoutToken = await http(main1.origin, '/api/v1/branding', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'if-match': '"1"' },
        body: '{}',
        jar,
      });
      expect(
        withoutToken.status === 403,
        `a write without a CSRF token answered ${String(withoutToken.status)}, expected 403`,
      );
      const token = await csrfToken(main1.origin, jar);
      const uploaded = await upload(
        main1.origin,
        token,
        'logoLight',
        logoPng(),
        'logo.png',
        'image/png',
        false,
        jar,
      );
      expect(
        uploaded.parsed !== undefined,
        `upload answered ${String(uploaded.status)}: ${uploaded.body}`,
      );
      const current = await http(main1.origin, '/api/v1/branding', { jar });
      const etag = current.headers.get('etag') ?? '"1"';
      const put = await http(main1.origin, '/api/v1/branding', {
        method: 'PUT',
        headers: { 'x-csrf-token': token, 'content-type': 'application/json', 'if-match': etag },
        jar,
        body: JSON.stringify({
          orgName: 'Acme Corp',
          accent: '#0078d4',
          logos: { light: uploaded.parsed.asset.hash, dark: null, compact: null },
        }),
      });
      expect(
        put.status === 200,
        `apply answered ${String(put.status)}: ${put.text().slice(0, 300)}`,
      );
      applied = true;
      const branding = put.json<Branding>();
      const icon = await http(main1.origin, branding.icons.pwa512.url);
      expect(icon.status === 200, `the icon answered ${String(icon.status)}`);
      const raster = decodePng(icon.bytes);
      const counts = new Map<number, number>();
      for (const pixel of raster.pixels) counts.set(pixel, (counts.get(pixel) ?? 0) + 1);
      const total = raster.width * raster.height;
      const dominant = Math.max(...counts.values());
      const glyph = total - dominant;
      expect(
        raster.width === 512 && raster.height === 512,
        `the icon is ${String(raster.width)}x${String(raster.height)}`,
      );
      expect(
        glyph > 20_000,
        `only ${String(glyph)} pixels differ from the tile colour: the monogram has no glyphs (no fonts?)`,
      );
      return `revision ${String(branding.revision)}, 512x512 icon with ${String(glyph)} glyph pixels (${((glyph / total) * 100).toFixed(1)} %)`;
    },
  );

  await check('a safe SVG upload is accepted and stored as PNG (R-06, real upload)', async () => {
    const token = await csrfToken(main1.origin, jar);
    const result = await upload(
      main1.origin,
      token,
      'logoDark',
      Buffer.from(SAFE_SVG),
      'logo.svg',
      'image/svg+xml',
      false,
      jar,
    );
    expect(
      result.parsed !== undefined,
      `SVG upload answered ${String(result.status)}: ${result.body}`,
    );
    const stored = await http(main1.origin, result.parsed.asset.url, { jar });
    expect(
      stored.status === 200 && stored.bytes.subarray(1, 4).toString('latin1') === 'PNG',
      'the stored SVG derivative is not a PNG',
    );
    figures.r06 = 'a safe SVG upload is rasterised by libvips in the distroless image';
    return `status ${String(result.status)}, warnings [${result.parsed.warnings.map((w) => w.code).join(', ')}], stored as PNG`;
  });

  await check('hostile SVGs are neutralised, not executed (script, XXE, bomb)', async () => {
    const token = await csrfToken(main1.origin, jar);
    const cases: [string, string][] = [
      [
        'script',
        '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><script>alert(1)</script><rect width="64" height="64" onload="alert(1)" fill="#f00"/></svg>',
      ],
      [
        'xxe',
        '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><text>&x;</text></svg>',
      ],
      [
        'bomb',
        '<svg xmlns="http://www.w3.org/2000/svg" width="60000" height="60000"><rect width="60000" height="60000" fill="#000"/></svg>',
      ],
    ];
    const seen: string[] = [];
    for (const [label, svg] of cases) {
      const result = await upload(
        main1.origin,
        token,
        'compact',
        Buffer.from(svg),
        `${label}.svg`,
        'image/svg+xml',
        false,
        jar,
      );
      if (result.parsed !== undefined) {
        const stored = await http(main1.origin, result.parsed.asset.url, { jar });
        expect(
          stored.bytes.subarray(1, 4).toString('latin1') === 'PNG',
          `${label}: stored output is not a PNG`,
        );
        expect(!stored.text().includes('root:'), `${label}: the output holds file contents`);
        seen.push(`${label}: accepted as PNG`);
      } else {
        expect(
          result.status >= 400 && result.status < 500,
          `${label}: answered ${String(result.status)}`,
        );
        seen.push(`${label}: refused ${String(result.status)}`);
      }
    }
    return seen.join('; ');
  });

  await check('two concurrent largest uploads: peak memory recorded (PR-15)', async () => {
    const token = await csrfToken(main1.origin, jar);
    const big = largestPng();
    await acquireUploadTokens(2);
    const begin = Date.now();
    const both = await Promise.all([
      upload(main1.origin, token, 'logoLight', big, 'big-1.png', 'image/png', true, jar),
      upload(main1.origin, token, 'logoDark', big, 'big-2.png', 'image/png', true, jar),
    ]);
    const memory = memoryOf(main1.name);
    figures.peakRssMb = memory.peakMb;
    figures.largeUploadMs = Date.now() - begin;
    const statuses = both.map((r) => r.status);
    expect(
      statuses.every((s) => s === 200 || s === 201),
      `the largest uploads were not both accepted: ${both.map((r) => `${String(r.status)} ${r.body.slice(0, 120)}`).join(' | ')}`,
    );
    return `PNG ${String(big.length)} bytes of 4096x4096; statuses ${statuses.join('/')} in ${String(Date.now() - begin)} ms; RSS idle ${String(memoryIdle.rssMb)} MB, now ${String(memory.rssMb)} MB, peak (VmHWM) ${String(memory.peakMb)} MB`;
  });

  await check('verify-audit is ok', () => {
    const done = docker(['exec', main1.name, '/nodejs/bin/node', 'dist/cli.js', 'verify-audit']);
    expect(
      done.status === 0,
      `verify-audit exited ${String(done.status)}: ${done.stdout}${done.stderr}`,
    );
    const verdict = JSON.parse(done.stdout.trim().split('\n').at(-1) ?? '{}') as {
      ok?: boolean;
      checked?: number;
    };
    expect(verdict.ok === true && (verdict.checked ?? 0) >= 2, `verdict ${done.stdout.trim()}`);
    return done.stdout.trim();
  });

  // Restart on the same volume ------------------------------------------------------------------------------
  const linesBefore = logsOf(main1.name).split('\n').length;
  await check('docker stop exits 0 within 10 s', () => stopAndCheck(main1));
  await check(
    'restart on the same volume keeps the branding and applies no migration twice',
    async () => {
      expect(applied, 'the apply step did not succeed, so there is nothing to keep');
      dockerOk(['start', main1.name]);
      const restarted: Running = { ...main1, startedAt: startedAtOf(main1.name) };
      await waitReady(restarted);
      const branding = (await http(main1.origin, '/api/v1/branding')).json<Branding>();
      expect(
        branding.orgName === 'Acme Corp',
        `orgName is "${branding.orgName}" after the restart`,
      );
      const newLines = logsOf(main1.name).split('\n').slice(linesBefore).join('\n');
      expect(newLines.includes('"event":"listening"'), 'the restart did not log "listening"');
      expect(!/"applied":[1-9]/.test(newLines), 'a migration was applied again after the restart');
      await waitHealth(restarted, 'healthy');
      return `orgName "${branding.orgName}", revision ${String(branding.revision)}, no migration applied`;
    },
  );
  await check(
    'the restart keeps the setup state and the certificate (FR-B-106; the session ends, the token file stays)',
    async () => {
      const again = new CookieJar();
      const status = await http(main1.origin, '/api/v1/setup/status');
      const body = status.json<{ state: string; tokenRequired: boolean }>();
      expect(
        body.state === 'in_progress' && body.tokenRequired,
        `status after the restart: ${status.text().slice(0, 120)}`,
      );
      const stale = await http(main1.origin, '/api/v1/setup/state', { jar });
      expect(
        stale.status === 401,
        `the old setup cookie still opens the wizard (${String(stale.status)})`,
      );
      const token = printToken(main1.name);
      expect(token === setupToken, 'setup-token prints another token after the restart');
      const unlocked = await unlockWith(main1.origin, again, token);
      expect(
        unlocked.status === 200,
        `unlock after the restart answered ${String(unlocked.status)}`,
      );
      const answer = await http(main1.origin, '/api/v1/setup/certificate.cer', { jar: again });
      expect(answer.status === 200, `certificate.cer answered ${String(answer.status)}`);
      expect(answer.bytes.equals(certificateDer), 'the certificate changed over the restart');
      return 'state in_progress, the old cookie is dead, the same token unlocks, the same certificate (byte for byte)';
    },
  );
  await check('docker stop after the restart exits 0 within 10 s', () => stopAndCheck(main1));
  await check(
    'a start without APP_KEY on the same volume: /readyz 503 with the secrets check (FR-B-108)',
    async () => {
      const run = await startContainer({ kind: 'nokey', mount: volume, appKey: false });
      await waitFor('/healthz 200', 30_000, async () => {
        try {
          return (await http(run.origin, '/healthz')).status === 200 ? true : undefined;
        } catch {
          return undefined;
        }
      });
      const ready = await http(run.origin, '/readyz');
      expect(ready.status === 503, `/readyz answered ${String(ready.status)}, expected 503`);
      expect(
        ready.text().includes('secrets') && ready.text().includes('app_key_missing'),
        `/readyz does not name the secrets check: ${ready.text().slice(0, 300)}`,
      );
      stopAndCheck(run);
      removeContainer(run);
      return '/readyz 503 secrets app_key_missing, /healthz 200';
    },
  );
  removeContainer(main1);

  // Size, Compose and the memory of the break-glass hash (FR-B-110, FR-B-710; SC-B-016) ---------------------------
  await check('the image size against the ceiling is re-measured', () => {
    const bytes = Number(dockerOk(['image', 'inspect', '--format', '{{.Size}}', image]));
    const megabytes = bytes / 1_000_000;
    figures.imageSizeMb = Number(megabytes.toFixed(1));
    expect(
      megabytes <= LIMITS.imageSizeCeilingMegabytes,
      `the image is ${megabytes.toFixed(1)} MB, the ceiling is ${String(LIMITS.imageSizeCeilingMegabytes)} MB`,
    );
    return `${megabytes.toFixed(1)} MB of ${String(LIMITS.imageSizeCeilingMegabytes)} MB`;
  });
  await check('docker compose config -q passes on the example file (FR-B-705)', () => {
    const done = spawnSync('docker', ['compose', '-f', 'docker-compose.yml', 'config', '-q'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(
      done.status === 0,
      `docker compose config -q exited ${String(done.status)}: ${(done.stderr || done.error?.message) ?? ''}`,
    );
    return 'docker-compose.yml is valid';
  });
  await check(
    'idle RSS is at most 200 MB and the 128 MiB scrypt of the break-glass hash fits in 256 MB',
    () => {
      expect(
        memoryIdle.rssMb <= 200,
        `idle RSS is ${String(memoryIdle.rssMb)} MB, the limit is 200 MB`,
      );
      const code =
        "const c=require('crypto');const t=Date.now();c.scryptSync('x'.repeat(20),Buffer.alloc(16),32,{N:131072,r:8,p:1,maxmem:268435456});" +
        'console.log(JSON.stringify({ms:Date.now()-t,peakKb:process.resourceUsage().maxRSS}))';
      const done = docker([
        'run',
        '--rm',
        '--network',
        'none',
        '--read-only',
        '--cap-drop',
        'ALL',
        '--memory',
        '256m',
        '--memory-swap',
        '256m',
        '--entrypoint',
        '/nodejs/bin/node',
        image,
        '-e',
        code,
      ]);
      expect(
        done.status === 0,
        `scrypt with N=131072 in 256 MB exited ${String(done.status)}: ${done.stderr.trim().slice(0, 200)}`,
      );
      const parsed = JSON.parse(done.stdout.trim()) as { ms: number; peakKb: number };
      figures.scryptPeakRssMb = Math.round(parsed.peakKb / 1024);
      figures.scryptMs = parsed.ms;
      const hashed = cli(['hash-password'], `${breakGlassPassword}\n`);
      expect(hashed.status === 0, 'hash-password failed under the same parameters');
      return `idle RSS ${String(memoryIdle.rssMb)} MB; scrypt N=131072 r=8 p=1 took ${String(parsed.ms)} ms with peak RSS ${String(Math.round(parsed.peakKb / 1024))} MB inside a 256 MB container`;
    },
  );

  // Run 2: a /data the user cannot write -----------------------------------------------------------------------
  const readOnlyData = mkdtempSync(join(tmpdir(), 'm365portal-smoke-rodata-'));
  scratchDirectories.push(readOnlyData);
  await check(
    'a /data that uid 65532 cannot write: /readyz 503 data_dir_not_writable, /healthz 200',
    async () => {
      const run = await startContainer({ kind: 'rodata', mount: readOnlyData });
      await waitFor('/healthz 200', 30_000, async () => {
        try {
          return (await http(run.origin, '/healthz')).status === 200 ? true : undefined;
        } catch {
          return undefined;
        }
      });
      const ready = await http(run.origin, '/readyz');
      expect(ready.status === 503, `/readyz answered ${String(ready.status)}, expected 503`);
      expect(
        ready.text().includes('data_dir_not_writable'),
        `/readyz body does not name data_dir_not_writable: ${ready.text().slice(0, 300)}`,
      );
      const live = await http(run.origin, '/healthz');
      expect(live.status === 200, `/healthz answered ${String(live.status)}`);
      await waitHealth(run, 'unhealthy', 40_000);
      stopAndCheck(run);
      removeContainer(run);
      return '/readyz 503 data_dir_not_writable, /healthz 200, Docker health unhealthy, stop exit 0';
    },
  );

  // Run 3: PORT from the environment -----------------------------------------------------------------------------
  await check(
    `PORT=${String(altPort)}: /healthz answers there and Docker health becomes healthy (FR-A-016, FR-A-165)`,
    async () => {
      const run = await startContainer({ kind: 'altport', port: altPort, mount: newVolume() });
      await waitReady(run);
      const live = await http(run.origin, '/healthz');
      expect(live.status === 200, `/healthz on ${run.origin} answered ${String(live.status)}`);
      await waitHealth(run, 'healthy');
      stopAndCheck(run);
      removeContainer(run);
      return `${run.origin}/healthz 200, healthy, stop exit 0`;
    },
  );
}

try {
  await main();
} catch (failure) {
  record('smoke test', false, failure instanceof Error ? failure.message : String(failure));
} finally {
  cleanup();
}

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${String(results.length - failed.length)} passed, ${String(failed.length)} failed. Figures: ${JSON.stringify(figures)}`,
);
if (process.env.SMOKE_REPORT !== undefined) {
  mkdirSync(dirname(resolve(process.env.SMOKE_REPORT)), { recursive: true });
  writeFileSync(process.env.SMOKE_REPORT, JSON.stringify({ results, figures }, null, 2));
}
process.exit(failed.length === 0 ? 0 : 1);

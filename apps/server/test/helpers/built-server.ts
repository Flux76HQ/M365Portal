// The built server as a real process (T-A-045, plan 13.2): the lifecycle is proven on the bundle
// `build.mjs` makes, started with `node`, signalled and watched from outside, not on the source.
//
// A bundle is built once per test file into a scratch directory laid out like the image:
//
//   <scratch>/dist/        index.js, cli.js, healthcheck.js, image-worker.js (build.mjs --outdir),
//                          and lifecycle-server.js (the same start sequence with one fixture module)
//   <scratch>/web/         the miniature frontend of the static tests (`../web` next to dist/)
//   <scratch>/drizzle/     the migrations (`../drizzle` next to dist/)
//   <scratch>/node_modules a link to the package's own, for the external dependencies
//
// There is no VERSION file anywhere in the scratch directory, so a version that comes back from
// `/healthz` was compiled into the bundle. The child gets an environment of its own: the proxy
// variables of the sandbox are not passed on.
import { spawn, type ChildProcess } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const SERVER_ROOT = fileURLToPath(new URL('../../', import.meta.url));

export interface BuiltLayout {
  readonly root: string;
  readonly dist: string;
  readonly web: string;
  remove(): Promise<void>;
}

/** Build the server like the image build does, and add the fixture entry. */
export async function buildLayout(): Promise<BuiltLayout> {
  const root = await mkdtemp(join(tmpdir(), 'm365portal-built-'));
  const dist = join(root, 'dist');
  const web = join(root, 'web');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [join(SERVER_ROOT, 'build.mjs'), '--outdir', dist], {
      stdio: 'pipe',
      env: { PATH: process.env.PATH ?? '' },
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`build.mjs exited with ${String(code)}:\n${output}`));
    });
  });

  const manifest = (await import(join(SERVER_ROOT, 'package.json'), {
    with: { type: 'json' },
  })) as {
    default: { dependencies: Record<string, string> };
  };
  await build({
    absWorkingDir: SERVER_ROOT,
    entryPoints: { 'lifecycle-server': 'test/fixtures/lifecycle-server.ts' },
    outdir: dist,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    external: Object.keys(manifest.default.dependencies),
    define: { __APP_VERSION__: JSON.stringify('0.0.0') },
    legalComments: 'none',
    logLevel: 'silent',
  });

  await cp(join(SERVER_ROOT, 'test', 'fixtures', 'web-dist'), web, { recursive: true });
  await cp(join(SERVER_ROOT, 'drizzle'), join(root, 'drizzle'), { recursive: true });
  await symlink(join(SERVER_ROOT, 'node_modules'), join(root, 'node_modules'), 'dir');
  await mkdir(join(root, 'data'), { recursive: true });
  return {
    root,
    dist,
    web,
    remove: async () => {
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

/**
 * A port the operating system hands out for loopback right now. The kernel gives parallel callers
 * different ephemeral ports (it does not reuse one at once), so test files running side by side do
 * not pick the same number the way a random choice from a small range does.
 */
export async function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => {
        if (port === 0) reject(new Error('the operating system gave no port'));
        else resolve(port);
      });
    });
  });
}

export interface HttpResult {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
}

/** A plain HTTP request to the loopback port; the sandbox proxy variables do not apply. */
export function httpRequest(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const call = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: options.headers,
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        response.on('error', reject);
      },
    );
    call.on('error', reject);
    call.end(options.body);
  });
}

export interface ExitResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface SpawnedServer {
  readonly port: number;
  readonly child: ChildProcess;
  /** Each line the process wrote to standard output, parsed as JSON. */
  lines(): Record<string, unknown>[];
  stdout(): string;
  stderr(): string;
  /** Resolves when the process has exited. */
  exited: Promise<ExitResult>;
  /** Resolves when the `listening` line appears; rejects if the process exits first. */
  listening(): Promise<void>;
  get(path: string, headers?: Record<string, string>): Promise<HttpResult>;
  signal(name: NodeJS.Signals): void;
  kill(): void;
}

export interface SpawnOptions {
  readonly layout: BuiltLayout;
  /** The file in dist/ to run. Default `index.js`. */
  readonly entry?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly port?: number;
}

/** Start `node dist/<entry>` with a clean environment; the process is killed when the test ends. */
export async function spawnServer(options: SpawnOptions): Promise<SpawnedServer> {
  const port = options.port ?? (await freePort());
  const child = spawn(process.execPath, [join(options.layout.dist, options.entry ?? 'index.js')], {
    cwd: options.layout.root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH ?? '',
      HOST: '127.0.0.1',
      PORT: String(port),
      DATA_DIR: join(options.layout.root, 'data'),
      PUBLIC_BASE_URL: `http://localhost:${String(port)}`,
      ...options.env,
    },
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
  const exited = new Promise<ExitResult>((resolve) => {
    child.once('exit', (code, signal) => {
      resolve({ code, signal });
    });
  });
  const lines = (): Record<string, unknown>[] =>
    out
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as Record<string, unknown>);

  const server: SpawnedServer = {
    port,
    child,
    lines,
    stdout: () => out,
    stderr: () => err,
    exited,
    listening: () =>
      new Promise<void>((resolve, reject) => {
        const started = Date.now();
        const poll = setInterval(() => {
          if (lines().some((line) => line.event === 'listening')) {
            clearInterval(poll);
            resolve();
          } else if (child.exitCode !== null || child.signalCode !== null) {
            clearInterval(poll);
            reject(new Error(`the server exited before it listened:\n${out}\n${err}`));
          } else if (Date.now() - started > 30_000) {
            clearInterval(poll);
            reject(new Error(`the server did not listen within 30 s:\n${out}\n${err}`));
          }
        }, 25);
      }),
    get: (path, headers) => httpRequest(port, path, headers === undefined ? {} : { headers }),
    signal: (name) => {
      child.kill(name);
    },
    kill: () => {
      child.kill('SIGKILL');
    },
  };
  return server;
}

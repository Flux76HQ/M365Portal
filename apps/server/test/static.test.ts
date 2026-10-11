// T-A-043: FR-A-048, FR-A-050 (static part), E-27, C6, plan 7.5.
//
// Static files come from the build output directory and from nowhere else: no directory listing, no
// dotfile, no path that leaves the root (plain, encoded, double-encoded, backslash, NUL, doubled or
// encoded slashes). An unknown asset is a 404 problem and never `index.html`. The SPA fallback answers
// only a GET or HEAD navigation that accepts HTML, outside `/api`, `/branding` and `/assets`, for a
// path without a file extension: 200, `no-store`, the html profile and a fresh nonce on every
// request, so a shell with a nonce in it is never cached. `/sw.js` has the worker profile and
// `no-cache`. `createPlaceholderShell()` fills only `__M365_NONCE__`, in one pass.
//
// The traversal table is a guard (`assertStaticIsSafe`): it is run over a real socket with the exact
// bytes of each path, and its negative fixture is the library on its own (`serveStatic` without the
// guard in front of it), which lets `index.html` and a dotfile through.
//
// The fixture build output is `test/fixtures/web-dist`; each test works in a temporary copy that also
// holds a dotfile, a file outside the root and a hostile directory, so nothing here touches the tree.
import { cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { serveStatic } from '@hono/node-server/serve-static';
import { expectGuardFails } from '@m365portal/shared/testing';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { WORKER_CSP } from '../src/http/csp.js';
import { isShellRequest, spaFallback } from '../src/http/spa-fallback.js';
import { isServablePath, serviceWorkerRoute, staticFallback } from '../src/http/static.js';
import {
  NONCE_PLACEHOLDER,
  ShellTemplateError,
  createPlaceholderShell,
  readShellTemplate,
} from '../src/shell-port.js';
import {
  createFixtureApp,
  fixtureRoutes,
  type FixtureApp,
  type FixtureAppOptions,
} from './helpers/http-app.js';
import { createTempDataDir } from './helpers/temp-data-dir.js';
import { createTestApp } from './helpers/test-app.js';

const FIXTURE_DIST = fileURLToPath(new URL('./fixtures/web-dist', import.meta.url));
const SECRET = 'canary-outside-root-3c9a41';
const DOTFILE_SECRET = 'canary-dotfile-77be02';
const HTML = { accept: 'text/html,application/xhtml+xml' };

interface Site {
  readonly root: string;
  readonly outside: string;
}

/** A copy of the fixture build output with a file outside it, a dotfile and a hostile directory. */
async function makeSite(): Promise<Site> {
  const dir = await createTempDataDir();
  const root = join(dir.path, 'dist');
  cpSync(FIXTURE_DIST, root, { recursive: true });
  writeFileSync(join(dir.path, 'secret.txt'), SECRET);
  writeFileSync(join(root, '.env'), `TOKEN=${DOTFILE_SECRET}\n`);
  writeFileSync(join(root, 'assets', '.hidden.js'), `// ${DOTFILE_SECRET}\n`);
  mkdirSync(join(root, 'assets', '.git'));
  writeFileSync(join(root, 'assets', '.git', 'config'), DOTFILE_SECRET);
  mkdirSync(join(root, 'assets', 'sub'));
  writeFileSync(join(root, 'assets', 'sub', 'inner-def456.js'), 'export const inner = 1;\n');
  writeFileSync(join(root, 'assets', 'index.html'), `<p>${DOTFILE_SECRET}</p>`);
  // A directory with a file-like name and an index inside, and a symlink out of the root.
  mkdirSync(join(root, 'assets', 'dir.js'));
  writeFileSync(join(root, 'assets', 'dir.js', 'index.html'), `<p>${DOTFILE_SECRET}</p>`);
  symlinkSync(join(dir.path, 'secret.txt'), join(root, 'assets', 'link-abc123.js'));
  return { root, outside: join(dir.path, 'secret.txt') };
}

interface SiteApp extends FixtureApp {
  readonly site: Site;
}

async function siteApp(options: Pick<FixtureAppOptions, 'rules'> = {}): Promise<SiteApp> {
  const site = await makeSite();
  const shell = createPlaceholderShell(readShellTemplate(site.root));
  const app = await createFixtureApp({
    ...(options.rules === undefined ? {} : { rules: options.rules }),
    routes: ({ calls, csrf }) => [
      ...fixtureRoutes(calls, csrf),
      serviceWorkerRoute({ root: site.root }),
    ],
    fallbacks: [staticFallback({ root: site.root }), spaFallback({ shell })],
  });
  return Object.assign(app, { site });
}

// ---------------------------------------------------------------------------------------------
// Serving files
// ---------------------------------------------------------------------------------------------

describe('serving the build output (FR-A-048, FR-A-050)', () => {
  it.each([
    ['/assets/app-abc123.js', 'text/javascript'],
    ['/assets/style-abc123.css', 'text/css'],
    ['/assets/icon-abc123.svg', 'image/svg+xml'],
    ['/assets/data-abc123.json', 'application/json'],
    ['/assets/font-abc123.woff2', 'font/woff2'],
    ['/assets/sub/inner-def456.js', 'text/javascript'],
  ])('%s has the Content-Type %s', async (path, type) => {
    const app = await siteApp();
    const response = await app.client.get(path);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain(type);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('serves the bytes of the file, immutable and public (hashed build output)', async () => {
    const app = await siteApp();
    const response = await app.client.get('/assets/style-abc123.css');
    expect(await response.text()).toBe(
      readFileSync(join(app.site.root, 'assets', 'style-abc123.css'), 'utf8'),
    );
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('answers HEAD with the headers and no body', async () => {
    const app = await siteApp();
    const response = await app.client.request('HEAD', '/assets/style-abc123.css');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe(
      String(readFileSync(join(app.site.root, 'assets', 'style-abc123.css')).length),
    );
    expect(await response.text()).toBe('');
  });

  it('serves offline.html with no-cache, an ETag and the html profile without a nonce', async () => {
    const app = await siteApp();
    const response = await app.client.get('/offline.html');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(response.headers.get('etag')).toMatch(/^W\//);
    const csp = response.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('nonce-');
    expect(csp).toContain("require-trusted-types-for 'script'");
  });

  it('revalidates offline.html: a matching If-None-Match gives 304', async () => {
    const app = await siteApp();
    const first = await app.client.get('/offline.html');
    const second = await app.client.get('/offline.html', {
      headers: { 'if-none-match': first.headers.get('etag') ?? '' },
    });
    expect(second.status).toBe(304);
  });

  it('is exempt from rate limiting: assets and the offline page answer a burst', async () => {
    const app = await siteApp({
      rules: {
        read: { capacity: 1, refillIntervalMs: 60_000 },
        write: { capacity: 10, refillIntervalMs: 2_000 },
        upload: { capacity: 3, refillIntervalMs: 10_000 },
      },
    });
    for (let request = 0; request < 30; request += 1) {
      expect((await app.client.get('/assets/app-abc123.js')).status).toBe(200);
      expect((await app.client.get('/offline.html')).status).toBe(200);
      expect((await app.client.get('/sw.js')).status).toBe(200);
    }
  });
});

describe('precompressed siblings (plan 7.5)', () => {
  const identity = readFileSync(join(FIXTURE_DIST, 'assets', 'app-abc123.js'));

  it('serves Brotli to a client that accepts it, with Content-Encoding and Vary', async () => {
    const app = await siteApp();
    const response = await app.client.get('/assets/app-abc123.js', {
      headers: { 'accept-encoding': 'br, gzip' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-encoding')).toBe('br');
    expect(response.headers.get('vary')?.toLowerCase()).toContain('accept-encoding');
    expect(response.headers.get('content-type')).toContain('text/javascript');
    expect(brotliDecompressSync(Buffer.from(await response.arrayBuffer()))).toEqual(identity);
  });

  it('serves gzip to a client that accepts only gzip', async () => {
    const app = await siteApp();
    const response = await app.client.get('/assets/app-abc123.js', {
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(response.headers.get('content-encoding')).toBe('gzip');
    expect(response.headers.get('vary')?.toLowerCase()).toContain('accept-encoding');
    expect(gunzipSync(Buffer.from(await response.arrayBuffer()))).toEqual(identity);
  });

  it('serves the file itself to a client that accepts neither, and still says Vary', async () => {
    const app = await siteApp();
    const response = await app.client.get('/assets/app-abc123.js', {
      headers: { 'accept-encoding': 'identity' },
    });
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.headers.get('vary')?.toLowerCase()).toContain('accept-encoding');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(identity);
  });

  it('says Vary on the plain file too when it has siblings (a cache must know the URL varies)', async () => {
    // A file under 1 KiB, so that the compression layer adds nothing and the Vary is the file server's.
    const app = await siteApp();
    const response = await app.client.get('/assets/small-abc123.js', {
      headers: { 'accept-encoding': 'identity' },
    });
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.headers.get('vary')?.toLowerCase()).toContain('accept-encoding');
    const plain = await app.client.get('/assets/style-abc123.css');
    expect(plain.headers.get('vary')).toBeNull();
  });

  it('keeps the immutable cache rule on a precompressed answer', async () => {
    const app = await siteApp();
    const response = await app.client.get('/assets/app-abc123.js', {
      headers: { 'accept-encoding': 'br' },
    });
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('does not compress a second time', async () => {
    const app = await siteApp();
    const response = await app.client.get('/assets/app-abc123.js', {
      headers: { 'accept-encoding': 'br' },
    });
    // One decompression gives the source text; a second pass would have produced garbage.
    expect(
      brotliDecompressSync(Buffer.from(await response.arrayBuffer())).toString('utf8'),
    ).toContain('fixtureLine0');
  });
});

// ---------------------------------------------------------------------------------------------
// Paths that must never be served: the guard and its negative fixture
// ---------------------------------------------------------------------------------------------

interface RawResponse {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

/** A GET with the exact bytes of the path: no client normalises `..` or `%2e` on the way. */
function rawGet(
  port: number,
  path: string,
  headers: Record<string, string> = {},
  method = 'GET',
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: '127.0.0.1', port, path, method, headers }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.on('end', () => {
        resolve({
          status: incoming.statusCode ?? 0,
          headers: incoming.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
}

/** Paths that try to leave the root or to reach what the build never published. */
const HOSTILE_PATHS: readonly string[] = [
  '/assets/../../secret.txt',
  '/assets/../secret.txt',
  '/assets/%2e%2e/%2e%2e/secret.txt',
  '/assets/%2E%2E/%2E%2E/secret.txt',
  '/assets/%2e%2e%2f%2e%2e%2fsecret.txt',
  '/assets/..%2f..%2fsecret.txt',
  '/assets/..%2F..%2Fsecret.txt',
  '/assets/%252e%252e/%252e%252e/secret.txt',
  '/assets/%252e%252e%252fsecret.txt',
  '/assets/..\\..\\secret.txt',
  '/assets/..%5c..%5csecret.txt',
  '/assets/%5c..%5csecret.txt',
  '/assets/%00/../secret.txt',
  '/assets/app-abc123.js%00.png',
  '/assets/app-abc123.js%00',
  '//assets/app-abc123.js/../../secret.txt',
  '/assets//..//secret.txt',
  '/assets/%2fsecret.txt',
  '/assets/%2f%2e%2e%2fsecret.txt',
  '/assets/..;/secret.txt',
  '/offline.html/../../secret.txt',
  '/offline.html%2f..%2f..%2fsecret.txt',
  '/%2e%2e/secret.txt',
  '/..%2fsecret.txt',
  // What exists but is not published.
  '/.env',
  '/assets/.env',
  '/assets/.hidden.js',
  '/assets/.git/config',
  '/assets/%2ehidden.js',
  '/assets/%2egit/config',
  '/index.html',
  '/assets/index.html',
  '/assets/sub/..%2findex.html',
  '/INDEX.HTML',
  // A directory named like a file, and a symlink that points out of the root.
  '/assets/dir.js',
  '/assets/dir.js/',
  '/assets/link-abc123.js',
  // Directories are not listed.
  '/assets',
  '/assets/',
  '/assets/sub',
  '/assets/sub/',
  '/assets/.',
  '/assets/./',
];

/**
 * The guard: every hostile path is refused (400 or 404, never 200), and nothing it serves contains
 * the canaries or the raw shell template. Throws, naming the path, on the first deviation.
 */
async function assertStaticIsSafe(
  get: (path: string) => Promise<RawResponse>,
  paths: readonly string[] = HOSTILE_PATHS,
): Promise<void> {
  for (const path of paths) {
    const response = await get(path);
    for (const canary of [SECRET, DOTFILE_SECRET, NONCE_PLACEHOLDER]) {
      if (response.body.includes(canary)) {
        throw new Error(
          `${path}: served content that must stay private (${canary.slice(0, 12)}...)`,
        );
      }
    }
    if (response.status !== 404 && response.status !== 400) {
      throw new Error(`${path}: answered ${String(response.status)}, not a refusal`);
    }
  }
}

describe('traversal, dotfiles and directories (FR-A-048, E-27)', () => {
  it('refuses every hostile path over a real socket, with the exact bytes of the path', async () => {
    const app = await siteApp();
    const running = await app.listen();
    await expect(
      assertStaticIsSafe((path) => rawGet(running.port, path, HTML)),
    ).resolves.toBeUndefined();
  });

  it('refuses them in process as well (the Request normalises some of them first)', async () => {
    const app = await siteApp();
    await expect(
      assertStaticIsSafe(async (path) => {
        const response = await app.client.get(path, { headers: HTML });
        return { status: response.status, headers: {}, body: await response.text() };
      }),
    ).resolves.toBeUndefined();
  });

  it.each(['/assets/missing-123.js', '/assets/sub/nothing.js', '/assets/app-abc123.js.map'])(
    'answers an unknown asset %s with a 404 problem, never index.html',
    async (path) => {
      const app = await siteApp();
      const response = await app.client.get(path, { headers: HTML });
      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toContain('application/problem+json');
      const text = await response.text();
      expect(JSON.parse(text)).toMatchObject({ code: 'not_found' });
      expect(text).not.toContain('<html');
    },
  );

  it('answers a missing offline file with a 404 problem as well', async () => {
    const app = await siteApp();
    for (const path of ['/offline.css', '/offline.js']) {
      const response = await app.client.get(path, { headers: HTML });
      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toContain('application/problem+json');
    }
  });

  it('does not list a directory or name its files in any answer', async () => {
    const app = await siteApp();
    for (const path of ['/assets', '/assets/', '/assets/sub/']) {
      const text = await (await app.client.get(path, { headers: HTML })).text();
      expect(text).not.toContain('app-abc123');
      expect(text).not.toContain('inner-def456');
    }
  });

  describe('negative fixture: the library without the guard in front of it fails the table', () => {
    it('lets the raw template and a dotfile through', async () => {
      const site = await makeSite();
      const unguarded = await createTestApp({
        buildApp: () => {
          const app = new Hono();
          app.use('*', serveStatic({ root: site.root }));
          return app;
        },
      });
      const running = await unguarded.listen();
      await expectGuardFails(
        (get: (path: string) => Promise<RawResponse>) => assertStaticIsSafe(get),
        (path) => rawGet(running.port, path, HTML),
        { reason: /served content that must stay private|not a refusal/ },
      );
    });

    it('is caught for the dotfile alone, and for the directory index alone', async () => {
      const site = await makeSite();
      const unguarded = await createTestApp({
        buildApp: () => {
          const app = new Hono();
          app.use('*', serveStatic({ root: site.root }));
          return app;
        },
      });
      const running = await unguarded.listen();
      const get = (path: string): Promise<RawResponse> => rawGet(running.port, path, HTML);
      await expectGuardFails(
        (paths: readonly string[]) => assertStaticIsSafe(get, paths),
        ['/.env'],
        {
          reason: '/.env',
        },
      );
      await expectGuardFails(
        (paths: readonly string[]) => assertStaticIsSafe(get, paths),
        ['/assets/'],
        {
          reason: '/assets/',
        },
      );
    });
  });
});

describe('isServablePath: the guard in front of the library', () => {
  it.each([
    '/assets/app-abc123.js',
    '/assets/sub/inner-def456.js',
    '/offline.html',
    '/sw.js',
    '/assets/font-a_b-c.woff2',
  ])('accepts %s', (path) => {
    expect(isServablePath(path)).toBe(true);
  });

  it.each([
    '',
    '/',
    '/assets',
    '/assets/',
    '/assets/.hidden.js',
    '/.env',
    '/assets/../x.js',
    '/assets/./x.js',
    '/assets//x.js',
    '//x.js',
    '/assets/x.js/',
    '/assets/a b.js',
    '/assets/a%20b.js',
    '/assets/a\\b.js',
    '/assets/a\u0000b.js',
    '/assets/é.js',
    '/assets/x.js?x=1',
    '/assets/x.js#x',
    '/assets/noextension',
    '/assets/trailingdot.',
    '/index.html',
    '/assets/index.html',
    '/assets/Index.HTML',
    `/assets/${'a'.repeat(300)}.js`,
  ])('refuses %j', (path) => {
    expect(isServablePath(path)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// The SPA fallback and the shell
// ---------------------------------------------------------------------------------------------

describe('the SPA fallback (FR-A-048, plan 7.5)', () => {
  it.each(['/', '/users', '/settings/appearance', '/a/b/c', '/users/', '/dashboard%20x'])(
    'answers the navigation %s with the shell: 200, no-store, the html profile',
    async (path) => {
      const app = await siteApp();
      const response = await app.client.get(path, { headers: HTML });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('etag')).toBeNull();
      expect(response.headers.get('last-modified')).toBeNull();
      expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin');
      expect(response.headers.get('x-frame-options')).toBe('DENY');
      expect(await response.text()).toContain('<div id="root">');
    },
  );

  it('puts the nonce of the CSP in every nonce attribute of the body', async () => {
    const app = await siteApp();
    const response = await app.client.get('/users', { headers: HTML });
    const csp = response.headers.get('content-security-policy') ?? '';
    const nonce = /script-src 'self' 'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeDefined();
    expect(csp).toContain(`style-src 'self' 'nonce-${nonce ?? ''}'`);
    const body = await response.text();
    const attributes = [...body.matchAll(/nonce="([^"]*)"/g)].map((match) => match[1]);
    expect(attributes.length).toBeGreaterThanOrEqual(3);
    for (const attribute of attributes) expect(attribute).toBe(nonce);
    expect(body).not.toContain(NONCE_PLACEHOLDER);
  });

  it('gives every request a fresh nonce, and never a cacheable answer with one in it', async () => {
    const app = await siteApp();
    const nonces = new Set<string>();
    const bodies = new Set<string>();
    for (let request = 0; request < 5; request += 1) {
      // Brotli on, so that a compression layer which cached its output would repeat itself.
      const response = await app.client.get('/users', {
        headers: { ...HTML, 'accept-encoding': 'br' },
      });
      expect(response.headers.get('content-encoding')).toBe('br');
      const text = brotliDecompressSync(Buffer.from(await response.arrayBuffer())).toString('utf8');
      const nonce = /script-src 'self' 'nonce-([^']+)'/.exec(
        response.headers.get('content-security-policy') ?? '',
      )?.[1];
      nonces.add(nonce ?? '');
      bodies.add(text);
      expect(text).toContain(`nonce="${nonce ?? ''}"`);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect(nonces.size).toBe(5);
    expect(bodies.size).toBe(5);
    for (const nonce of nonces)
      expect(Buffer.from(nonce, 'base64').length).toBeGreaterThanOrEqual(16);
  });

  it('does not answer 304 to a conditional request: there is nothing to validate', async () => {
    const app = await siteApp();
    const response = await app.client.get('/users', {
      headers: {
        ...HTML,
        'if-none-match': '*',
        'if-modified-since': 'Wed, 21 Oct 2026 07:28:00 GMT',
      },
    });
    expect(response.status).toBe(200);
  });

  it('answers HEAD with the headers of a navigation and no body', async () => {
    const app = await siteApp();
    const response = await app.client.request('HEAD', '/users', { headers: HTML });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-security-policy')).toContain("'nonce-");
    expect(await response.text()).toBe('');
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('%s is never the shell', async (method) => {
    const app = await siteApp();
    const response = await app.client.request(method, '/users', {
      headers: HTML,
      ...(method === 'DELETE' ? {} : { json: {} }),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.headers.get('content-type')).not.toContain('text/html');
  });

  it.each(['*/*', 'application/json', 'text/plain', 'image/png', 'text/html;q=0', ''])(
    'is not the shell for Accept: %j',
    async (accept) => {
      const app = await siteApp();
      const response = await app.client.get('/users', { headers: { accept } });
      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toContain('application/problem+json');
    },
  );

  it('is not the shell for a request without an Accept header', async () => {
    const app = await siteApp();
    const response = await app.client.get('/users');
    expect(response.status).toBe(404);
  });

  it('accepts text/html among other types, in any case and with parameters', async () => {
    const app = await siteApp();
    for (const accept of [
      'text/html',
      'TEXT/HTML',
      'application/json, text/html;q=0.8',
      'text/html; charset=utf-8',
      'image/avif,image/webp,text/html;q=0.9,*/*;q=0.8',
    ]) {
      const response = await app.client.get('/users', { headers: { accept } });
      expect(response.status, accept).toBe(200);
    }
  });

  it.each([
    '/api',
    '/api/',
    '/api/v1/unknown',
    '/api/v1/users',
    '/branding',
    '/branding/',
    '/branding/zzz',
    '/assets',
    '/assets/',
    '/assets/nothing',
  ])('is never the shell under %s, even for a navigation', async (path) => {
    const app = await siteApp();
    const response = await app.client.get(path, { headers: HTML });
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
  });

  it.each([
    '/favicon.ico',
    '/robots.txt',
    '/apple-touch-icon.png',
    '/index.html',
    '/manifest.webmanifest',
    '/some.page',
    '/x.png',
    '/a/b.css',
    '/missing.js',
  ])('is never the shell for the file-like path %s', async (path) => {
    const app = await siteApp();
    const response = await app.client.get(path, { headers: HTML });
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    expect(await response.text()).not.toContain('<div id="root">');
  });

  it('leaves a route that is registered alone: an API route is not shadowed by the shell', async () => {
    const app = await siteApp();
    const response = await app.client.get('/api/v1/fixture/read', { headers: HTML });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
  });
});

describe('isShellRequest', () => {
  const base = { method: 'GET', path: '/users', accept: 'text/html' };

  it('is true for a navigation', () => {
    expect(isShellRequest(base)).toBe(true);
    expect(isShellRequest({ ...base, method: 'HEAD' })).toBe(true);
  });

  it.each([
    { method: 'POST' },
    { method: 'OPTIONS' },
    { accept: undefined },
    { accept: '*/*' },
    { path: '/api/x' },
    { path: '/api' },
    { path: '/branding/x' },
    { path: '/assets/x' },
    { path: '/x.js' },
    { path: '/dir/file.txt' },
  ])('is false for %j', (override) => {
    expect(isShellRequest({ ...base, ...override })).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// The worker
// ---------------------------------------------------------------------------------------------

describe('/sw.js (R17, FR-A-050, plan V-04)', () => {
  it('is JavaScript with the worker profile and no-cache, with an ETag', async () => {
    const app = await siteApp();
    const response = await app.client.get('/sw.js');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/javascript');
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(response.headers.get('etag')).toMatch(/^W\//);
    expect(response.headers.get('content-security-policy')).toBe(WORKER_CSP);
    expect(response.headers.get('cross-origin-embedder-policy')).toBe('require-corp');
    expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(await response.text()).toContain('fixture service worker');
  });

  it('answers a matching If-None-Match with 304', async () => {
    const app = await siteApp();
    const first = await app.client.get('/sw.js');
    const second = await app.client.get('/sw.js', {
      headers: { 'if-none-match': first.headers.get('etag') ?? '' },
    });
    expect(second.status).toBe(304);
  });

  it('is in the route table as a public, exempt route and in the OpenAPI document', async () => {
    const app = await siteApp();
    const route = app.http.table.routes.find((candidate) => candidate.id === 'pwa.serviceWorker');
    expect(route?.access).toEqual({ public: true });
    expect(route?.rateLimit).toBe('exempt');
    expect(JSON.stringify(app.http.document.paths)).toContain('/sw.js');
  });

  it.each(['/sw.js/', '/sw.js.map', '/SW.js', '/sw.JS'])(
    '%s is a 404 problem with the ordinary profile',
    async (path) => {
      const app = await siteApp();
      const response = await app.client.get(path, { headers: HTML });
      expect(response.status).toBe(404);
      expect(response.headers.get('content-security-policy')).not.toBe(WORKER_CSP);
    },
  );
});

// ---------------------------------------------------------------------------------------------
// The shell port
// ---------------------------------------------------------------------------------------------

describe('createPlaceholderShell (C6)', () => {
  const NONCE = 'AbCd+/EfGhIjKlMnOpQrSt==';

  it('fills __M365_NONCE__ and nothing else', async () => {
    const template = readFileSync(join(FIXTURE_DIST, 'index.html'), 'utf8');
    const html = await createPlaceholderShell(template).render({
      nonce: NONCE,
      request: new Request('http://localhost:9300/users'),
    });
    expect(html).not.toContain(NONCE_PLACEHOLDER);
    expect(html.split(NONCE).length - 1).toBe(template.split(NONCE_PLACEHOLDER).length - 1);
    expect(html).toBe(template.replaceAll(NONCE_PLACEHOLDER, NONCE));
    for (const other of [
      '__M365_TITLE__',
      '__M365_THEME_CSS__',
      '__M365_ICON_LINKS__',
      '__M365_THEME_COLOR__',
      '__M365_BOOT_JSON__',
    ]) {
      expect(html).toContain(other);
    }
  });

  it('replaces in one pass: a replacement pattern in the template stays literal', async () => {
    const template = `<a nonce="${NONCE_PLACEHOLDER}">$& $' $\` $$ $1 ${NONCE_PLACEHOLDER}</a>`;
    const html = await createPlaceholderShell(template).render({
      nonce: NONCE,
      request: new Request('http://localhost:9300/'),
    });
    expect(html).toBe(`<a nonce="${NONCE}">$& $' $\` $$ $1 ${NONCE}</a>`);
  });

  it('gives two nonces two documents that differ only in the nonce', async () => {
    const template = readFileSync(join(FIXTURE_DIST, 'index.html'), 'utf8');
    const shell = createPlaceholderShell(template);
    const request = new Request('http://localhost:9300/');
    const first = await shell.render({ nonce: NONCE, request });
    const second = await shell.render({ nonce: 'ZyXw+/VuTsRqPoNmLkJiHg==', request });
    expect(first).not.toBe(second);
    expect(first.replaceAll(NONCE, '#')).toBe(second.replaceAll('ZyXw+/VuTsRqPoNmLkJiHg==', '#'));
  });

  it.each([
    '',
    'short',
    'AbCdEfGhIjKlMnOpQrStUv-_',
    '"><script>alert(1)</script>',
    '$&',
    'has space has space',
    `${NONCE}"`,
    `${NONCE}\n`,
    `${NONCE}'`,
    '__M365_NONCE__ and more',
  ])('refuses the nonce %j: it is written into attributes', async (nonce) => {
    const shell = createPlaceholderShell(`<p nonce="${NONCE_PLACEHOLDER}"></p>`);
    await expect(
      shell.render({ nonce, request: new Request('http://localhost:9300/') }),
    ).rejects.toThrow(TypeError);
  });

  it('does not mind the template containing the placeholder zero times', async () => {
    const html = await createPlaceholderShell('<p>no nonce</p>').render({
      nonce: NONCE,
      request: new Request('http://localhost:9300/'),
    });
    expect(html).toBe('<p>no nonce</p>');
  });
});

describe('readShellTemplate (plan 7.1 step 3)', () => {
  it('reads index.html from the build output', () => {
    const template = readShellTemplate(FIXTURE_DIST);
    expect(template).toContain(NONCE_PLACEHOLDER);
    expect(template).toContain('__M365_BOOT_JSON__');
  });

  it('is a broken build when index.html is missing', async () => {
    const dir = await createTempDataDir();
    expect(() => readShellTemplate(dir.path)).toThrow(ShellTemplateError);
    expect(() => readShellTemplate(dir.path)).toThrow(/index\.html/);
  });

  it('is a broken build when index.html has no nonce placeholder', async () => {
    const dir = await createTempDataDir();
    writeFileSync(join(dir.path, 'index.html'), '<!doctype html><title>plain</title>');
    expect(() => readShellTemplate(dir.path)).toThrow(ShellTemplateError);
    expect(() => readShellTemplate(dir.path)).toThrow(/__M365_NONCE__/);
  });

  it('does not put the path or the content into the error', async () => {
    const dir = await createTempDataDir();
    writeFileSync(join(dir.path, 'index.html'), 'canary-content-11ab');
    try {
      readShellTemplate(dir.path);
      expect.unreachable();
    } catch (failure) {
      expect((failure as Error).message).not.toContain('canary-content-11ab');
    }
  });
});

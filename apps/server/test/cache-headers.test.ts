// T-A-032: FR-A-050 (cache rules) and the compression rules of contract section 1 and plan 7.2.
//
//   - HTML `no-store`; `/assets/*` and referenced `/branding/<hash>.png` `public, max-age=31536000,
//     immutable`; unreferenced branding `private, max-age=31536000, immutable`; `/api/*`, `/healthz`,
//     `/readyz` `no-store`; `/sw.js`, `/manifest.webmanifest`, `/offline.*`, `/robots.txt` `no-cache`
//     with an ETag; a route that sets its own `Cache-Control` keeps it.
//   - Brotli (quality 4) or gzip for HTML, JSON and text of at least 1 KiB; never for
//     `/api/v1/csrf`, images, a `Range` request or a response marked `no-transform`;
//     `Vary: Accept-Encoding` where the answer depends on it.
//
// Negative fixtures (tasks.md section 0.3): `assertCacheRules` and `assertCompressionRules` are run
// on middleware that is wrong in each way this kind of middleware can be wrong, and must fail on
// every one.
import { brotliCompressSync, brotliDecompressSync, constants as zlib, gunzipSync } from 'node:zlib';
import { request as httpRequest } from 'node:http';
import { expectGuardFails } from '@m365portal/shared/testing';
import { Hono, type MiddlewareHandler } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  brandingAssetCacheControl,
  cacheHeaders,
  CACHE_CONTROL,
  defaultCacheControl,
  replaceResponse,
} from '../src/http/cache-headers.js';
import { compress, COMPRESS_MIN_BYTES } from '../src/http/compress.js';
import { type AppEnv } from '../src/http/request-context.js';
import { createTestApp } from './helpers/test-app.js';

const HASH = 'a'.repeat(64);
const IMMUTABLE_PUBLIC = 'public, max-age=31536000, immutable';
const IMMUTABLE_PRIVATE = 'private, max-age=31536000, immutable';

/** Compressible text of exactly `length` bytes (ASCII). */
function textOf(length: number): string {
  const phrase = 'The quick brown fox jumps over the lazy dog. ';
  return phrase.repeat(Math.ceil(length / phrase.length)).slice(0, length);
}

// ---------------------------------------------------------------------------------------------
// The default Cache-Control (FR-A-050)
// ---------------------------------------------------------------------------------------------

describe('CACHE_CONTROL values', () => {
  it('are the values FR-A-050 writes down', () => {
    expect(CACHE_CONTROL.noStore).toBe('no-store');
    expect(CACHE_CONTROL.noCache).toBe('no-cache');
    expect(CACHE_CONTROL.immutablePublic).toBe(IMMUTABLE_PUBLIC);
    expect(CACHE_CONTROL.immutablePrivate).toBe(IMMUTABLE_PRIVATE);
    expect(brandingAssetCacheControl(true)).toBe(IMMUTABLE_PUBLIC);
    expect(brandingAssetCacheControl(false)).toBe(IMMUTABLE_PRIVATE);
  });
});

describe('defaultCacheControl (FR-A-050)', () => {
  it.each([
    ['/assets/index-abc123.js', 200, IMMUTABLE_PUBLIC],
    ['/assets/inter-latin.woff2', 200, IMMUTABLE_PUBLIC],
    ['/assets/nested/file.css', 304, IMMUTABLE_PUBLIC],
    [`/branding/${HASH}.png`, 200, IMMUTABLE_PRIVATE],
    ['/api/v1/me', 200, 'no-store'],
    ['/api/v1/branding', 200, 'no-store'],
    ['/api/v1/openapi.json', 200, 'no-store'],
    ['/api', 200, 'no-store'],
    ['/healthz', 200, 'no-store'],
    ['/readyz', 200, 'no-store'],
    ['/readyz', 503, 'no-store'],
    ['/sw.js', 200, 'no-cache'],
    ['/sw.js', 304, 'no-cache'],
    ['/manifest.webmanifest', 200, 'no-cache'],
    ['/offline.html', 200, 'no-cache'],
    ['/offline.css', 200, 'no-cache'],
    ['/offline.js', 200, 'no-cache'],
    ['/robots.txt', 200, 'no-cache'],
    ['/favicon.ico', 200, 'no-cache'],
    ['/apple-touch-icon.png', 200, 'no-cache'],
    ['/', 200, 'no-store'],
    ['/users', 200, 'no-store'],
    ['/settings/appearance', 200, 'no-store'],
  ] as const)('%s with status %i is %s', (path, status, expected) => {
    expect(defaultCacheControl(path, status)).toBe(expected);
  });

  it.each([
    '/assets',
    '/assets/',
    '/assetsx/app.js',
    '/Assets/app.js',
    '/api-docs',
    '/apix/v1',
    '/branding',
    '/brandingx/a.png',
    '/Healthz',
    '/healthz/',
    '/sw.js/',
    '/sw.js.map',
    '/offline.exe',
    '/offline',
    '/robots.txt/',
    '/static/assets/app.js',
  ])('does not take %s for one of the cached classes', (path) => {
    expect(defaultCacheControl(path, 200)).toBe('no-store');
  });

  it('draws the lines between success, redirect and error exactly at 300 and 400', () => {
    expect(defaultCacheControl('/assets/app.js', 199)).toBe('no-store');
    expect(defaultCacheControl('/assets/app.js', 299)).toBe(IMMUTABLE_PUBLIC);
    expect(defaultCacheControl('/assets/app.js', 300)).toBe('no-store');
    expect(defaultCacheControl('/favicon.ico', 300)).toBe('no-cache');
    expect(defaultCacheControl('/favicon.ico', 399)).toBe('no-cache');
    expect(defaultCacheControl('/favicon.ico', 400)).toBe('no-store');
    expect(defaultCacheControl('/favicon.ico', 304)).toBe('no-cache');
  });

  it.each([400, 401, 403, 404, 405, 413, 415, 422, 429, 500, 503, 301, 302, 307, 101])(
    'is no-store for status %i, whatever the path: an error must never be cached for a year',
    (status) => {
      for (const path of ['/assets/app.js', `/branding/${HASH}.png`, '/sw.js', '/api/v1/me', '/']) {
        expect(defaultCacheControl(path, status), `${path} ${String(status)}`).toBe('no-store');
      }
    },
  );

  it.each([301, 302, 307, 308])(
    'lets the icon redirects revalidate (contract R14, R15): status %i',
    (status) => {
      expect(defaultCacheControl('/favicon.ico', status)).toBe('no-cache');
      expect(defaultCacheControl('/apple-touch-icon.png', status)).toBe('no-cache');
      expect(defaultCacheControl('/favicon.ico/', status)).toBe('no-store');
    },
  );
});

// A fixture application: one route of every class, in the order of plan 7.2.
function cacheApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use(cacheHeaders());
  app.get('/', (c) => c.html('<p>shell</p>'));
  app.get('/users', (c) => c.html('<p>users</p>'));
  app.get('/assets/:file', (c) => {
    if (c.req.param('file') === 'missing.js') return c.json({ title: 'not found' }, 404);
    return c.text('asset', 200, { 'Content-Type': 'text/javascript' });
  });
  app.get(`/branding/${HASH}.png`, (c) => c.body('png', 200, { 'Content-Type': 'image/png' }));
  app.get('/branding/referenced.png', (c) =>
    c.body('png', 200, {
      'Content-Type': 'image/png',
      'Cache-Control': brandingAssetCacheControl(true),
    }),
  );
  app.get('/branding/unreferenced.png', (c) =>
    c.body('png', 200, {
      'Content-Type': 'image/png',
      'Cache-Control': brandingAssetCacheControl(false),
    }),
  );
  app.get('/branding/missing.png', (c) => c.json({ title: 'not found' }, 404));
  app.get('/api/v1/me', (c) => c.json({ ok: true }));
  app.get('/api/v1/own', (c) =>
    c.json({ ok: true }, 200, { 'Cache-Control': 'private, max-age=5' }),
  );
  app.get('/api/v1/fails', (c) => c.json({ title: 'boom' }, 500));
  app.get('/healthz', (c) => c.json({ status: 'ok' }));
  app.get('/readyz', (c) => c.json({ status: 'ok' }));
  app.get('/sw.js', (c) =>
    c.text('self.addEventListener("fetch", () => {});', 200, { 'Content-Type': 'text/javascript' }),
  );
  app.get('/manifest.webmanifest', (c) =>
    c.body('{}', 200, { 'Content-Type': 'application/manifest+json' }),
  );
  app.get('/offline.html', (c) => c.html('<p>offline</p>'));
  app.get('/offline.css', (c) => c.body('p{margin:0}', 200, { 'Content-Type': 'text/css' }));
  app.get('/offline.js', (c) => c.body('void 0;', 200, { 'Content-Type': 'text/javascript' }));
  app.get('/robots.txt', (c) => c.text('User-agent: *\nDisallow: /\n'));
  app.get('/favicon.ico', (c) => c.redirect(`/branding/${HASH}.png`, 307));
  app.get('/redirect', (c) => c.redirect('/', 302));
  return app;
}

describe('replaceResponse', () => {
  it('makes the headers of the context exactly those of the new response, Set-Cookie included', async () => {
    const app = new Hono<AppEnv>();
    app.get('/x', (c) => {
      c.header('X-Stale', 'old');
      c.header('Content-Length', '999');
      c.header('X-Kept', 'old');
      replaceResponse(
        c,
        (() => {
          const next = new Response('new body', { status: 201 });
          next.headers.set('X-Kept', 'new');
          next.headers.append('Set-Cookie', 'a=1; Path=/');
          next.headers.append('Set-Cookie', 'b=2; Path=/');
          return next;
        })(),
      );
      return c.res;
    });
    const harness = await createTestApp({ buildApp: () => app });

    const response = await harness.client.get('/x');

    expect(response.status).toBe(201);
    expect(await response.text()).toBe('new body');
    expect(response.headers.get('x-stale')).toBeNull();
    expect(response.headers.get('content-length')).toBeNull();
    expect(response.headers.get('x-kept')).toBe('new');
    expect(response.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/']);
  });

  it('drops a Set-Cookie of the old response that the new one does not have', async () => {
    const app = new Hono<AppEnv>();
    app.get('/x', (c) => {
      c.header('Set-Cookie', 'old=1', { append: true });
      replaceResponse(c, new Response('x'));
      return c.res;
    });
    const harness = await createTestApp({ buildApp: () => app });
    const response = await harness.client.get('/x');
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});

describe('cacheHeaders: the default rules apply unless a route sets its own header (FR-A-050)', () => {
  it.each([
    ['/', 'no-store'],
    ['/users', 'no-store'],
    ['/assets/index-abc123.js', IMMUTABLE_PUBLIC],
    [`/branding/${HASH}.png`, IMMUTABLE_PRIVATE],
    ['/branding/referenced.png', IMMUTABLE_PUBLIC],
    ['/branding/unreferenced.png', IMMUTABLE_PRIVATE],
    ['/api/v1/me', 'no-store'],
    ['/healthz', 'no-store'],
    ['/readyz', 'no-store'],
    ['/sw.js', 'no-cache'],
    ['/manifest.webmanifest', 'no-cache'],
    ['/offline.html', 'no-cache'],
    ['/offline.css', 'no-cache'],
    ['/offline.js', 'no-cache'],
    ['/robots.txt', 'no-cache'],
    ['/favicon.ico', 'no-cache'],
    ['/api/v1/own', 'private, max-age=5'],
  ] as const)('%s answers with %s', async (path, expected) => {
    const harness = await createTestApp({ buildApp: cacheApp });

    const response = await harness.client.get(path);

    expect(response.headers.get('cache-control')).toBe(expected);
  });

  it('gives a 404 under /assets or /branding no-store, never a year of immutable', async () => {
    const harness = await createTestApp({ buildApp: cacheApp });

    for (const path of ['/assets/missing.js', '/branding/missing.png']) {
      const response = await harness.client.get(path);
      expect(response.status, path).toBe(404);
      expect(response.headers.get('cache-control'), path).toBe('no-store');
    }
  });

  it('gives an error from an API route and a redirect no-store', async () => {
    const harness = await createTestApp({ buildApp: cacheApp });

    expect((await harness.client.get('/api/v1/fails')).headers.get('cache-control')).toBe(
      'no-store',
    );
    expect((await harness.client.get('/redirect')).headers.get('cache-control')).toBe('no-store');
  });

  it('keeps the validators of a 304 on an asset path with the cache rule of the 200', async () => {
    const app = new Hono<AppEnv>();
    app.use(cacheHeaders());
    app.get('/assets/:file', (c) => c.body(null, 304));
    const harness = await createTestApp({ buildApp: () => app });

    const response = await harness.client.get('/assets/app.js');

    expect(response.status).toBe(304);
    expect(response.headers.get('cache-control')).toBe(IMMUTABLE_PUBLIC);
  });

  it('leaves a header the route set on a HEAD request too', async () => {
    const harness = await createTestApp({ buildApp: cacheApp });
    const response = await harness.client.request('HEAD', '/branding/referenced.png');
    expect(response.headers.get('cache-control')).toBe(IMMUTABLE_PUBLIC);
  });
});

describe('cacheHeaders: ETag on the files that are revalidated (FR-A-050)', () => {
  const REVALIDATED = [
    '/sw.js',
    '/manifest.webmanifest',
    '/offline.html',
    '/offline.css',
    '/offline.js',
    '/robots.txt',
  ] as const;

  it.each(REVALIDATED)('%s gets a weak ETag that follows the content', async (path) => {
    const harness = await createTestApp({ buildApp: cacheApp });

    const first = await harness.client.get(path);
    const second = await harness.client.get(path);

    const etag = first.headers.get('etag');
    // Weak: the file may also be sent with a content coding, which a strong tag could not name.
    expect(etag).toMatch(/^W\/"[A-Za-z0-9_-]{20,}"$/);
    expect(second.headers.get('etag')).toBe(etag);
  });

  it('changes the ETag when the content changes', async () => {
    let version = 1;
    const app = new Hono<AppEnv>();
    app.use(cacheHeaders());
    app.get('/sw.js', (c) => c.text(`worker v${String(version)}`));
    const harness = await createTestApp({ buildApp: () => app });

    const before = (await harness.client.get('/sw.js')).headers.get('etag');
    version = 2;
    const after = (await harness.client.get('/sw.js')).headers.get('etag');

    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
  });

  it('answers If-None-Match with a 304 that keeps the validators and has no body', async () => {
    const harness = await createTestApp({ buildApp: cacheApp });
    const etag = (await harness.client.get('/sw.js')).headers.get('etag') ?? '';

    const response = await harness.client.get('/sw.js', { headers: { 'if-none-match': etag } });

    expect(response.status).toBe(304);
    expect(await response.text()).toBe('');
    expect(response.headers.get('etag')).toBe(etag);
    expect(response.headers.get('cache-control')).toBe('no-cache');
  });

  it('repeats on the 304 the headers that RFC 9110 section 15.4.5 names, and no others', async () => {
    const app = new Hono<AppEnv>();
    app.use(cacheHeaders());
    app.get('/robots.txt', (c) =>
      c.text('User-agent: *\n', 200, {
        'Content-Location': '/robots-v2.txt',
        Date: 'Tue, 01 Jan 2030 00:00:00 GMT',
        Expires: 'Wed, 02 Jan 2030 00:00:00 GMT',
        Vary: 'Accept-Language',
        'X-Not-Kept': 'body-only',
      }),
    );
    const harness = await createTestApp({ buildApp: () => app });
    const etag = (await harness.client.get('/robots.txt')).headers.get('etag') ?? '';

    const response = await harness.client.get('/robots.txt', {
      headers: { 'if-none-match': etag },
    });

    expect(response.status).toBe(304);
    expect(response.headers.get('content-location')).toBe('/robots-v2.txt');
    expect(response.headers.get('date')).toBe('Tue, 01 Jan 2030 00:00:00 GMT');
    expect(response.headers.get('expires')).toBe('Wed, 02 Jan 2030 00:00:00 GMT');
    expect(response.headers.get('vary')).toBe('Accept-Language');
    expect(response.headers.get('etag')).toBe(etag);
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(response.headers.get('x-not-kept')).toBeNull();
  });

  it.each([
    ['the tag as it was sent', (etag: string) => etag],
    [
      'the strong spelling of the tag (weak comparison)',
      (etag: string) => etag.replace(/^W\//, ''),
    ],
    ['a list that contains it', (etag: string) => `"other", ${etag}`],
    ['a list with the strong spelling', (etag: string) => `"other", ${etag.replace(/^W\//, '')}`],
    ['the wildcard', () => '*'],
  ])('answers 304 for %s', async (_name, header) => {
    const harness = await createTestApp({ buildApp: cacheApp });
    const etag = (await harness.client.get('/robots.txt')).headers.get('etag') ?? '';

    const response = await harness.client.get('/robots.txt', {
      headers: { 'if-none-match': header(etag) },
    });

    expect(response.status).toBe(304);
  });

  it.each(['"other"', 'W/"other"', '', 'garbage', '"a", "b"'])(
    'answers 200 with the file for If-None-Match: %j',
    async (header) => {
      const harness = await createTestApp({ buildApp: cacheApp });

      const response = await harness.client.get('/robots.txt', {
        headers: { 'if-none-match': header },
      });

      expect(response.status).toBe(200);
      expect(await response.text()).toContain('Disallow: /');
    },
  );

  it('keeps an ETag the route set and uses it for the 304: the manifest has the tag of its revision', async () => {
    const app = new Hono<AppEnv>();
    app.use(cacheHeaders());
    app.get('/manifest.webmanifest', (c) =>
      c.body('{}', 200, { 'Content-Type': 'application/manifest+json', ETag: '"3"' }),
    );
    const harness = await createTestApp({ buildApp: () => app });

    const plain = await harness.client.get('/manifest.webmanifest');
    expect(plain.headers.get('etag')).toBe('"3"');

    const conditional = await harness.client.get('/manifest.webmanifest', {
      headers: { 'if-none-match': '"3"' },
    });
    expect(conditional.status).toBe(304);
    expect(conditional.headers.get('etag')).toBe('"3"');
    expect(conditional.headers.get('cache-control')).toBe('no-cache');

    const stale = await harness.client.get('/manifest.webmanifest', {
      headers: { 'if-none-match': '"2"' },
    });
    expect(stale.status).toBe(200);
  });

  it('gives a HEAD request the ETag a GET gets', async () => {
    const harness = await createTestApp({ buildApp: cacheApp });
    const get = await harness.client.get('/sw.js');
    const head = await harness.client.request('HEAD', '/sw.js');
    expect(head.headers.get('etag')).toBe(get.headers.get('etag'));
  });

  it('adds no ETag where the contract says none: assets, API responses, HTML, errors', async () => {
    const harness = await createTestApp({ buildApp: cacheApp });

    for (const path of ['/assets/app.js', '/api/v1/me', '/', '/healthz', '/assets/missing.js']) {
      const response = await harness.client.get(path, {
        headers: { 'if-none-match': '*' },
      });
      expect(response.headers.get('etag'), path).toBeNull();
      expect(response.status, path).not.toBe(304);
    }
  });

  it('does not answer 304 to a request that is not a GET or HEAD', async () => {
    const app = new Hono<AppEnv>();
    app.use(cacheHeaders());
    app.post('/sw.js', (c) => c.text('posted'));
    const harness = await createTestApp({ buildApp: () => app });

    const response = await harness.client.post('/sw.js', {
      csrf: 'none',
      headers: { 'if-none-match': '*' },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Compression (contract section 1, plan 7.2 stage 4)
// ---------------------------------------------------------------------------------------------

function compressApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use(compress());
  app.get('/json', (c) => c.json({ text: textOf(3_000), ünicode: 'ß' }));
  app.get('/html', (c) => c.html(`<p>${textOf(3_000)}</p>`));
  app.get('/text', (c) => c.text(textOf(3_000)));
  app.get('/js', (c) => c.body(textOf(3_000), 200, { 'Content-Type': 'text/javascript' }));
  app.get('/js-legacy', (c) =>
    c.body(textOf(3_000), 200, { 'Content-Type': 'application/javascript; charset=utf-8' }),
  );
  app.get('/problem', (c) =>
    c.body(JSON.stringify({ detail: textOf(3_000) }), 500, {
      'Content-Type': 'application/problem+json',
    }),
  );
  app.get('/manifest', (c) =>
    c.body(JSON.stringify({ name: textOf(3_000) }), 200, {
      'Content-Type': 'application/manifest+json',
    }),
  );
  app.get('/image', (c) => c.body(textOf(5_000), 200, { 'Content-Type': 'image/png' }));
  app.get('/svg', (c) =>
    c.body(`<svg>${textOf(5_000)}</svg>`, 200, { 'Content-Type': 'image/svg+xml' }),
  );
  app.get('/font', (c) => c.body(textOf(5_000), 200, { 'Content-Type': 'font/woff2' }));
  app.get('/binary', (c) =>
    c.body(textOf(5_000), 200, { 'Content-Type': 'application/octet-stream' }),
  );
  app.get('/api/v1/csrf', (c) => c.json({ token: textOf(3_000) }));
  app.get('/api/v1/other', (c) => c.json({ token: textOf(3_000) }));
  app.get('/small', (c) => c.text(textOf(COMPRESS_MIN_BYTES - 1)));
  app.get('/exact', (c) => c.text(textOf(COMPRESS_MIN_BYTES)));
  app.get('/empty', (c) => c.body(null, 200, { 'Content-Type': 'text/plain' }));
  app.get('/notransform', (c) =>
    c.text(textOf(3_000), 200, { 'Cache-Control': 'public, no-transform, max-age=60' }),
  );
  app.get('/encoded', (c) =>
    c.body('already-compressed-bytes', 200, {
      'Content-Type': 'text/javascript',
      'Content-Encoding': 'br',
      Vary: 'Accept-Encoding',
    }),
  );
  app.get('/partial', (c) => c.text(textOf(3_000), 206, { 'Content-Range': 'bytes 0-2999/9000' }));
  // Not a 206, but it names a range of a larger body, which a compressed copy would misstate.
  app.get('/range-header-200', (c) =>
    c.text(textOf(3_000), 200, { 'Content-Range': 'bytes 0-2999/9000' }),
  );
  app.get('/no-content', (c) => c.body(null, 204));
  app.get('/partial-no-range', (c) => c.text(textOf(3_000), 206));
  // Bytes, not a string: a string body gets a text/plain content type from the constructor.
  app.get('/no-type', () => new Response(Buffer.from(textOf(3_000))));
  app.get('/exact-length', (c) =>
    c.text(textOf(COMPRESS_MIN_BYTES), 200, { 'Content-Length': String(COMPRESS_MIN_BYTES) }),
  );
  app.get('/short-length', (c) =>
    c.text(textOf(COMPRESS_MIN_BYTES - 1), 200, {
      'Content-Length': String(COMPRESS_MIN_BYTES - 1),
    }),
  );
  app.get('/vary-origin', (c) => c.text(textOf(3_000), 200, { Vary: 'Origin' }));
  app.get('/vary-encoding', (c) => c.text(textOf(3_000), 200, { Vary: 'accept-encoding' }));
  app.get('/vary-star', (c) => c.text(textOf(3_000), 200, { Vary: '*' }));
  app.get('/etag-strong', (c) => c.text(textOf(3_000), 200, { ETag: '"abc"' }));
  app.get('/etag-weak', (c) => c.text(textOf(3_000), 200, { ETag: 'W/"abc"' }));
  app.get('/length', (c) => c.text(textOf(3_000), 200, { 'Content-Length': '3000' }));
  app.get('/small-length', (c) => c.text(textOf(100), 200, { 'Content-Length': '100' }));
  return app;
}

async function fetchEncoded(
  path: string,
  acceptEncoding: string | null,
  extra: Record<string, string> = {},
  method = 'GET',
): Promise<Response> {
  const harness = await createTestApp({ buildApp: compressApp });
  const headers: Record<string, string> = { ...extra };
  if (acceptEncoding !== null) headers['accept-encoding'] = acceptEncoding;
  return await harness.client.request(method, path, { headers });
}

async function bodyOf(response: Response): Promise<Buffer> {
  return Buffer.from(await response.arrayBuffer());
}

function decode(response: Response, body: Buffer): string {
  const encoding = response.headers.get('content-encoding');
  if (encoding === 'br') return brotliDecompressSync(body).toString('utf8');
  if (encoding === 'gzip') return gunzipSync(body).toString('utf8');
  return body.toString('utf8');
}

describe('compress: Brotli at quality 4, or gzip (contract section 1)', () => {
  it('compresses JSON with Brotli when the client accepts it, and the body is the same after decoding', async () => {
    const response = await fetchEncoded('/json', 'gzip, deflate, br');

    expect(response.headers.get('content-encoding')).toBe('br');
    const body = await bodyOf(response);
    expect(JSON.parse(decode(response, body))).toEqual({ text: textOf(3_000), ünicode: 'ß' });
    expect(body.length).toBeLessThan(500);
  });

  it('uses quality 4: the bytes are those Brotli produces at that quality, and not those of another', async () => {
    const response = await fetchEncoded('/text', 'br');
    const body = await bodyOf(response);
    const original = Buffer.from(textOf(3_000));
    const at = (quality: number): Buffer =>
      brotliCompressSync(original, {
        params: {
          [zlib.BROTLI_PARAM_QUALITY]: quality,
          [zlib.BROTLI_PARAM_SIZE_HINT]: original.length,
        },
      });

    expect(body.equals(at(4))).toBe(true);
    expect(body.equals(at(11))).toBe(false);
    expect(body.equals(at(0))).toBe(false);
  });

  it('uses gzip when the client does not accept Brotli', async () => {
    for (const accept of [
      'gzip',
      'gzip, deflate',
      'deflate, gzip;q=0.5',
      'x-gzip',
      'br;q=0, gzip',
    ]) {
      const response = await fetchEncoded('/json', accept);
      expect(response.headers.get('content-encoding'), accept).toBe('gzip');
      expect(gunzipSync(await bodyOf(response)).toString()).toContain('quick brown fox');
    }
  });

  it('follows the q values of the client, and prefers Brotli on a tie', async () => {
    expect(
      (await fetchEncoded('/text', 'gzip;q=1, br;q=0.5')).headers.get('content-encoding'),
    ).toBe('gzip');
    expect(
      (await fetchEncoded('/text', 'gzip;q=0.5, br;q=1')).headers.get('content-encoding'),
    ).toBe('br');
    expect((await fetchEncoded('/text', 'gzip, br')).headers.get('content-encoding')).toBe('br');
    expect(
      (await fetchEncoded('/text', 'gzip;q=0.8, br;q=0.8')).headers.get('content-encoding'),
    ).toBe('br');
  });

  it('treats a coding with no weight as weight 1: equal to an explicit q=1, so Brotli wins the tie either way round', async () => {
    expect((await fetchEncoded('/text', 'gzip, br;q=1')).headers.get('content-encoding')).toBe(
      'br',
    );
    expect((await fetchEncoded('/text', 'br;q=1, gzip')).headers.get('content-encoding')).toBe(
      'br',
    );
    expect((await fetchEncoded('/text', 'gzip;q=1, br')).headers.get('content-encoding')).toBe(
      'br',
    );
    expect(
      (await fetchEncoded('/text', 'gzip;q=1.0, br;q=0.9')).headers.get('content-encoding'),
    ).toBe('gzip');
  });

  it('takes the wildcard for Brotli, and q=0 for a refusal', async () => {
    expect((await fetchEncoded('/text', '*')).headers.get('content-encoding')).toBe('br');
    expect((await fetchEncoded('/text', '*;q=0')).headers.get('content-encoding')).toBeNull();
    expect(
      (await fetchEncoded('/text', 'br;q=0, gzip;q=0')).headers.get('content-encoding'),
    ).toBeNull();
    expect((await fetchEncoded('/text', 'br;q=0, *')).headers.get('content-encoding')).toBe('gzip');
  });

  it.each([
    null,
    '',
    'identity',
    'deflate',
    'compress',
    'zstd',
    'br;q=0',
    'garbage;;;',
    'br;q=abc',
  ])('sends the plain body to a client that accepts %j', async (accept) => {
    const response = await fetchEncoded('/json', accept);

    // `br;q=abc` has a q that is not a number; it is read as 0, never as "accepted".
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(JSON.parse(await response.text())).toMatchObject({ ünicode: 'ß' });
    // The answer would have differed by Accept-Encoding, so the cache has to know.
    expect(response.headers.get('vary')).toBe('Accept-Encoding');
  });

  it.each([
    ['/json', 'application/json'],
    ['/html', 'text/html'],
    ['/text', 'text/plain'],
    ['/js', 'text/javascript'],
    ['/js-legacy', 'application/javascript'],
    ['/problem', 'application/problem+json'],
    ['/manifest', 'application/manifest+json'],
  ])('compresses %s (%s)', async (path) => {
    const response = await fetchEncoded(path, 'br');
    expect(response.headers.get('content-encoding')).toBe('br');
    expect(response.headers.get('vary')).toBe('Accept-Encoding');
    expect(decode(response, await bodyOf(response))).toContain('quick brown fox');
  });

  it.each(['/image', '/svg', '/font', '/binary'])(
    'never compresses %s: images, fonts and other binary data',
    async (path) => {
      const response = await fetchEncoded(path, 'br, gzip');
      expect(response.headers.get('content-encoding')).toBeNull();
      expect(response.headers.get('vary')).toBeNull();
      expect((await bodyOf(response)).length).toBeGreaterThanOrEqual(5_000);
    },
  );

  it('never compresses /api/v1/csrf (the BREACH shape), and adds no Vary there', async () => {
    const response = await fetchEncoded('/api/v1/csrf', 'br, gzip');
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.headers.get('vary')).toBeNull();
    expect((await response.json()) as { token: string }).toHaveProperty('token');

    const other = await fetchEncoded('/api/v1/other', 'br, gzip');
    expect(other.headers.get('content-encoding')).toBe('br');
  });

  it('compresses from 1 KiB and not below', async () => {
    const small = await fetchEncoded('/small', 'br');
    expect(small.headers.get('content-encoding')).toBeNull();
    expect(small.headers.get('vary')).toBeNull();
    expect((await bodyOf(small)).length).toBe(COMPRESS_MIN_BYTES - 1);

    const exact = await fetchEncoded('/exact', 'br');
    expect(exact.headers.get('content-encoding')).toBe('br');
    expect(COMPRESS_MIN_BYTES).toBe(1_024);
  });

  it('does not read a body at all when its declared length already says it is too small', async () => {
    let pulls = 0;
    const app = new Hono<AppEnv>();
    app.use(compress());
    app.get('/x', () => {
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array(40));
          if (pulls >= 3) controller.close();
        },
      });
      return new Response(body, {
        headers: { 'Content-Type': 'text/plain', 'Content-Length': '120' },
      });
    });
    const harness = await createTestApp({ buildApp: () => app });

    const response = await harness.client.get('/x', { headers: { 'accept-encoding': 'br' } });

    // A stream is pulled once when it is created; reading it to the end would pull it three times.
    expect(pulls).toBe(1);
    expect(response.headers.get('content-encoding')).toBeNull();
  });

  it('compresses a response whose declared length is exactly 1 KiB, and not one byte less', async () => {
    const exact = await fetchEncoded('/exact-length', 'br');
    expect(exact.headers.get('content-encoding')).toBe('br');
    const short = await fetchEncoded('/short-length', 'br');
    expect(short.headers.get('content-encoding')).toBeNull();
    expect(short.headers.get('vary')).toBeNull();
  });

  it('leaves a response alone when its declared length says it is small', async () => {
    const response = await fetchEncoded('/small-length', 'br');
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.headers.get('content-length')).toBe('100');
  });

  it('never compresses an answer to a Range request', async () => {
    const response = await fetchEncoded('/text', 'br', { range: 'bytes=0-99' });
    expect(response.headers.get('content-encoding')).toBeNull();
    expect((await bodyOf(response)).length).toBe(3_000);
  });

  it('never compresses a response marked no-transform', async () => {
    const response = await fetchEncoded('/notransform', 'br');
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('public, no-transform, max-age=60');
  });

  it('leaves a response that is already encoded exactly as it is (a precompressed file)', async () => {
    const response = await fetchEncoded('/encoded', 'br, gzip');
    expect(response.headers.get('content-encoding')).toBe('br');
    expect(response.headers.get('vary')).toBe('Accept-Encoding');
    expect(await response.text()).toBe('already-compressed-bytes');
  });

  it.each([
    '/partial',
    '/partial-no-range',
    '/range-header-200',
    '/no-content',
    '/empty',
    '/no-type',
  ])('leaves %s alone', async (path) => {
    const response = await fetchEncoded(path, 'br');
    expect(response.headers.get('content-encoding')).toBeNull();
  });

  it('compresses an error response that is large enough, like any other JSON', async () => {
    const response = await fetchEncoded('/problem', 'br');
    expect(response.status).toBe(500);
    expect(response.headers.get('content-encoding')).toBe('br');
  });

  it('compresses a response to HEAD the way the GET is compressed', async () => {
    const get = await fetchEncoded('/json', 'br');
    const head = await fetchEncoded('/json', 'br', {}, 'HEAD');
    expect(head.headers.get('content-encoding')).toBe(get.headers.get('content-encoding'));
    expect(head.headers.get('vary')).toBe(get.headers.get('vary'));
    expect((await bodyOf(head)).length).toBe(0);
  });

  it('removes a Content-Length that no longer fits, or states the new one', async () => {
    const response = await fetchEncoded('/length', 'br');
    const body = await bodyOf(response);
    const declared = response.headers.get('content-length');
    expect(response.headers.get('content-encoding')).toBe('br');
    if (declared !== null) expect(Number(declared)).toBe(body.length);
  });
});

describe('compress: Vary and ETag stay truthful', () => {
  it('adds Accept-Encoding to a Vary the route set, once', async () => {
    expect((await fetchEncoded('/vary-origin', 'br')).headers.get('vary')).toBe(
      'Origin, Accept-Encoding',
    );
    expect((await fetchEncoded('/vary-encoding', 'br')).headers.get('vary')).toBe(
      'accept-encoding',
    );
    expect((await fetchEncoded('/vary-star', 'br')).headers.get('vary')).toBe('*');
  });

  it('makes a strong ETag weak when it compresses, because the bytes are no longer those the tag names', async () => {
    expect((await fetchEncoded('/etag-strong', 'br')).headers.get('etag')).toBe('W/"abc"');
    expect((await fetchEncoded('/etag-weak', 'br')).headers.get('etag')).toBe('W/"abc"');
    expect((await fetchEncoded('/etag-strong', null)).headers.get('etag')).toBe('"abc"');
  });
});

describe('the pipeline order of plan 7.2: compression outside, cache rules inside', () => {
  function pipeline(): Hono<AppEnv> {
    const app = new Hono<AppEnv>();
    app.use(compress());
    app.use(cacheHeaders());
    app.get('/sw.js', (c) => c.text(textOf(3_000), 200, { 'Content-Type': 'text/javascript' }));
    app.get('/assets/app.js', (c) =>
      c.text(textOf(3_000), 200, { 'Content-Type': 'text/javascript' }),
    );
    return app;
  }

  it('revalidates a compressed worker with the weak form of its tag, and the 304 is not compressed', async () => {
    const harness = await createTestApp({ buildApp: pipeline });

    const first = await harness.client.get('/sw.js', { headers: { 'accept-encoding': 'br' } });
    expect(first.headers.get('content-encoding')).toBe('br');
    const etag = first.headers.get('etag') ?? '';
    expect(etag).toMatch(/^W\/"/);
    expect(first.headers.get('cache-control')).toBe('no-cache');

    const second = await harness.client.get('/sw.js', {
      headers: { 'accept-encoding': 'br', 'if-none-match': etag },
    });
    expect(second.status).toBe(304);
    expect(second.headers.get('content-encoding')).toBeNull();
    expect(await second.text()).toBe('');
  });

  it('compresses an asset and keeps the immutable header', async () => {
    const harness = await createTestApp({ buildApp: pipeline });
    const response = await harness.client.get('/assets/app.js', {
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(response.headers.get('content-encoding')).toBe('gzip');
    expect(response.headers.get('cache-control')).toBe(IMMUTABLE_PUBLIC);
    expect(response.headers.get('vary')).toBe('Accept-Encoding');
  });
});

describe('over a real socket', () => {
  it('sends a Brotli body with the right headers, and a client that decodes it gets the text back', async () => {
    const harness = await createTestApp({ buildApp: compressApp });
    const running = await harness.listen();

    const { headers, body } = await new Promise<{ headers: Record<string, unknown>; body: Buffer }>(
      (resolve, reject) => {
        const request = httpRequest(
          {
            host: '127.0.0.1',
            port: running.port,
            path: '/json',
            headers: { 'accept-encoding': 'br' },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => chunks.push(chunk));
            response.on('end', () => {
              resolve({ headers: response.headers, body: Buffer.concat(chunks) });
            });
          },
        );
        request.on('error', reject);
        request.end();
      },
    );

    expect(headers['content-encoding']).toBe('br');
    expect(headers.vary).toBe('Accept-Encoding');
    expect(Number(headers['content-length'])).toBe(body.length);
    expect(JSON.parse(brotliDecompressSync(body).toString())).toMatchObject({ ünicode: 'ß' });
  });

  it('revalidates a worker file with an ETag and answers 304 without a body, as a browser would ask', async () => {
    const harness = await createTestApp({
      buildApp: () => {
        const app = new Hono<AppEnv>();
        app.use(compress());
        app.use(cacheHeaders());
        app.get('/sw.js', (c) => c.text(textOf(3_000), 200, { 'Content-Type': 'text/javascript' }));
        return app;
      },
    });
    const running = await harness.listen();

    const first = await fetch(`${running.origin}/sw.js`);
    const etag = first.headers.get('etag') ?? '';
    expect(first.status).toBe(200);
    expect(etag).toMatch(/^W\/"/);
    expect(first.headers.get('cache-control')).toBe('no-cache');
    expect((await first.text()).length).toBe(3_000);

    const second = await fetch(`${running.origin}/sw.js`, { headers: { 'if-none-match': etag } });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe('');
    expect(second.headers.get('etag')).toBe(etag);
    expect(second.headers.get('cache-control')).toBe('no-cache');

    const head = await fetch(`${running.origin}/sw.js`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('etag')).toBe(etag);
  });

  it('is decoded by a standard fetch client without a word from the test', async () => {
    const harness = await createTestApp({ buildApp: compressApp });
    const running = await harness.listen();

    const response = await fetch(`${running.origin}/json`);

    expect(JSON.parse(await response.text())).toMatchObject({ ünicode: 'ß' });
  });
});

// ---------------------------------------------------------------------------------------------
// The guards, and the middleware that must fail them
// ---------------------------------------------------------------------------------------------

type CacheFactory = () => MiddlewareHandler<AppEnv>;

/** Throws unless the middleware applies the default rules of FR-A-050 and respects a route's own header. */
async function assertCacheRules(make: CacheFactory): Promise<void> {
  const app = new Hono<AppEnv>();
  app.use(make());
  app.get('/', (c) => c.html('<p>x</p>'));
  app.get('/assets/:file', (c) =>
    c.req.param('file') === 'missing.js' ? c.json({ t: 1 }, 404) : c.text('x'),
  );
  app.get(`/branding/${HASH}.png`, (c) => c.text('x'));
  app.get('/branding/own.png', (c) =>
    c.text('x', 200, { 'Cache-Control': 'public, max-age=31536000, immutable' }),
  );
  app.get('/api/v1/me', (c) => c.json({}));
  app.get('/api/v1/own', (c) => c.json({}, 200, { 'Cache-Control': 'private, max-age=5' }));
  app.get('/healthz', (c) => c.json({}));
  app.get('/sw.js', (c) => c.text('x'));
  const cacheControl = async (path: string): Promise<string | null> =>
    (await app.fetch(new Request(`http://localhost${path}`))).headers.get('cache-control');
  const fail = (message: string): never => {
    throw new Error(message);
  };

  if ((await cacheControl('/')) !== 'no-store') fail('html is not no-store');
  if ((await cacheControl('/assets/app.js')) !== IMMUTABLE_PUBLIC) fail('assets are not immutable');
  if ((await cacheControl('/assets/missing.js')) !== 'no-store')
    fail('a 404 under assets is cached');
  if ((await cacheControl(`/branding/${HASH}.png`)) !== IMMUTABLE_PRIVATE)
    fail('branding is not private by default');
  if ((await cacheControl('/branding/own.png')) !== IMMUTABLE_PUBLIC)
    fail('a route header was overwritten');
  if ((await cacheControl('/api/v1/me')) !== 'no-store') fail('the API is not no-store');
  if ((await cacheControl('/api/v1/own')) !== 'private, max-age=5')
    fail('a route header was overwritten');
  if ((await cacheControl('/healthz')) !== 'no-store') fail('health is not no-store');
  if ((await cacheControl('/sw.js')) !== 'no-cache') fail('the worker is not no-cache');
}

describe('the cache guard', () => {
  it('passes for the real middleware', async () => {
    await expect(assertCacheRules(cacheHeaders)).resolves.toBeUndefined();
  });

  it('fails for a middleware that sets nothing', async () => {
    await expectGuardFails(
      assertCacheRules,
      () => async (_c, next) => {
        await next();
      },
      { reason: 'not no-store' },
    );
  });

  it('fails for a middleware that caches a 404 under /assets for a year', async () => {
    const byPathOnly: CacheFactory = () => async (c, next) => {
      await next();
      if (!c.res.headers.has('cache-control')) {
        c.header(
          'Cache-Control',
          c.req.path.startsWith('/assets/') ? IMMUTABLE_PUBLIC : 'no-store',
        );
      }
    };
    await expectGuardFails(assertCacheRules, byPathOnly, { reason: '404 under assets' });
  });

  it('fails for a middleware that overwrites the header a route set', async () => {
    const overwrite: CacheFactory = () => async (c, next) => {
      await next();
      c.header('Cache-Control', 'no-store');
    };
    await expectGuardFails(assertCacheRules, overwrite, { reason: 'assets are not immutable' });
  });

  it('fails for a middleware that makes branding public by default', async () => {
    const publicBranding: CacheFactory = () => {
      const real = cacheHeaders();
      return async (c, next) => {
        await real(c, next);
        if (
          c.req.path.startsWith('/branding/') &&
          c.res.status === 200 &&
          c.res.headers.get('cache-control') === IMMUTABLE_PRIVATE
        ) {
          c.header('Cache-Control', IMMUTABLE_PUBLIC);
        }
      };
    };
    await expectGuardFails(assertCacheRules, publicBranding, { reason: 'branding is not private' });
  });
});

interface NaiveOptions {
  readonly minBytes?: number;
  readonly images?: boolean;
  readonly csrf?: boolean;
  readonly range?: boolean;
  readonly noTransform?: boolean;
  readonly refusals?: boolean;
  readonly vary?: boolean;
  readonly weakEtag?: boolean;
  readonly quality?: number;
  readonly encoded?: boolean;
}

/** A compressor that is right unless an option breaks one rule. Used only for negative fixtures. */
function naiveCompress(options: NaiveOptions = {}): MiddlewareHandler<AppEnv> {
  const {
    minBytes = 1_024,
    images = false,
    csrf = false,
    range = false,
    noTransform = false,
  } = options;
  const { refusals = false, vary = true, weakEtag = true, quality = 4, encoded = false } = options;
  return async (c, next) => {
    await next();
    const response = c.res;
    const type = response.headers.get('content-type') ?? '';
    const accept = c.req.header('accept-encoding') ?? '';
    const wantsBrotli = refusals ? /\bbr\b/.test(accept) : /\bbr\b(?!;q=0)/.test(accept);
    if (!wantsBrotli) return;
    if (!images && !/^(text\/|application\/(.*\+)?json)/.test(type)) return;
    if (!csrf && c.req.path === '/api/v1/csrf') return;
    if (!range && c.req.header('range') !== undefined) return;
    if (!noTransform && (response.headers.get('cache-control') ?? '').includes('no-transform'))
      return;
    if (!encoded && response.headers.has('content-encoding')) return;
    const original = Buffer.from(await response.arrayBuffer());
    const headers = new Headers(response.headers);
    if (original.length < minBytes) {
      replaceResponse(c, new Response(original, { status: response.status, headers }));
      return;
    }
    const output = brotliCompressSync(original, {
      params: {
        [zlib.BROTLI_PARAM_QUALITY]: quality,
        [zlib.BROTLI_PARAM_SIZE_HINT]: original.length,
      },
    });
    headers.set('Content-Encoding', 'br');
    headers.delete('Content-Length');
    if (vary) headers.set('Vary', 'Accept-Encoding');
    const etag = headers.get('etag');
    if (weakEtag && etag !== null && !etag.startsWith('W/')) headers.set('etag', `W/${etag}`);
    replaceResponse(c, new Response(output, { status: response.status, headers }));
  };
}

/** Throws unless the middleware obeys the compression rules, for a client that accepts Brotli. */
async function assertCompressionRules(make: () => MiddlewareHandler<AppEnv>): Promise<void> {
  const app = new Hono<AppEnv>();
  app.use(make());
  app.get('/json', (c) => c.json({ text: textOf(3_000) }, 200, { ETag: '"abc"' }));
  app.get('/small', (c) => c.text(textOf(1_000)));
  app.get('/image', (c) => c.body(textOf(3_000), 200, { 'Content-Type': 'image/png' }));
  app.get('/api/v1/csrf', (c) => c.json({ token: textOf(3_000) }));
  app.get('/notransform', (c) => c.text(textOf(3_000), 200, { 'Cache-Control': 'no-transform' }));
  app.get('/encoded', (c) =>
    c.body('x'.repeat(2_000), 200, { 'Content-Type': 'text/plain', 'Content-Encoding': 'gzip' }),
  );
  const get = (
    path: string,
    headers: Record<string, string> = { 'accept-encoding': 'br' },
  ): Promise<Response> =>
    Promise.resolve(app.fetch(new Request(`http://localhost${path}`, { headers })));
  const fail = (message: string): never => {
    throw new Error(message);
  };

  const json = await get('/json');
  if (json.headers.get('content-encoding') !== 'br') fail('a large JSON body is not compressed');
  if (json.headers.get('vary') !== 'Accept-Encoding') fail('no Vary on a compressed body');
  if (json.headers.get('etag') !== 'W/"abc"') fail('the ETag stays strong on a compressed body');
  const expected = brotliCompressSync(Buffer.from(JSON.stringify({ text: textOf(3_000) })), {
    params: {
      [zlib.BROTLI_PARAM_QUALITY]: 4,
      [zlib.BROTLI_PARAM_SIZE_HINT]: JSON.stringify({ text: textOf(3_000) }).length,
    },
  });
  if (!Buffer.from(await json.arrayBuffer()).equals(expected)) fail('not Brotli at quality 4');
  if ((await get('/small')).headers.get('content-encoding') !== null)
    fail('a small body is compressed');
  if ((await get('/image')).headers.get('content-encoding') !== null)
    fail('an image is compressed');
  if ((await get('/api/v1/csrf')).headers.get('content-encoding') !== null)
    fail('csrf is compressed');
  if (
    (await get('/json', { 'accept-encoding': 'br', range: 'bytes=0-9' })).headers.get(
      'content-encoding',
    ) !== null
  ) {
    fail('a Range request is compressed');
  }
  if ((await get('/notransform')).headers.get('content-encoding') !== null)
    fail('no-transform is ignored');
  if (
    (await get('/json', { 'accept-encoding': 'br;q=0' })).headers.get('content-encoding') !== null
  ) {
    fail('a refusal of Brotli is ignored');
  }
  const encoded = await get('/encoded');
  if (encoded.headers.get('content-encoding') !== 'gzip')
    fail('an encoded response is encoded twice');
}

describe('the compression guard', () => {
  it('passes for the real middleware', async () => {
    await expect(assertCompressionRules(compress)).resolves.toBeUndefined();
  });

  it('passes for the reference implementation of this test, which proves the fixtures are fair', async () => {
    await expect(assertCompressionRules(() => naiveCompress())).resolves.toBeUndefined();
  });

  it.each([
    ['compresses small bodies', { minBytes: 0 }, 'small body is compressed'],
    ['compresses images', { images: true }, 'an image is compressed'],
    ['compresses /api/v1/csrf', { csrf: true }, 'csrf is compressed'],
    ['compresses a Range response', { range: true }, 'Range request is compressed'],
    ['ignores no-transform', { noTransform: true }, 'no-transform is ignored'],
    ['ignores q=0', { refusals: true }, 'refusal of Brotli is ignored'],
    ['sends no Vary', { vary: false }, 'no Vary'],
    ['keeps a strong ETag', { weakEtag: false }, 'ETag stays strong'],
    ['uses the wrong quality', { quality: 11 }, 'not Brotli at quality 4'],
    ['encodes an encoded response again', { encoded: true }, 'encoded twice'],
  ] as const)('fails for a compressor that %s', async (_name, options, reason) => {
    await expectGuardFails(assertCompressionRules, () => naiveCompress(options), { reason });
  });
});

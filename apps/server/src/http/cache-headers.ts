// Stage 5 of the request pipeline (plan 7.2, FR-A-050): the default `Cache-Control` of a response
// by what it is, and the validators (`ETag`, `304`) of the few files that are revalidated rather
// than cached. A route that sets its own `Cache-Control` keeps it: the branding route knows whether
// an asset is referenced, which no middleware can know.
//
//   /assets/*                 public, max-age=31536000, immutable   (hashed build output)
//   /branding/<hash>.png      private, max-age=31536000, immutable  (the route says `public` for a
//                             referenced asset, via `brandingAssetCacheControl`)
//   /sw.js, /manifest.webmanifest, /offline.*, /robots.txt, the favicon redirects
//                             no-cache, with an ETag on the files themselves
//   everything else           no-store: the HTML shell, /api/*, /healthz, /readyz, a path nobody knows
//
// Only a successful answer (2xx, or a 304 that stands for one) gets the rule of its path. An error
// is `no-store` whatever the path: a 404 for `/assets/app.js` cached for a year would keep a missing
// file missing after it is deployed.
//
// Phase B (FR-B-417, T-B-195): the sign-in and setup surface is never stored, whatever a route says.
// `/auth/*`, `/api/v1/auth/*`, `/api/v1/setup/*`, `/api/v1/connection/*`, `/api/v1/me` (and
// `/api/v1/me/access`), `/api/v1/rbac/*` and every HTML page answer `no-store`; a header such as
// `public, max-age=600` set by one of those routes is replaced.
//
// Phase C (FR-C-403, seam XC6): `/api/v1/users*` and `/api/v1/groups*` hold personal data (names,
// addresses, memberships) and join the list. `setCookieDiscipline` is the last
// word on `Set-Cookie`: only the three panel cookies, built as `auth/cookies.ts` builds them, leave
// the process.
//
// The ETag is a hash of the bytes, weak. It is added to the worker, the offline files and
// `robots.txt` when the file has none (static serving does not send one), and used for the 304. The
// manifest comes with the ETag of its revision from its route; that tag is kept and used for the 304.
import { createHash } from 'node:crypto';
import type { CookieKind } from '@m365portal/shared/auth/cookies';
import type { Context, MiddlewareHandler } from 'hono';
import { setResponseHeaders, type AppEnv } from './request-context.js';

const ONE_YEAR_SECONDS = 31_536_000;

export const CACHE_CONTROL = {
  noStore: 'no-store',
  noCache: 'no-cache',
  immutablePublic: `public, max-age=${String(ONE_YEAR_SECONDS)}, immutable`,
  immutablePrivate: `private, max-age=${String(ONE_YEAR_SECONDS)}, immutable`,
} as const;

/**
 * The `Cache-Control` of a branding image (FR-A-090): a year, immutable, `public` for an asset the
 * applied branding references and `private` for one only an administrator may fetch.
 */
export function brandingAssetCacheControl(referenced: boolean): string {
  return referenced ? CACHE_CONTROL.immutablePublic : CACHE_CONTROL.immutablePrivate;
}

/** Files the browser may keep but must revalidate. */
const REVALIDATED: ReadonlySet<string> = new Set([
  '/sw.js',
  '/manifest.webmanifest',
  '/robots.txt',
  '/favicon.ico',
  '/apple-touch-icon.png',
  '/offline.html',
  '/offline.css',
  '/offline.js',
]);

/** Of those, the ones that are files with a body, which get an ETag (the icons are redirects). */
const WITH_ETAG: ReadonlySet<string> = new Set([
  '/sw.js',
  '/manifest.webmanifest',
  '/robots.txt',
  '/offline.html',
  '/offline.css',
  '/offline.js',
]);

/** `/assets/` followed by at least one character: the directory itself is not an asset. */
function under(path: string, prefix: string): boolean {
  return path.startsWith(prefix) && path.length > prefix.length;
}

/** The two icon paths answer with a redirect to the current image (contract R14, R15). */
const REVALIDATED_REDIRECTS: ReadonlySet<string> = new Set([
  '/favicon.ico',
  '/apple-touch-icon.png',
]);

/** The default `Cache-Control` for a response of this status at this path. */
export function defaultCacheControl(path: string, status: number): string {
  if (status >= 300 && status < 400 && status !== 304) {
    return REVALIDATED_REDIRECTS.has(path) ? CACHE_CONTROL.noCache : CACHE_CONTROL.noStore;
  }
  // Left after the redirects above: 2xx, and the 304 that stands for one.
  if (status < 200 || status >= 400) return CACHE_CONTROL.noStore;
  if (under(path, '/assets/')) return CACHE_CONTROL.immutablePublic;
  if (under(path, '/branding/')) return CACHE_CONTROL.immutablePrivate;
  if (REVALIDATED.has(path)) return CACHE_CONTROL.noCache;
  return CACHE_CONTROL.noStore;
}

/**
 * Put `next` in place of the response of the context. Hono's `c.res = ...` copies every header of
 * the old response onto the new one (a `Content-Length` that no longer fits, a `Content-Encoding`
 * that is gone), so the headers are set to exactly those of `next` afterwards.
 */
export function replaceResponse(c: Context, next: Response): void {
  // Read everything first: when the context had no response yet, `c.res` becomes `next` itself and
  // the two share their headers.
  const wanted = new Map<string, string>();
  next.headers.forEach((value, name) => {
    // Set-Cookie is the one header that can occur several times; it is handled below.
    if (name !== 'set-cookie') wanted.set(name, value);
  });
  const cookies = next.headers.getSetCookie();

  c.res = next;
  for (const name of [...c.res.headers.keys()]) {
    if (!wanted.has(name)) c.res.headers.delete(name);
  }
  for (const [name, value] of wanted) c.res.headers.set(name, value);
  for (const cookie of cookies) c.res.headers.append('set-cookie', cookie);
}

/** The headers a 304 repeats from the 200 it stands for (RFC 9110 section 15.4.5). */
const KEPT_ON_304 = [
  'ETag',
  'Cache-Control',
  'Vary',
  'Content-Location',
  'Date',
  'Expires',
] as const;

/** Does `If-None-Match` name this tag? Weak comparison, as RFC 9110 requires for this header. */
function matches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (ifNoneMatch === undefined) return false;
  const strip = (tag: string): string => tag.trim().replace(/^W\//, '');
  return (
    ifNoneMatch.trim() === '*' || ifNoneMatch.split(',').some((tag) => strip(tag) === strip(etag))
  );
}

async function settleEtag(c: Context<AppEnv>): Promise<void> {
  let etag = c.res.headers.get('ETag');
  if (etag === null) {
    const bytes = new Uint8Array(await c.res.clone().arrayBuffer());
    // Weak, because the same file is also served with a content coding (compress.ts), and a strong
    // tag would have to differ between the codings.
    etag = `W/"${createHash('sha256').update(bytes).digest('base64url')}"`;
    setResponseHeaders(c, { ETag: etag });
  }
  if (!matches(c.req.header('if-none-match'), etag)) return;

  const headers = new Headers();
  for (const name of KEPT_ON_304) {
    const value = c.res.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  replaceResponse(c, new Response(null, { status: 304, headers }));
}

/** The paths of FR-B-417 that no route may make cacheable. */
const NO_STORE_PATHS: readonly RegExp[] = [
  /^\/auth\//,
  /^\/api\/v1\/auth\//,
  /^\/api\/v1\/setup(?:\/|$)/,
  /^\/api\/v1\/connection(?:\/|$)/,
  /^\/api\/v1\/me(?:\/|$)/,
  /^\/api\/v1\/rbac(?:\/|$)/,
  // Phase C (FR-C-403): the directory reads hold personal data.
  /^\/api\/v1\/users(?:\/|$)/,
  /^\/api\/v1\/groups(?:\/|$)/,
];

/** Is this path one that must be `no-store` whatever its route says (FR-B-417)? */
export function isNoStorePath(path: string): boolean {
  return NO_STORE_PATHS.some((pattern) => pattern.test(path));
}

export function cacheHeaders(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    const path = c.req.path;

    // The sign-in surface and the pages (the shell holds the boot data) are never stored; the offline
    // page is the one HTML file that revalidates.
    const isPage = (c.res.headers.get('Content-Type') ?? '').startsWith('text/html');
    if (c.res.status !== 304 && (isNoStorePath(path) || (isPage && !REVALIDATED.has(path)))) {
      setResponseHeaders(c, { 'Cache-Control': CACHE_CONTROL.noStore });
    }

    if (!c.res.headers.has('Cache-Control')) {
      setResponseHeaders(c, { 'Cache-Control': defaultCacheControl(path, c.res.status) });
    }

    const readsOnly = c.req.method === 'GET' || c.req.method === 'HEAD';
    if (readsOnly && c.res.status === 200 && WITH_ETAG.has(path)) await settleEtag(c);
  };
}

// ---------------------------------------------------------------------------------------------
// Set-Cookie discipline (FR-B-417)
// ---------------------------------------------------------------------------------------------

export interface SetCookieDisciplineOptions {
  /** The cookie names of the deployment (`cookieNames(PUBLIC_BASE_URL)`). */
  readonly names: Readonly<Record<CookieKind, string>>;
  /** Told the NAME of a cookie that was removed; never its value. */
  readonly onRefused?: (name: string) => void;
}

/** A cookie header the panel may send: one of its names, `HttpOnly`, `Path=/`, no `Domain`. */
function isPanelCookie(header: string, names: ReadonlySet<string>): boolean {
  const [pair = '', ...attributes] = header.split(';').map((part) => part.trim());
  const name = pair.slice(0, Math.max(0, pair.indexOf('=')));
  if (!names.has(name)) return false;
  const lower = attributes.map((attribute) => attribute.toLowerCase());
  return (
    lower.includes('httponly') &&
    lower.includes('path=/') &&
    !lower.some((attribute) => attribute.startsWith('domain='))
  );
}

/**
 * `Set-Cookie` appears only on responses that set or clear a session, transaction or setup cookie:
 * anything else a route (or a library under it) attached is removed, and the refusal is reported by
 * name.
 */
export function setCookieDiscipline(
  options: SetCookieDisciplineOptions,
): MiddlewareHandler<AppEnv> {
  const names = new Set<string>(Object.values(options.names));
  return async (c, next) => {
    await next();
    const cookies = c.res.headers.getSetCookie();
    if (cookies.length === 0) return;
    const kept = cookies.filter((cookie) => isPanelCookie(cookie, names));
    if (kept.length === cookies.length) return;
    for (const cookie of cookies) {
      if (!kept.includes(cookie)) {
        options.onRefused?.(cookie.slice(0, Math.max(0, cookie.indexOf('='))));
      }
    }
    c.res.headers.delete('Set-Cookie');
    for (const cookie of kept) c.res.headers.append('Set-Cookie', cookie);
  };
}

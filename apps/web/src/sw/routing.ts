// The routing decision of the service worker (FR-A-140, PD-17, plan 9.8): a pure function of the
// request's URL, mode and method, and the origin of the worker. It is an allow-list, never a deny-list:
//
//   cache-first   `GET /assets/<name>`, `GET /branding/<64 hex>.png` and the two files of the offline page
//                 (`/offline.css`, `/offline.js`), same origin, nothing else
//   navigate      a same-origin `GET` navigation that is not the API and not the worker itself
//   pass          everything else, which the worker does not touch: the browser fetches it as if there
//                 were no worker (so `/api` is never served from a cache, in any encoding)
//
// The cache patterns are matched against the path exactly as the URL parser normalised it, and a path
// that contains a percent sign is never cache-first: the server serves only plain file names
// (apps/server/src/http/static.ts), so an encoded spelling is a 404 there and must not become a cache
// key here. The API check is separate and paranoid: it decodes repeatedly and removes backslashes,
// doubled slashes, dot segments, case and trailing dots before it looks, so no spelling of the prefix
// reaches a handler that could cache it.

export type RouteDecision = 'cache-first' | 'navigate' | 'pass';

export interface RoutedRequest {
  /** The absolute URL of the request. */
  readonly url: string;
  /** `Request.mode`: only the value `navigate` matters. */
  readonly mode: string;
  /** `Request.method`, any case. */
  readonly method: string;
}

/** Hashed build output: `/assets/index-abc123.js`. One path segment of plain file-name characters. */
export const ASSET_PATH = /^\/assets\/[A-Za-z0-9._-]+$/;
/** A processed branding image, named by the SHA-256 of its bytes. */
export const BRANDING_PATH = /^\/branding\/[0-9a-f]{64}\.png$/;

/**
 * The two files the offline page loads. They are precached at install (src/sw/sw.ts) and answered from
 * that copy, so the page is complete with the server gone. Exact paths: nothing else is added this way.
 */
export const OFFLINE_ASSETS: ReadonlySet<string> = new Set(['/offline.css', '/offline.js']);

const MAX_DECODE_ROUNDS = 5;

/** Decode until nothing changes (a double-encoded spelling included); stop at a malformed sequence. */
function fullyDecoded(path: string): string {
  let current = path;
  for (let round = 0; round < MAX_DECODE_ROUNDS; round += 1) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      return current;
    }
    if (next === current) return current;
    current = next;
  }
  return current;
}

/** Resolve `.` and `..`, collapse empty segments, drop trailing dots and the case of each segment. */
function canonicalSegments(path: string): string[] {
  const segments: string[] = [];
  for (const raw of path.replaceAll('\\', '/').split('/')) {
    const lower = raw.toLowerCase();
    const segment = lower === '.' || lower === '..' ? lower : lower.replace(/\.+$/, '');
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments;
}

/** True when any spelling of the path could be taken for the API (`/api...`) by a server or a proxy. */
export function looksLikeApi(pathname: string): boolean {
  return canonicalSegments(fullyDecoded(pathname))[0]?.startsWith('api') ?? false;
}

/** The worker script itself is never part of a navigation or a cache. */
function isWorkerScript(pathname: string): boolean {
  return canonicalSegments(fullyDecoded(pathname)).join('/') === 'sw.js';
}

export function decideRoute(request: RoutedRequest, origin: string): RouteDecision {
  if (request.method !== 'GET') return 'pass';

  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return 'pass';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'pass';
  if (url.origin !== origin) return 'pass';

  const { pathname } = url;
  if (looksLikeApi(pathname) || isWorkerScript(pathname)) return 'pass';
  if (request.mode === 'navigate') return 'navigate';

  if (pathname.includes('%')) return 'pass';
  return ASSET_PATH.test(pathname) || BRANDING_PATH.test(pathname) || OFFLINE_ASSETS.has(pathname)
    ? 'cache-first'
    : 'pass';
}

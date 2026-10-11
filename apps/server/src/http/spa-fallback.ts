// The SPA fallback (FR-A-048, plan 7.5, contract S2): the answer to a page navigation. The client
// router owns the page paths, so the server answers any of them with the shell and the client renders
// "not found" for the paths it does not know. Everything else that is unknown stays a 404 problem.
//
// A request gets the shell only if ALL of this holds:
//   - the method is GET or HEAD;
//   - `Accept` names `text/html` with a weight above zero (a `*/*` from `fetch` or curl is an API
//     client and gets the problem, not a page);
//   - the path is not `/api`, `/branding` or `/assets` or below them (an unknown API path is a JSON
//     problem; an unknown asset is a 404, never `index.html`);
//   - the last segment of the path has no `.` (a path with a file extension is a file: `/favicon.ico`,
//     `/robots.txt`, `/index.html`, a missing `.js` are 404 problems, never the shell).
//
// The answer is 200, `no-store`, with the nonce of this response's CSP in the body. Nothing about it
// is cacheable: no ETag, no Last-Modified, and the compression layer keeps no copy of its output.
import type { ShellRenderer } from '../shell-port.js';
import { defineFallback, type FallbackDefinition } from './route.js';

/** Paths the shell never answers: each, and everything below it. */
const NOT_PAGES: readonly string[] = ['/api', '/branding', '/assets'];

export interface ShellRequest {
  readonly method: string;
  /** The path of the request, as the router sees it. */
  readonly path: string;
  /** The `Accept` header, if the request has one. */
  readonly accept: string | undefined;
}

/** Does an `Accept` header name `text/html` with a weight above zero? */
function acceptsHtml(accept: string | undefined): boolean {
  if (accept === undefined) return false;
  for (const item of accept.split(',')) {
    const [type = '', ...parameters] = item.split(';');
    if (type.trim().toLowerCase() !== 'text/html') continue;
    const weight = parameters
      .map((parameter) => parameter.trim().toLowerCase())
      .find((parameter) => parameter.startsWith('q='));
    if (weight === undefined) return true;
    const value = Number(weight.slice(2));
    if (Number.isFinite(value) && value > 0) return true;
  }
  return false;
}

/** The last non-empty segment of a path ('' for the root). */
function lastSegment(path: string): string {
  const segments = path.split('/').filter((segment) => segment !== '');
  return segments[segments.length - 1] ?? '';
}

/** Is this request a page navigation that gets the shell? */
export function isShellRequest(request: ShellRequest): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  if (!acceptsHtml(request.accept)) return false;
  const { path } = request;
  if (NOT_PAGES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) return false;
  return !lastSegment(path).includes('.');
}

export interface SpaFallbackOptions {
  /** Renders the page. Until the branding module is registered: `createPlaceholderShell`. */
  readonly shell: ShellRenderer;
}

export function spaFallback(options: SpaFallbackOptions): FallbackDefinition {
  return defineFallback({
    id: 'shell.html',
    methods: ['GET'],
    paths: ['/*'],
    access: { public: true },
    rateLimit: 'read',
    openapi: false,
    handler: async (c) => {
      if (
        !isShellRequest({ method: c.req.method, path: c.req.path, accept: c.req.header('accept') })
      ) {
        return undefined;
      }
      // The same value the security headers put in the CSP of this response.
      const html = await options.shell.render({ nonce: c.get('nonce')(), request: c.req.raw });
      return c.html(html, 200, { 'Cache-Control': 'no-store' });
    },
  });
}

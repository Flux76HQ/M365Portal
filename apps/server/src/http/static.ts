// Static files (FR-A-048, FR-A-050 static part, plan 7.5, contract S1 and R17): the hashed build
// output under `/assets`, the offline page, and the service worker. They are served from one
// directory, the build output, and from nowhere else.
//
// `serveStatic` of `@hono/node-server` does the serving (Content-Type, streaming, HEAD, ranges, and
// the Brotli or gzip sibling of a file with `Content-Encoding` and `Vary`). It is not the guard: on its
// own it serves a dotfile, the raw `index.html` for `/`, and any directory's index. So a path reaches
// it only after `isServablePath` has accepted it, and only if it is a regular file whose real path is
// inside the root (a symlink out is refused). The traversal table of `static.test.ts` decides whether
// this is enough; if a hostile path ever gets through, the library is replaced by a small handler of
// our own and the table stays as it is (PR-11).
//
// What a path must look like: `/`, then segments of letters, digits, `.`, `_` and `-`, none of them
// starting with a dot; the last one has an extension and is not `index.html`. Everything else (an
// encoded character, a backslash, a NUL, `//`, `..`, a dotfile, a directory) is not a file of the
// build and is a 404 problem. The build output has no file that needs more.
import { existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, sep } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { z } from 'zod';
import { problemResponse } from './problem.js';
import {
  defineFallback,
  defineRoute,
  type FallbackDefinition,
  type RouteContext,
  type RouteDefinition,
} from './route.js';

const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const EXTENSION = /\.[A-Za-z0-9]+$/;
const MAX_PATH_LENGTH = 512;
const MAX_SEGMENT_LENGTH = 128;

/**
 * May this request path name a file of the build output? A fixed grammar, not a blacklist: a path is
 * served only when it is one the build can have produced.
 */
export function isServablePath(path: string): boolean {
  if (path.length === 0 || path.length > MAX_PATH_LENGTH || !path.startsWith('/')) return false;
  const segments = path.slice(1).split('/');
  for (const segment of segments) {
    if (segment.length > MAX_SEGMENT_LENGTH || !SEGMENT.test(segment)) return false;
  }
  const last = segments[segments.length - 1] ?? '';
  // `index.html` is the template, with placeholders in it: only the shell renderer may send it.
  return EXTENSION.test(last) && last.toLowerCase() !== 'index.html';
}

/** A regular file whose real path is below the root: no directory, no symlink that leaves it. */
function isFileInside(root: string, file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    return realpathSync(file).startsWith(`${root}${sep}`);
  } catch {
    return false;
  }
}

/** Has the file a Brotli or gzip sibling? Then the same URL has more than one representation. */
function hasPrecompressedSibling(file: string): boolean {
  return existsSync(`${file}.br`) || existsSync(`${file}.gz`);
}

export interface StaticOptions {
  /** The absolute path of the build output directory. It must exist. */
  readonly root: string;
}

/** Serve the file the request names, or return `undefined` when it names none the build published. */
function createFileServer(
  options: StaticOptions,
): (c: RouteContext) => Promise<Response | undefined> {
  if (!isAbsolute(options.root)) throw new TypeError('the static root must be an absolute path');
  // Throws if the directory is missing: a server without its frontend must not start.
  const root = realpathSync(options.root);
  const serve = serveStatic({ root, precompressed: true });

  return async (c) => {
    const path = c.req.path;
    if (!isServablePath(path)) return undefined;
    const file = join(root, path);
    if (!isFileInside(root, file)) return undefined;

    const result = await serve(c, () => Promise.resolve());
    if (!(result instanceof Response)) return undefined;
    // The library says Vary only when it picked a sibling; a client that took the plain file must
    // not be served the Brotli copy by a cache that did not know the request differed.
    if (!result.headers.has('Vary') && hasPrecompressedSibling(file)) {
      result.headers.set('Vary', 'Accept-Encoding');
    }
    return result;
  };
}

/**
 * `static.assets` (S1): `/assets/*` and the offline page. Exempt from rate limiting. A file the build
 * did not publish, and any path that is not a plain file, is a 404 problem: never `index.html`.
 */
export function staticFallback(options: StaticOptions): FallbackDefinition {
  const serveFile = createFileServer(options);
  return defineFallback({
    id: 'static.assets',
    methods: ['GET'],
    paths: ['/assets/*', '/offline.html', '/offline.css', '/offline.js'],
    access: { public: true },
    rateLimit: 'exempt',
    openapi: false,
    handler: async (c) => (await serveFile(c)) ?? problemResponse(c, 'not_found'),
  });
}

/**
 * `pwa.serviceWorker` (R17): `/sw.js`. A route, because the contract documents it; its profile
 * (worker) and its cache rule (`no-cache` with an ETag) come from the pipeline by path.
 */
export function serviceWorkerRoute(options: StaticOptions): RouteDefinition {
  const serveFile = createFileServer(options);
  return defineRoute({
    id: 'pwa.serviceWorker',
    method: 'GET',
    path: '/sw.js',
    access: { public: true },
    rateLimit: 'exempt',
    summary: 'The service worker',
    description:
      'Served with its own header profile and revalidated on every use, so that an update reaches clients.',
    responses: {
      200: {
        description: 'The service worker script.',
        content: { 'text/javascript': { schema: z.string() } },
      },
    },
    handler: async (c) => (await serveFile(c)) ?? problemResponse(c, 'not_found'),
  });
}

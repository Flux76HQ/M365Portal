// Stage 4 of the request pipeline (plan 7.2, contract section 1): Brotli at quality 4, or gzip, for
// HTML, JSON and text of at least 1 KiB.
//
// What is never compressed, and why:
//   - `/api/v1/csrf`: a secret next to attacker-influenced text in one compressed body is the shape
//     of BREACH. The token endpoint is the only place the application returns a secret in a body.
//   - images and other binary data: already compressed, and a second pass costs CPU for nothing.
//   - `text/csv`: an export is streamed row by row and can be long (step D2, FR-D-406); reading it whole to
//     compress it would hold the file in memory and send nothing until the last row is read.
//   - an answer to a `Range` request, a 206, a response with `Content-Range`: the bytes are positions
//     in the identity representation.
//   - a response marked `no-transform`, and one that already has a `Content-Encoding` (a precompressed
//     file from the static handler): somebody else decided.
//   - a body below 1 KiB: the headers cost more than the saving.
//
// `Vary: Accept-Encoding` is added to every response that could have been compressed, whether or not
// this client asked for it: the same URL then has two representations and a cache must know. A strong
// `ETag` becomes weak when the body is compressed, because the tag no longer names these bytes.
//
// The body is read whole and compressed asynchronously (not on the event loop). Compressible bodies
// are small; the largest is the branding export, about 8 MiB of base64, once, on request.
import { brotliCompress, constants, gzip } from 'node:zlib';
import { promisify } from 'node:util';
import type { MiddlewareHandler } from 'hono';
import { replaceResponse } from './cache-headers.js';
import type { AppEnv } from './request-context.js';

const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

/** Bodies shorter than this are sent as they are: 1 KiB. */
export const COMPRESS_MIN_BYTES = 1_024;

/** Brotli quality: 4 is close to gzip's speed and clearly better than gzip's size. */
export const BROTLI_QUALITY = 4;

export type ContentEncoding = 'br' | 'gzip';

/** Paths whose answers are never compressed. */
const NEVER_COMPRESSED: ReadonlySet<string> = new Set(['/api/v1/csrf']);

/** Text, JSON (also `+json`: problem documents, the manifest) and JavaScript. Not `image/svg+xml`. */
export function isCompressibleType(contentType: string | null): boolean {
  if (contentType === null) return false;
  const essence = (contentType.split(';')[0] ?? '').trim().toLowerCase();
  if (essence === 'text/csv') return false;
  return (
    essence.startsWith('text/') ||
    essence === 'application/json' ||
    essence.endsWith('+json') ||
    essence === 'application/javascript'
  );
}

/**
 * The encoding to use for an `Accept-Encoding` header: the one the client weights highest, Brotli
 * on a tie, and nothing when the client refuses both (or names neither). A weight that is not a
 * number counts as 0: when in doubt, send the body as it is.
 */
export function chooseEncoding(header: string | null): ContentEncoding | undefined {
  if (header === null) return undefined;
  const weights = new Map<string, number>();
  for (const item of header.split(',')) {
    const [rawName = '', ...parameters] = item.toLowerCase().split(';');
    const name = rawName.trim();
    if (name === '') continue;
    let weight = 1;
    for (const parameter of parameters) {
      const [key, value] = parameter.split('=');
      if (key?.trim() === 'q') {
        const parsed = Number(value?.trim());
        weight = Number.isFinite(parsed) ? parsed : 0;
      }
    }
    weights.set(name, weight);
  }
  const weightOf = (name: string): number => weights.get(name) ?? weights.get('*') ?? 0;
  const br = weightOf('br');
  const gzipWeight = Math.max(weightOf('gzip'), weightOf('x-gzip'));
  if (br <= 0 && gzipWeight <= 0) return undefined;
  return br >= gzipWeight ? 'br' : 'gzip';
}

async function encode(bytes: Buffer, encoding: ContentEncoding): Promise<Buffer> {
  if (encoding === 'br') {
    return await brotli(bytes, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
        [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
      },
    });
  }
  return await gzipAsync(bytes);
}

/** Add `Accept-Encoding` to `Vary` unless it (or `*`) is already there. */
function addVary(headers: Headers): void {
  const existing = headers.get('Vary');
  if (existing === null) {
    headers.set('Vary', 'Accept-Encoding');
    return;
  }
  const names = existing.split(',').map((name) => name.trim().toLowerCase());
  if (names.includes('*') || names.includes('accept-encoding')) return;
  headers.set('Vary', `${existing}, Accept-Encoding`);
}

export interface CompressOptions {
  /** Default: `COMPRESS_MIN_BYTES`. */
  readonly minBytes?: number;
  /** Default: `/api/v1/csrf`. */
  readonly neverPaths?: ReadonlySet<string>;
}

export function compress(options: CompressOptions = {}): MiddlewareHandler<AppEnv> {
  const minBytes = options.minBytes ?? COMPRESS_MIN_BYTES;
  const never = options.neverPaths ?? NEVER_COMPRESSED;

  return async (c, next) => {
    await next();
    const response = c.res;
    const { headers } = response;

    // 204, 205 and 304 are "null body statuses": a Response cannot carry a body with them, so the
    // first test covers them. A 206 has a body whose bytes are positions in the whole.
    if (response.body === null || response.status === 206) return;
    if (headers.has('Content-Encoding') || headers.has('Content-Range')) return;
    if (c.req.header('range') !== undefined || never.has(c.req.path)) return;
    if (/(?:^|[\s,])no-transform(?:[\s,;]|$)/i.test(headers.get('Cache-Control') ?? '')) return;
    if (!isCompressibleType(headers.get('Content-Type'))) return;
    const declared = headers.get('Content-Length');
    if (declared !== null && /^\d+$/.test(declared) && Number(declared) < minBytes) return;

    const bytes = Buffer.from(await response.arrayBuffer());
    const outgoing = new Headers(headers);
    const large = bytes.length >= minBytes;
    if (large) addVary(outgoing);
    const encoding = large ? chooseEncoding(c.req.header('accept-encoding') ?? null) : undefined;
    const init = { status: response.status, statusText: response.statusText };

    if (encoding === undefined) {
      replaceResponse(c, new Response(bytes, { ...init, headers: outgoing }));
      return;
    }

    const output = await encode(bytes, encoding);
    outgoing.set('Content-Encoding', encoding);
    outgoing.set('Content-Length', String(output.length));
    const etag = outgoing.get('ETag');
    if (etag !== null && !etag.startsWith('W/')) outgoing.set('ETag', `W/${etag}`);
    replaceResponse(c, new Response(output, { ...init, headers: outgoing }));
  };
}

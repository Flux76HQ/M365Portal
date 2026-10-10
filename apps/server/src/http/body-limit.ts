// Stage 8 of the request pipeline (plan 7.2, FR-A-025): the size of a request body, per route class,
// enforced while the body streams. A body over the limit answers 413 `payload_too_large`.
//
// Two checks, because either alone is not a limit:
//   - a declared `Content-Length` over the limit is refused at once, before a byte is read;
//   - otherwise the bytes are counted as they arrive, whatever the headers claim: a chunked body has
//     no length, and a length that is a lie (or is ignored because `Transfer-Encoding` wins, RFC 9112)
//     says nothing. At the first byte over the limit reading stops. A 50 MB body is never read to
//     the end.
//
// The body is read here, in full, up to the limit, and handed on as a fresh request. That is what
// makes the guard order of plan 7.2 true for a chunked body too: a request that is too large is a 413
// before its content type, its Origin or its permission is judged. The cost is at most the limit of
// the route in memory per request, and the limits are small (the largest is the 9 MiB import, behind
// the `upload` bucket of three).
//
// The refusal carries `Connection: close`: the rest of the body is still on the wire, and the
// connection is not worth keeping.
import { LIMITS } from '@m365portal/shared/limits';
import type { Context, MiddlewareHandler } from 'hono';
import { ProblemError, problemResponse } from './problem.js';
import type { AppEnv } from './request-context.js';

/** The three body classes of the limits table. The only place the three numbers are named. */
export const BODY_LIMIT_BYTES = {
  /** Every JSON route except the import. */
  json: LIMITS.body.jsonBytes,
  /** The logo upload: the file plus its multipart envelope. */
  upload: LIMITS.body.uploadRequestBytes,
  /** The branding import: the largest request the application accepts. */
  import: LIMITS.body.importRequestBytes,
} as const;

export type BodyClass = keyof typeof BODY_LIMIT_BYTES;

const DIGITS = /^\d+$/;

/**
 * The length the client announced, when it is to be believed at all: a `Content-Length` of digits,
 * and no `Transfer-Encoding` (which takes precedence and makes the length meaningless).
 */
function declaredLength(headers: Headers): number | undefined {
  if (headers.has('transfer-encoding')) return undefined;
  const value = headers.get('content-length');
  return value !== null && DIGITS.test(value) ? Number(value) : undefined;
}

/**
 * One read of the body. The stream fails when the client goes away or the request times out; that is
 * the client's doing and not a defect of ours, so it is a problem like any other and not an
 * `unhandled_error` in the log.
 */
async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<{ readonly done: true } | { readonly done: false; readonly value: Uint8Array }> {
  try {
    const result = await reader.read();
    return result.done ? { done: true } : { done: false, value: result.value };
  } catch {
    throw new ProblemError('validation_failed', {
      errors: [{ pointer: '', code: 'body_unreadable' }],
    });
  }
}

function refuse(c: Context<AppEnv>): Response {
  const response = problemResponse(c, 'payload_too_large');
  response.headers.set('Connection', 'close');
  return response;
}

/**
 * Limit the request body to a class of the limits table, or to a number of bytes (for a test that
 * needs a smaller limit than the frozen `LIMITS`).
 */
export function bodyLimit(limit: BodyClass | number): MiddlewareHandler<AppEnv> {
  const maxBytes = typeof limit === 'number' ? limit : BODY_LIMIT_BYTES[limit];
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError('a body limit is a whole number of bytes, 1 or more');
  }

  return async (c, next) => {
    const request = c.req.raw;
    if (request.body === null) {
      await next();
      return;
    }

    const declared = declaredLength(request.headers);
    if (declared !== undefined && declared > maxBytes) return refuse(c);

    const reader = request.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const chunk = await readChunk(reader);
      if (chunk.done) break;
      const { value } = chunk;
      total += value.byteLength;
      if (total > maxBytes) {
        // Stop pulling: nothing more of this body is wanted.
        await reader.cancel().catch(() => undefined);
        return refuse(c);
      }
      chunks.push(value);
    }

    c.req.raw = new Request(request, { body: Buffer.concat(chunks, total) });
    await next();
  };
}

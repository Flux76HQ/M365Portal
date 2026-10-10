// The error handler (plan 7.2 stage 14, FR-A-022, FR-A-023, FR-A-065): whatever is thrown below the
// pipeline becomes a problem response, and what is logged about it cannot carry what was thrown.
//
// What reaches the client: a registry code with its generic texts and the request id. A thrown
// `ProblemError` is answered as itself; a Hono `HTTPException` by its status; a storage failure as
// 503; everything else as 500 `internal_error`.
//
// What reaches the log (an unhandled error): the error's name, its system code when it is an upper-
// case token (`ENOENT`, `SQLITE_BUSY`), and the stack frames without the message line. Never the
// message, never the `cause`, never any other property: the message of a failed query holds the SQL
// and the message of a failed login holds a name, and a stack that starts with the message holds it
// too. A storage failure is logged by its code alone.
import { HTTPException } from 'hono/http-exception';
import type { Context, MiddlewareHandler } from 'hono';
import { classifyStorageError, type StorageFailure } from '../db/errors.js';
import {
  problemResponse,
  problemResponseFor,
  ProblemError,
  requestIdOf,
  type ProblemDetails,
} from './problem.js';
import type { AppEnv } from './request-context.js';
import type { ProblemCode } from '@m365portal/shared/problem';

/** The two calls the handler makes on a logger. The pino logger of T-A-029 has this shape. */
export interface ErrorLogger {
  error(fields: Readonly<Record<string, unknown>>, message: string): void;
  warn(fields: Readonly<Record<string, unknown>>, message: string): void;
}

export interface ErrorHandlerOptions {
  readonly log: ErrorLogger;
  /**
   * Told about every storage failure the handler answers, so that readiness can follow (`corrupt`
   * makes `/readyz` say `database_corrupt`). A callback that throws is ignored.
   */
  readonly onStorageFailure?: (failure: StorageFailure) => void;
}

export type ErrorHandlerFunction = (error: unknown, c: Context<AppEnv>) => Response;

// ---------------------------------------------------------------------------------------------
// What may be logged about an error
// ---------------------------------------------------------------------------------------------

const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_$.]{0,63}$/;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const FRAME_LINE = /^\s+at /;
export const MAX_STACK_CHARACTERS = 4_000;
export const MAX_STACK_FRAMES = 30;

export interface ErrorDescription {
  readonly name: string;
  readonly code?: string;
  readonly stack?: string;
  /** For a value that is not an Error: `typeof`, nothing else about it. */
  readonly thrownType?: string;
}

/** The frames of a stack, without the "Name: message" header, which holds the message. */
function framesOf(error: Error): string | undefined {
  const { stack, message } = error;
  if (typeof stack !== 'string') return undefined;
  let rest = stack;
  if (message !== '') {
    const at = stack.indexOf(message);
    if (at >= 0) rest = stack.slice(at + message.length);
  }
  // Keep only lines that are frames: a message that was changed after the stack was captured, or a
  // header of several lines, leaves nothing else behind.
  const frames = rest
    .split('\n')
    .filter((line) => FRAME_LINE.test(line))
    .slice(0, MAX_STACK_FRAMES)
    .join('\n');
  return frames === '' ? undefined : frames.slice(0, MAX_STACK_CHARACTERS);
}

export function describeError(error: unknown): ErrorDescription {
  if (!(error instanceof Error)) return { name: 'NonErrorThrown', thrownType: typeof error };
  const { code } = error as { code?: unknown };
  const stack = framesOf(error);
  return {
    name: SAFE_NAME.test(error.name) ? error.name : 'Error',
    ...(typeof code === 'string' && SAFE_CODE.test(code) ? { code } : {}),
    ...(stack === undefined ? {} : { stack }),
  };
}

// ---------------------------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------------------------

/** A status a Hono `HTTPException` may carry, and the problem it is answered with. */
const HTTP_EXCEPTION_PROBLEMS: ReadonlyMap<
  number,
  { code: ProblemCode; details?: ProblemDetails }
> = new Map([
  // `c.req.json()` on a body that is not JSON.
  [
    400,
    { code: 'validation_failed', details: { errors: [{ pointer: '', code: 'invalid_json' }] } },
  ],
  [404, { code: 'not_found' }],
  [413, { code: 'payload_too_large' }],
  [415, { code: 'unsupported_media_type' }],
  [428, { code: 'precondition_required' }],
]);

export function createErrorHandler(options: ErrorHandlerOptions): ErrorHandlerFunction {
  const { log } = options;

  // A broken logger or callback must never turn an answerable error into a hang.
  const attempt = (action: () => void): void => {
    try {
      action();
    } catch {
      // Nothing to do: the response is what matters.
    }
  };

  return (error, c) => {
    if (error instanceof ProblemError) return problemResponseFor(c, error.code, error.details);

    if (error instanceof HTTPException) {
      const mapped = HTTP_EXCEPTION_PROBLEMS.get(error.status);
      if (mapped !== undefined) return problemResponseFor(c, mapped.code, mapped.details);
      return problemResponse(c, 'internal_error');
    }

    const storage = classifyStorageError(error);
    if (storage !== undefined) {
      attempt(() => {
        log.warn(
          {
            event: 'storage_failure',
            kind: storage.kind,
            code: storage.code,
            requestId: requestIdOf(c),
          },
          'storage_failure',
        );
      });
      attempt(() => {
        options.onStorageFailure?.(storage);
      });
      return storage.kind === 'busy'
        ? problemResponse(c, 'storage_busy')
        : problemResponse(c, 'storage_unavailable');
    }

    attempt(() => {
      log.error({ requestId: requestIdOf(c), ...describeError(error) }, 'unhandled_error');
    });
    return problemResponse(c, 'internal_error');
  };
}

/** The not-found handler: a 404 problem, for `/api` and for everything the static layer declines. */
export function notFoundHandler(c: Context<AppEnv>): Response {
  return problemResponse(c, 'not_found');
}

/**
 * Hono hands an `Error` to `app.onError`, but a value that is not an `Error` (`throw 'text'`) is
 * rethrown out of the application, past every middleware and so past the security headers. This
 * middleware sits just inside them and answers such a value with the same handler, so that no
 * response leaves without the pipeline's headers.
 */
export function errorBoundary(handler: ErrorHandlerFunction): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    try {
      await next();
    } catch (thrown) {
      c.res = handler(thrown, c);
    }
  };
}

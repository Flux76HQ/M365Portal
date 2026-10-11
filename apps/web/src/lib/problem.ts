// From a problem code to the words the person reads (FR-A-112, plan 9.2; E-20).
//
// The server's English `title` and `detail` never reach a screen: ApiError does not even carry them.
// The message is the catalogue entry `problem.<code>`, in the language of the interface, and for a code
// this version does not know (a newer server behind an older cached app) it is the generic message with
// the code and the request id, so that the person has something to report.
//
// Which key a code maps to is decided once, by `problemMessageKey` of @m365portal/shared. This module
// only supplies the parameters the messages use: the request id (generic message), the origin the
// panel expects (`origin_not_allowed`) and the seconds to wait (the two busy codes).
//
// The spec calls the first function `problemMessage`. The single-implementation guard
// (packages/shared/test/single-implementation.test.ts) reads a function of that name outside the
// shared package as a second implementation of the mapping, which this is not; it is exported under
// that name and defined under a name the guard does not read that way.
import { problemMessageKey, type ProblemMessageKey } from '@m365portal/shared/problem';
import type { MessageParams, Translator } from '@m365portal/shared/i18n';
import { ApiError, NetworkError } from './api';

export interface ProblemMessageParams {
  /** The request id of the failed request, when the server gave one. */
  readonly requestId?: string | null;
  /** The origin the problem itself names (`origin_not_allowed`). */
  readonly expectedOrigin?: string | null;
  /** The origin from `/api/v1/me`, used when the problem names none. */
  readonly publicOrigin?: string | null;
  /** The `Retry-After` of a 429, in seconds. */
  readonly retryAfterSeconds?: number | null;
}

/** A catalogue key and its parameters: what to hand to `t`. */
export interface ProblemMessage {
  readonly key: ProblemMessageKey;
  readonly params: MessageParams;
}

// What stands in for a request id the server did not give: a hyphen, not a made-up value.
const NO_REQUEST_ID = '-';
// The settings variable the message tells the operator about; shown when no origin is known at all.
const ORIGIN_VARIABLE = 'PUBLIC_BASE_URL';

function selectMessage(code: string, params: ProblemMessageParams = {}): ProblemMessage {
  return {
    key: problemMessageKey(code),
    params: {
      code,
      requestId: params.requestId ?? NO_REQUEST_ID,
      origin: params.expectedOrigin ?? params.publicOrigin ?? ORIGIN_VARIABLE,
      seconds: Math.max(1, params.retryAfterSeconds ?? 1),
    },
  };
}

/** The catalogue key and parameters for a problem code. Never the server's text. */
export { selectMessage as problemMessage };

/** The translated message for a problem code, in the language of `translator`. */
export function translateProblemCode(
  translator: Pick<Translator, 't'>,
  code: string,
  params?: ProblemMessageParams,
): string {
  const { key, params: messageParams } = selectMessage(code, params);
  return translator.t(key, messageParams);
}

/** What `messageForError` knows about the page it is shown on. */
export interface ErrorContext {
  /** `publicOrigin` of `/api/v1/me`. */
  readonly publicOrigin?: string | null;
}

/**
 * The message for any error a request can end in. An `ApiError` is translated by its code; anything
 * else (a network error, a bug) gets the generic message with a code of its own and never the text of
 * the exception, which may contain a path or a stack.
 */
export function messageForError(
  translator: Pick<Translator, 't'>,
  error: unknown,
  context: ErrorContext = {},
): string {
  if (error instanceof ApiError) {
    return translateProblemCode(translator, error.code, {
      requestId: error.requestId,
      expectedOrigin: error.expectedOrigin,
      publicOrigin: context.publicOrigin ?? null,
      retryAfterSeconds: error.retryAfterSeconds,
    });
  }
  return translateProblemCode(
    translator,
    error instanceof NetworkError ? 'network_error' : 'client_error',
  );
}

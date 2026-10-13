// Exchange failures as the problem a route answers, and as the reason of one failed member (T-D-118,
// T-D-119, FR-D-105, FR-D-107, EC-D1, EC-D2, EC-D4). Nothing of Exchange reaches the response: the
// clients throw typed errors without text (ports/errors.ts), and this file chooses the registry code.
//
//   worker, role or Exchange not available      503 `exchange_unavailable` (+ `Retry-After: 30`);
//                                               the detail code `exchange_role_pending` when the role
//                                               has not propagated yet, `exchange_timeout` for a call
//                                               that ran out of time
//   throttled after the retry budget            503 `exchange_throttled`, `Retry-After` when given
//   Exchange refused the application            503 `exchange_permission_missing`
//   the object is read-only for Exchange        409 `read_only_object`
//   the object is not there                     404 `not_found`
//   the secrets are unusable                    503 `secrets_unavailable`
//
// `memberFailureOf` is the other direction for a member write: the reason code of the wire
// (`MemberFailReason`) for the error of one call, or `null` when the request as a whole must fail.
import type { MemberFailReason } from '@m365portal/shared/schemas/member-writes';
import { ProblemError } from '../http/problem.js';
import {
  ExchangeCommandError,
  ExchangeThrottledError,
  ExchangeUnavailableError,
  ExchangeUnsupportedError,
  IntegrationError,
  NotConnectedError,
  SecretsUnavailableError,
} from '../ports/errors.js';

/** The hint of `exchange_unavailable`, in seconds: long enough for a worker restart. */
const UNAVAILABLE_RETRY_SECONDS = 30;

function retryAfterSecondsOf(retryAfterMs: number | undefined): number | undefined {
  if (retryAfterMs === undefined || !Number.isFinite(retryAfterMs) || retryAfterMs <= 0) {
    return undefined;
  }
  return Math.min(86_400, Math.max(1, Math.ceil(retryAfterMs / 1000)));
}

const TIMEOUT_REASONS: ReadonlySet<string> = new Set(['timeout', 'worker_timeout']);

/** The problem for a failure of the Exchange client; a value that is not a client error is a bug and is thrown again. */
export function exchangeProblem(error: unknown): ProblemError {
  if (error instanceof ProblemError) return error;
  if (error instanceof SecretsUnavailableError) return new ProblemError('secrets_unavailable');
  if (error instanceof NotConnectedError) {
    return new ProblemError('exchange_unavailable', {
      retryAfterSeconds: UNAVAILABLE_RETRY_SECONDS,
    });
  }
  if (error instanceof ExchangeThrottledError) {
    const seconds = retryAfterSecondsOf(error.retryAfterMs);
    return new ProblemError(
      'exchange_throttled',
      seconds === undefined ? {} : { retryAfterSeconds: seconds },
    );
  }
  if (error instanceof ExchangeUnavailableError) {
    const detail =
      error.reason === 'role_pending'
        ? 'exchange_role_pending'
        : TIMEOUT_REASONS.has(error.reason)
          ? 'exchange_timeout'
          : undefined;
    return new ProblemError('exchange_unavailable', {
      retryAfterSeconds: UNAVAILABLE_RETRY_SECONDS,
      ...(detail === undefined ? {} : { errors: [{ pointer: '', code: detail }] }),
    });
  }
  if (error instanceof ExchangeUnsupportedError) {
    // An argument the allow-list refused: the only caller-controlled one is the search text.
    return new ProblemError('validation_failed', {
      errors: [{ pointer: '/q', code: 'search_invalid' }],
    });
  }
  if (error instanceof ExchangeCommandError) {
    switch (error.commandCode) {
      case 'permission_denied':
      case 'manager_check':
        return new ProblemError('exchange_permission_missing');
      case 'not_found':
        return new ProblemError('not_found');
      case 'read_only_object':
        return new ProblemError('read_only_object');
      case 'already_exists':
        return new ProblemError('conflict');
      case 'role_pending':
        return new ProblemError('exchange_unavailable', {
          retryAfterSeconds: UNAVAILABLE_RETRY_SECONDS,
          errors: [{ pointer: '', code: 'exchange_role_pending' }],
        });
      case 'throttled': {
        const seconds = retryAfterSecondsOf(error.retryAfterMs);
        return new ProblemError(
          'exchange_throttled',
          seconds === undefined ? {} : { retryAfterSeconds: seconds },
        );
      }
      case 'timeout':
        return new ProblemError('exchange_unavailable', {
          retryAfterSeconds: UNAVAILABLE_RETRY_SECONDS,
          errors: [{ pointer: '', code: 'exchange_timeout' }],
        });
      default:
        return new ProblemError('exchange_unavailable', {
          retryAfterSeconds: UNAVAILABLE_RETRY_SECONDS,
        });
    }
  }
  if (error instanceof IntegrationError) {
    return new ProblemError('exchange_unavailable', {
      retryAfterSeconds: UNAVAILABLE_RETRY_SECONDS,
    });
  }
  throw error;
}

/** Runs an Exchange call; whatever it throws leaves as a problem (a `ProblemError` of the service passes). */
export async function viaExchange<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (failure) {
    throw exchangeProblem(failure);
  }
}

/** What one failed call of a member write means. */
export interface MemberFailure {
  readonly reason: MemberFailReason;
  /** After this the following members are not tried: Exchange is throttled or gone. */
  readonly stop: boolean;
  /** Before anything was written this fails the whole request (`exchange_permission_missing`, `exchange_unavailable`). */
  readonly wholeRequestFirst: boolean;
}

/**
 * The reason code of a failed member call, or `null` for an error that is not a failure of a client
 * (a bug: the caller throws it again).
 */
export function memberFailureOf(error: unknown): MemberFailure | null {
  if (error instanceof ExchangeCommandError) {
    switch (error.commandCode) {
      case 'not_found':
        return { reason: 'not_found', stop: false, wholeRequestFirst: false };
      case 'member_type_not_allowed':
        return { reason: 'member_type_not_allowed', stop: false, wholeRequestFirst: false };
      case 'permission_denied':
      case 'manager_check':
        return { reason: 'permission_missing', stop: false, wholeRequestFirst: true };
      case 'role_pending':
        return { reason: 'unavailable', stop: true, wholeRequestFirst: true };
      case 'throttled':
        return { reason: 'throttled', stop: true, wholeRequestFirst: true };
      case 'timeout':
        return { reason: 'timeout', stop: true, wholeRequestFirst: true };
      default:
        return { reason: 'rejected', stop: false, wholeRequestFirst: false };
    }
  }
  if (error instanceof ExchangeThrottledError) {
    return { reason: 'throttled', stop: true, wholeRequestFirst: true };
  }
  if (error instanceof ExchangeUnavailableError) {
    if (error.reason === 'role_pending') {
      return { reason: 'unavailable', stop: true, wholeRequestFirst: true };
    }
    return {
      reason: TIMEOUT_REASONS.has(error.reason) ? 'timeout' : 'unavailable',
      stop: true,
      wholeRequestFirst: true,
    };
  }
  if (error instanceof ExchangeUnsupportedError) {
    return { reason: 'rejected', stop: false, wholeRequestFirst: false };
  }
  if (error instanceof IntegrationError || error instanceof NotConnectedError) {
    return { reason: 'unavailable', stop: true, wholeRequestFirst: true };
  }
  return null;
}

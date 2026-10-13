// T-D-118, T-D-119, FR-D-105, FR-D-107, EC-D1, EC-D2, EC-D4: Exchange failures as problems and as the reason
// of one failed member. No text of Exchange, no argument, no id reaches a response.
import { describe, expect, it } from 'vitest';
import { exchangeProblem, memberFailureOf } from '../../src/distribution-lists/errors.js';
import { ProblemError } from '../../src/http/problem.js';
import {
  ExchangeCommandError,
  ExchangeThrottledError,
  ExchangeUnavailableError,
  ExchangeUnsupportedError,
  GraphTransientError,
  NotConnectedError,
  SecretsUnavailableError,
} from '../../src/ports/errors.js';

const problemOf = (error: unknown): ProblemError => exchangeProblem(error);

describe('exchangeProblem', () => {
  it('maps the typed errors to the registry codes of spec 6.11.3, with the detail codes', () => {
    const cases: [unknown, string, ProblemError['details']][] = [
      [new SecretsUnavailableError({ reason: 'no_certificate' }), 'secrets_unavailable', {}],
      [new NotConnectedError(), 'exchange_unavailable', { retryAfterSeconds: 30 }],
      [
        new ExchangeUnavailableError({ reason: 'role_pending' }),
        'exchange_unavailable',
        { retryAfterSeconds: 30, errors: [{ pointer: '', code: 'exchange_role_pending' }] },
      ],
      [
        new ExchangeUnavailableError({ reason: 'worker_timeout' }),
        'exchange_unavailable',
        { retryAfterSeconds: 30, errors: [{ pointer: '', code: 'exchange_timeout' }] },
      ],
      [
        new ExchangeUnavailableError({ reason: 'worker_crashed' }),
        'exchange_unavailable',
        { retryAfterSeconds: 30 },
      ],
      [
        new ExchangeThrottledError({ retryAfterMs: 2_100 }),
        'exchange_throttled',
        { retryAfterSeconds: 3 },
      ],
      [new ExchangeThrottledError(), 'exchange_throttled', {}],
      [new ExchangeCommandError('permission_denied'), 'exchange_permission_missing', {}],
      [new ExchangeCommandError('manager_check'), 'exchange_permission_missing', {}],
      [new ExchangeCommandError('not_found'), 'not_found', {}],
      [new ExchangeCommandError('read_only_object'), 'read_only_object', {}],
      [new ExchangeCommandError('already_exists'), 'conflict', {}],
      [
        new ExchangeCommandError('role_pending'),
        'exchange_unavailable',
        { retryAfterSeconds: 30, errors: [{ pointer: '', code: 'exchange_role_pending' }] },
      ],
      [new ExchangeCommandError('internal'), 'exchange_unavailable', { retryAfterSeconds: 30 }],
      [
        new ExchangeUnsupportedError({ reason: 'invalid_parameter' }),
        'validation_failed',
        { errors: [{ pointer: '/q', code: 'search_invalid' }] },
      ],
      [new GraphTransientError(), 'exchange_unavailable', { retryAfterSeconds: 30 }],
    ];
    for (const [error, code, details] of cases) {
      const problem = problemOf(error);
      expect(problem.code, String(error)).toBe(code);
      expect(problem.details).toEqual(details);
    }
  });

  it('lets a problem pass and throws a value that is not a client error again (a bug is not a 503)', () => {
    const own = new ProblemError('not_found');
    expect(exchangeProblem(own)).toBe(own);
    const bug = new TypeError('a bug');
    expect(() => exchangeProblem(bug)).toThrow(bug);
  });
});

describe('memberFailureOf', () => {
  it('gives the reason of the wire, whether the rest is stopped, and whether it fails the request when it is the first write', () => {
    const cases: [unknown, string, boolean, boolean][] = [
      [new ExchangeCommandError('not_found'), 'not_found', false, false],
      [
        new ExchangeCommandError('member_type_not_allowed'),
        'member_type_not_allowed',
        false,
        false,
      ],
      [new ExchangeCommandError('permission_denied'), 'permission_missing', false, true],
      [new ExchangeCommandError('manager_check'), 'permission_missing', false, true],
      [new ExchangeCommandError('internal'), 'rejected', false, false],
      [new ExchangeCommandError('invalid_argument'), 'rejected', false, false],
      [new ExchangeThrottledError(), 'throttled', true, true],
      [new ExchangeUnavailableError({ reason: 'timeout' }), 'timeout', true, true],
      [new ExchangeUnavailableError({ reason: 'worker_crashed' }), 'unavailable', true, true],
      [new ExchangeUnavailableError({ reason: 'role_pending' }), 'unavailable', true, true],
      [new ExchangeUnsupportedError(), 'rejected', false, false],
    ];
    for (const [error, reason, stop, whole] of cases) {
      expect(memberFailureOf(error), String(error)).toEqual({
        reason,
        stop,
        wholeRequestFirst: whole,
      });
    }
    expect(memberFailureOf(new TypeError('x'))).toBeNull();
  });
});

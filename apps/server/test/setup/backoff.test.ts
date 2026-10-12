// T-B-128: the backoff schedule and the failure classification (FR-B-212, SB-06). Pure functions of
// the attempt number, the class and the injected random source.
import { describe, expect, it } from 'vitest';
import {
  GraphBadRequestError,
  GraphConflictError,
  GraphForbiddenError,
  GraphNetworkError,
  GraphNotFoundError,
  GraphThrottledError,
  GraphTransientError,
  GraphUnauthorizedError,
  ExchangeForbiddenError,
  ExchangeTransientError,
  TokenEndpointError,
  DeviceCodeError,
  SecretsUnavailableError,
} from '../../src/ports/errors.js';
import {
  backoffDelay,
  replicationWindowEnded,
  windowSecondsFor,
} from '../../src/setup/backoff.js';
import { classifyFailure } from '../../src/setup/classify.js';

const fixed = (value: number): { float(): number } => ({ float: () => value });

describe('backoffDelay: transient', () => {
  it('attempts 1 to 8 with full jitter: ceiling 1 s doubling to 30 s, at most 6 tries', () => {
    const ceiling = [1000, 2000, 4000, 8000, 16000, 30000];
    for (const [index, cap] of ceiling.entries()) {
      const attempt = index + 1;
      expect(backoffDelay({ klass: 'transient', attempt, random: fixed(0.999999) })).toBeCloseTo(
        cap * 0.999999,
        3,
      );
      expect(backoffDelay({ klass: 'transient', attempt, random: fixed(0.5) })).toBe(cap / 2 < 500 ? 500 : cap / 2);
    }
    expect(backoffDelay({ klass: 'transient', attempt: 7, random: fixed(0.5) })).toBeNull();
    expect(backoffDelay({ klass: 'transient', attempt: 8, random: fixed(0.5) })).toBeNull();
  });

  it('never waits less than 500 ms, even for a draw near zero (SB-06)', () => {
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      expect(backoffDelay({ klass: 'transient', attempt, random: fixed(0) })).toBe(500);
      expect(backoffDelay({ klass: 'transient', attempt, random: fixed(0.0001) })).toBe(500);
    }
  });

  it('uses Retry-After when it is present (with the same floor)', () => {
    expect(
      backoffDelay({ klass: 'transient', attempt: 3, retryAfterMs: 7_000, random: fixed(0.1) }),
    ).toBe(7_000);
    expect(
      backoffDelay({ klass: 'transient', attempt: 1, retryAfterMs: 0, random: fixed(0.9) }),
    ).toBe(500);
    // The attempt limit still holds.
    expect(
      backoffDelay({ klass: 'transient', attempt: 7, retryAfterMs: 1_000, random: fixed(0.9) }),
    ).toBeNull();
  });
});

describe('backoffDelay: replication', () => {
  it('attempts 1 to 8: ceiling 2 s doubling to 60 s, no try limit (the window decides)', () => {
    const ceiling = [2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000];
    for (const [index, cap] of ceiling.entries()) {
      const attempt = index + 1;
      expect(backoffDelay({ klass: 'replication', attempt, random: fixed(0.5) })).toBe(cap / 2);
      expect(backoffDelay({ klass: 'replication', attempt, random: fixed(0) })).toBe(500);
    }
    expect(backoffDelay({ klass: 'replication', attempt: 40, random: fixed(0.5) })).toBe(30_000);
  });

  it('jitter stays inside 500 ms and the cap for a seeded sequence', () => {
    let state = 12345;
    const random = {
      float: (): number => {
        state = (state * 1103515245 + 12345) % 2147483648;
        return state / 2147483648;
      },
    };
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      for (let n = 0; n < 200; n += 1) {
        const delay = backoffDelay({ klass: 'replication', attempt, random });
        const cap = Math.min(60_000, 2_000 * 2 ** (attempt - 1));
        expect(delay).toBeGreaterThanOrEqual(500);
        expect(delay).toBeLessThanOrEqual(cap);
      }
    }
  });

  it('retryAfterMs does not apply to replication', () => {
    expect(
      backoffDelay({ klass: 'replication', attempt: 1, retryAfterMs: 90_000, random: fixed(0.5) }),
    ).toBe(1_000);
  });
});

describe('permanent', () => {
  it('is never retried', () => {
    expect(backoffDelay({ klass: 'permanent', attempt: 1, random: fixed(0.5) })).toBeNull();
  });
});

describe('the window', () => {
  it('300 s for object chains, the setting for role-to-token propagation (default 900, at most 3,600)', () => {
    expect(windowSecondsFor('objects', 900)).toBe(300);
    expect(windowSecondsFor('propagation', 900)).toBe(900);
    expect(windowSecondsFor('propagation', 99_999)).toBe(3_600);
    expect(windowSecondsFor('propagation', 1)).toBe(60);
  });

  it('ends exactly when the elapsed time reaches the window', () => {
    expect(replicationWindowEnded(299_999, 300)).toBe(false);
    expect(replicationWindowEnded(300_000, 300)).toBe(true);
    expect(replicationWindowEnded(0, 300)).toBe(false);
  });

  it('the wait is cut to what is left of the window', () => {
    expect(
      backoffDelay({
        klass: 'replication',
        attempt: 6,
        random: fixed(0.999),
        remainingWindowMs: 5_000,
      }),
    ).toBe(5_000);
  });
});

describe('classifyFailure', () => {
  const none = {};

  it('429 and 5xx are transient, and so is a network failure', () => {
    expect(classifyFailure(new GraphThrottledError({ retryAfterMs: 2000 }), none)).toMatchObject({
      klass: 'transient',
      retryAfterMs: 2000,
    });
    expect(classifyFailure(new GraphTransientError({ status: 503 }), none).klass).toBe('transient');
    expect(classifyFailure(new GraphTransientError({ status: 504 }), none).klass).toBe('transient');
    expect(classifyFailure(new GraphNetworkError(), none).klass).toBe('transient');
    expect(classifyFailure(new ExchangeTransientError(), none).klass).toBe('transient');
  });

  it('a 404 is replication only for an id the run created or received within the window', () => {
    expect(classifyFailure(new GraphNotFoundError(), { justCreated: true }).klass).toBe('replication');
    expect(classifyFailure(new GraphNotFoundError(), none).klass).toBe('permanent');
  });

  it('a 400 is replication only on an object the run just created, otherwise permanent', () => {
    expect(classifyFailure(new GraphBadRequestError(), { justCreated: true }).klass).toBe('replication');
    expect(classifyFailure(new GraphBadRequestError(), none).klass).toBe('permanent');
    expect(
      classifyFailure(new GraphBadRequestError({ graphCode: 'Request_BadRequest' }), none).klass,
    ).toBe('permanent');
  });

  it('401 and 403 are replication only inside the propagation window after a grant or role assignment', () => {
    expect(classifyFailure(new GraphForbiddenError(), { afterGrant: true }).klass).toBe('replication');
    expect(classifyFailure(new GraphUnauthorizedError(), { afterGrant: true }).klass).toBe('replication');
    expect(classifyFailure(new ExchangeForbiddenError(), { afterGrant: true }).klass).toBe('replication');
    expect(classifyFailure(new GraphForbiddenError(), none).klass).toBe('permanent');
    expect(classifyFailure(new GraphUnauthorizedError(), none).klass).toBe('permanent');
  });

  it('invalid_client is replication only inside the window after a certificate upload', () => {
    const invalidClient = new TokenEndpointError({ error: 'invalid_client', status: 401 });
    expect(classifyFailure(invalidClient, { afterCertificateUpload: true }).klass).toBe('replication');
    expect(classifyFailure(invalidClient, none).klass).toBe('permanent');
    expect(
      classifyFailure(new TokenEndpointError({ error: 'invalid_grant' }), { afterCertificateUpload: true })
        .klass,
    ).toBe('permanent');
  });

  it('everything else is permanent: 409, a device-code failure, an unavailable secret, an unknown error', () => {
    expect(classifyFailure(new GraphConflictError(), { justCreated: true }).klass).toBe('permanent');
    expect(classifyFailure(new DeviceCodeError({ kind: 'declined' }), none).klass).toBe('permanent');
    expect(classifyFailure(new SecretsUnavailableError({ reason: 'app_key_missing' }), none).klass).toBe(
      'permanent',
    );
    expect(classifyFailure(new Error('boom'), { justCreated: true, afterGrant: true }).klass).toBe(
      'permanent',
    );
    expect(classifyFailure('x', none).klass).toBe('permanent');
  });

  it('carries the allow-listed Graph error code and the retry hint, nothing else', () => {
    const verdict = classifyFailure(new GraphBadRequestError({ graphCode: 'Request_BadRequest' }), none);
    expect(verdict.graphCode).toBe('Request_BadRequest');
    expect(Object.keys(verdict).sort()).toEqual(['graphCode', 'klass']);
  });
});

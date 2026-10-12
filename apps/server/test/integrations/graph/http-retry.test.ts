// T-B-071, FR-B-312, EB-07 (part), RB-15: how `GraphHttp` meets throttling, outages and overload.
//
// The server side is a scripted route on the shared fake tenant behind MSW; time is the injected
// clock plus the injected scheduler, moved together by `elapse`, so no test sleeps. The numbers are
// the ones of spec FR-B-312 and plan 8.3 (`LIMITS.microsoft` holds them once for the code):
//   - 429 waits `Retry-After` (seconds or an HTTP date) plus 0 to 20 % jitter, at most 60 s per wait;
//     a longer value fails fast as `graph_throttled` carrying the value; at most 4 retries;
//   - 503 and 504 retry with 500 ms doubling to 10 s with full jitter, at most 4 retries, for GET,
//     HEAD, PUT, DELETE and a POST the caller marks idempotent; 500 and 502 do not retry;
//   - 400, 401, 403, 404 and 409 never retry;
//   - budgets: 20 s interactive, 60 s wizard; the wizard budget has no retries and surfaces
//     `retryAfterMs`; one attempt lasts at most min(remaining budget, 10 s);
//   - at most 4 calls in flight, FIFO, a queue of at most 64;
//   - `x-ms-throttle-priority`, `client-request-id`; no token in any error or log line.
import { inspect } from 'node:util';
import { LIMITS } from '@m365portal/shared/limits';
import { expectGuardFails } from '@m365portal/shared/testing';
import { describe, expect, it } from 'vitest';
import {
  createGraphHttp,
  type GraphHttpDeps,
  type GraphRequest,
} from '../../../src/integrations/graph/graph-http.js';
import { backoffCapMs, retryAfterWaitMs } from '../../../src/integrations/graph/retry.js';
import {
  GraphBadRequestError,
  GraphConflictError,
  GraphForbiddenError,
  GraphNetworkError,
  GraphNotFoundError,
  GraphThrottledError,
  GraphTransientError,
  GraphUnauthorizedError,
  NotConnectedError,
} from '../../../src/ports/errors.js';
import type { RandomSource } from '../../../src/ports/clock.js';
import { jsonResponse } from '../../fakes/fake-tenant/index.js';
import { fake, testClock } from '../../support/msw.js';
import {
  createTime,
  mountScript,
  rejectionOf,
  sequenceRandom,
  settle,
  track,
  type ScriptStep,
} from '../support.js';

const TOKEN = 'canary-token-5b1d8e03c7a94f26';
const GRAPH = 'graph.microsoft.com';

interface LogLine {
  level: 'debug' | 'warn';
  fields: Record<string, unknown>;
  message: string;
}

function harness(options: { random?: RandomSource; token?: GraphHttpDeps['token'] } = {}) {
  const time = createTime();
  const lines: LogLine[] = [];
  const tokenRequests: { skipCache: boolean }[] = [];
  const http = createGraphHttp({
    token:
      options.token ??
      ((o) => {
        tokenRequests.push({ skipCache: o?.skipCache === true });
        return Promise.resolve(TOKEN);
      }),
    clock: time.clock,
    random: options.random ?? sequenceRandom([0]),
    scheduler: time.scheduler,
    log: {
      debug: (fields, message) => lines.push({ level: 'debug', fields: { ...fields }, message }),
      warn: (fields, message) => lines.push({ level: 'warn', fields: { ...fields }, message }),
    },
  });
  return { http, time, lines, tokenRequests };
}

function get(path = '/organization', extra: Partial<GraphRequest> = {}): GraphRequest {
  return { method: 'GET', route: 'test.get', path, ...extra };
}

const THROTTLED = (seconds: string | undefined): ScriptStep => ({
  status: 429,
  body: { error: { code: 'TooManyRequests', message: 'free text that must not leak' } },
  headers: seconds === undefined ? {} : { 'retry-after': seconds },
});
const OK: ScriptStep = { status: 200, body: { value: [{ id: 'x' }] } };
const UNAVAILABLE: ScriptStep = { status: 503, body: { error: { code: 'serviceNotAvailable' } } };

describe('429: Retry-After (T-B-071, FR-B-312)', () => {
  it('waits the Retry-After seconds plus the jitter, then tries again', async () => {
    const { calls } = mountScript(GRAPH, 'GET', '/v1.0/organization', [THROTTLED('2'), OK]);
    // Jitter 0.5: 2000 * (1 + 0.2 * 0.5) = 2200 ms.
    const { http, time } = harness({ random: sequenceRandom([0.5]) });
    const call = track(http.request(get()));
    await settle();
    expect(calls).toHaveLength(1);
    time.elapse(2_199);
    await settle();
    expect(calls).toHaveLength(1);
    time.elapse(1);
    await settle();
    expect(calls).toHaveLength(2);
    expect((await call.promise).status).toBe(200);
  });

  it('keeps the jitter between 0 and 20 per cent', () => {
    expect(retryAfterWaitMs(10_000, 0)).toBe(10_000);
    expect(retryAfterWaitMs(10_000, 0.999999)).toBeLessThanOrEqual(12_000);
    expect(retryAfterWaitMs(10_000, 0.999999)).toBeGreaterThanOrEqual(11_999);
    expect(retryAfterWaitMs(0, 0.7)).toBe(0);
    // Never more than 60 s even with jitter on top of 60 s.
    expect(retryAfterWaitMs(60_000, 0.999)).toBe(60_000);
  });

  it('reads the HTTP date form of Retry-After against the injected clock', async () => {
    const date = new Date(testClock.nowMs() + 5_000).toUTCString();
    const { calls } = mountScript(GRAPH, 'GET', '/v1.0/organization', [THROTTLED(date), OK]);
    const { http, time } = harness();
    const call = track(http.request(get()));
    await settle();
    expect(calls).toHaveLength(1);
    time.elapse(4_999);
    await settle();
    expect(calls).toHaveLength(1);
    time.elapse(1);
    await settle();
    expect(calls).toHaveLength(2);
    expect((await call.promise).status).toBe(200);
  });

  it('retries a POST after 429 too: the call was not processed', async () => {
    const { calls } = mountScript(GRAPH, 'POST', '/v1.0/applications', [
      THROTTLED('1'),
      { status: 201, body: { id: 'a' } },
    ]);
    const { http, time } = harness();
    const call = track(
      http.request({
        method: 'POST',
        route: 'app.create',
        path: '/applications',
        json: { displayName: 'x' },
      }),
    );
    await settle();
    time.elapse(1_000);
    await settle();
    expect(calls).toHaveLength(2);
    expect((await call.promise).status).toBe(201);
  });

  it('fails fast, without waiting, when Retry-After is longer than 60 seconds', async () => {
    const { calls } = mountScript(GRAPH, 'GET', '/v1.0/organization', [THROTTLED('61'), OK]);
    const { http, time } = harness();
    const failure = (await rejectionOf(http.request(get()))) as GraphThrottledError;
    expect(failure).toBeInstanceOf(GraphThrottledError);
    expect(failure.code).toBe('graph_throttled');
    expect(failure.retryAfterMs).toBe(61_000);
    expect(failure.retryable).toBe(true);
    expect(calls).toHaveLength(1);
    expect(time.scheduler.pending()).toBe(0);
  });

  it('fails fast when the wait would not fit in what is left of the 20 second budget', async () => {
    const { calls } = mountScript(GRAPH, 'GET', '/v1.0/organization', [THROTTLED('25'), OK]);
    const { http } = harness();
    const failure = (await rejectionOf(http.request(get()))) as GraphThrottledError;
    expect(failure).toBeInstanceOf(GraphThrottledError);
    expect(failure.retryAfterMs).toBe(25_000);
    expect(calls).toHaveLength(1);
  });

  it('retries at most 4 times: five answers of 429 end in graph_throttled with the last value', async () => {
    const { calls } = mountScript(GRAPH, 'GET', '/v1.0/organization', [
      THROTTLED('1'),
      THROTTLED('1'),
      THROTTLED('1'),
      THROTTLED('1'),
      THROTTLED('3'),
    ]);
    const { http, time } = harness();
    const call = track(http.request(get()));
    for (let wait = 0; wait < 4; wait += 1) {
      await settle();
      time.elapse(1_000);
    }
    await settle();
    expect(calls).toHaveLength(5);
    const failure = (await rejectionOf(call.promise)) as GraphThrottledError;
    expect(failure).toBeInstanceOf(GraphThrottledError);
    expect(failure.retryAfterMs).toBe(3_000);
    expect(failure.status).toBe(429);
    expect(time.scheduler.pending()).toBe(0);
  });

  it('backs off exponentially when a 429 carries no Retry-After', async () => {
    const { calls } = mountScript(GRAPH, 'GET', '/v1.0/organization', [THROTTLED(undefined), OK]);
    // Full jitter 0.5 of the first cap (500 ms) is 250 ms.
    const { http, time } = harness({ random: sequenceRandom([0.5]) });
    const call = track(http.request(get()));
    await settle();
    time.elapse(249);
    await settle();
    expect(calls).toHaveLength(1);
    time.elapse(1);
    await settle();
    expect(calls).toHaveLength(2);
    expect((await call.promise).status).toBe(200);
  });

  it('ignores a Retry-After it cannot read and backs off instead', async () => {
    const { calls } = mountScript(GRAPH, 'GET', '/v1.0/organization', [THROTTLED('soon'), OK]);
    const { http, time } = harness({ random: sequenceRandom([0.5]) });
    const call = track(http.request(get()));
    await settle();
    time.elapse(250);
    await settle();
    expect(calls).toHaveLength(2);
    await call.promise;
  });
});

describe('503 and 504: backoff (T-B-071, FR-B-312)', () => {
  it('doubles the cap from 500 ms up to 10 s', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 20].map(backoffCapMs)).toEqual([
      500, 1_000, 2_000, 4_000, 8_000, 10_000, 10_000, 10_000,
    ]);
    expect(LIMITS.microsoft.graph5xxBackoff).toEqual({
      initialMs: 500,
      maxMs: 10_000,
      maxRetries: 4,
    });
  });

  it('waits a random time below the cap (full jitter) and retries up to 4 times', async () => {
    const { calls } = mountScript(GRAPH, 'GET', '/v1.0/organization', [
      UNAVAILABLE,
      UNAVAILABLE,
      UNAVAILABLE,
      UNAVAILABLE,
      OK,
    ]);
    // Random 0.5 gives 250, 500, 1000, 2000 ms.
    const { http, time } = harness({ random: sequenceRandom([0.5]) });
    const call = track(http.request(get()));
    const expectedWaits = [250, 500, 1_000, 2_000];
    for (const [index, wait] of expectedWaits.entries()) {
      await settle();
      expect(calls).toHaveLength(index + 1);
      time.elapse(wait - 1);
      await settle();
      expect(calls).toHaveLength(index + 1);
      time.elapse(1);
    }
    await settle();
    expect(calls).toHaveLength(5);
    expect((await call.promise).status).toBe(200);
  });

  it('gives up after the fourth retry with graph_transient and the status', async () => {
    const { calls } = mountScript(GRAPH, 'GET', '/v1.0/organization', [UNAVAILABLE]);
    const { http, time } = harness({ random: sequenceRandom([0]) });
    const call = track(http.request(get()));
    for (let round = 0; round < 6; round += 1) {
      await settle();
      time.elapse(10_000);
    }
    const failure = (await rejectionOf(call.promise)) as GraphTransientError;
    expect(failure).toBeInstanceOf(GraphTransientError);
    expect(failure.status).toBe(503);
    expect(failure.retryable).toBe(true);
    expect(calls).toHaveLength(5);
  });

  it('retries 504 as well', async () => {
    const { calls } = mountScript(GRAPH, 'GET', '/v1.0/organization', [
      { status: 504, body: {} },
      OK,
    ]);
    const { http, time } = harness();
    const call = track(http.request(get()));
    await settle();
    time.elapse(500);
    await settle();
    expect(calls).toHaveLength(2);
    await call.promise;
  });

  it.each(['GET', 'HEAD', 'PUT', 'DELETE'] as const)('retries %s', async (method) => {
    const { calls } = mountScript(GRAPH, method, '/v1.0/things', [
      UNAVAILABLE,
      { status: 200, body: {} },
    ]);
    const { http, time } = harness();
    const call = track(http.request({ method, route: 'things', path: '/things' }));
    await settle();
    time.elapse(500);
    await settle();
    expect(calls).toHaveLength(2);
    await call.promise;
  });

  it.each(['POST', 'PATCH'] as const)(
    'does not retry a %s that is not marked idempotent',
    async (method) => {
      const { calls } = mountScript(GRAPH, method, '/v1.0/things', [
        UNAVAILABLE,
        { status: 200, body: {} },
      ]);
      const { http, time } = harness();
      const failure = await rejectionOf(
        http.request({ method, route: 'things', path: '/things', json: {} }),
      );
      expect(failure).toBeInstanceOf(GraphTransientError);
      expect(calls).toHaveLength(1);
      expect(time.scheduler.pending()).toBe(0);
    },
  );

  it('retries a POST the caller marks idempotent (a read that uses POST)', async () => {
    const { calls } = mountScript(GRAPH, 'POST', '/v1.0/users/u/checkMemberGroups', [
      UNAVAILABLE,
      { status: 200, body: { value: [] } },
    ]);
    const { http, time } = harness();
    const call = track(
      http.request({
        method: 'POST',
        route: 'check',
        path: '/users/u/checkMemberGroups',
        json: { groupIds: [] },
        idempotent: true,
      }),
    );
    await settle();
    time.elapse(500);
    await settle();
    expect(calls).toHaveLength(2);
    await call.promise;
  });

  it.each([500, 502])('does not retry %i, not even a GET', async (status) => {
    const { calls } = mountScript(GRAPH, 'GET', '/v1.0/organization', [{ status, body: {} }, OK]);
    const { http } = harness();
    const failure = (await rejectionOf(http.request(get()))) as GraphTransientError;
    expect(failure).toBeInstanceOf(GraphTransientError);
    expect(failure.status).toBe(status);
    expect(calls).toHaveLength(1);
  });
});

describe('answers that are never retried (T-B-071, FR-B-312)', () => {
  const cases = [
    [400, GraphBadRequestError, 'Request_BadRequest'],
    [401, GraphUnauthorizedError, 'InvalidAuthenticationToken'],
    [403, GraphForbiddenError, 'Authorization_RequestDenied'],
    [404, GraphNotFoundError, 'Request_ResourceNotFound'],
    [409, GraphConflictError, 'Request_MultipleErrors'],
  ] as const;

  it.each(cases)(
    '%i is one request and a typed error with the Graph code and the ids',
    async (status, ErrorClass, graphCode) => {
      const { calls } = mountScript(GRAPH, 'GET', '/v1.0/organization', [
        {
          status,
          body: { error: { code: graphCode, message: 'free text that must not leak' } },
          headers: { 'request-id': 'req-123' },
        },
        OK,
      ]);
      const { http, time } = harness();
      const failure = (await rejectionOf(http.request(get()))) as InstanceType<typeof ErrorClass>;
      expect(failure).toBeInstanceOf(ErrorClass);
      expect(failure.status).toBe(status);
      expect(failure.graphCode).toBe(graphCode);
      expect(failure.requestId).toBe('req-123');
      expect(failure.clientRequestId).toMatch(/^[0-9a-f-]{36}$/);
      expect(failure.retryable).toBe(false);
      expect(JSON.stringify(failure)).not.toContain('free text');
      expect(calls).toHaveLength(1);
      expect(time.scheduler.pending()).toBe(0);
    },
  );

  it('maps another 4xx to graph_bad_request without a retry', async () => {
    const { calls } = mountScript(GRAPH, 'GET', '/v1.0/organization', [
      { status: 412, body: { error: { code: 'PreconditionFailed' } } },
      OK,
    ]);
    const { http } = harness();
    const failure = (await rejectionOf(http.request(get()))) as GraphBadRequestError;
    expect(failure).toBeInstanceOf(GraphBadRequestError);
    expect(failure.graphCode).toBe('PreconditionFailed');
    expect(calls).toHaveLength(1);
  });

  it('drops a Graph error code that is not a code', async () => {
    mountScript(GRAPH, 'GET', '/v1.0/organization', [
      { status: 400, body: { error: { code: 'two words and "quotes"' } } },
    ]);
    const { http } = harness();
    const failure = (await rejectionOf(http.request(get()))) as GraphBadRequestError;
    expect(failure.graphCode).toBeUndefined();
  });

  it('is a network error when the body of a success is not JSON, and when the connection drops', async () => {
    mountScript(GRAPH, 'GET', '/v1.0/organization', [
      () =>
        new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    ]);
    const { http } = harness();
    expect(await rejectionOf(http.request(get()))).toBeInstanceOf(GraphNetworkError);

    mountScript(GRAPH, 'POST', '/v1.0/applications', [{ status: 201, body: { id: 'x' } }]);
    fake.control.crashAfterMutating(1);
    const dropped = await rejectionOf(
      http.request({ method: 'POST', route: 'app.create', path: '/applications', json: {} }),
    );
    expect(dropped).toBeInstanceOf(GraphNetworkError);
    expect((dropped as GraphNetworkError).retryable).toBe(true);
  });
});

describe('budgets (T-B-071, FR-B-312, plan 8.3)', () => {
  it('ends an attempt that gets no answer after 10 seconds', async () => {
    const { calls } = mountScript(GRAPH, 'GET', '/v1.0/organization', ['hang']);
    const { http, time } = harness();
    const call = track(http.request(get()));
    await settle();
    time.elapse(9_999);
    await settle();
    expect(call.settled()).toBe(false);
    time.elapse(1);
    const failure = await rejectionOf(call.promise);
    expect(failure).toBeInstanceOf(GraphNetworkError);
    expect(calls).toHaveLength(1);
  });

  it('gives a wizard call 60 seconds, but an attempt still ends after 10', async () => {
    mountScript(GRAPH, 'GET', '/v1.0/organization', ['hang']);
    const { http, time } = harness();
    const call = track(http.request(get('/organization', { budget: 'wizard' })));
    await settle();
    time.elapse(10_000);
    expect(await rejectionOf(call.promise)).toBeInstanceOf(GraphNetworkError);
  });

  it('does not retry in the wizard budget: 429 surfaces the wait, 503 surfaces at once', async () => {
    const throttled = mountScript(GRAPH, 'GET', '/v1.0/organization', [THROTTLED('7'), OK]);
    const { http, time } = harness();
    const failure = (await rejectionOf(
      http.request(get('/organization', { budget: 'wizard' })),
    )) as GraphThrottledError;
    expect(failure).toBeInstanceOf(GraphThrottledError);
    expect(failure.retryAfterMs).toBe(7_000);
    expect(throttled.calls).toHaveLength(1);

    fake.reset();
    const outage = mountScript(GRAPH, 'GET', '/v1.0/organization', [UNAVAILABLE, OK]);
    const second = await rejectionOf(http.request(get('/organization', { budget: 'wizard' })));
    expect(second).toBeInstanceOf(GraphTransientError);
    expect(outage.calls).toHaveLength(1);
    expect(time.scheduler.pending()).toBe(0);
  });

  it('gives a 429 with a long wait to the wizard caller as the number, not as a failed wait', async () => {
    mountScript(GRAPH, 'GET', '/v1.0/organization', [THROTTLED('45')]);
    const { http } = harness();
    const failure = (await rejectionOf(
      http.request(get('/organization', { budget: 'wizard' })),
    )) as GraphThrottledError;
    expect(failure.retryAfterMs).toBe(45_000);
  });

  it('stops retrying when the 20 second budget is used up by earlier waits', async () => {
    // 15 s then another 15 s do not fit in 20 s: the second 429 fails fast.
    const { calls } = mountScript(GRAPH, 'GET', '/v1.0/organization', [
      THROTTLED('15'),
      THROTTLED('15'),
      OK,
    ]);
    const { http, time } = harness();
    const call = track(http.request(get()));
    await settle();
    time.elapse(15_000);
    await settle();
    expect(calls).toHaveLength(2);
    const failure = (await rejectionOf(call.promise)) as GraphThrottledError;
    expect(failure).toBeInstanceOf(GraphThrottledError);
    expect(failure.retryAfterMs).toBe(15_000);
  });

  it('negative: a client that ignores the 60 second cap would wait for a long Retry-After', () => {
    expectGuardFails(
      (retryAfterMs: number) => {
        if (retryAfterWaitMs(retryAfterMs, 0) === null) throw new Error('refused');
        return retryAfterWaitMs(retryAfterMs, 0);
      },
      300_000,
      { name: 'retryAfterWaitMs', reason: 'refused' },
    );
  });
});

describe('concurrency (T-B-071, FR-B-312)', () => {
  function gatedRoute() {
    const state = {
      inFlight: 0,
      maxInFlight: 0,
      started: [] as string[],
      releases: [] as (() => void)[],
    };
    fake.mount((core) => {
      core.router.add({
        host: GRAPH,
        method: 'GET',
        path: '/v1.0/slow/:n',
        handler: async ({ params }) => {
          state.inFlight += 1;
          state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
          state.started.push(params.n ?? '?');
          await new Promise<void>((resolve) => {
            state.releases.push(resolve);
          });
          state.inFlight -= 1;
          return jsonResponse(200, { n: params.n });
        },
      });
    });
    return state;
  }

  it('runs at most 4 calls at once and starts the rest in the order they were made', async () => {
    const state = gatedRoute();
    const { http } = harness();
    const calls = Array.from({ length: 10 }, (_, n) =>
      track(http.request(get(`/slow/${String(n)}`))),
    );
    await settle();
    expect(state.inFlight).toBe(4);
    expect(state.started).toEqual(['0', '1', '2', '3']);
    for (let finished = 0; finished < 10; finished += 1) {
      const release = state.releases[finished];
      expect(release).toBeDefined();
      release?.();
      await settle();
    }
    await Promise.all(calls.map((call) => call.promise));
    expect(state.maxInFlight).toBe(4);
    expect(state.started).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
  });

  it('refuses call number 69: 4 in flight and 64 queued are the limit', async () => {
    const state = gatedRoute();
    const { http } = harness();
    const accepted = Array.from({ length: 68 }, (_, n) =>
      track(http.request(get(`/slow/${String(n)}`))),
    );
    await settle();
    expect(state.inFlight).toBe(4);
    const refused = await rejectionOf(http.request(get('/slow/68')));
    expect(refused).toBeInstanceOf(GraphTransientError);
    expect((refused as GraphTransientError).status).toBe(503);
    for (let finished = 0; finished < 68; finished += 1) {
      state.releases[finished]?.();
      await settle(2);
    }
    await Promise.all(accepted.map((call) => call.promise));
    expect(state.maxInFlight).toBe(4);
  });

  it('frees the slot while a call waits for Retry-After', async () => {
    const throttled = mountScript(GRAPH, 'GET', '/v1.0/organization', [THROTTLED('10'), OK]);
    const quick = mountScript(GRAPH, 'GET', '/v1.0/users', [{ status: 200, body: {} }]);
    const { http, time } = harness();
    // Four calls all sleeping on a 429 would hold every slot if sleeping kept it.
    const sleepers = Array.from({ length: 4 }, () => track(http.request(get())));
    await settle();
    expect(throttled.calls).toHaveLength(4);
    const other = track(http.request(get('/users')));
    await settle();
    expect(other.settled()).toBe(true);
    expect(quick.calls).toHaveLength(1);
    time.elapse(10_000);
    await Promise.all(sleepers.map((call) => call.promise));
  });
});

describe('headers (T-B-071, FR-B-312)', () => {
  it('sets the throttle priority only when the caller says high or low', async () => {
    const { calls } = mountScript(GRAPH, 'GET', '/v1.0/organization', [OK]);
    const { http } = harness();
    await http.request(get('/organization', { priority: 'high' }));
    await http.request(get('/organization', { priority: 'low' }));
    await http.request(get('/organization'));
    expect(calls.map((call) => call.headers.get('x-ms-throttle-priority'))).toEqual([
      'high',
      'low',
      null,
    ]);
  });

  it('sends the bearer token, a new client-request-id per attempt, JSON accept and no Origin', async () => {
    const { calls } = mountScript(GRAPH, 'GET', '/v1.0/organization', [UNAVAILABLE, OK]);
    const { http, time } = harness();
    const call = track(http.request(get()));
    await settle();
    time.elapse(500);
    await settle();
    await call.promise;
    expect(calls).toHaveLength(2);
    const ids = calls.map((entry) => entry.headers.get('client-request-id'));
    for (const id of ids)
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(new Set(ids).size).toBe(2);
    for (const entry of calls) {
      expect(entry.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
      expect(entry.headers.get('accept')).toContain('application/json');
      expect(entry.headers.get('origin')).toBeNull();
    }
  });

  it('sends ConsistencyLevel only when the method asks, and a JSON body only with a body', async () => {
    const { calls } = mountScript(GRAPH, 'GET', '/v1.0/groups', [OK]);
    const { http } = harness();
    await http.request(get('/groups', { consistencyLevelEventual: true }));
    await http.request(get('/groups'));
    expect(calls[0]?.headers.get('consistencylevel')).toBe('eventual');
    expect(calls[1]?.headers.get('consistencylevel')).toBeNull();
    expect(calls[1]?.headers.get('content-type')).toBeNull();
  });

  it('reports the client-request-id it sent in the error', async () => {
    const { calls } = mountScript(GRAPH, 'GET', '/v1.0/organization', [{ status: 403, body: {} }]);
    const { http } = harness();
    const failure = (await rejectionOf(http.request(get()))) as GraphForbiddenError;
    expect(failure.clientRequestId).toBe(calls[0]?.headers.get('client-request-id'));
  });

  it('asks the token source for a fresh token only when the caller says so', async () => {
    mountScript(GRAPH, 'GET', '/v1.0/organization', [OK]);
    const { http, tokenRequests } = harness();
    await http.request(get());
    await http.request(get('/organization', { freshToken: true }));
    expect(tokenRequests).toEqual([{ skipCache: false }, { skipCache: true }]);
  });

  it('lets a token failure through unchanged and sends nothing', async () => {
    const { calls } = mountScript(GRAPH, 'GET', '/v1.0/organization', [OK]);
    const { http } = harness({ token: () => Promise.reject(new NotConnectedError()) });
    expect(await rejectionOf(http.request(get()))).toBeInstanceOf(NotConnectedError);
    expect(calls).toHaveLength(0);
  });
});

describe('no token in an error or a log line (T-B-071, FR-B-316; canary + negative)', () => {
  const EVERY_STATUS = [
    { status: 400, body: { error: { code: 'Request_BadRequest', message: TOKEN } } },
    {
      status: 401,
      body: { error: { code: 'InvalidAuthenticationToken', message: `token ${TOKEN}` } },
    },
    { status: 403, body: {} },
    { status: 404, body: {} },
    { status: 409, body: {} },
    { status: 429, body: {}, headers: { 'retry-after': '90' } },
    { status: 500, body: {} },
    { status: 503, body: {} },
  ] as const;

  it('keeps the token, the free text and the query out of every error and every log line', async () => {
    const { http, lines } = harness();
    const seen: unknown[] = [];
    for (const step of EVERY_STATUS) {
      fake.reset();
      mountScript(GRAPH, 'GET', '/v1.0/organization', [step]);
      seen.push(
        await rejectionOf(
          http.request(
            get('/organization', {
              query: { $filter: `displayName eq '${TOKEN}'` },
              budget: 'wizard',
            }),
          ),
        ),
      );
    }
    fake.reset();
    mountScript(GRAPH, 'GET', '/v1.0/organization', ['hang']);
    seen.push(
      await rejectionOf(http.request(get('/organization', { signal: AbortSignal.abort() }))),
    );
    expect(seen).toHaveLength(EVERY_STATUS.length + 1);
    for (const failure of seen) {
      const text = [
        String(failure),
        JSON.stringify(failure),
        inspect(failure, { depth: 6 }),
        (failure as Error).stack ?? '',
      ].join('\n');
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain('displayName');
    }
    const logged = JSON.stringify(lines);
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain('displayName');
    expect(logged).not.toContain('Bearer');
  });

  it('logs one debug line per attempt and a warning for a retry or a failure, with fixed fields', async () => {
    mountScript(GRAPH, 'GET', '/v1.0/organization', [UNAVAILABLE, OK]);
    const { http, lines, time } = harness();
    const call = track(http.request(get('/organization', { route: 'organization.get' })));
    await settle();
    time.elapse(500);
    await settle();
    await call.promise;
    expect(lines.map((line) => line.level)).toEqual(['warn', 'debug']);
    for (const line of lines) {
      expect(Object.keys(line.fields).sort()).toEqual(
        expect.arrayContaining(['attempt', 'durationMs', 'method', 'route', 'status']),
      );
      expect(
        Object.keys(line.fields).every((key) =>
          ['attempt', 'durationMs', 'method', 'route', 'status', 'code', 'retryInMs'].includes(key),
        ),
      ).toBe(true);
    }
  });

  it('negative: the check notices a token in an error', () => {
    expectGuardFails(
      (failure: Error) => {
        if (failure.message.includes(TOKEN)) throw new Error('token in error');
      },
      new Error(`Authorization: Bearer ${TOKEN}`),
      { name: 'canary', reason: 'token in error' },
    );
  });
});

// The call engine under both Microsoft clients (T-B-071, T-B-080; FR-B-312, FR-B-314): one loop that
// sends a request through a `JsonFetch`, with the retry rules, the call budget and the concurrency
// cap that Graph and the Exchange Admin API share. `GraphHttp` and the Admin API adapter differ in
// what they build around it (paths, headers, paging, cache) and in the typed errors they raise; both
// pass those in as `EngineErrors`.
//
// What the engine owns:
//   - the token, asked for per attempt and handed to `JsonFetch` as the bearer (never stored,
//     logged or put in an error); a failure of the token source passes through unchanged;
//   - the retry rules: a response `retryPolicy` classifies as `retry_after` waits the `Retry-After`
//     plus 0 to 20 % jitter (at most 60 s, a longer value fails fast; no header means backoff),
//     `backoff` waits 500 ms doubling to 10 s with full jitter; at most 4 retries in all;
//   - the budget: 20 s interactive, 60 s wizard; the wizard budget has no retries (the runner owns
//     every wait); an attempt lasts at most min(remaining, 10 s); a wait that does not fit in what is
//     left is not started and the answer becomes the error;
//   - at most 4 calls in flight (a FIFO queue of 64 behind them): a slot is held for one attempt and
//     released while the call waits to retry;
//   - one `client-request-id` per attempt for correlation (sent as a header when the client wants it).
// Time, randomness and timers are injected. Logging is one `debug` line per attempt and a `warn`
// line for a retry or a failure, with fixed fields: no token, no query, no id, no body.
import type { Clock, RandomSource, Scheduler } from '../../ports/clock.js';
import type { IntegrationError } from '../../ports/errors.js';
import {
  JsonFetchError,
  createJsonFetch,
  type JsonFetch,
  type JsonFetchResponse,
} from './json-fetch.js';
import {
  ATTEMPT_TIMEOUT_MS,
  MAX_IN_FLIGHT,
  MAX_QUEUED,
  backoffWaitMs,
  budgetMs,
  retriesAllowed,
  retryAfterWaitMs,
  type GraphBudget,
} from './retry.js';
import { uuidV4 } from './uuid.js';

export type CallBudget = GraphBudget;
export type CallMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** What an error built from an answer may carry (plan 8.2). */
export interface ErrorMeta {
  readonly retryAfterMs: number | null;
  readonly requestId: string | null;
  readonly clientRequestId: string | null;
}

/** The typed errors of one client family, built by the family and raised by the engine. */
export interface EngineErrors<E extends IntegrationError> {
  /** No answer: refused, timed out, redirected, not JSON, too large. */
  network(clientRequestId: string | undefined): E;
  /** The request itself was refused before it was sent (URL, header). */
  refused(clientRequestId: string | undefined): E;
  /** The queue behind the in-flight calls is full. */
  queueFull(): E;
  /** A non-2xx answer. */
  answer(status: number, body: unknown, meta: ErrorMeta): E;
}

export type RetryClass = 'retry_after' | 'backoff' | null;

export interface EngineRequest {
  readonly method: CallMethod;
  /** A fixed lower-case template name for the logs. */
  readonly route: string;
  /** The absolute URL, already checked against the origin and prefix of the client. */
  readonly href: string;
  readonly json?: unknown;
  /** Extra request headers; `JsonFetch` keeps only the ones on its allow-list. */
  readonly headers?: Readonly<Record<string, string>>;
  /** A POST that may be repeated. */
  readonly idempotent?: boolean;
  readonly budget?: CallBudget;
  readonly freshToken?: boolean;
  readonly signal?: AbortSignal;
}

export interface EngineResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface CallEngineConfig<E extends IntegrationError> {
  readonly origin: string;
  readonly pathPrefix: string;
  readonly maxResponseBytes: number;
  readonly token: (options?: { skipCache?: boolean }) => Promise<string>;
  readonly clock: Clock;
  readonly random: RandomSource;
  readonly scheduler: Scheduler;
  readonly errors: EngineErrors<E>;
  /** The error to raise when a sleeping call is aborted. */
  readonly aborted: () => E;
  /** Which non-2xx answers are worth another try, and how long to wait for it. */
  readonly retryPolicy: (answer: JsonFetchResponse, request: EngineRequest) => RetryClass;
  /** Whether the `client-request-id` header is sent (Graph documents it; the Admin API does not). */
  readonly sendClientRequestId: boolean;
  /** The message of the log lines, such as `graph_call`. */
  readonly logMessage: string;
  readonly log?: {
    debug(fields: Readonly<Record<string, unknown>>, message: string): void;
    warn(fields: Readonly<Record<string, unknown>>, message: string): void;
  };
  readonly fetch?: typeof fetch;
}

export interface CallEngine {
  send(request: EngineRequest): Promise<EngineResponse>;
}

/** A FIFO counting semaphore with a bounded queue. */
class Slots {
  readonly #waiting: (() => void)[] = [];
  #free: number = MAX_IN_FLIGHT;

  /** Resolves when a slot is free; `null` when the queue is full. */
  acquire(): Promise<void> | null {
    if (this.#free > 0) {
      this.#free -= 1;
      return Promise.resolve();
    }
    if (this.#waiting.length >= MAX_QUEUED) return null;
    return new Promise<void>((resolve) => {
      this.#waiting.push(resolve);
    });
  }

  release(): void {
    const next = this.#waiting.shift();
    if (next === undefined) this.#free += 1;
    else next();
  }
}

export function createCallEngine<E extends IntegrationError>(
  config: CallEngineConfig<E>,
): CallEngine {
  const { clock, random, scheduler, log, errors } = config;
  const jsonFetch: JsonFetch = createJsonFetch({
    origin: config.origin,
    pathPrefix: config.pathPrefix,
    maxResponseBytes: config.maxResponseBytes,
    clock,
    scheduler,
    ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
  });
  const slots = new Slots();

  function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        scheduler.clearTimeout(handle);
        reject(config.aborted());
      };
      const handle = scheduler.setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  function emit(level: 'debug' | 'warn', fields: Record<string, unknown>): void {
    log?.[level](fields, config.logMessage);
  }

  return {
    async send(request) {
      const budget: CallBudget = request.budget ?? 'interactive';
      const startedAt = clock.now();
      const deadline = startedAt + budgetMs(budget);
      const maxRetries = retriesAllowed(budget);
      let retries = 0;
      let lastClientRequestId: string | undefined;

      for (let attempt = 1; ; attempt += 1) {
        const remaining = deadline - clock.now();
        if (remaining <= 0) throw errors.network(lastClientRequestId);
        if (request.signal?.aborted === true) throw errors.network(lastClientRequestId);

        // The token is fetched per attempt, before a slot is taken; a failure of the token source
        // (secrets unavailable, not connected, token endpoint error) passes through unchanged.
        const token = await config.token(
          request.freshToken === true ? { skipCache: true } : undefined,
        );
        const queued = slots.acquire();
        if (queued === null) throw errors.queueFull();
        await queued;

        const clientRequestId = uuidV4(random);
        lastClientRequestId = clientRequestId;
        const attemptStartedAt = clock.now();
        let answer: JsonFetchResponse;
        try {
          answer = await jsonFetch({
            method: request.method,
            url: request.href,
            bearer: token,
            headers: {
              ...(config.sendClientRequestId ? { 'client-request-id': clientRequestId } : {}),
              ...request.headers,
            },
            ...(request.json === undefined ? {} : { json: request.json }),
            timeoutMs: Math.max(1, Math.min(Math.floor(remaining), ATTEMPT_TIMEOUT_MS)),
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          });
        } catch (failure) {
          const mapped =
            failure instanceof JsonFetchError && failure.failure === 'request_refused'
              ? errors.refused(clientRequestId)
              : errors.network(clientRequestId);
          emit('warn', {
            method: request.method,
            route: request.route,
            status: null,
            durationMs: clock.now() - attemptStartedAt,
            attempt,
            code: mapped.code,
          });
          throw mapped;
        } finally {
          slots.release();
        }

        const fields = {
          method: request.method,
          route: request.route,
          status: answer.status,
          durationMs: clock.now() - attemptStartedAt,
          attempt,
        };
        if (answer.status >= 200 && answer.status < 300) {
          emit('debug', fields);
          return { status: answer.status, body: answer.body };
        }

        const error = errors.answer(answer.status, answer.body, {
          retryAfterMs: answer.retryAfterMs,
          requestId: answer.requestId,
          clientRequestId,
        });

        let waitMs: number | null = null;
        if (retries < maxRetries) {
          const kind = config.retryPolicy(answer, request);
          if (kind === 'retry_after') {
            waitMs =
              answer.retryAfterMs === null
                ? backoffWaitMs(retries, random.float())
                : retryAfterWaitMs(answer.retryAfterMs, random.float());
          } else if (kind === 'backoff') {
            waitMs = backoffWaitMs(retries, random.float());
          }
        }
        // A wait that does not fit in what is left of the budget is not started.
        if (waitMs !== null && waitMs >= deadline - clock.now()) waitMs = null;

        if (waitMs === null) {
          emit('warn', { ...fields, code: error.code });
          throw error;
        }
        emit('warn', { ...fields, code: error.code, retryInMs: waitMs });
        retries += 1;
        await sleep(waitMs, request.signal);
      }
    },
  };
}

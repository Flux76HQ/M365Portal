// The one `fetch` wrapper for every outbound call of the product (T-B-070, PB-01, FR-B-312,
// FR-B-314, FR-B-316, FR-B-317). Graph, the Exchange Admin API, the token endpoint, the tenant
// metadata and the key set all go through a `JsonFetch` made here; this is the only file in
// `apps/server/src` that calls the global `fetch` (`test/integrations/json-fetch.test.ts` scans for
// it, and the layering rule keeps `fetch` out of everything outside `integrations/`).
//
// What it does, and the rule behind each part:
//
//   - A wrapper serves one origin and one path prefix (`createJsonFetch`). A request URL is checked
//     by `resolveUnder` (url-guard.ts) before anything is sent; a URL that leaves the origin or the
//     prefix is `request_refused` and no request exists. A `@odata.nextLink` is followed only
//     because the caller passes it through this same check.
//   - Request headers are an allow-list. A header the wrapper does not know is dropped; `Origin` and
//     `Cookie` are not on the list, so they are never sent (Learn rejects a token request that
//     carries `Origin`). The bearer token is a field of its own and travels only as `Authorization`.
//   - `redirect: 'error'`, and a 3xx answer that reaches the code anyway is a `redirect` failure:
//     nothing here follows a `Location`.
//   - The timeout and the caller's abort run on one `AbortController`; the timer is the injected
//     `Scheduler`, never a global timer. The timeout covers reading the body.
//   - The answer is `application/json` only and at most `maxResponseBytes` (read as a stream, so an
//     answer without `Content-Length` is cut as well). 204 and an empty body are `null`. A non-2xx
//     answer that is not JSON is `null` too, because its status is what the caller needs; a 2xx
//     answer that is not JSON is a `not_json` failure.
//   - A failure is a `JsonFetchError`: a code, a flag and at most a status. It carries no URL, no
//     header value, no token, no body and no `cause`.
//
// Time comes from the injected `Clock` (only for the `Retry-After` HTTP date) and `Scheduler`.
import type { Clock, Scheduler } from '../../ports/clock.js';
import { IntegrationError, type IntegrationErrorDetails } from '../../ports/errors.js';
import { UrlRefusedError, assertBase, resolveUnder } from './url-guard.js';

export const JSON_FETCH_FAILURES = Object.freeze([
  'timeout',
  'network',
  'redirect',
  'too_large',
  'not_json',
  'request_refused',
  'aborted',
] as const);
export type JsonFetchFailure = (typeof JSON_FETCH_FAILURES)[number];

/** Whether trying the same call again later can help: a slow or dropped connection can. */
const RETRYABLE: Readonly<Record<JsonFetchFailure, boolean>> = {
  timeout: true,
  network: true,
  redirect: false,
  too_large: false,
  not_json: false,
  request_refused: false,
  aborted: false,
};

export class JsonFetchError extends IntegrationError {
  readonly failure: JsonFetchFailure;

  constructor(failure: JsonFetchFailure, details?: IntegrationErrorDetails & { status?: number }) {
    const status = details?.status;
    super(
      {
        name: 'JsonFetchError',
        code: `fetch_${failure}`,
        retryable: RETRYABLE[failure],
        ...(typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
          ? { status }
          : {}),
      },
      details,
    );
    this.failure = failure;
  }

  protected override extraJson(): Record<string, string> {
    return { failure: this.failure };
  }
}

export type JsonFetchMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
const METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);

export interface JsonFetchRequest {
  readonly method: JsonFetchMethod;
  /** Absolute; checked against the origin and prefix of the wrapper. */
  readonly url: string;
  /** The access token. Attached as `Authorization: Bearer` here and nowhere else. */
  readonly bearer?: string;
  /** Extra request headers; only the allow-listed names are sent. */
  readonly headers?: Readonly<Record<string, string>>;
  /** A JSON body. Not together with `form`. */
  readonly json?: unknown;
  /** A `application/x-www-form-urlencoded` body (the token endpoint). Not together with `json`. */
  readonly form?: Readonly<Record<string, string>>;
  /** Milliseconds, a positive whole number; covers the answer and the reading of its body. */
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface JsonFetchResponse {
  readonly status: number;
  /** The parsed JSON, or `null` for an empty body and for a non-2xx answer that is not JSON. */
  readonly body: unknown;
  /** `Retry-After` in milliseconds from now, or `null` when absent or unreadable. */
  readonly retryAfterMs: number | null;
  /** `request-id` of the answer when it looks like an id. */
  readonly requestId: string | null;
  /** `client-request-id` of the answer when it looks like an id. */
  readonly clientRequestId: string | null;
}

export type JsonFetch = (request: JsonFetchRequest) => Promise<JsonFetchResponse>;

export interface JsonFetchConfig {
  /** `https://graph.microsoft.com`: no path, no trailing slash. */
  readonly origin: string;
  /** `/v1.0/`: slash at both ends. */
  readonly pathPrefix: string;
  /** Largest answer body in bytes. */
  readonly maxResponseBytes: number;
  readonly clock: Clock;
  readonly scheduler: Scheduler;
  /** The function that sends. Defaults to the global `fetch`, looked up at call time. */
  readonly fetch?: typeof fetch;
}

/** The request headers the wrapper sends. Matching is case-insensitive. */
const ALLOWED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  'accept',
  'client-request-id',
  'consistencylevel',
  'x-anchormailbox',
  'x-ms-throttle-priority',
]);
const HEADER_VALUE = /^[\x20-\x7e]{0,1024}$/;
const BEARER = /^[\x21-\x7e]{1,16384}$/;
const CORRELATION_ID = /^[A-Za-z0-9-]{1,64}$/;
/** Seconds as Graph sends them. An HTTP date is read separately. */
const SECONDS = /^\d{1,9}$/;
const MAX_RETRY_AFTER_MS = 7 * 86_400_000;

function jsonMediaType(contentType: string | null): boolean {
  if (contentType === null) return false;
  const type = contentType.split(';')[0]?.trim().toLowerCase();
  return type === 'application/json';
}

function pickId(value: string | null): string | null {
  return value !== null && CORRELATION_ID.test(value) ? value : null;
}

function readRetryAfter(value: string | null, clock: Clock): number | null {
  if (value === null) return null;
  const text = value.trim();
  if (SECONDS.test(text)) {
    const ms = Number(text) * 1000;
    return ms <= MAX_RETRY_AFTER_MS ? ms : null;
  }
  // An HTTP date has a day name and a comma; `Date.parse` is lenient about many other shapes.
  if (!/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text)) return null;
  const at = Date.parse(text);
  if (!Number.isFinite(at)) return null;
  const ms = Math.max(0, at - clock.now());
  return ms <= MAX_RETRY_AFTER_MS ? ms : null;
}

/** Reads at most `limit` bytes; more is `too_large` and the stream is cancelled. */
async function readBody(
  response: Response,
  limit: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const declared = response.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new JsonFetchError('too_large');
  }
  const reader = response.body?.getReader() as ReadableStreamDefaultReader<Uint8Array> | undefined;
  if (reader === undefined) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  // Aborting the request does not stop a body that is already streaming: the reader is cancelled
  // here, which ends a pending `read()` with `done`.
  const onAbort = (): void => {
    reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw new JsonFetchError('too_large');
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  if (signal.aborted) throw new Error('aborted while reading');
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseJson(bytes: Uint8Array): unknown {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new JsonFetchError('not_json');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new JsonFetchError('not_json');
  }
}

export function createJsonFetch(config: JsonFetchConfig): JsonFetch {
  assertBase(config.origin, config.pathPrefix);
  if (!Number.isSafeInteger(config.maxResponseBytes) || config.maxResponseBytes < 1) {
    throw new RangeError('maxResponseBytes is a positive whole number');
  }
  const { origin, pathPrefix, maxResponseBytes, clock, scheduler } = config;
  const send: typeof fetch = config.fetch ?? ((input, init) => fetch(input, init));

  function buildHeaders(request: JsonFetchRequest): Headers {
    const headers = new Headers();
    headers.set('accept', 'application/json');
    for (const [name, value] of Object.entries(request.headers ?? {})) {
      const key = name.toLowerCase();
      if (!ALLOWED_REQUEST_HEADERS.has(key)) continue;
      if (typeof value !== 'string' || !HEADER_VALUE.test(value)) {
        throw new JsonFetchError('request_refused');
      }
      headers.set(key, value);
    }
    if (request.bearer !== undefined) {
      if (typeof request.bearer !== 'string' || !BEARER.test(request.bearer)) {
        throw new JsonFetchError('request_refused');
      }
      headers.set('authorization', `Bearer ${request.bearer}`);
    }
    return headers;
  }

  function buildBody(request: JsonFetchRequest, headers: Headers): string | undefined {
    if (request.json !== undefined && request.form !== undefined) {
      throw new JsonFetchError('request_refused');
    }
    if (request.json !== undefined) {
      headers.set('content-type', 'application/json');
      return JSON.stringify(request.json);
    }
    if (request.form !== undefined) {
      headers.set('content-type', 'application/x-www-form-urlencoded');
      return new URLSearchParams(request.form as Record<string, string>).toString();
    }
    return undefined;
  }

  return async function jsonFetch(request: JsonFetchRequest): Promise<JsonFetchResponse> {
    if (!METHODS.has(request.method)) throw new JsonFetchError('request_refused');
    if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1) {
      throw new JsonFetchError('request_refused');
    }
    let url: URL;
    try {
      url = resolveUnder(origin, pathPrefix, request.url);
    } catch (failure) {
      if (failure instanceof UrlRefusedError) throw new JsonFetchError('request_refused');
      throw failure;
    }
    const headers = buildHeaders(request);
    const body = buildBody(request, headers);
    if (request.signal?.aborted === true) throw new JsonFetchError('aborted');

    const controller = new AbortController();
    let ended: 'timeout' | 'aborted' | undefined;
    const end = (why: 'timeout' | 'aborted'): void => {
      ended ??= why;
      controller.abort();
    };
    const timer = scheduler.setTimeout(() => {
      end('timeout');
    }, request.timeoutMs);
    const onAbort = (): void => {
      end('aborted');
    };
    request.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      let response: Response;
      try {
        response = await send(url.href, {
          method: request.method,
          headers,
          ...(body === undefined ? {} : { body }),
          redirect: 'error',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          signal: controller.signal,
        });
      } catch (failure) {
        throw failureOfSend(failure, ended);
      }

      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        throw new JsonFetchError('redirect', { status: response.status });
      }

      const meta = {
        status: response.status,
        retryAfterMs: readRetryAfter(response.headers.get('retry-after'), clock),
        requestId: pickId(response.headers.get('request-id')),
        clientRequestId: pickId(response.headers.get('client-request-id')),
      };

      let bytes: Uint8Array;
      try {
        bytes =
          request.method === 'HEAD'
            ? new Uint8Array(0)
            : await readBody(response, maxResponseBytes, controller.signal);
      } catch (failure) {
        if (failure instanceof JsonFetchError) {
          throw new JsonFetchError(failure.failure, { status: response.status });
        }
        throw failureOfSend(failure, ended);
      }

      const ok = response.status >= 200 && response.status < 300;
      if (bytes.byteLength === 0) return { ...meta, body: null };
      if (!jsonMediaType(response.headers.get('content-type'))) {
        if (ok) throw new JsonFetchError('not_json', { status: response.status });
        return { ...meta, body: null };
      }
      let parsed: unknown;
      try {
        parsed = parseJson(bytes);
      } catch (failure) {
        if (!ok) return { ...meta, body: null };
        throw failure instanceof JsonFetchError
          ? new JsonFetchError(failure.failure, { status: response.status })
          : failure;
      }
      return { ...meta, body: parsed };
    } finally {
      scheduler.clearTimeout(timer);
      request.signal?.removeEventListener('abort', onAbort);
    }
  };
}

/** What a thrown `fetch` or body read means. The original error is not kept: it can name the URL. */
function failureOfSend(failure: unknown, ended: 'timeout' | 'aborted' | undefined): JsonFetchError {
  if (failure instanceof JsonFetchError) return failure;
  if (ended !== undefined) return new JsonFetchError(ended);
  // With `redirect: 'error'` fetch rejects with a TypeError whose cause is the text "unexpected
  // redirect" (a string in undici and in MSW's interceptor, an Error elsewhere).
  const cause = (failure as { cause?: unknown } | null)?.cause;
  const text =
    typeof cause === 'string'
      ? cause
      : typeof (cause as { message?: unknown } | null)?.message === 'string'
        ? (cause as { message: string }).message
        : '';
  if (/redirect/i.test(text)) return new JsonFetchError('redirect');
  return new JsonFetchError('network');
}

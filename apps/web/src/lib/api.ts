// The API client: the only code in the web app that talks to the network (FR-A-112, plan 9.2, 8.3;
// `test/api.test.ts` scans src/ for a second caller of `fetch`).
//
// What it does for every caller:
//   - sends `Accept: application/json` and keeps the request on this origin and under /api/;
//   - on a write (anything but GET) attaches `X-CSRF-Token`: it asks `GET /api/v1/csrf` for a token
//     once, before the first write, shares that request between writes that start together, and when
//     the server answers `csrf_invalid` it fetches a new token and sends the write once more;
//   - turns a failure into a typed error: `ApiError` for an answer of the server (code, status,
//     request id, field errors, the expected origin), `NetworkError` when there was no answer. An
//     error body that is not a problem (HTML from a proxy, nothing at all, broken JSON) never makes
//     it throw something else: the code becomes `http_<status>`;
//   - never keeps the server's English `title` or `detail`: the UI shows the catalogue message of the
//     code (lib/problem.ts), so those texts are dropped here and cannot leak into a screen;
//   - notes the version the server reports and raises "update available" when it is not the version
//     this bundle was built from (E-21).
//
// Retrying is the job of TanStack Query, with `shouldRetry` below as its rule: a request that was
// refused (4xx) is never repeated, a network error or a 5xx is repeated twice. A write is never
// retried here, except the single replay after a stale CSRF token, which cannot have changed anything.
import { RequestIdSchema, OriginSchema } from '@m365portal/shared/schemas/common';
import { CsrfResponseSchema } from '@m365portal/shared/schemas/meta';
import { ProblemFieldErrorSchema, type ProblemFieldError } from '@m365portal/shared/problem';

/** The build version of this bundle (vite.config.ts defines it from the VERSION file). */
declare const __APP_VERSION__: string | undefined;

/** The `fetch` of the browser, or a stand-in in a test. */
export type FetchFunction = (input: string, init?: RequestInit) => Promise<Response>;

/** A header-safe request id, as the server writes it (`^[A-Za-z0-9-]{8,64}$`). */
function validRequestId(value: unknown): string | null {
  const parsed = RequestIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export interface ApiErrorInit {
  /** The machine code of the problem, or `http_<status>` when the server sent none. */
  readonly code: string;
  readonly status: number;
  readonly requestId: string | null;
  readonly errors: readonly ProblemFieldError[];
  /** Only for `origin_not_allowed`: the origin the panel expects. */
  readonly expectedOrigin: string | null;
  /** The `Retry-After` of a 429, in whole seconds. */
  readonly retryAfterSeconds: number | null;
}

/**
 * The server answered with an error. It carries what the UI needs to translate it and nothing of the
 * server's English text: the message is the code and the status.
 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId: string | null;
  readonly errors: readonly ProblemFieldError[];
  readonly expectedOrigin: string | null;
  readonly retryAfterSeconds: number | null;

  constructor(init: ApiErrorInit) {
    super(`${init.code} (HTTP ${String(init.status)})`);
    this.name = 'ApiError';
    this.code = init.code;
    this.status = init.status;
    this.requestId = init.requestId;
    this.errors = init.errors;
    this.expectedOrigin = init.expectedOrigin;
    this.retryAfterSeconds = init.retryAfterSeconds;
  }
}

/** There was no answer: offline, DNS, a refused connection, a dropped one. */
export class NetworkError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'NetworkError';
  }
}

/** Query's retry rule (plan 9.2): a refusal is final, a network error or a 5xx is tried twice more. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= 2) return false;
  if (error instanceof NetworkError) return true;
  if (error instanceof ApiError) return error.status >= 500;
  return false;
}

// ---------------------------------------------------------------------------------------------
// Reading an error
// ---------------------------------------------------------------------------------------------

const CODE_PATTERN = /^[a-z][a-z0-9_]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRetryAfter(header: string | null): number | null {
  return header !== null && /^\d{1,6}$/.test(header) ? Number(header) : null;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    return text.trim() === '' ? undefined : (JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

async function toApiError(response: Response): Promise<ApiError> {
  const body = await readJson(response);
  const problem = isRecord(body) ? body : {};

  const code =
    typeof problem.code === 'string' && problem.code.length <= 64 && CODE_PATTERN.test(problem.code)
      ? problem.code
      : `http_${String(response.status)}`;

  const errors = Array.isArray(problem.errors)
    ? (problem.errors as unknown[]).flatMap((entry) => {
        const parsed = ProblemFieldErrorSchema.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
      })
    : [];

  const origin = OriginSchema.safeParse(problem.expectedOrigin);

  return new ApiError({
    code,
    status: response.status,
    requestId:
      validRequestId(problem.requestId) ?? validRequestId(response.headers.get('X-Request-Id')),
    errors,
    expectedOrigin: code === 'origin_not_allowed' && origin.success ? origin.data : null,
    retryAfterSeconds: parseRetryAfter(response.headers.get('Retry-After')),
  });
}

function invalidResponse(response: Response): ApiError {
  return new ApiError({
    code: 'invalid_response',
    status: response.status,
    requestId: validRequestId(response.headers.get('X-Request-Id')),
    errors: [],
    expectedOrigin: null,
    retryAfterSeconds: null,
  });
}

// ---------------------------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------------------------

export interface RequestOptions<T> {
  /** A JSON-serialisable value (sent as application/json), a FormData or a Blob (sent as it is). */
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  /** Anything with a `parse` that returns T and throws when the data does not fit (a Zod schema). */
  readonly schema?: { parse(value: unknown): T };
}

export interface ApiResponse<T> {
  readonly data: T;
  readonly status: number;
  readonly headers: Headers;
}

export interface ApiClientOptions {
  /** Defaults to the browser's `fetch`. */
  readonly fetch?: FetchFunction;
  /**
   * The version this bundle was built from. Defaults to the one the build defined; `null` says it is
   * not known (a development server), and the update signal then never rises.
   */
  readonly buildVersion?: string | null;
}

export interface UpdateSignal {
  readonly get: () => boolean;
  readonly subscribe: (listener: () => void) => () => void;
}

export interface ApiClient {
  readonly request: <T = unknown>(
    method: string,
    path: string,
    options?: RequestOptions<T>,
  ) => Promise<ApiResponse<T>>;
  readonly get: <T = unknown>(path: string, options?: RequestOptions<T>) => Promise<T>;
  readonly post: <T = unknown>(path: string, options?: RequestOptions<T>) => Promise<T>;
  readonly put: <T = unknown>(path: string, options?: RequestOptions<T>) => Promise<T>;
  readonly delete: <T = unknown>(path: string, options?: RequestOptions<T>) => Promise<T>;
  /** Tell the client which version the server runs (from /api/v1/me). */
  readonly observeVersion: (serverVersion: string) => void;
  /** True once the server has reported a version other than the build version. */
  readonly updateAvailable: UpdateSignal;
}

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const CSRF_PATH = '/api/v1/csrf';
const CSRF_HEADER = 'X-CSRF-Token';

/** Only the application's own API: absolute, under /api/, no traversal, no second slash. */
function checkPath(path: string): void {
  const bad =
    !/^\/api\/[A-Za-z0-9._~%/-]+$/.test(path) ||
    path.includes('//') ||
    /(?:^|\/)\.\.?(?:\/|$)/.test(path) ||
    /%2[ef]/i.test(path);
  if (bad) throw new Error(`not an API path: ${JSON.stringify(path)}`);
}

function withQuery(path: string, query: RequestOptions<unknown>['query']): string {
  if (query === undefined) return path;
  const parameters = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined) parameters.set(name, String(value));
  }
  const text = parameters.toString();
  return text === '' ? path : `${path}?${text}`;
}

function isRawBody(body: unknown): body is FormData | Blob {
  return body instanceof FormData || body instanceof Blob;
}

function defaultFetch(input: string, init?: RequestInit): Promise<Response> {
  return globalThis.fetch(input, init);
}

function defaultBuildVersion(): string | null {
  return typeof __APP_VERSION__ === 'string' && __APP_VERSION__ !== '' ? __APP_VERSION__ : null;
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const send = options.fetch ?? defaultFetch;
  const buildVersion =
    options.buildVersion === undefined ? defaultBuildVersion() : options.buildVersion;

  // --- the CSRF token ---------------------------------------------------------------------------
  let token: Promise<string> | undefined;

  async function fetchToken(): Promise<string> {
    const response = await perform('GET', CSRF_PATH, undefined);
    if (!response.ok) throw await toApiError(response);
    const parsed = CsrfResponseSchema.safeParse(await readJson(response));
    if (!parsed.success) throw invalidResponse(response);
    return parsed.data.token;
  }

  function currentToken(): Promise<string> {
    token ??= fetchToken().catch((error: unknown) => {
      token = undefined; // a failed request is not remembered
      throw error;
    });
    return token;
  }

  // --- one request ------------------------------------------------------------------------------
  async function perform(
    method: string,
    path: string,
    requestOptions: RequestOptions<unknown> | undefined,
    csrfToken?: string,
  ): Promise<Response> {
    const headers = new Headers({ Accept: 'application/json' });
    for (const [name, value] of Object.entries(requestOptions?.headers ?? {}))
      headers.set(name, value);

    const init: RequestInit = { method, headers, credentials: 'same-origin' };
    if (requestOptions?.signal) init.signal = requestOptions.signal;
    const body = requestOptions?.body;
    if (body !== undefined) {
      if (isRawBody(body)) {
        init.body = body;
      } else {
        headers.set('Content-Type', 'application/json');
        init.body = JSON.stringify(body);
      }
    }
    if (csrfToken !== undefined) headers.set(CSRF_HEADER, csrfToken);

    try {
      return await send(withQuery(path, requestOptions?.query), init);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new NetworkError('the server could not be reached', { cause: error });
    }
  }

  async function execute<T>(
    method: string,
    path: string,
    requestOptions: RequestOptions<T> | undefined,
  ): Promise<Response> {
    if (method === 'GET') return perform(method, path, requestOptions);

    // A write: with a token, and once more with a fresh one when the server calls the token invalid.
    for (let attempt = 0; ; attempt += 1) {
      const used = currentToken();
      const response = await perform(method, path, requestOptions, await used);
      if (attempt === 0 && response.status === 403) {
        const error = await toApiError(response.clone());
        if (error.code === 'csrf_invalid') {
          if (token === used) token = undefined; // writes that started together refresh once
          continue;
        }
      }
      return response;
    }
  }

  async function request<T = unknown>(
    method: string,
    path: string,
    requestOptions?: RequestOptions<T>,
  ): Promise<ApiResponse<T>> {
    const verb = method.toUpperCase();
    if (!METHODS.has(verb)) throw new Error(`unsupported method ${JSON.stringify(method)}`);
    checkPath(path);

    const response = await execute(verb, path, requestOptions);
    if (!response.ok) throw await toApiError(response);

    const isJson = (response.headers.get('Content-Type') ?? '').includes('json');
    let data: unknown;
    if (isJson && response.status !== 204) {
      const text = await response.text();
      if (text.trim() !== '') {
        try {
          data = JSON.parse(text) as unknown;
        } catch {
          throw invalidResponse(response);
        }
      }
    }
    if (requestOptions?.schema !== undefined) {
      try {
        data = requestOptions.schema.parse(data);
      } catch {
        throw invalidResponse(response);
      }
    }
    return { data: data as T, status: response.status, headers: response.headers };
  }

  // --- the version ------------------------------------------------------------------------------
  let updateAvailable = false;
  const listeners = new Set<() => void>();

  function observeVersion(serverVersion: string): void {
    if (buildVersion === null || updateAvailable) return;
    if (typeof serverVersion !== 'string' || serverVersion === '' || serverVersion === buildVersion)
      return;
    updateAvailable = true;
    for (const listener of [...listeners]) listener();
  }

  const call =
    (method: string) =>
    async <T = unknown>(path: string, requestOptions?: RequestOptions<T>): Promise<T> =>
      (await request<T>(method, path, requestOptions)).data;

  return {
    request,
    get: call('GET'),
    post: call('POST'),
    put: call('PUT'),
    delete: call('DELETE'),
    observeVersion,
    updateAvailable: {
      get: () => updateAvailable,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  };
}

let shared: ApiClient | undefined;

/** The client of this page, created on first use. */
export function getApiClient(): ApiClient {
  shared ??= createApiClient();
  return shared;
}

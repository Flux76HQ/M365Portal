// A small HTTP client for the server tests. It talks to an application that is only a `fetch`
// function, in process (`app.fetch`) or over a socket (global `fetch`), and behaves like the web
// app's client where it matters for the security tests:
//
//   - a read (GET, HEAD) carries nothing special;
//   - a write (POST, PUT, PATCH, DELETE) carries the `Origin` of `PUBLIC_BASE_URL` and an
//     `X-CSRF-Token` that the application itself issued through `GET /api/v1/csrf` (the token is
//     fetched once and kept; a test asks for a new one with `csrfToken({ refresh: true })`);
//   - the `Host` header is the host of the base URL, because an in-process request has none.
//
// Every one of those can be replaced, removed or broken per request, which is what the CSRF, Origin
// and preview-mode matrices need. The client never retries and never repairs: a refused request is
// returned as it came, so the test sees the problem body of the real answer.
import { CsrfResponseSchema } from '@m365portal/shared/schemas/meta';

export type FetchLike = (request: Request) => Response | Promise<Response>;

// The request types come from the Request constructor itself, so the helper needs no DOM library.
type RequestInitLike = NonNullable<ConstructorParameters<typeof Request>[1]>;
type BodyLike = NonNullable<RequestInitLike['body']>;

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface HttpClientOptions {
  /** Where requests go: `app.fetch` in process, or the global `fetch` over a socket. */
  readonly fetch: FetchLike;
  /** Requests are sent to `new URL(path, baseUrl)`. Its host becomes the default `Host` header. */
  readonly baseUrl: string;
  /** The `Origin` header of a write: the origin of `PUBLIC_BASE_URL`. */
  readonly origin: string;
  /** Headers sent with every request; a header of the request itself wins. */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface RequestOptions {
  /** Headers of this request (lower or upper case names). */
  readonly headers?: Readonly<Record<string, string>>;
  /** A value to send as JSON; sets `Content-Type: application/json`. */
  readonly json?: unknown;
  /** A body to send as given (text, bytes, a stream, form data). */
  readonly body?: BodyLike;
  /** Replace the `Origin` of a write with this value, or send none with `null`. */
  readonly origin?: string | null;
  /**
   * The CSRF token of a write: by default one the application issued; `'none'` sends none;
   * `{ token }` sends exactly that text (a wrong, expired or forged one).
   */
  readonly csrf?: 'auto' | 'none' | { readonly token: string };
  /** Replace the `Host` header with this value, or send none with `null`. */
  readonly host?: string | null;
}

export class HttpClient {
  readonly #options: HttpClientOptions;
  #token: string | undefined;

  constructor(options: HttpClientOptions) {
    this.#options = options;
  }

  /** The CSRF token the application issued; fetched on first use and then kept. */
  async csrfToken(options: { readonly refresh?: boolean } = {}): Promise<string> {
    if (this.#token !== undefined && options.refresh !== true) return this.#token;
    const response = await this.#send(
      new Request(new URL('/api/v1/csrf', this.#options.baseUrl), {
        headers: this.#baseHeaders(),
      }),
    );
    if (response.status !== 200) {
      throw new Error(`GET /api/v1/csrf answered ${String(response.status)}, not 200`);
    }
    const parsed = CsrfResponseSchema.safeParse(await readJson(response));
    if (!parsed.success) {
      throw new Error(
        `GET /api/v1/csrf did not return a CsrfResponse: ${parsed.error.issues
          .map((issue) => issue.path.join('.') || '(body)')
          .join(', ')}`,
      );
    }
    this.#token = parsed.data.token;
    return this.#token;
  }

  async request(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
    const upper = method.toUpperCase();
    const headers = this.#baseHeaders(options.headers);
    if (options.host === null) headers.delete('host');
    else if (options.host !== undefined) headers.set('host', options.host);

    let body: BodyLike | undefined = options.body;
    if (options.json !== undefined) {
      body = JSON.stringify(options.json);
      if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    }

    if (!SAFE_METHODS.has(upper)) {
      const origin = options.origin === undefined ? this.#options.origin : options.origin;
      if (origin !== null) headers.set('origin', origin);
      const csrf = options.csrf ?? 'auto';
      if (csrf === 'auto') headers.set('x-csrf-token', await this.csrfToken());
      else if (csrf !== 'none') headers.set('x-csrf-token', csrf.token);
    }

    const init: RequestInitLike = { method: upper, headers };
    if (body !== undefined) init.body = body;
    return this.#send(new Request(new URL(path, this.#options.baseUrl), init));
  }

  get(path: string, options?: RequestOptions): Promise<Response> {
    return this.request('GET', path, options);
  }

  post(path: string, options?: RequestOptions): Promise<Response> {
    return this.request('POST', path, options);
  }

  put(path: string, options?: RequestOptions): Promise<Response> {
    return this.request('PUT', path, options);
  }

  patch(path: string, options?: RequestOptions): Promise<Response> {
    return this.request('PATCH', path, options);
  }

  delete(path: string, options?: RequestOptions): Promise<Response> {
    return this.request('DELETE', path, options);
  }

  #baseHeaders(extra?: Readonly<Record<string, string>>): Headers {
    const headers = new Headers({ host: new URL(this.#options.baseUrl).host });
    for (const [name, value] of Object.entries(this.#options.headers ?? {}))
      headers.set(name, value);
    for (const [name, value] of Object.entries(extra ?? {})) headers.set(name, value);
    return headers;
  }

  async #send(request: Request): Promise<Response> {
    return await this.#options.fetch(request);
  }
}

export function createHttpClient(options: HttpClientOptions): HttpClient {
  return new HttpClient(options);
}

/** Read a response body as a JSON value. Throws, without echoing the body, when it is not JSON. */
export async function readJson<T = unknown>(response: Response): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      `the response body is not JSON (status ${String(response.status)}, content-type ${
        response.headers.get('content-type') ?? 'none'
      }, ${String(text.length)} characters)`,
    );
  }
}

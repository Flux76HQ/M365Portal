// A small HTTP client for global-setup and for specs that talk to an instance directly (CB17): one
// cookie jar, the panel's `Origin` and the CSRF token on every write, as the web app sends them. It
// reaches the server on the loopback address; the `Origin` is the public base URL.
import { freshClientAddress } from './client-address.js';
import { originOf, portOf, type InstanceName } from './ports.js';

export interface ApiResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  json<T = unknown>(): T;
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

export class ApiClient {
  readonly #socket: string;
  readonly #origin: string;
  readonly #cookies = new Map<string, string>();
  #csrf: string | undefined;

  readonly #address: string | undefined;

  /**
   * `clientAddress` is sent as `X-Forwarded-For` (instance A only: it trusts one proxy hop); `null`
   * sends none, which the setup routes need: they answer 404 to a forwarded request (FR-B-201).
   */
  constructor(
    instance: InstanceName,
    cookies: Readonly<Record<string, string>> = {},
    clientAddress?: string | null,
  ) {
    this.#address =
      clientAddress === null ? undefined : (clientAddress ?? (instance === 'a' ? freshClientAddress() : undefined));
    this.#socket = `http://127.0.0.1:${String(portOf(instance))}`;
    this.#origin = originOf(instance);
    for (const [name, value] of Object.entries(cookies)) this.#cookies.set(name, value);
  }

  cookie(name: string): string | undefined {
    return this.#cookies.get(name);
  }

  setCookie(name: string, value: string): void {
    this.#cookies.set(name, value);
    this.#csrf = undefined;
  }

  #store(headers: Headers): void {
    for (const line of headers.getSetCookie()) {
      const [pair = '', ...attributes] = line.split(';').map((part) => part.trim());
      const separator = pair.indexOf('=');
      if (separator <= 0) continue;
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      const expired = attributes.some((attribute) => attribute.toLowerCase() === 'max-age=0');
      if (expired || value === '') this.#cookies.delete(name);
      else this.#cookies.set(name, value);
      this.#csrf = undefined;
    }
  }

  async request(
    method: string,
    path: string,
    options: { json?: unknown; headers?: Record<string, string>; origin?: string | null } = {},
  ): Promise<ApiResponse> {
    const upper = method.toUpperCase();
    const headers = new Headers(options.headers);
    if (this.#address !== undefined) headers.set('x-forwarded-for', this.#address);
    if (this.#cookies.size > 0) {
      headers.set('cookie', [...this.#cookies].map(([name, value]) => `${name}=${value}`).join('; '));
    }
    let body: string | undefined;
    if (options.json !== undefined) {
      body = JSON.stringify(options.json);
      headers.set('content-type', 'application/json');
    }
    if (!SAFE.has(upper)) {
      const origin = options.origin === undefined ? this.#origin : options.origin;
      if (origin !== null) headers.set('origin', origin);
      headers.set('x-csrf-token', await this.csrfToken());
    }
    const response = await fetch(`${this.#socket}${path}`, {
      method: upper,
      headers,
      redirect: 'manual',
      ...(body === undefined ? {} : { body }),
    });
    this.#store(response.headers);
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      text,
      json: <T>() => JSON.parse(text) as T,
    };
  }

  /** The CSRF token the panel issued for this cookie jar (fetched once, then kept). */
  async csrfToken(): Promise<string> {
    if (this.#csrf !== undefined) return this.#csrf;
    const headers = new Headers();
    if (this.#address !== undefined) headers.set('x-forwarded-for', this.#address);
    if (this.#cookies.size > 0) {
      headers.set('cookie', [...this.#cookies].map(([name, value]) => `${name}=${value}`).join('; '));
    }
    const response = await fetch(`${this.#socket}/api/v1/csrf`, { headers });
    this.#store(response.headers);
    const parsed = (await response.json()) as { token?: string };
    if (response.status !== 200 || typeof parsed.token !== 'string') {
      throw new Error(`GET /api/v1/csrf answered ${String(response.status)}`);
    }
    this.#csrf = parsed.token;
    return parsed.token;
  }

  get(path: string, headers?: Record<string, string>): Promise<ApiResponse> {
    return this.request('GET', path, headers === undefined ? {} : { headers });
  }

  post(path: string, json?: unknown, options: { origin?: string | null } = {}): Promise<ApiResponse> {
    return this.request('POST', path, { json: json ?? {}, ...options });
  }

  put(path: string, json?: unknown): Promise<ApiResponse> {
    return this.request('PUT', path, { json: json ?? {} });
  }

  delete(path: string): Promise<ApiResponse> {
    return this.request('DELETE', path);
  }
}

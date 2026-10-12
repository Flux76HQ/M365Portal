// A scripted browser for the sign-in tests (T-B-186): a cookie jar, redirect following and nothing
// else (no JavaScript, no cache). It knows the two sites of a sign-in:
//
//   the panel      the server under test, reached on its loopback socket; the jar applies the
//                  `SameSite` rules of a browser to the request it sends
//   Microsoft      `login.microsoftonline.com`, answered by the fake tenant behind MSW; no cookies
//
// A request the browser makes because a page of the OTHER site redirected it is a cross-site
// navigation: it carries `Sec-Fetch-Site: cross-site` and the panel's `Strict` cookies are withheld
// (the behaviour the interstitial of FR-B-412 exists for, U39). A request that follows a redirect of
// the panel itself is same-origin and carries them all. Test support: nothing in `src/` imports it.

export interface Hop {
  readonly url: string;
  readonly status: number;
  readonly location: string | null;
}

export interface Navigation {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  readonly url: string;
  readonly chain: readonly Hop[];
  /** The `Set-Cookie` lines of the last response. */
  readonly setCookies: readonly string[];
}

interface StoredCookie {
  readonly value: string;
  readonly sameSite: 'strict' | 'lax' | 'none';
}

export interface FakeBrowserOptions {
  /** `http://localhost:<port>`: the origin the panel believes it has. */
  readonly origin: string;
  /** `http://127.0.0.1:<port>`: where the server really listens. */
  readonly socket: string;
  /** Sent with every request to the panel (a forwarded client address, for a test that needs many clients). */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface NavigateOptions {
  /** Where the first request comes from: `none` (typed address) or `cross-site` (a link elsewhere). */
  readonly initiator?: 'none' | 'cross-site';
  /** Stop following redirects once the next location is on this origin (`panel`) or this path. */
  readonly stopBeforePanel?: boolean;
  readonly maxRedirects?: number;
  /** Change a URL of the panel before the request is sent (for the fixtures that tamper with it). */
  readonly rewrite?: (url: URL) => URL;
  readonly headers?: Readonly<Record<string, string>>;
}

const MICROSOFT_HOST = 'login.microsoftonline.com';

export class FakeBrowser {
  readonly #options: FakeBrowserOptions;
  readonly #jar = new Map<string, StoredCookie>();
  readonly #panelHost: string;

  constructor(options: FakeBrowserOptions) {
    this.#options = options;
    this.#panelHost = new URL(options.origin).host;
  }

  /** The value of a cookie in the jar, or `undefined`. */
  cookie(name: string): string | undefined {
    return this.#jar.get(name)?.value;
  }

  /** Put a cookie in the jar as if the panel had set it (a test that needs a stale or foreign one). */
  setCookie(name: string, value: string, sameSite: 'strict' | 'lax' = 'strict'): void {
    this.#jar.set(name, { value, sameSite });
  }

  deleteCookie(name: string): void {
    this.#jar.delete(name);
  }

  cookieNames(): string[] {
    return [...this.#jar.keys()];
  }

  #cookieHeader(crossSite: boolean): string | undefined {
    const sent = [...this.#jar.entries()]
      .filter(([, cookie]) => !crossSite || cookie.sameSite !== 'strict')
      .map(([name, cookie]) => `${name}=${cookie.value}`);
    return sent.length === 0 ? undefined : sent.join('; ');
  }

  #store(setCookies: readonly string[]): void {
    for (const line of setCookies) {
      const [pair = '', ...attributes] = line.split(';').map((part) => part.trim());
      const separator = pair.indexOf('=');
      if (separator <= 0) continue;
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      const lower = attributes.map((attribute) => attribute.toLowerCase());
      if (lower.includes('max-age=0')) {
        this.#jar.delete(name);
        continue;
      }
      const sameSite = lower.includes('samesite=strict')
        ? 'strict'
        : lower.includes('samesite=lax')
          ? 'lax'
          : 'none';
      this.#jar.set(name, { value, sameSite });
    }
  }

  /** One request, no redirect following. `from` is the site of the page that caused it. */
  async request(
    target: string | URL,
    init: {
      readonly method?: string;
      readonly from: 'none' | 'panel' | 'microsoft';
      readonly headers?: Readonly<Record<string, string>>;
      readonly body?: string;
    },
  ): Promise<Navigation> {
    const url = new URL(target);
    const onPanel = url.host === this.#panelHost;
    const headers = new Headers(init.headers);
    let requestUrl = url.toString();
    if (onPanel) {
      for (const [name, value] of Object.entries(this.#options.headers ?? {})) {
        headers.set(name, value);
      }
      const crossSite = init.from === 'microsoft';
      requestUrl = `${this.#options.socket}${url.pathname}${url.search}`;
      const cookie = this.#cookieHeader(crossSite);
      if (cookie !== undefined) headers.set('cookie', cookie);
      headers.set(
        'sec-fetch-site',
        init.from === 'none' ? 'none' : crossSite ? 'cross-site' : 'same-origin',
      );
      headers.set('sec-fetch-mode', 'navigate');
      headers.set('accept', 'text/html');
    }
    const response = await fetch(requestUrl, {
      method: init.method ?? 'GET',
      headers,
      redirect: 'manual',
      ...(init.body === undefined ? {} : { body: init.body }),
    });
    const setCookies = response.headers.getSetCookie();
    if (onPanel) this.#store(setCookies);
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      text,
      url: url.toString(),
      chain: [],
      setCookies,
    };
  }

  /** A top-level navigation that follows redirects like a browser. */
  async navigate(target: string | URL, options: NavigateOptions = {}): Promise<Navigation> {
    let url = new URL(target, this.#options.origin);
    let from: 'none' | 'panel' | 'microsoft' =
      options.initiator === 'cross-site' ? 'microsoft' : 'none';
    const chain: Hop[] = [];
    const limit = options.maxRedirects ?? 10;
    for (let hops = 0; ; hops += 1) {
      if (url.host === this.#panelHost && options.rewrite !== undefined) {
        url = options.rewrite(url);
      }
      const result = await this.request(url, {
        from,
        ...(options.headers === undefined ? {} : { headers: options.headers }),
      });
      const location = result.headers.get('location');
      chain.push({ url: url.toString(), status: result.status, location });
      const redirect = result.status >= 300 && result.status < 400 && location !== null;
      if (!redirect || hops >= limit) return { ...result, chain };
      const next = new URL(location, url);
      if (options.stopBeforePanel === true && next.host === this.#panelHost) {
        return { ...result, chain };
      }
      from = url.host === this.#panelHost ? 'panel' : 'microsoft';
      url = next;
    }
  }

  /** POST a JSON body from a page of the panel. */
  async postJson(
    path: string,
    body: unknown,
    headers: Readonly<Record<string, string>> = {},
  ): Promise<Navigation> {
    return await this.request(new URL(path, this.#options.origin), {
      method: 'POST',
      from: 'panel',
      headers: { 'content-type': 'application/json', origin: this.#options.origin, ...headers },
      body: JSON.stringify(body),
    });
  }

  /** `true` when `url` is on Microsoft's sign-in host. */
  static isMicrosoft(url: string | URL): boolean {
    return new URL(url).host === MICROSOFT_HOST;
  }
}

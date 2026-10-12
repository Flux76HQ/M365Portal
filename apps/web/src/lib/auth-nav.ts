// Navigation helpers of the sign-in flow (T-B-295; FR-B-606, FR-B-414 web half, FR-B-402; plan 12.3).
//
// Everything that moves the browser for a session reason is here: the address of the sign-in page and of
// the login route, the `returnTo` of the page the person is on, and the effects the API client runs when
// the server says the session is the problem. A sign-in and the redirect to Microsoft are top-level
// navigations (`location.assign` or a link), never a `fetch`, and the page never navigates to a value from
// the network without `safeReturnTo` or `checkedLogoutRedirect`.
import { safeReturnTo, RETURN_TO_DEFAULT } from '@m365portal/shared/auth/return-to';
import type { SessionStore } from '../features/auth/session-store';

/** The part of `window.location` the effects use; a test hands in its own. */
export interface BrowserLocation {
  readonly pathname: string;
  readonly search: string;
  readonly assign: (url: string) => void;
  readonly replace: (url: string) => void;
}

/** What the API client does about the session (see `createApiClient({ auth })`). */
export interface AuthEffects {
  /** The `X-Session-Idle-Expires` header of a response. */
  readonly idleExpires: (value: string | null) => void;
  /** 401 `unauthenticated`. */
  readonly unauthenticated: () => void;
  /** 401 `session_expired`. */
  readonly sessionExpired: () => void;
  /** 403 `step_up_required`: opens the dialog, replays nothing. */
  readonly stepUpRequired: () => void;
}

export const SIGNIN_PATH = '/signin';
export const LOGIN_PATH = '/auth/login';

/**
 * The pages whose own requests may be answered `unauthenticated` without the page being the problem: the
 * sign-in page, the break-glass form (a wrong password is a 401) and the setup wizard (the setup session has
 * ended; the wizard shows its token form). The browser does not leave them for the sign-in page.
 */
const OWN_AUTH_PATHS = ['/signin', '/break-glass', '/setup'] as const;

function staysOnPage(pathname: string): boolean {
  return OWN_AUTH_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

/** The error values `/signin?error=` accepts from the client side of the flow. */
export type SignInErrorParam = 'session_expired';

export interface SignInUrlOptions {
  readonly returnTo?: string;
  readonly error?: SignInErrorParam;
}

function withQuery(path: string, entries: readonly (readonly [string, string | undefined])[]): string {
  const parameters = new URLSearchParams();
  for (const [name, value] of entries) {
    if (value !== undefined) parameters.set(name, value);
  }
  const text = parameters.toString();
  return text === '' ? path : `${path}?${text}`;
}

/** `returnTo` as the sign-in wants it: kept only when it is a safe path, and left out for the dashboard. */
function cleanReturnTo(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const safe = safeReturnTo(value);
  return safe === RETURN_TO_DEFAULT ? undefined : safe;
}

/** `/signin`, with `error` and `returnTo` when they say something. */
export function signInUrl(options: SignInUrlOptions = {}): string {
  return withQuery(SIGNIN_PATH, [
    ['error', options.error],
    ['returnTo', cleanReturnTo(options.returnTo)],
  ]);
}

export interface LoginUrlOptions {
  readonly returnTo?: string;
  readonly prompt?: 'login' | 'select_account';
  readonly purpose?: 'stepup';
}

/**
 * `/auth/login?...`: the route that starts the sign-in at Microsoft. It is a navigation target (a link
 * or `location.assign`), never a `fetch`. The query has a fixed order.
 */
export function loginUrl(options: LoginUrlOptions = {}): string {
  return withQuery(LOGIN_PATH, [
    ['purpose', options.purpose],
    ['prompt', options.prompt],
    ['returnTo', cleanReturnTo(options.returnTo)],
  ]);
}

/** The page the person is on, as a `returnTo`: path and query, never the fragment, and `/` when unsafe. */
export function currentReturnTo(location: Pick<BrowserLocation, 'pathname' | 'search'>): string {
  return safeReturnTo(`${location.pathname}${location.search}`);
}

export interface AuthEffectsOptions {
  readonly location: BrowserLocation;
  readonly store: Pick<SessionStore, 'noteIdleHeader' | 'requestStepUp'>;
}

/**
 * The effects of the API client for a session problem. A 401 sends the browser to the sign-in page with
 * the current page as `returnTo` (`location.replace`: the page that failed is not worth going Back to),
 * once however many calls fail together, and not at all when the person is on the sign-in page already.
 */
export function createAuthEffects({ location, store }: AuthEffectsOptions): AuthEffects {
  let leaving = false;
  function leave(error: SignInErrorParam | undefined): void {
    if (leaving || staysOnPage(location.pathname)) return;
    leaving = true;
    const options: { returnTo: string; error?: SignInErrorParam } = {
      returnTo: currentReturnTo(location),
    };
    if (error !== undefined) options.error = error;
    location.replace(signInUrl(options));
  }
  return {
    idleExpires: (value) => {
      store.noteIdleHeader(value);
    },
    unauthenticated: () => {
      leave(undefined);
    },
    sessionExpired: () => {
      leave('session_expired');
    },
    stepUpRequired: () => {
      store.requestStepUp();
    },
  };
}

/** The browser's own location, as `BrowserLocation`. */
export function browserLocation(): BrowserLocation {
  return {
    get pathname() {
      return window.location.pathname;
    },
    get search() {
      return window.location.search;
    },
    assign: (url) => {
      window.location.assign(url);
    },
    replace: (url) => {
      window.location.replace(url);
    },
  };
}

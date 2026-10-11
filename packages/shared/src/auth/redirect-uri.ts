// The redirect URIs of the app registration, built in one place (FR-B-103, TB-04, CB4; research
// section 2.2, source https://learn.microsoft.com/en-us/entra/identity-platform/reply-url).
//
// Three strings come out of a `PUBLIC_BASE_URL`:
//   - the two URIs REGISTERED on the application (`redirectUris`): the callback and the post-logout
//     landing page, separate entries that differ by path;
//   - the URI SENT in an authorize request (`authorizeRedirectUri`);
//   - the post-logout URI sent when signing out (`postLogoutRedirectUri`).
//
// For https all of them carry the origin as it is. For `http://localhost:<port>` Learn ignores the
// port when it matches a localhost redirect URI, so the registered URIs carry none (two URIs that
// differ only by port are "ambiguous"), while the requests carry the real origin with its port.
//
// A base URL is accepted only when it can be registered: https (any host) or http with the host
// exactly `localhost`. `127.0.0.1` and `[::1]` are refused (the portal cannot add the first, the
// second is unsupported), as are wildcards, user information, a path other than `/`, a query, a
// fragment, the characters `! $ ' ( ) , ;` (Learn forbids them), internationalised host names and
// a registered URI longer than 256 characters (Learn's limit). Paths are case sensitive, so the two
// paths are written lower case here and nowhere else. Failures carry a reason code and never the
// value, so a configuration error can name the variable without echoing it.

export const CALLBACK_PATH = '/auth/callback';
export const LOGGED_OUT_PATH = '/auth/logged-out';

/** Learn: a redirect URI has at most 256 characters. */
const REDIRECT_URI_MAX_CHARS = 256;

export type RedirectUriFailure =
  | 'not_a_url'
  | 'scheme_not_allowed'
  | 'host_not_allowed'
  | 'credentials'
  | 'path'
  | 'query'
  | 'fragment'
  | 'wildcard'
  | 'forbidden_character'
  | 'internationalised_host'
  | 'too_long';

export type PublicBaseUrlResult =
  | {
      readonly ok: true;
      /** The serialised origin: scheme, lower-case host and a non-default port. */
      readonly origin: string;
      readonly https: boolean;
      /** The host without port, lower case (`localhost` for plain http). */
      readonly hostname: string;
    }
  | { readonly ok: false; readonly reason: RedirectUriFailure };

/** Thrown by the builders for a base URL that cannot be registered. Never carries the value. */
export class RedirectUriError extends Error {
  readonly reason: RedirectUriFailure;

  constructor(reason: RedirectUriFailure) {
    super(`PUBLIC_BASE_URL cannot be registered as a redirect URI: ${reason}`);
    this.name = 'RedirectUriError';
    this.reason = reason;
  }
}

const FORBIDDEN_CHARACTERS = /[!$'(),;]/;
// eslint-disable-next-line no-control-regex -- the point is to find control characters
const CONTROL_OR_SPACE = /[\s\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex -- the point is to find anything outside ASCII
const NON_ASCII = /[^\u0000-\u007f]/;

/** The registered pair: plain http is only ever `localhost`, registered without the port. */
function registeredPair(origin: string, https: boolean): readonly [string, string] {
  const base = https ? origin : 'http://localhost';
  return [`${base}${CALLBACK_PATH}`, `${base}${LOGGED_OUT_PATH}`];
}

/**
 * Check a `PUBLIC_BASE_URL` for what the application registration can hold. The checks run in a
 * fixed order, so a value with two faults always gets the same reason.
 */
export function parsePublicBaseUrl(raw: string): PublicBaseUrlResult {
  // A backslash is read as a slash by a URL parser: refused, not interpreted.
  if (CONTROL_OR_SPACE.test(raw) || raw === '' || raw.includes('\\')) {
    return { ok: false, reason: 'not_a_url' };
  }
  if (raw.includes('*')) return { ok: false, reason: 'wildcard' };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'not_a_url' };
  }
  const https = url.protocol === 'https:';
  if (!https && url.protocol !== 'http:') return { ok: false, reason: 'scheme_not_allowed' };
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'credentials' };
  if (NON_ASCII.test(raw) || url.hostname.split('.').some((label) => label.startsWith('xn--'))) {
    return { ok: false, reason: 'internationalised_host' };
  }
  if (!https && url.hostname !== 'localhost') return { ok: false, reason: 'host_not_allowed' };
  if (FORBIDDEN_CHARACTERS.test(raw)) return { ok: false, reason: 'forbidden_character' };
  if (raw.includes('#')) return { ok: false, reason: 'fragment' };
  if (raw.includes('?')) return { ok: false, reason: 'query' };
  if (url.pathname !== '/') return { ok: false, reason: 'path' };

  const longest = [
    ...registeredPair(url.origin, https),
    `${url.origin}${CALLBACK_PATH}`,
    `${url.origin}${LOGGED_OUT_PATH}`,
  ];
  if (longest.some((uri) => uri.length > REDIRECT_URI_MAX_CHARS)) {
    return { ok: false, reason: 'too_long' };
  }
  return { ok: true, origin: url.origin, https, hostname: url.hostname };
}

function accepted(publicBaseUrl: string): Extract<PublicBaseUrlResult, { ok: true }> {
  const result = parsePublicBaseUrl(publicBaseUrl);
  if (!result.ok) throw new RedirectUriError(result.reason);
  return result;
}

/** The two URIs to register as `web.redirectUris` of the application (never on the service principal). */
export function redirectUris(publicBaseUrl: string): {
  readonly callback: string;
  readonly loggedOut: string;
} {
  const base = accepted(publicBaseUrl);
  const [callback, loggedOut] = registeredPair(base.origin, base.https);
  return { callback, loggedOut };
}

/** The `redirect_uri` of an authorize and token request: the real origin, port included. */
export function authorizeRedirectUri(publicBaseUrl: string): string {
  return `${accepted(publicBaseUrl).origin}${CALLBACK_PATH}`;
}

/** The `post_logout_redirect_uri` of a sign-out request: the real origin, port included. */
export function postLogoutRedirectUri(publicBaseUrl: string): string {
  return `${accepted(publicBaseUrl).origin}${LOGGED_OUT_PATH}`;
}

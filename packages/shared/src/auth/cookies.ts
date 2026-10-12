// The three cookies of the panel: names and attributes, built in one place (FR-B-401, FR-B-713,
// spec 6.9.3, CB4). Server code that sets or clears a cookie calls these functions; nothing else
// writes a `Set-Cookie` string for the panel.
//
//   kind      https name                     SameSite  Max-Age  carries
//   session   __Host-m365portal_session      Strict    none     session id (user and break-glass)
//   oidc      __Host-m365portal_oidc         Lax       600      OIDC transaction id
//   setup     __Host-m365portal_setup        Strict    none     setup session id (memory only)
//
// All three are `HttpOnly`, `Path=/`, have no `Domain` and no `Expires`. `Secure` and the `__Host-`
// prefix apply exactly when `PUBLIC_BASE_URL` is https; on `http://localhost` the names are plain
// and `Secure` is omitted (BC-03, B-07; the `__Host-` prefix requires `Secure`). The value is a
// 256-bit random id as 43 base64url
// characters. The session and setup cookies are browser-session cookies: the server enforces the
// timeouts. The transaction cookie lives for ten minutes, the lifetime of a login transaction.

export const COOKIE_KINDS = ['session', 'oidc', 'setup'] as const;

export type CookieKind = (typeof COOKIE_KINDS)[number];

const BASE_NAMES: Readonly<Record<CookieKind, string>> = {
  session: 'm365portal_session',
  oidc: 'm365portal_oidc',
  setup: 'm365portal_setup',
};

const SAME_SITE: Readonly<Record<CookieKind, 'Strict' | 'Lax'>> = {
  session: 'Strict',
  oidc: 'Lax',
  setup: 'Strict',
};

/** `Max-Age` in seconds of the cookies that expire by themselves; the others have none. */
const MAX_AGE_SECONDS: Readonly<Partial<Record<CookieKind, number>>> = {
  oidc: 600,
};

const VALUE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** `true` for an https base URL, `false` for `http://localhost`; anything else is refused. */
function isSecureBase(publicBaseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(publicBaseUrl);
  } catch {
    throw new TypeError('the base URL (PUBLIC_BASE_URL) is not a URL');
  }
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:' && url.hostname === 'localhost') return false;
  throw new TypeError('the base URL (PUBLIC_BASE_URL) must be https or http://localhost');
}

/** The cookie names for a base URL: with the `__Host-` prefix on https, plain on `http://localhost`. */
export function cookieNames(publicBaseUrl: string): Readonly<Record<CookieKind, string>> {
  const prefix = isSecureBase(publicBaseUrl) ? '__Host-' : '';
  return {
    session: `${prefix}${BASE_NAMES.session}`,
    oidc: `${prefix}${BASE_NAMES.oidc}`,
    setup: `${prefix}${BASE_NAMES.setup}`,
  };
}

function attributesFor(kind: CookieKind, secure: boolean): string[] {
  return ['Path=/', 'HttpOnly', ...(secure ? ['Secure'] : []), `SameSite=${SAME_SITE[kind]}`];
}

/** A `Set-Cookie` header value that sets the cookie `kind` to `value` (43 base64url characters). */
export function serializeCookie(kind: CookieKind, value: string, publicBaseUrl: string): string {
  const secure = isSecureBase(publicBaseUrl);
  if (!VALUE_PATTERN.test(value)) {
    throw new TypeError('a cookie value must be 43 base64url characters (256 bits)');
  }
  const maxAge = MAX_AGE_SECONDS[kind];
  const attributes = attributesFor(kind, secure);
  if (maxAge !== undefined) attributes.push(`Max-Age=${String(maxAge)}`);
  return `${cookieNames(publicBaseUrl)[kind]}=${value}; ${attributes.join('; ')}`;
}

/**
 * A `Set-Cookie` header value that deletes the cookie `kind`: every attribute of the setting header
 * is repeated, because a browser matches a deletion on name, domain and path and a `__Host-` cookie
 * only on an equally strict header; `Max-Age=0` ends it.
 */
export function serializeCookieDeletion(kind: CookieKind, publicBaseUrl: string): string {
  const secure = isSecureBase(publicBaseUrl);
  const attributes = [...attributesFor(kind, secure), 'Max-Age=0'];
  return `${cookieNames(publicBaseUrl)[kind]}=; ${attributes.join('; ')}`;
}

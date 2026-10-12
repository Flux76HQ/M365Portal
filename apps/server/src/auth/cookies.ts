// The server side of the panel's cookies (T-B-181, FR-B-401, FR-B-417): the one place in
// `apps/server/src` that turns a cookie into a `Set-Cookie` header value or reads one back for the
// sign-in path. Names and attributes are the shared package's (`serializeCookie`,
// `serializeCookieDeletion`, `cookieNames`); this file adds the server's half:
//
//   newCookieId      a 256-bit id from the injected `RandomSource`, 43 base64url characters
//   setCookie        appends the setting header to a `Headers` (a response may carry several)
//   clearCookie      appends the deletion: every attribute repeated, `Max-Age=0`
//   readAuthCookies  the session, transaction and setup cookie of a request. Two cookies of one name
//                    count as absent (fail closed, one `cookie_duplicate` line per name and request,
//                    never the value); a value that is not a 256-bit id is absent.
import {
  cookieNames,
  serializeCookie,
  serializeCookieDeletion,
  type CookieKind,
} from '@m365portal/shared/auth/cookies';
import type { Logger } from '../logging/logger.js';
import type { RandomSource } from '../ports/clock.js';

const ID_BYTES = 32;
const VALUE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** A fresh 256-bit id as the cookie carries it (43 base64url characters). */
export function newCookieId(random: RandomSource): string {
  return Buffer.from(random.bytes(ID_BYTES)).toString('base64url');
}

/** Append the `Set-Cookie` header that sets the cookie `kind` to `value`. */
export function setCookie(
  headers: Headers,
  kind: CookieKind,
  value: string,
  publicBaseUrl: string,
): void {
  headers.append('Set-Cookie', serializeCookie(kind, value, publicBaseUrl));
}

/** Append the `Set-Cookie` header that deletes the cookie `kind`. */
export function clearCookie(headers: Headers, kind: CookieKind, publicBaseUrl: string): void {
  headers.append('Set-Cookie', serializeCookieDeletion(kind, publicBaseUrl));
}

export interface AuthCookies {
  readonly session: string | undefined;
  readonly oidc: string | undefined;
  readonly setup: string | undefined;
  /** The cookies that appeared more than once in the request. */
  readonly duplicates: readonly CookieKind[];
}

export function readAuthCookies(
  header: string | null | undefined,
  publicBaseUrl: string,
  log?: Pick<Logger, 'warn'>,
): AuthCookies {
  const names = cookieNames(publicBaseUrl);
  const found: Record<CookieKind, string[]> = { session: [], oidc: [], setup: [] };
  if (header !== null && header !== undefined) {
    for (const pair of header.split(';')) {
      const separator = pair.indexOf('=');
      if (separator <= 0) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      for (const kind of Object.keys(found) as CookieKind[]) {
        if (name === names[kind]) found[kind].push(value);
      }
    }
  }
  const duplicates: CookieKind[] = [];
  const one = (kind: CookieKind): string | undefined => {
    const values = found[kind];
    if (values.length > 1) {
      duplicates.push(kind);
      log?.warn({ event: 'cookie_duplicate', cookie: kind }, 'cookie_duplicate');
      return undefined;
    }
    const [value] = values;
    return value !== undefined && VALUE_PATTERN.test(value) ? value : undefined;
  };
  const session = one('session');
  const oidc = one('oidc');
  const setup = one('setup');
  return { session, oidc, setup, duplicates };
}

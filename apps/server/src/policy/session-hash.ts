// The session-id hash and the CSRF binding (T-B-241, FR-B-407, FR-B-408, FR-B-205, SB-09): one
// implementation each, imported by the session store (S-B4), the setup session (S-B3), the resolvers
// and the wrapper. Nothing else hashes a session id or builds a binding.
//
//   hashSessionId(value)      SHA-256 of the cookie value, lower-case hex: the primary key of `session`
//                             and the key of a setup session. The cookie holds 256 random bits, so a
//                             plain hash is enough: there is nothing to guess and nothing to salt.
//   csrfBindingFor(cookies)   the hash of the session cookie and the hash of the setup cookie, joined by
//                             a dot when both are present, the single hash when only one is, and the
//                             empty string for an anonymous browser. It is computed from the cookies
//                             as sent, with no database read, so a cross-site request learns nothing
//                             before Origin and CSRF are checked, and so one token serves a browser that
//                             holds both cookies (an Owner who reopened setup) on both route families.
import { createHash } from 'node:crypto';
import { cookieNames } from '@m365portal/shared/auth/cookies';
import { readPanelCookies } from './cookies.js';

/** SHA-256 of a session id as 64 lower-case hex characters. */
export function hashSessionId(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** The binding of a browser holding these cookies. An absent or empty cookie contributes nothing. */
export function csrfBindingFor(cookies: {
  readonly session?: string | undefined;
  readonly setup?: string | undefined;
}): string {
  return [cookies.session, cookies.setup]
    .filter((value): value is string => value !== undefined && value !== '')
    .map(hashSessionId)
    .join('.');
}

/** The binding of a request: its `Cookie` header read with the names of the base URL. */
export function csrfBindingOfHeaders(headers: Headers, publicBaseUrl: string): string {
  const names = cookieNames(publicBaseUrl);
  return csrfBindingFor(readPanelCookies(headers.get('cookie'), names));
}

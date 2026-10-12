// The one check before the client navigates to the address a sign-out answered with (T-B-295; FR-B-410,
// FR-B-606; plan 12.3). `POST /api/v1/auth/logout` returns `{redirect}`; the client follows it only when
// it is one of two shapes, and navigates to nothing else:
//   - the sign-out page of Entra: `https:` on exactly `login.microsoftonline.com`, without credentials
//     and without a port;
//   - exactly the local path `/signin?signedout=1` (a break-glass session has no Entra session to end).
// The server checks the same value before it sends it (`isLogoutRedirect` of the shared package, which
// also pins the tenant and the return address); this is the second line, in the browser, and it is the
// only place in the web source that names a Microsoft host.

/** The host of the Entra sign-in service (the value of `ENTRA_LOGIN_HOST` in the shared package). */
export const ENTRA_HOST = 'login.microsoftonline.com';
/** The local landing page of a sign-out without an Entra session. */
export const SIGNED_OUT_PATH = '/signin?signedout=1';

const MAX_LENGTH = 2048;
/** Printable ASCII only: no space, no control character, nothing a header or a parser could read twice. */
const PLAIN = /^[\x21-\x7e]+$/;

/**
 * The address to navigate to, or `null` when the value is not one of the two accepted shapes. A value
 * that is not a string is refused. The value is returned unchanged: nothing is rewritten, so what was
 * checked is what is used.
 */
export function checkedLogoutRedirect(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value === SIGNED_OUT_PATH) return value;
  if (value.length === 0 || value.length > MAX_LENGTH || !PLAIN.test(value)) return null;
  if (value.includes('\\')) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const accepted =
    url.protocol === 'https:' &&
    url.hostname === ENTRA_HOST &&
    url.username === '' &&
    url.password === '' &&
    url.port === '';
  return accepted ? value : null;
}

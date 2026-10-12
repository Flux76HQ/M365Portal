// The redirects of the sign-in surface (FR-B-403, FR-B-402): always 303, `Cache-Control: no-store`
// comes from the pipeline for every `/auth/*` path. The location is built here from allow-listed
// codes only; a value from the request never reaches it unencoded.
import type { SigninErrorCode, NoAccessReason } from '@m365portal/shared/auth/signin-errors';

/** `/signin?error=<code>`, with the sanitised `returnTo` when the page should offer to continue there. */
export function signinErrorLocation(code: SigninErrorCode, returnTo?: string): string {
  const query = new URLSearchParams({ error: code });
  if (returnTo !== undefined && returnTo !== '/') query.set('returnTo', returnTo);
  return `/signin?${query.toString()}`;
}

/** `/no-access?reason=<reason>&ref=<request id>`. */
export function noAccessLocation(reason: NoAccessReason, requestId: string): string {
  return `/no-access?${new URLSearchParams({ reason, ref: requestId }).toString()}`;
}

export function redirectResponse(location: string, headers: Headers = new Headers()): Response {
  headers.set('Location', location);
  return new Response(null, { status: 303, headers });
}

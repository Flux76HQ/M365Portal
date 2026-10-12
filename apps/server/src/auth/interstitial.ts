// The interstitial that ends a successful sign-in (T-B-187, FR-B-412, RB-11, U39): `200 text/html`
// with a meta refresh, never a 303. A redirect chain started by a cross-site navigation (Entra's
// redirect to the callback) may withhold `SameSite=Strict` cookies from the follow-up request; the
// refresh makes the next navigation a same-site one, so the first paint carries the session and the
// boot data shows the signed-in person.
//
// The page has no script and no style, so the strict content security policy of the html profile
// needs nothing from it; it carries the response's nonce only through the header. The `returnTo` is
// already sanitised by `safeReturnTo`, and is escaped in both places it appears.
import type { Context } from 'hono';
import type { AppEnv } from '../http/request-context.js';

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character);
}

/** The page. `returnTo` is a path that starts with a single `/`. */
export function interstitialHtml(returnTo: string): string {
  const target = escapeHtml(returnTo);
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="refresh" content="0;url=${target}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow">',
    '<title>M365Portal</title>',
    '</head>',
    '<body>',
    `<p><a href="${target}">Doorgaan / Continue</a></p>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/**
 * The 200 response. `headers` carries the `Set-Cookie` lines (the new session, the cleared
 * transaction); `Cache-Control: no-store` comes from the pipeline for every `/auth/` path.
 */
export function interstitialResponse(
  c: Context<AppEnv>,
  returnTo: string,
  headers: Headers = new Headers(),
): Response {
  // Draw the nonce of this response: the security headers put the same value in the policy.
  c.get('nonce')();
  headers.set('Content-Type', 'text/html; charset=utf-8');
  return new Response(interstitialHtml(returnTo), { status: 200, headers });
}

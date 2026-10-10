// Stage 2 of the request pipeline (plan 7.2): the security headers on every response (FR-A-040 to
// FR-A-043, FR-A-047, FR-A-049), in one of three profiles (plan 8.1, PD-01, PD-02):
//
//   html    the shell and the offline page: the full policy with the nonce of this request.
//   worker  `/sw.js`: a policy that lets the worker fetch from its own origin (plan V-04).
//   other   everything else: API, images, health, errors, manifest, robots, static assets.
//
// The middleware wraps the handler and writes the headers on the response that comes back, so a
// response made by a handler, by the error handler, by the not-found handler, by a guard that
// answered early or by another middleware all leave through the same place. It sets the headers
// whatever the handler set: a handler cannot weaken the policy, and a library cannot add `Server`,
// `X-Powered-By` or a CORS header (FR-A-040, FR-A-047).
//
// The profile follows the response, not the request: a page is a page because it was answered with
// `text/html`, and `/sw.js` is the worker because of its path. A request for an unknown path is a
// problem document and therefore `other`, never a shell.
import type { MiddlewareHandler } from 'hono';
import type { AppConfig } from '../config/env.js';
import { buildCsp, createNonce, OTHER_CSP, WORKER_CSP } from './csp.js';
import { hstsHeaderValue } from './hsts.js';
import { FEATURE_POLICY } from './permissions-policy.js';
import { problemResponse } from './problem.js';
import { setResponseHeaders, type AppEnv } from './request-context.js';
import { requestHost } from './trust-proxy.js';

export type HeaderProfile = 'html' | 'worker' | 'other';

/** The one path that is the worker profile. Exactly this path: no trailing slash, no `.map`. */
const WORKER_PATH = '/sw.js';

/** A `Content-Type` whose media type is `text/html` (parameters allowed, case ignored). */
const HTML_CONTENT_TYPE = /^\s*text\/html\s*(?:;|$)/i;

/** Which profile a response gets: the path of the request and the content type of the response. */
export function profileOf(path: string, contentType: string | null): HeaderProfile {
  if (path === WORKER_PATH) return 'worker';
  return contentType !== null && HTML_CONTENT_TYPE.test(contentType) ? 'html' : 'other';
}

export interface ProfileHeadersInput {
  readonly profile: HeaderProfile;
  /** The nonce of this request. Used by the html profile only; `undefined` means no inline code. */
  readonly nonce: string | undefined;
  readonly https: boolean;
  /** The `Strict-Transport-Security` value, when one is to be sent (`hstsHeaderValue`). */
  readonly strictTransport?: string | undefined;
}

/**
 * The security headers of a profile (plan 8.1). `Cache-Control` is not among them: it belongs to
 * the route (FR-A-050), not to the security profile.
 */
export function headersForProfile(input: ProfileHeadersInput): Record<string, string> {
  const { profile, nonce, https, strictTransport } = input;
  const headers: Record<string, string> = {
    'Content-Security-Policy':
      profile === 'html'
        ? buildCsp({ nonce, https })
        : profile === 'worker'
          ? WORKER_CSP
          : OTHER_CSP,
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': FEATURE_POLICY,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'noindex, nofollow',
  };
  if (profile === 'html') {
    headers['Cross-Origin-Opener-Policy'] = 'same-origin';
    headers['X-Frame-Options'] = 'DENY';
  }
  if (profile !== 'other') headers['Cross-Origin-Embedder-Policy'] = 'require-corp';
  if (strictTransport !== undefined) headers['Strict-Transport-Security'] = strictTransport;
  return headers;
}

/** Headers no response of this server carries, whatever a handler or a library set. */
const NEVER_SENT = ['Server', 'X-Powered-By'] as const;

export interface SecurityHeadersOptions {
  readonly config: Pick<AppConfig, 'hsts' | 'publicHost'>;
}

export function securityHeaders(options: SecurityHeadersOptions): MiddlewareHandler<AppEnv> {
  const { config } = options;

  return async (c, next) => {
    // The nonce is drawn the first time the page asks for it and is then the same value for the
    // rest of the request, so the policy and the page always agree. A response that does not ask
    // (JSON, an image, the offline page) costs no random bytes and its policy has no nonce.
    let nonce: string | undefined;
    c.set('nonce', () => {
      nonce ??= createNonce();
      return nonce;
    });

    await next();

    const profile = profileOf(c.req.path, c.res.headers.get('content-type'));
    const https = c.get('scheme') === 'https';
    const strictTransport = hstsHeaderValue({ config, https, host: requestHost(c.req.raw) });

    const headers: Record<string, string | undefined> = {
      ...headersForProfile({
        profile,
        nonce: profile === 'html' ? nonce : undefined,
        https,
        strictTransport,
      }),
    };
    // A header this response must not have: forbidden by name, CORS by prefix (FR-A-047), and an
    // HSTS value a handler set that the rule did not allow (over http, or an unknown host form).
    if (strictTransport === undefined) headers['Strict-Transport-Security'] = undefined;
    for (const name of NEVER_SENT) headers[name] = undefined;
    for (const name of c.res.headers.keys()) {
      if (name.startsWith('access-control-')) headers[name] = undefined;
    }
    // Profile-specific headers a handler set on a profile that must not have them.
    if (profile !== 'html') {
      headers['Cross-Origin-Opener-Policy'] = undefined;
      headers['X-Frame-Options'] = undefined;
    }
    if (profile === 'other') headers['Cross-Origin-Embedder-Policy'] = undefined;

    setResponseHeaders(c, headers);
  };
}

/** The methods a path answers when nothing better is known: the table of routes supplies the rest. */
const DEFAULT_ALLOW: readonly string[] = ['GET', 'HEAD'];

/**
 * No CORS (FR-A-047): a preflight is not answered. `OPTIONS` gets a 405 problem with `Allow`, and
 * no `Access-Control-*` header, so a browser's preflight fails and the cross-origin request is
 * never sent. `allowFor` lets the route table say which methods the path really has.
 */
export function rejectOptions(
  allowFor?: (request: Request) => readonly string[],
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.req.method !== 'OPTIONS') {
      await next();
      return;
    }
    const allow = allowFor?.(c.req.raw) ?? DEFAULT_ALLOW;
    return problemResponse(c, 'method_not_allowed', {
      allow: allow.length > 0 ? allow : DEFAULT_ALLOW,
    });
  };
}

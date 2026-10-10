// Strict-Transport-Security (FR-A-043, E-16, BC-01, baseline section 13).
//
// What the header promises, and so who may be promised it:
//   - `max-age` says "use https for this host". It is sent on every https response, on any host the
//     app answers on, because it is a promise about the host being asked and nothing else.
//   - `includeSubDomains` says "and for every subdomain, at every depth, for the whole max-age, in
//     every browser that saw it once". A self-hosted panel cannot know which subdomains its operator
//     owns, so the flag is an explicit opt-in (`HSTS_INCLUDE_SUBDOMAINS`) and applies only to the one
//     host the operator declared in `PUBLIC_BASE_URL`: an alias, an IP address, an internal name or a
//     request without a `Host` header gets the plain form.
//   - `preload` asks browser vendors to hard-code the host into the browser. It is an opt-in
//     (`HSTS_PRELOAD`) on the same host, and it needs `includeSubDomains` and a year of `max-age`
//     (the configuration refuses anything else at start; this function does not trust that and
//     checks again, so a hand-built configuration cannot send a preload promise that is not valid).
//
// Over http nothing is sent: a browser ignores the header there, and a proxy that rewrites it would
// be making a promise the connection cannot keep.
import { LIMITS } from '@m365portal/shared/limits';
import type { AppConfig } from '../config/env.js';

export interface HstsInput {
  readonly config: Pick<AppConfig, 'hsts' | 'publicHost'>;
  /** Is the effective scheme of the request https (`PUBLIC_BASE_URL`, or a trusted proxy)? */
  readonly https: boolean;
  /**
   * The host of the request, in the form `requestHost` gives (lower case, no port, no trailing dot,
   * IPv6 in brackets), or `undefined` when the `Host` header is missing or malformed. It is
   * compared as it is: the caller normalises, so there is exactly one normaliser in the server.
   */
  readonly host: string | undefined;
}

/** The value of the header, or `undefined` when none is to be sent. */
export function hstsHeaderValue(input: HstsInput): string | undefined {
  const { config, https, host } = input;
  if (!https) return undefined;

  const parts = [`max-age=${String(config.hsts.maxAgeSeconds)}`];
  const onDeclaredHost = host !== undefined && host === config.publicHost;
  const includeSubDomains = config.hsts.includeSubDomains && onDeclaredHost;
  if (includeSubDomains) parts.push('includeSubDomains');
  if (
    config.hsts.preload &&
    includeSubDomains &&
    config.hsts.maxAgeSeconds >= LIMITS.hstsMaxAgeSeconds
  ) {
    parts.push('preload');
  }
  return parts.join('; ');
}

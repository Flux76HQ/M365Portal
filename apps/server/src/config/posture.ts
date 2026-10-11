// The posture line (FR-A-015, FR-A-036): what the server logs once at start about the choices that
// change who may do what. Modes and flags only: no value of a variable, no address, no port.
import type { AppConfig } from './env.js';

export interface Posture {
  /**
   * `off`; `loopback-only`: preview mode is on and a request whose `Host` is not loopback, or that
   * carries forwarding headers, is treated as anonymous (FR-A-036); `any-host`: preview mode is on
   * with `PREVIEW_MODE_ALLOW_REMOTE=true`, so that rule is lifted.
   */
  readonly preview: 'off' | 'loopback-only' | 'any-host';
  readonly trustProxy: 'none' | 'hops' | 'list';
  /**
   * `off` when `Strict-Transport-Security` can never be sent (the base URL is http and no proxy is
   * trusted to say otherwise); otherwise the opt-in level that applies on the declared host.
   */
  readonly hsts: 'off' | 'plain' | 'include-subdomains' | 'preload';
  readonly showcase: boolean;
  /** Present only when preview mode is on: the Host-based detection is not a security boundary. */
  readonly previewBoundary?: 'host-detection-not-a-security-boundary';
}

export function readPosture(config: AppConfig): Posture {
  let preview: Posture['preview'] = 'off';
  if (config.previewMode) preview = config.previewModeAllowRemote ? 'any-host' : 'loopback-only';

  let hsts: Posture['hsts'] = 'plain';
  if (!config.publicIsHttps && config.trustProxy.mode === 'none') hsts = 'off';
  else if (config.hsts.preload) hsts = 'preload';
  else if (config.hsts.includeSubDomains) hsts = 'include-subdomains';

  return {
    preview,
    trustProxy: config.trustProxy.mode,
    hsts,
    showcase: config.showcase,
    ...(config.previewMode
      ? { previewBoundary: 'host-detection-not-a-security-boundary' as const }
      : {}),
  };
}

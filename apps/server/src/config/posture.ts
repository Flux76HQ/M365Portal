// The posture line (FR-A-015, FR-B-101): what the server logs once at start about the choices that
// change who may do what. Modes and flags only: no value of a variable, no address, no port.
//
// Phase B drops the preview fields (FR-B-102) and adds the choices that decide how a person gets
// in: whether the break-glass account exists and whether multi-factor sign-in is required. The
// setup state and the secrets state are runtime facts, not configuration; the start supplies them
// next to the storage facts (`logPosture`).
import type { AppConfig } from './env.js';

export interface Posture {
  readonly trustProxy: 'none' | 'hops' | 'list';
  /**
   * `off` when `Strict-Transport-Security` can never be sent (the base URL is http and no proxy is
   * trusted to say otherwise); otherwise the opt-in level that applies on the declared host.
   */
  readonly hsts: 'off' | 'plain' | 'include-subdomains' | 'preload';
  readonly showcase: boolean;
  /** `on` when `BREAK_GLASS_USERNAME` and `BREAK_GLASS_PASSWORD_HASH` are set (FR-B-521). */
  readonly breakGlass: 'on' | 'off';
  /** `on` when `AUTH_REQUIRE_MFA` is true (FR-B-405). */
  readonly mfa: 'on' | 'off';
}

export function readPosture(config: AppConfig): Posture {
  let hsts: Posture['hsts'] = 'plain';
  if (!config.publicIsHttps && config.trustProxy.mode === 'none') hsts = 'off';
  else if (config.hsts.preload) hsts = 'preload';
  else if (config.hsts.includeSubDomains) hsts = 'include-subdomains';

  return {
    trustProxy: config.trustProxy.mode,
    hsts,
    showcase: config.showcase,
    breakGlass: config.breakGlass === undefined ? 'off' : 'on',
    mfa: config.auth.requireMfa ? 'on' : 'off',
  };
}

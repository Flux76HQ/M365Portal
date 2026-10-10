// The Content-Security-Policy of the three header profiles (FR-A-041, FR-A-042, plan 8.1 and 8.2).
//
// `buildCsp` is the one function that builds the policy of the shell. Nothing else in the server
// writes a `script-src` or a `style-src`, so there is one place where "no unsafe-inline, no
// unsafe-eval, no wildcard, no data:" has to hold, and `server/security-headers.test.ts` parses
// what it returns and asserts exactly that.
import { randomBytes } from 'node:crypto';
import { TRUSTED_TYPES_POLICY_NAME } from '@m365portal/shared/limits';

/** 16 random bytes: 128 bits, the least FR-A-041 allows. */
const NONCE_BYTES = 16;

/**
 * A nonce as `createNonce` makes it: standard base64 of at least 128 bits. A value outside this
 * alphabet could close the quoted source (`'`), end the directive (`;`) or end the header (CR, LF),
 * so `buildCsp` refuses it instead of repairing it.
 */
const NONCE_PATTERN = /^[A-Za-z0-9+/]{22,}={0,2}$/;

/** A fresh nonce: 16 bytes from the system random source, base64. Never reused. */
export function createNonce(): string {
  return randomBytes(NONCE_BYTES).toString('base64');
}

export interface CspInput {
  /**
   * The nonce of this request. `undefined` builds the policy of a page that has no inline code (the
   * offline page): the same policy with no nonce token, which then allows no inline code at all.
   */
  readonly nonce: string | undefined;
  /** `upgrade-insecure-requests` has no use over plain http, so it is added over https only. */
  readonly https: boolean;
}

/** The policy of the html profile: the shell and the offline page. */
export function buildCsp(input: CspInput): string {
  const { nonce, https } = input;
  if (nonce !== undefined && !NONCE_PATTERN.test(nonce)) {
    throw new TypeError('buildCsp: the nonce must be base64 of at least 128 bits');
  }
  const token = nonce === undefined ? '' : ` 'nonce-${nonce}'`;
  const directives = [
    "default-src 'none'",
    `script-src 'self'${token}`,
    `style-src 'self'${token}`,
    "img-src 'self'",
    "font-src 'self'",
    "connect-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "require-trusted-types-for 'script'",
    `trusted-types ${TRUSTED_TYPES_POLICY_NAME}`,
  ];
  if (https) directives.push('upgrade-insecure-requests');
  return directives.join('; ');
}

/**
 * The policy of `/sw.js` (plan V-04, PD-02). The generic policy of the other profile makes every
 * navigation fail once the worker is registered, online and offline; this one lets the worker
 * fetch from its own origin and nothing else.
 */
export const WORKER_CSP = "default-src 'none'; connect-src 'self'; frame-ancestors 'none'";

/** The policy of everything that is not a page or the worker: API, images, health, errors. */
export const OTHER_CSP = "default-src 'none'; frame-ancestors 'none'; sandbox";

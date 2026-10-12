// CSRF tokens (plan 8.3, FR-A-044, E-09). A token is
//
//     v1.<iat>.<exp>.<nonce>.<mac>
//
// `iat` and `exp` are whole seconds since the epoch in decimal, `nonce` is 16 random bytes and `mac`
// is HMAC-SHA-256 over the text `v1.<iat>.<exp>.<nonce>.<binding>`, the last two fields in base64url.
// The key is 32 random bytes made when the process starts and kept in memory: a restart invalidates
// every token, and the client fetches a new one on `csrf_invalid` (once, then retries). Nothing is
// stored on the server, so a token can be shown as often as the client likes until it expires; the
// defence is that a foreign page cannot read one (the same-origin policy keeps it out of
// `GET /api/v1/csrf`) and cannot send the header without a preflight, which this server refuses.
//
// `binding` ties a token to something the server knows about the caller. It is the empty string in
// Phase A; Phase B passes the session id, and no signature changes.
//
// Time. A token lives 8 hours (`LIMITS.csrfTokenLifetimeMs`). It is accepted while `iat` is at most 5
// minutes in the future (a client clock cannot cause that, only ours stepping back) and `exp` plus a
// 60 s leeway has not passed. The clock is injected; a backward step of more than 5 minutes makes
// tokens issued before it invalid until the client fetches a new one, which is the safe direction.
//
// The signature is checked before the time, and is compared in constant time, so a forged token
// learns nothing about the clock and a near miss learns nothing about the key.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { LIMITS } from '@m365portal/shared/limits';
import type { Context, MiddlewareHandler } from 'hono';
import { problemResponse } from './problem.js';
import type { AppEnv } from './request-context.js';

const VERSION = 'v1';
const KEY_BYTES = 32;
const NONCE_BYTES = 16;
/** `iat` may lie this far ahead of our clock. */
const FUTURE_SKEW_SECONDS = 300;
/** `exp` is honoured this long after it has passed. */
const LEEWAY_SECONDS = 60;

export const CSRF_HEADER = 'X-CSRF-Token';

// Canonical decimal numbers (no sign, no leading zero, no exponent), and base64url fields of the
// exact length of 16 and 32 bytes. Every quantifier is bounded.
const TOKEN_SHAPE =
  /^v1\.(0|[1-9]\d{0,11})\.(0|[1-9]\d{0,11})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;

export interface IssuedToken {
  readonly token: string;
  /** UTC with milliseconds: the `expiresAt` of the `CsrfResponse`. */
  readonly expiresAt: string;
}

/** Why a token was refused. Internal: for the audit entry, never for the client (plan 8.3, step 4). */
export type CsrfFailure = 'missing' | 'malformed' | 'bad_signature' | 'expired' | 'not_yet_valid';

export type CsrfCheck =
  { readonly ok: true } | { readonly ok: false; readonly reason: CsrfFailure };

export interface Csrf {
  issue(binding: string): IssuedToken;
  validate(token: string | null | undefined, binding: string): CsrfCheck;
}

export interface CsrfOptions {
  /** The clock, in milliseconds. Injected. */
  readonly now: () => number;
  /** For tests: the key. Default: 32 random bytes. At least 32 bytes. */
  readonly key?: Uint8Array;
  /** For tests: the source of random bytes for the nonce. Default: the system's. */
  readonly random?: (length: number) => Uint8Array;
  /** Default: `LIMITS.csrfTokenLifetimeMs`. */
  readonly ttlMs?: number;
}

export function createCsrf(options: CsrfOptions): Csrf {
  const key = Buffer.from(options.key ?? randomBytes(KEY_BYTES));
  if (key.length < KEY_BYTES) throw new RangeError(`the CSRF key needs ${String(KEY_BYTES)} bytes`);
  const random = options.random ?? randomBytes;
  const ttlSeconds = Math.floor((options.ttlMs ?? LIMITS.csrfTokenLifetimeMs) / 1000);

  const now = (): number => {
    const milliseconds = options.now();
    if (!Number.isFinite(milliseconds)) {
      throw new RangeError('the clock did not return a time');
    }
    return milliseconds;
  };

  const sign = (iat: string, exp: string, nonce: string, binding: string): Buffer =>
    createHmac('sha256', key).update(`${VERSION}.${iat}.${exp}.${nonce}.${binding}`).digest();

  return {
    issue(binding) {
      const iat = Math.floor(now() / 1000);
      const exp = iat + ttlSeconds;
      const nonce = Buffer.from(random(NONCE_BYTES)).toString('base64url');
      const mac = sign(String(iat), String(exp), nonce, binding).toString('base64url');
      return {
        token: `${VERSION}.${String(iat)}.${String(exp)}.${nonce}.${mac}`,
        expiresAt: new Date(exp * 1000).toISOString(),
      };
    },

    validate(token, binding) {
      if (token === null || token === undefined || token === '') {
        return { ok: false, reason: 'missing' };
      }
      if (!TOKEN_SHAPE.test(token)) return { ok: false, reason: 'malformed' };
      // The shape matched, so each replacement picks one captured field of our own token.
      const iat = token.replace(TOKEN_SHAPE, '$1');
      const exp = token.replace(TOKEN_SHAPE, '$2');
      const nonce = token.replace(TOKEN_SHAPE, '$3');
      const mac = token.replace(TOKEN_SHAPE, '$4');

      // The last character of a 32-byte base64url string carries two bits that mean nothing; a
      // string that sets them decodes to the same bytes. Only the canonical spelling is a token.
      const given = Buffer.from(mac, 'base64url');
      if (given.toString('base64url') !== mac) return { ok: false, reason: 'bad_signature' };
      const expected = sign(iat, exp, nonce, binding);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        return { ok: false, reason: 'bad_signature' };
      }

      const current = now();
      if (Number(iat) * 1000 > current + FUTURE_SKEW_SECONDS * 1000) {
        return { ok: false, reason: 'not_yet_valid' };
      }
      if (current > (Number(exp) + LEEWAY_SECONDS) * 1000) return { ok: false, reason: 'expired' };
      return { ok: true };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------------------------

const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Every method other than GET, HEAD and OPTIONS is a write, including one nobody has heard of. */
export function isWriteMethod(method: string): boolean {
  return !READ_METHODS.has(method);
}

/** What a guard refused and why. `reason` is for the audit entry (FR-A-034); the client sees `code`. */
export interface Denial {
  readonly code: 'origin_not_allowed' | 'csrf_invalid';
  readonly reason: string;
}

/**
 * Called once for a refusal, before the response exists. It is awaited: the audit entry of FR-A-034
 * is written before the response is sent, and if the hook throws the request fails (closed) with
 * the error handler's answer instead of the refusal, and the handler is never reached.
 */
export type OnDenied = (c: Context<AppEnv>, denial: Denial) => void | Promise<void>;

export interface CsrfGuardOptions {
  readonly csrf: Csrf;
  /** The binding of the caller. Default: the empty string (Phase A). */
  readonly binding?: (c: Context<AppEnv>) => string;
  readonly onDenied?: OnDenied;
}

/** Reject a write whose `X-CSRF-Token` is missing or invalid: 403 `csrf_invalid`. */
export function csrfGuard(options: CsrfGuardOptions): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!isWriteMethod(c.req.method)) {
      await next();
      return;
    }
    const binding = options.binding?.(c) ?? '';
    const result = options.csrf.validate(c.req.header(CSRF_HEADER), binding);
    if (result.ok) {
      await next();
      return;
    }
    await options.onDenied?.(c, { code: 'csrf_invalid', reason: result.reason });
    return problemResponse(c, 'csrf_invalid');
  };
}
